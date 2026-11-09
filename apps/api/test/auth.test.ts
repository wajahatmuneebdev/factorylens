import { createHash } from "node:crypto";

import type { User } from "@factorylens/contracts";
import request, { type Response } from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type {
  AuthStore,
  OidcAuthorizationRequest,
  OidcIdentity,
  OidcProvider,
} from "../src/auth.js";

const appOrigin = new URL("https://factorylens.example");
const callbackUrl = new URL("/auth/google/callback", appOrigin);
const currentTime = new Date("2026-11-09T08:00:00.000Z");
const state = "test-state-value-000000000000000";
const nonce = "test-nonce-value-000000000000000";
const codeVerifier = "v".repeat(64);
const identity: OidcIdentity = {
  avatarUrl: "https://images.example/avatar.png",
  displayName: "Factory Owner",
  email: "owner@example.com",
  googleSubject: "google-subject-stable-1",
};
const user: User = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  avatarUrl: identity.avatarUrl,
  displayName: identity.displayName,
  email: identity.email,
};

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookiePair(setCookie: string[], name: string): string {
  const cookie = setCookie.find((value) => value.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Missing ${name} cookie`);
  }
  return cookie.split(";", 1)[0]!;
}

function setCookies(response: Response): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [header] : [];
}

class FakeOidcProvider implements OidcProvider {
  readonly createAuthorizationRequest = vi.fn(
    async (receivedCallbackUrl: URL): Promise<OidcAuthorizationRequest> => {
      const location = new URL("https://accounts.google.test/authorize");
      location.searchParams.set("redirect_uri", receivedCallbackUrl.href);
      location.searchParams.set("response_type", "code");
      location.searchParams.set("scope", "openid email profile");
      location.searchParams.set("code_challenge", "fake-code-challenge");
      location.searchParams.set("code_challenge_method", "S256");
      location.searchParams.set("state", state);
      location.searchParams.set("nonce", nonce);
      return { codeVerifier, location, nonce, state };
    },
  );

  readonly exchangeAuthorizationCode = vi.fn(
    async (): Promise<OidcIdentity> => identity,
  );
}

class FakeAuthStore implements AuthStore {
  readonly sessions = new Map<
    string,
    { expiresAt: Date; revokedAt: Date | null; user: User }
  >();

  readonly createSession = vi.fn(
    async (
      receivedIdentity: OidcIdentity,
      tokenHash: string,
      expiresAt: Date,
    ): Promise<User> => {
      expect(receivedIdentity).toEqual(identity);
      this.sessions.set(tokenHash, { expiresAt, revokedAt: null, user });
      return user;
    },
  );

  readonly findActiveUser = vi.fn(
    async (tokenHash: string, now: Date): Promise<User | null> => {
      const session = this.sessions.get(tokenHash);
      return session && !session.revokedAt && session.expiresAt > now
        ? session.user
        : null;
    },
  );

  readonly revokeSession = vi.fn(
    async (tokenHash: string, now: Date): Promise<void> => {
      const session = this.sessions.get(tokenHash);
      if (session) {
        session.revokedAt = now;
      }
    },
  );
}

describe("Google sign-in and FactoryLens sessions", () => {
  let oidcProvider: FakeOidcProvider;
  let store: FakeAuthStore;

  beforeEach(() => {
    oidcProvider = new FakeOidcProvider();
    store = new FakeAuthStore();
  });

  function authApp() {
    return createApp({
      appOrigin,
      callbackUrl,
      now: () => new Date(currentTime),
      oidcProvider,
      store,
      transactionSecret: "test-transaction-secret-with-32-characters",
    });
  }

  async function signIn() {
    const start = await request(authApp())
      .get("/auth/google")
      .query({ returnTo: "/history" });
    const transactionCookie = cookiePair(setCookies(start), "factorylens_oidc");
    const callback = await request(authApp())
      .get("/auth/google/callback")
      .query({ code: "fake-authorization-code", state })
      .set("Cookie", transactionCookie);
    const sessionCookie = cookiePair(
      setCookies(callback),
      "__Host-factorylens_session",
    );
    return { callback, sessionCookie, start };
  }

  it("binds PKCE, state, and nonce to the callback and stores only a session hash", async () => {
    const { callback, sessionCookie, start } = await signIn();

    expect(start.status).toBe(302);
    expect(start.headers["cache-control"]).toBe("no-store");
    expect(start.headers["referrer-policy"]).toBe("no-referrer");
    const authorizationUrl = new URL(start.headers.location);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
    expect(authorizationUrl.searchParams.get("nonce")).toBe(nonce);
    expect(setCookies(start)[0]).toContain("HttpOnly");
    expect(setCookies(start)[0]).toContain("Secure");
    expect(setCookies(start)[0]).toContain("SameSite=Lax");

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/history");
    expect(oidcProvider.exchangeAuthorizationCode).toHaveBeenCalledWith(
      new URL(
        `${callbackUrl.href}?code=fake-authorization-code&state=${state}`,
      ),
      { codeVerifier, nonce, state },
    );

    const sessionToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
    expect(sessionToken).toHaveLength(43);
    expect(store.createSession).toHaveBeenCalledWith(
      identity,
      hash(sessionToken),
      new Date("2026-12-09T08:00:00.000Z"),
      currentTime,
    );
    expect(store.createSession.mock.calls[0]![1]).not.toContain(sessionToken);

    const sessionSetCookie = setCookies(callback).find((cookie) =>
      cookie.startsWith("__Host-factorylens_session="),
    );
    expect(sessionSetCookie).toContain("HttpOnly");
    expect(sessionSetCookie).toContain("Secure");
    expect(sessionSetCookie).toContain("SameSite=Lax");
    expect(sessionSetCookie).toContain("Path=/");
  });

  it("returns the current profile and rejects expired sessions", async () => {
    const { sessionCookie } = await signIn();

    const authenticated = await request(authApp())
      .get("/api/me")
      .set("Cookie", sessionCookie);
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toEqual({ user });

    const sessionToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
    store.sessions.get(hash(sessionToken))!.expiresAt = currentTime;
    const expired = await request(authApp())
      .get("/api/me")
      .set("Cookie", sessionCookie);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("authentication_required");
    expect(setCookies(expired)[0]).toContain("__Host-factorylens_session=;");
  });

  it("rejects a callback whose state does not match before provider exchange", async () => {
    const start = await request(authApp()).get("/auth/google");
    const transactionCookie = cookiePair(setCookies(start), "factorylens_oidc");

    const callback = await request(authApp())
      .get("/auth/google/callback")
      .query({
        code: "fake-authorization-code",
        state: "wrong-state-value-000000",
      })
      .set("Cookie", transactionCookie);

    expect(callback.status).toBe(400);
    expect(callback.body.error.code).toBe("provider_response_invalid");
    expect(oidcProvider.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(setCookies(callback)[0]).toContain("factorylens_oidc=;");
  });

  it("revokes logout sessions and rejects cross-origin logout", async () => {
    const { sessionCookie } = await signIn();

    const denied = await request(authApp())
      .post("/auth/logout")
      .set("Cookie", sessionCookie)
      .set("Origin", "https://attacker.example");
    expect(denied.status).toBe(403);
    expect(store.revokeSession).not.toHaveBeenCalled();

    const logout = await request(authApp())
      .post("/auth/logout")
      .set("Cookie", sessionCookie)
      .set("Origin", appOrigin.origin);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ signedOut: true });

    const sessionToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
    expect(store.revokeSession).toHaveBeenCalledWith(
      hash(sessionToken),
      currentTime,
    );
    expect(setCookies(logout)[0]).toContain("__Host-factorylens_session=;");

    const revoked = await request(authApp())
      .get("/api/me")
      .set("Cookie", sessionCookie);
    expect(revoked.status).toBe(401);
  });
});
