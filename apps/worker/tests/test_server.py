import json

from factorylens_worker.server import health_payload


def test_health_payload() -> None:
    assert json.loads(health_payload()) == {"service": "worker", "status": "ok"}
