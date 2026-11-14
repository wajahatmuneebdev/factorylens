import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  GoogleAuthCallbackRequestSchema,
  GoogleAuthRequestSchema,
  type User,
} from "@factorylens/contracts";
import type { Express, Request } from "express";
import { z } from "zod";

import {
  authenticatedUser,
  clearSessionCookie,
  hashSessionToken,
  readCookie,
  requireSession,
  SESSION_COOKIE_NAME,
  type SessionStore,
} from "./session.js";
import {
  DEFAULT_RATE_LIMITS,
  rateLimit,
  RequestRateLimiter,
} from "./security.js";

const TRANSACTION_COOKIE_NAME = "factorylens_oidc";
const TRANSACTION_COOKIE_PATH = "/auth/google/callback";
const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const transactionSchema = z
  .object({
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(16).max(256),
    returnTo: z.string().startsWith("/").max(512),
    state: z.string().min(16).max(256),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export interface OidcAuthorizationRequest {
  codeVerifier: string;
  location: URL;
  nonce: string;
  state: string;
}

export interface OidcIdentity {
  avatarUrl: string | null;
  displayName: string;
  email: string;
  googleSubject: string;
}

export interface OidcProvider {
  createAuthorizationRequest(
    callbackUrl: URL,
  ): Promise<OidcAuthorizationRequest>;
  exchangeAuthorizationCode(
    callbackUrl: URL,
    expected: Pick<
      OidcAuthorizationRequest,
      "codeVerifier" | "nonce" | "state"
    >,
  ): Promise<OidcIdentity>;
}

export interface AuthStore extends SessionStore {
  createSession(
    identity: OidcIdentity,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<User>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

export interface AuthDependencies {
  appOrigin: URL;
  callbackUrl: URL;
  oidcProvider: OidcProvider;
  store: AuthStore;
  transactionSecret: string;
  now?: () => Date;
  requestRateLimiter?: RequestRateLimiter;
}

function sealTransaction(
  transaction: z.infer<typeof transactionSchema>,
  secret: string,
): string {
  const key = createHash("sha256").update(secret).digest();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(Buffer.from(TRANSACTION_COOKIE_NAME));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    initializationVector,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
}

function openTransaction(
  value: string,
  secret: string,
  now: Date,
): z.infer<typeof transactionSchema> | null {
  try {
    const sealed = Buffer.from(value, "base64url");
    if (sealed.length < 29) {
      return null;
    }

    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(TRANSACTION_COOKIE_NAME));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const decrypted = Buffer.concat([
      decipher.update(sealed.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    const transaction = transactionSchema.parse(JSON.parse(decrypted));

    return transaction.expiresAt > now.getTime() ? transaction : null;
  } catch {
    return null;
  }
}

function matchesState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function callbackUrl(request: Request, configuredCallbackUrl: URL): URL {
  const current = new URL(configuredCallbackUrl);
  const queryStart = request.originalUrl.indexOf("?");
  current.search =
    queryStart === -1 ? "" : request.originalUrl.slice(queryStart);
  return current;
}

export function registerAuthRoutes(
  app: Express,
  dependencies: AuthDependencies,
): void {
  if (dependencies.callbackUrl.origin !== dependencies.appOrigin.origin) {
    throw new Error("The Google callback URL must use the application origin");
  }
  if (dependencies.transactionSecret.length < 32) {
    throw new Error(
      "The auth transaction secret must be at least 32 characters",
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const requestRateLimiter =
    dependencies.requestRateLimiter ?? new RequestRateLimiter();

  app.use(["/auth", "/api"], (_request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.use("/api", requireSession({ store: dependencies.store, now }));

  app.get(
    "/auth/google",
    rateLimit(requestRateLimiter, "sign-in", DEFAULT_RATE_LIMITS.signIn, now),
    async (request, response) => {
      const parsed = GoogleAuthRequestSchema.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: "invalid_request",
            category: "terminal",
            message: "The sign-in request is invalid.",
          },
        });
        return;
      }

      try {
        const authorization =
          await dependencies.oidcProvider.createAuthorizationRequest(
            dependencies.callbackUrl,
          );
        const currentTime = now();
        const transaction = sealTransaction(
          {
            codeVerifier: authorization.codeVerifier,
            nonce: authorization.nonce,
            returnTo: parsed.data.returnTo ?? "/",
            state: authorization.state,
            expiresAt: currentTime.getTime() + TRANSACTION_LIFETIME_MS,
          },
          dependencies.transactionSecret,
        );

        response.cookie(TRANSACTION_COOKIE_NAME, transaction, {
          httpOnly: true,
          maxAge: TRANSACTION_LIFETIME_MS,
          path: TRANSACTION_COOKIE_PATH,
          sameSite: "lax",
          secure: true,
        });
        response.redirect(302, authorization.location.href);
      } catch {
        response.status(503).json({
          error: {
            code: "provider_unavailable",
            category: "retryable",
            message: "Google sign-in is temporarily unavailable.",
          },
        });
      }
    },
  );

  app.get("/auth/google/callback", async (request, response) => {
    const transactionCookie = readCookie(request, TRANSACTION_COOKIE_NAME);
    response.clearCookie(TRANSACTION_COOKIE_NAME, {
      httpOnly: true,
      path: TRANSACTION_COOKIE_PATH,
      sameSite: "lax",
      secure: true,
    });

    const parsed = GoogleAuthCallbackRequestSchema.safeParse(request.query);
    const transaction = transactionCookie
      ? openTransaction(
          transactionCookie,
          dependencies.transactionSecret,
          now(),
        )
      : null;
    if (
      !parsed.success ||
      !transaction ||
      !matchesState(parsed.data.state, transaction.state) ||
      "error" in parsed.data
    ) {
      response.status(400).json({
        error: {
          code: "provider_response_invalid",
          category: "terminal",
          message: "Google sign-in could not be verified. Please try again.",
        },
      });
      return;
    }

    try {
      const identity =
        await dependencies.oidcProvider.exchangeAuthorizationCode(
          callbackUrl(request, dependencies.callbackUrl),
          {
            codeVerifier: transaction.codeVerifier,
            nonce: transaction.nonce,
            state: transaction.state,
          },
        );
      const currentTime = now();
      const expiresAt = new Date(currentTime.getTime() + SESSION_LIFETIME_MS);
      const sessionToken = randomBytes(32).toString("base64url");
      await dependencies.store.createSession(
        identity,
        hashSessionToken(sessionToken),
        expiresAt,
        currentTime,
      );

      response.cookie(SESSION_COOKIE_NAME, sessionToken, {
        expires: expiresAt,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: true,
      });
      response.redirect(302, transaction.returnTo);
    } catch {
      response.status(400).json({
        error: {
          code: "provider_response_invalid",
          category: "terminal",
          message: "Google sign-in could not be verified. Please try again.",
        },
      });
    }
  });

  app.get("/api/me", (request, response) => {
    response.json({ user: authenticatedUser(request) });
  });

  app.post("/auth/logout", async (request, response) => {
    if (request.get("origin") !== dependencies.appOrigin.origin) {
      response.status(403).json({
        error: {
          code: "access_denied",
          category: "authorization",
          message: "The sign-out request origin is not allowed.",
        },
      });
      return;
    }

    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    try {
      if (sessionToken) {
        await dependencies.store.revokeSession(
          hashSessionToken(sessionToken),
          now(),
        );
      }
      clearSessionCookie(response);
      response.json({ signedOut: true });
    } catch {
      response.status(503).json({
        error: {
          code: "provider_unavailable",
          category: "retryable",
          message: "Sign-out is temporarily unavailable.",
        },
      });
    }
  });
}
