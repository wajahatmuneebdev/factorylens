import type { NextFunction, Request, RequestHandler, Response } from "express";

import { authenticatedUser, SESSION_COOKIE_NAME } from "./session.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|session|token|signed.?url|prediction/i;
const SIGNED_URL_PARAMETER =
  /^(?:x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|signature|token)$/i;

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

export const DEFAULT_RATE_LIMITS = {
  inspectionCreation: { limit: 10, windowMs: 60_000 },
  inspectionRetry: { limit: 5, windowMs: 15 * 60_000 },
  signIn: { limit: 10, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

export class RequestRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();
  private lastCleanupAt = 0;

  consume(
    bucket: string,
    key: string,
    policy: RateLimitPolicy,
    now: Date,
  ): { allowed: boolean; remaining: number; resetAt: Date } {
    const mapKey = `${bucket}:${key}`;
    const timestamp = now.getTime();
    if (timestamp - this.lastCleanupAt >= 60_000) {
      for (const [existingKey, existingWindow] of this.windows) {
        if (timestamp >= existingWindow.resetAt) {
          this.windows.delete(existingKey);
        }
      }
      this.lastCleanupAt = timestamp;
    }
    let window = this.windows.get(mapKey);
    if (!window || timestamp >= window.resetAt) {
      window = { count: 0, resetAt: timestamp + policy.windowMs };
      this.windows.set(mapKey, window);
    }
    window.count += 1;

    return {
      allowed: window.count <= policy.limit,
      remaining: Math.max(0, policy.limit - window.count),
      resetAt: new Date(window.resetAt),
    };
  }
}

function rateLimitKey(request: Request, authenticated: boolean): string {
  if (authenticated) {
    return `user:${authenticatedUser(request).id}`;
  }
  return `ip:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`;
}

export function rateLimit(
  limiter: RequestRateLimiter,
  bucket: string,
  policy: RateLimitPolicy,
  now: () => Date,
  authenticated = false,
): RequestHandler {
  return (request, response, next) => {
    const currentTime = now();
    const result = limiter.consume(
      bucket,
      rateLimitKey(request, authenticated),
      policy,
      currentTime,
    );
    const resetAfterSeconds = Math.max(
      1,
      Math.ceil((result.resetAt.getTime() - currentTime.getTime()) / 1000),
    );
    response.set({
      "RateLimit-Limit": String(policy.limit),
      "RateLimit-Remaining": String(result.remaining),
      "RateLimit-Reset": String(resetAfterSeconds),
    });
    if (!result.allowed) {
      response.set("Retry-After", String(resetAfterSeconds));
      response.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          category: "retryable",
          message: "Too many requests. Please try again later.",
        },
      });
      return;
    }
    next();
  };
}

export function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.set({
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'self'; connect-src 'self' https:; frame-ancestors 'none'; img-src 'self' data: https:; media-src 'self' blob: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

export function browserCsrfProtection(appOrigin: URL): RequestHandler {
  return (request, response, next) => {
    if (
      request.method === "GET" ||
      request.method === "HEAD" ||
      request.method === "OPTIONS" ||
      (!request.path.startsWith("/api/") && request.path !== "/auth/logout")
    ) {
      next();
      return;
    }

    const sameOrigin = request.get("origin") === appOrigin.origin;
    const fetchSite = request.get("sec-fetch-site");
    if (
      !sameOrigin ||
      (fetchSite !== undefined && fetchSite !== "same-origin")
    ) {
      response.status(403).json({
        error: {
          code: "access_denied",
          category: "authorization",
          message: "The request origin is not allowed.",
        },
      });
      return;
    }
    next();
  };
}

export function rejectBrowserSession(request: Request): boolean {
  return (request.get("cookie") ?? "").split(";").some((entry) => {
    return entry.trim().startsWith(`${SESSION_COOKIE_NAME}=`);
  });
}

export function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      let redacted = false;
      for (const key of [...url.searchParams.keys()]) {
        if (SIGNED_URL_PARAMETER.test(key)) {
          url.searchParams.set(key, REDACTED);
          redacted = true;
        }
      }
      return redacted ? url.toString() : value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactLogValue(entry),
      ]),
    );
  }
  return value;
}

export function writeStructuredLog(
  level: "error" | "info",
  event: string,
  context: Record<string, unknown> = {},
): void {
  const entry = JSON.stringify(redactLogValue({ event, level, ...context }));
  if (level === "error") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}
