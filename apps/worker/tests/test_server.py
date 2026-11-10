import json
from collections.abc import Iterator
from contextlib import contextmanager
from http.client import HTTPConnection
from threading import Thread

import pytest

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import LeaseDecision, LeaseOutcome
from factorylens_worker.server import WorkerHandler, WorkerServer, health_payload

VALID_TASK = {
    "jobId": "018f4f72-3d3a-7c1c-b10b-f2a7c849e831",
    "dispatchGeneration": 2,
}


class FakeLeaseStore:
    def __init__(self, outcome: LeaseOutcome) -> None:
        self.outcome = outcome
        self.messages: list[ProcessTaskMessage] = []

    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        self.messages.append(message)
        return LeaseDecision(self.outcome)


class FailingLeaseStore(FakeLeaseStore):
    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        raise RuntimeError("simulated database failure")


@contextmanager
def running_server(store: FakeLeaseStore) -> Iterator[tuple[str, int]]:
    server = WorkerServer(("127.0.0.1", 0), WorkerHandler)
    server.lease_store = store
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        address = server.server_address
        yield str(address[0]), int(address[1])
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def post_task(
    store: FakeLeaseStore,
    payload: object,
    content_type: str = "application/json",
) -> tuple[int, dict[str, str], bytes]:
    body = json.dumps(payload).encode()
    with running_server(store) as (host, port):
        connection = HTTPConnection(host, port)
        connection.request(
            "POST",
            "/internal/tasks/process",
            body=body,
            headers={"Content-Type": content_type},
        )
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result


def test_health_payload() -> None:
    assert json.loads(health_payload()) == {"service": "worker", "status": "ok"}


def test_task_endpoint_validates_and_acquires_only_the_task_contract() -> None:
    store = FakeLeaseStore(LeaseOutcome.ACQUIRED)

    status, _, body = post_task(store, VALID_TASK)

    assert status == 202
    assert json.loads(body) == {"outcome": "acquired"}
    assert [message.model_dump(mode="json") for message in store.messages] == [
        VALID_TASK
    ]

    status, _, body = post_task(store, {**VALID_TASK, "inspectionId": "not-allowed"})

    assert status == 400
    assert json.loads(body) == {"error": "invalid_task_payload"}
    assert len(store.messages) == 1


@pytest.mark.parametrize(
    ("outcome", "expected_status", "expected_error"),
    [
        (LeaseOutcome.TERMINAL, 204, None),
        (LeaseOutcome.BUSY, 503, "lease_conflict"),
        (LeaseOutcome.GENERATION_MISMATCH, 409, "dispatch_generation_mismatch"),
        (LeaseOutcome.NOT_FOUND, 404, "job_not_found"),
        (LeaseOutcome.INELIGIBLE, 409, "job_not_eligible"),
    ],
)
def test_task_endpoint_maps_lease_decisions(
    outcome: LeaseOutcome, expected_status: int, expected_error: str | None
) -> None:
    status, headers, body = post_task(FakeLeaseStore(outcome), VALID_TASK)

    assert status == expected_status
    if expected_error is None:
        assert body == b""
    else:
        assert json.loads(body) == {"error": expected_error}
    if outcome is LeaseOutcome.BUSY:
        assert headers["Retry-After"] == "10"


def test_task_endpoint_requires_json() -> None:
    store = FakeLeaseStore(LeaseOutcome.ACQUIRED)

    status, _, body = post_task(store, VALID_TASK, content_type="text/plain")

    assert status == 415
    assert json.loads(body) == {"error": "content_type_must_be_json"}
    assert store.messages == []


def test_task_endpoint_retries_database_failures() -> None:
    status, _, body = post_task(FailingLeaseStore(LeaseOutcome.ACQUIRED), VALID_TASK)

    assert status == 503
    assert json.loads(body) == {"error": "database_unavailable"}
