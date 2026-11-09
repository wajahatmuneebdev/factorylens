import { createHash } from "node:crypto";

import type { SafeError, User } from "@factorylens/contracts";
import type { Request, RequestHandler, Response } from "express";

export const SESSION_COOKIE_NAME = "__Host-factorylens_session";

export interface SessionStore {
  findActiveUser(tokenHash: string, now: Date): Promise<User | null>;
}

export interface SessionDependencies {
  store: SessionStore;
  now?: () => Date;
}

const authenticatedUserKey = Symbol("authenticatedUser");
type SessionRequest = Request & { [authenticatedUserKey]?: User };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.get("cookie");
  if (!header) {
    return null;
  }

  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1 || entry.slice(0, separator).trim() !== name) {
      continue;
    }

    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

function sendSafeError(
  response: Response,
  status: number,
  error: SafeError,
): void {
  response.status(status).json({ error });
}

function sendAuthenticationRequired(response: Response): void {
  sendSafeError(response, 401, {
    code: "authentication_required",
    category: "authorization",
    message: "Sign in to continue.",
  });
}

export function requireSession(
  dependencies: SessionDependencies,
): RequestHandler {
  const now = dependencies.now ?? (() => new Date());

  return async (request, response, next) => {
    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionToken) {
      sendAuthenticationRequired(response);
      return;
    }

    try {
      const user = await dependencies.store.findActiveUser(
        hashSessionToken(sessionToken),
        now(),
      );
      if (!user) {
        clearSessionCookie(response);
        sendAuthenticationRequired(response);
        return;
      }

      (request as SessionRequest)[authenticatedUserKey] = user;
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Authentication is temporarily unavailable.",
      });
      return;
    }

    next();
  };
}

export function authenticatedUser(request: Request): User {
  const user = (request as SessionRequest)[authenticatedUserKey];
  if (!user) {
    throw new Error("Session authorization middleware was not applied");
  }
  return user;
}
