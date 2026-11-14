from typing import Any

import pytest
from google.oauth2 import id_token

from factorylens_worker import internal_auth


def test_google_service_identity_requires_verified_configured_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: dict[str, Any] = {}

    def verify(token: str, request: object, audience: str) -> dict[str, Any]:
        received.update(token=token, request=request, audience=audience)
        return {
            "email": "tasks@project.iam.gserviceaccount.com",
            "email_verified": True,
        }

    monkeypatch.setattr(id_token, "verify_oauth2_token", verify)
    verifier = internal_auth.GoogleServiceIdentityVerifier(
        "https://worker.example",
        "tasks@project.iam.gserviceaccount.com",
    )

    assert verifier.verify("signed-token") is True
    assert received["token"] == "signed-token"
    assert received["audience"] == "https://worker.example"


@pytest.mark.parametrize(
    "claims",
    [
        {"email": "attacker@project.iam.gserviceaccount.com", "email_verified": True},
        {"email": "tasks@project.iam.gserviceaccount.com", "email_verified": False},
    ],
)
def test_google_service_identity_rejects_wrong_or_unverified_email(
    monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any]
) -> None:
    monkeypatch.setattr(
        id_token,
        "verify_oauth2_token",
        lambda *_args: claims,
    )
    verifier = internal_auth.GoogleServiceIdentityVerifier(
        "https://worker.example",
        "tasks@project.iam.gserviceaccount.com",
    )

    assert verifier.verify("signed-token") is False


def test_google_service_identity_rejects_invalid_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject(*_args: object) -> dict[str, Any]:
        raise ValueError("invalid signature")

    monkeypatch.setattr(id_token, "verify_oauth2_token", reject)
    verifier = internal_auth.GoogleServiceIdentityVerifier(
        "https://worker.example",
        "tasks@project.iam.gserviceaccount.com",
    )

    assert verifier.verify("invalid-token") is False
