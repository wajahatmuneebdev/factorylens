import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from http.client import HTTPConnection
from threading import Thread
from uuid import UUID, uuid4

import pytest

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import JobLease, LeaseDecision, LeaseOutcome
from factorylens_worker.server import WorkerHandler, WorkerServer, health_payload
from factorylens_worker.task_execution import TaskExecutionOutcome

VALID_TASK = {
    "correlationId": "018f4f72-3d3a-7c1c-b10b-f2a7c849e831",
    "jobId": "018f4f72-3d3a-7c1c-b10b-f2a7c849e831",
    "dispatchGeneration": 2,
}


class FakeLeaseStore:
    def __init__(self, outcome: LeaseOutcome) -> None:
        self.outcome = outcome
        self.messages: list[ProcessTaskMessage] = []

    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        self.messages.append(message)
        lease = None
        if self.outcome is LeaseOutcome.ACQUIRED:
            lease = JobLease(
                job_id=message.jobId,
                inspection_id=uuid4(),
                dispatch_generation=message.dispatchGeneration,
                attempt_count=1,
                max_attempts=3,
                token=uuid4(),
                expires_at=datetime.now(UTC) + timedelta(minutes=5),
                correlation_id=message.correlationId,
            )
        return LeaseDecision(self.outcome, lease)


class FailingLeaseStore(FakeLeaseStore):
    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        raise RuntimeError("simulated database failure")


class CompletedAfterFirstDeliveryStore(FakeLeaseStore):
    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        decision = super().acquire(message)
        self.outcome = LeaseOutcome.TERMINAL
        return decision


class FakeExecutor:
    def __init__(
        self, outcome: TaskExecutionOutcome = TaskExecutionOutcome.ACKNOWLEDGED
    ) -> None:
        self.outcome = outcome
        self.leases: list[JobLease] = []

    def execute(self, lease: JobLease) -> TaskExecutionOutcome:
        self.leases.append(lease)
        return self.outcome


class FakeIdentityVerifier:
    def verify(self, token: str) -> bool:
        return token == "valid-service-token"


@contextmanager
def running_server(
    store: FakeLeaseStore, executor: FakeExecutor
) -> Iterator[tuple[str, int]]:
    server = WorkerServer(("127.0.0.1", 0), WorkerHandler)
    server.lease_store = store
    server.executor = executor
    server.identity_verifier = FakeIdentityVerifier()
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
    executor: FakeExecutor | None = None,
    authorization: str | None = "Bearer valid-service-token",
    cookie: str | None = None,
) -> tuple[int, dict[str, str], bytes]:
    body = json.dumps(payload).encode()
    with running_server(store, executor or FakeExecutor()) as (host, port):
        connection = HTTPConnection(host, port)
        headers = {"Content-Type": content_type}
        if authorization is not None:
            headers["Authorization"] = authorization
        if cookie is not None:
            headers["Cookie"] = cookie
        connection.request(
            "POST",
            "/internal/tasks/process",
            body=body,
            headers=headers,
        )
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result


def test_health_payload() -> None:
    assert json.loads(health_payload()) == {"service": "worker", "status": "ok"}


def test_task_endpoint_validates_and_acquires_only_the_task_contract() -> None:
    store = FakeLeaseStore(LeaseOutcome.ACQUIRED)
    executor = FakeExecutor()

    status, _, body = post_task(store, VALID_TASK, executor=executor)

    assert status == 204
    assert body == b""
    assert len(executor.leases) == 1
    assert executor.leases[0].correlation_id == UUID(str(VALID_TASK["correlationId"]))
    assert [message.model_dump(mode="json") for message in store.messages] == [
        VALID_TASK
    ]

    status, _, body = post_task(store, {**VALID_TASK, "inspectionId": "not-allowed"})

    assert status == 400
    assert json.loads(body) == {"error": "invalid_task_payload"}
    assert len(store.messages) == 1


def test_task_endpoint_returns_retryable_failure_after_persisted_retry() -> None:
    executor = FakeExecutor(TaskExecutionOutcome.RETRY)

    status, headers, body = post_task(
        FakeLeaseStore(LeaseOutcome.ACQUIRED), VALID_TASK, executor=executor
    )

    assert status == 503
    assert headers["Retry-After"] == "10"
    assert json.loads(body) == {"error": "processing_retry_scheduled"}


def test_response_loss_redelivery_acknowledges_without_reprocessing() -> None:
    store = CompletedAfterFirstDeliveryStore(LeaseOutcome.ACQUIRED)
    executor = FakeExecutor()

    first_status, _, _ = post_task(store, VALID_TASK, executor=executor)
    redelivery_status, _, redelivery_body = post_task(
        store, VALID_TASK, executor=executor
    )

    assert first_status == 204
    assert redelivery_status == 204
    assert redelivery_body == b""
    assert len(executor.leases) == 1


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


@pytest.mark.parametrize(
    ("authorization", "cookie"),
    [
        (None, None),
        ("Bearer invalid", None),
        (
            "Bearer valid-service-token",
            "__Host-factorylens_session=browser-token",
        ),
    ],
)
def test_task_endpoint_requires_service_identity_and_rejects_browser_sessions(
    authorization: str | None, cookie: str | None
) -> None:
    store = FakeLeaseStore(LeaseOutcome.ACQUIRED)

    status, _, body = post_task(
        store,
        VALID_TASK,
        authorization=authorization,
        cookie=cookie,
    )

    assert status == 401
    assert json.loads(body) == {"error": "authentication_required"}
    assert store.messages == []


def test_task_endpoint_retries_database_failures() -> None:
    status, _, body = post_task(FailingLeaseStore(LeaseOutcome.ACQUIRED), VALID_TASK)

    assert status == 503
    assert json.loads(body) == {"error": "database_unavailable"}
