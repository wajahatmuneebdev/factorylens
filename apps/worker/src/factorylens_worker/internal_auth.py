from typing import Any

from google.auth.transport.requests import Request
from google.oauth2 import id_token


class GoogleServiceIdentityVerifier:
    """Verify a Google-signed OIDC token for one configured service identity."""

    def __init__(self, audience: str, service_account_email: str) -> None:
        self._audience = audience
        self._service_account_email = service_account_email
        self._request = Request()

    def verify(self, token: str) -> bool:
        try:
            claims: dict[str, Any] = id_token.verify_oauth2_token(  # type: ignore[no-untyped-call]
                token,
                self._request,
                self._audience,
            )
        except (ValueError, OSError):
            return False

        return (
            claims.get("email") == self._service_account_email
            and claims.get("email_verified") is True
        )
