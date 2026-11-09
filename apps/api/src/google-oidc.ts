import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";
import { z } from "zod";

import type {
  OidcAuthorizationRequest,
  OidcIdentity,
  OidcProvider,
} from "./auth.js";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");

const googleClaimsSchema = z
  .object({
    sub: z.string().min(1).max(255),
    email: z.email().max(320),
    email_verified: z.literal(true),
    name: z.string().trim().min(1).optional(),
    picture: z.url().max(2048).optional(),
  })
  .loose();

function displayName(name: string | undefined, email: string): string {
  const candidate = name ?? email.split("@")[0] ?? "FactoryLens user";
  return Array.from(candidate.trim()).slice(0, 120).join("");
}

export class GoogleOidcProvider implements OidcProvider {
  constructor(private readonly configuration: Configuration) {}

  async createAuthorizationRequest(
    callbackUrl: URL,
  ): Promise<OidcAuthorizationRequest> {
    const codeVerifier = randomPKCECodeVerifier();
    const nonce = randomNonce();
    const state = randomState();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const location = buildAuthorizationUrl(this.configuration, {
      redirect_uri: callbackUrl.href,
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      nonce,
      state,
    });

    return { codeVerifier, location, nonce, state };
  }

  async exchangeAuthorizationCode(
    callbackUrl: URL,
    expected: Pick<
      OidcAuthorizationRequest,
      "codeVerifier" | "nonce" | "state"
    >,
  ): Promise<OidcIdentity> {
    const tokens = await authorizationCodeGrant(
      this.configuration,
      callbackUrl,
      {
        expectedNonce: expected.nonce,
        expectedState: expected.state,
        idTokenExpected: true,
        pkceCodeVerifier: expected.codeVerifier,
      },
    );
    const claims = googleClaimsSchema.parse(tokens.claims());

    return {
      avatarUrl: claims.picture ?? null,
      displayName: displayName(claims.name, claims.email),
      email: claims.email,
      googleSubject: claims.sub,
    };
  }
}

export async function createGoogleOidcProvider(
  clientId: string,
  clientSecret: string,
): Promise<GoogleOidcProvider> {
  const configuration = await discovery(GOOGLE_ISSUER, clientId, clientSecret);
  return new GoogleOidcProvider(configuration);
}
