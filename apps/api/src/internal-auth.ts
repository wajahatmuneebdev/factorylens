import { OAuth2Client } from "google-auth-library";

export interface InternalIdentityVerifier {
  verify(token: string): Promise<boolean>;
}

export class GoogleServiceIdentityVerifier implements InternalIdentityVerifier {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly audience: string,
    private readonly serviceAccountEmail: string,
  ) {}

  async verify(token: string): Promise<boolean> {
    try {
      const ticket = await this.client.verifyIdToken({
        audience: this.audience,
        idToken: token,
      });
      const payload = ticket.getPayload();
      return (
        payload?.email === this.serviceAccountEmail &&
        payload.email_verified === true
      );
    } catch {
      return false;
    }
  }
}
