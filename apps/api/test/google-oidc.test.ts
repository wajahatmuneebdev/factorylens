import { beforeEach, describe, expect, it, vi } from "vitest";

const openidMocks = vi.hoisted(() => ({
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  discovery: vi.fn(),
  randomNonce: vi.fn(),
  randomPKCECodeVerifier: vi.fn(),
  randomState: vi.fn(),
}));

vi.mock("openid-client", () => openidMocks);

import { GoogleOidcProvider } from "../src/google-oidc.js";

describe("GoogleOidcProvider", () => {
  const configuration = { client: "fake-configuration" };
  const callbackUrl = new URL(
    "https://factorylens.example/auth/google/callback",
  );

  beforeEach(() => {
    vi.clearAllMocks();
    openidMocks.randomPKCECodeVerifier.mockReturnValue("v".repeat(64));
    openidMocks.randomNonce.mockReturnValue("nonce-0000000000000000");
    openidMocks.randomState.mockReturnValue("state-0000000000000000");
    openidMocks.calculatePKCECodeChallenge.mockResolvedValue("challenge");
    openidMocks.buildAuthorizationUrl.mockReturnValue(
      new URL("https://accounts.google.com/o/oauth2/v2/auth"),
    );
  });

  it("builds an authorization request with PKCE, state, and nonce", async () => {
    const provider = new GoogleOidcProvider(configuration as never);

    await expect(
      provider.createAuthorizationRequest(callbackUrl),
    ).resolves.toMatchObject({
      codeVerifier: "v".repeat(64),
      nonce: "nonce-0000000000000000",
      state: "state-0000000000000000",
    });
    expect(openidMocks.buildAuthorizationUrl).toHaveBeenCalledWith(
      configuration,
      {
        redirect_uri: callbackUrl.href,
        scope: "openid email profile",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        nonce: "nonce-0000000000000000",
        state: "state-0000000000000000",
      },
    );
  });

  it("requires a validated ID token and passes every callback check", async () => {
    openidMocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: "stable-google-subject",
        email: "owner@example.com",
        email_verified: true,
        name: "Factory Owner",
        picture: "https://images.example/avatar.png",
      }),
    });
    const provider = new GoogleOidcProvider(configuration as never);

    await expect(
      provider.exchangeAuthorizationCode(callbackUrl, {
        codeVerifier: "v".repeat(64),
        nonce: "nonce-0000000000000000",
        state: "state-0000000000000000",
      }),
    ).resolves.toEqual({
      avatarUrl: "https://images.example/avatar.png",
      displayName: "Factory Owner",
      email: "owner@example.com",
      googleSubject: "stable-google-subject",
    });
    expect(openidMocks.authorizationCodeGrant).toHaveBeenCalledWith(
      configuration,
      callbackUrl,
      {
        expectedNonce: "nonce-0000000000000000",
        expectedState: "state-0000000000000000",
        idTokenExpected: true,
        pkceCodeVerifier: "v".repeat(64),
      },
    );
  });

  it("rejects unverified provider identity claims", async () => {
    openidMocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: "stable-google-subject",
        email: "owner@example.com",
        email_verified: false,
        name: "Factory Owner",
      }),
    });
    const provider = new GoogleOidcProvider(configuration as never);

    await expect(
      provider.exchangeAuthorizationCode(callbackUrl, {
        codeVerifier: "v".repeat(64),
        nonce: "nonce-0000000000000000",
        state: "state-0000000000000000",
      }),
    ).rejects.toThrow();
  });
});
