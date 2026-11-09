import { generateKeyPairSync, sign } from "node:crypto";

import { Configuration, customFetch, type ServerMetadata } from "openid-client";
import { describe, expect, it } from "vitest";

import { GoogleOidcProvider } from "../src/google-oidc.js";

const issuer = "https://accounts.google.test";
const clientId = "factorylens-client";
const clientSecret = "factorylens-client-secret";
const nonce = "nonce-0000000000000000";
const state = "state-0000000000000000";
const codeVerifier = "v".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = publicKey.export({ format: "jwk" });

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", kid: "fake-key", typ: "JWT" });
  const payload = encodeJson({
    iss: issuer,
    aud: clientId,
    sub: "stable-google-subject",
    email: "owner@example.com",
    email_verified: true,
    name: "Factory Owner",
    iat: now,
    exp: now + 300,
    nonce,
    ...overrides,
  });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function fakeProvider(token: string): {
  provider: GoogleOidcProvider;
  tokenRequest: () => URLSearchParams | null;
} {
  const server: ServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    id_token_signing_alg_values_supported: ["RS256"],
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
  const configuration = new Configuration(server, clientId, clientSecret);
  let receivedTokenRequest: URLSearchParams | null = null;
  configuration[customFetch] = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === `${issuer}/token`) {
      receivedTokenRequest = new URLSearchParams(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "fake-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: token,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${issuer}/jwks`) {
      return new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: "RS256", kid: "fake-key", use: "sig" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fake provider request: ${url}`);
  };

  return {
    provider: new GoogleOidcProvider(configuration),
    tokenRequest: () => receivedTokenRequest,
  };
}

function callbackUrl(): URL {
  return new URL(
    `https://factorylens.example/auth/google/callback?code=fake-code&state=${state}`,
  );
}

describe("Google OIDC validation against a fake provider", () => {
  it("accepts a valid response and sends the PKCE verifier", async () => {
    const fake = fakeProvider(idToken());

    await expect(
      fake.provider.exchangeAuthorizationCode(callbackUrl(), {
        codeVerifier,
        nonce,
        state,
      }),
    ).resolves.toMatchObject({
      email: "owner@example.com",
      googleSubject: "stable-google-subject",
    });
    expect(fake.tokenRequest()?.get("code_verifier")).toBe(codeVerifier);
    expect(fake.tokenRequest()?.get("client_secret")).toBe(clientSecret);
  });

  it.each([
    ["issuer", { iss: "https://attacker.example" }],
    ["audience", { aud: "another-client" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["nonce", { nonce: "another-nonce" }],
  ])("rejects an invalid %s", async (_name, overrides) => {
    const fake = fakeProvider(idToken(overrides));

    await expect(
      fake.provider.exchangeAuthorizationCode(callbackUrl(), {
        codeVerifier,
        nonce,
        state,
      }),
    ).rejects.toThrow();
  });
});
