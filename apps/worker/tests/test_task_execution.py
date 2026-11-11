from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import uuid4

from factorylens_worker.job_lease import (
    CheckpointOutcome,
    FailureOutcome,
    JobFailure,
    JobLease,
)
from factorylens_worker.task_execution import (
    ProcessingFailureError,
    TaskExecutionOutcome,
    TaskExecutor,
)


def job_lease() -> JobLease:
    return JobLease(
        job_id=uuid4(),
        inspection_id=uuid4(),
        dispatch_generation=1,
        attempt_count=1,
        max_attempts=3,
        token=uuid4(),
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )


class RecordingStore:
    def __init__(
        self,
        checkpoints: list[CheckpointOutcome] | None = None,
        failure_outcome: FailureOutcome = FailureOutcome.RETRY,
    ) -> None:
        self.checkpoints = checkpoints or [CheckpointOutcome.ACTIVE]
        self.failure_outcome = failure_outcome
        self.progress: list[tuple[str, int]] = []
        self.failures: list[JobFailure] = []

    def checkpoint(
        self, lease: JobLease, stage: str, progress_percent: int
    ) -> CheckpointOutcome:
        del lease
        self.progress.append((stage, progress_percent))
        index = min(len(self.progress) - 1, len(self.checkpoints) - 1)
        return self.checkpoints[index]

    def record_failure(self, lease: JobLease, failure: JobFailure) -> FailureOutcome:
        del lease
        self.failures.append(failure)
        return self.failure_outcome


class SuccessfulPipeline:
    def run(self, lease, *, report_progress, is_cancelled) -> None:  # type: ignore[no-untyped-def]
        del lease
        report_progress("validating_media", 5)
        assert not is_cancelled()
        report_progress("running_workflow", 40)


class FailingPipeline:
    def __init__(self, failure: JobFailure) -> None:
        self.failure = failure

    def run(self, lease, *, report_progress, is_cancelled) -> None:  # type: ignore[no-untyped-def]
        del lease, report_progress, is_cancelled
        raise ProcessingFailureError(self.failure)


class CancellationPipeline:
    called_expensive_stage = False

    def run(self, lease, *, report_progress, is_cancelled) -> None:  # type: ignore[no-untyped-def]
        del lease, is_cancelled
        report_progress("validating_media", 5)
        self.called_expensive_stage = True


class WaitingPipeline:
    def __init__(self) -> None:
        self.heartbeat_seen = Event()

    def run(self, lease, *, report_progress, is_cancelled) -> None:  # type: ignore[no-untyped-def]
        del lease, is_cancelled
        report_progress("running_workflow", 40)
        self.heartbeat_seen.wait(timeout=1)


def test_successful_pipeline_reports_lease_protected_progress() -> None:
    store = RecordingStore()

    outcome = TaskExecutor(store, SuccessfulPipeline()).execute(job_lease())

    assert outcome is TaskExecutionOutcome.ACKNOWLEDGED
    assert store.progress == [("validating_media", 5), ("running_workflow", 40)]


def test_cancellation_at_stage_boundary_skips_expensive_work() -> None:
    store = RecordingStore([CheckpointOutcome.CANCELLED])
    pipeline = CancellationPipeline()

    outcome = TaskExecutor(store, pipeline).execute(job_lease())

    assert outcome is TaskExecutionOutcome.ACKNOWLEDGED
    assert not pipeline.called_expensive_stage


def test_lease_loss_stops_further_stage_commits() -> None:
    store = RecordingStore([CheckpointOutcome.ACTIVE, CheckpointOutcome.LOST])

    outcome = TaskExecutor(store, SuccessfulPipeline()).execute(job_lease())

    assert outcome is TaskExecutionOutcome.RETRY
    assert store.progress == [("validating_media", 5), ("running_workflow", 40)]


def test_retryable_failure_uses_persisted_failure_outcome() -> None:
    failure = JobFailure("provider_unavailable", "Try again later.", retryable=True)
    store = RecordingStore(failure_outcome=FailureOutcome.RETRY)

    outcome = TaskExecutor(store, FailingPipeline(failure)).execute(job_lease())

    assert outcome is TaskExecutionOutcome.RETRY
    assert store.failures == [failure]


def test_final_or_terminal_failure_is_acknowledged() -> None:
    failure = JobFailure("invalid_media", "Invalid media.", retryable=False)
    store = RecordingStore(failure_outcome=FailureOutcome.TERMINAL)

    outcome = TaskExecutor(store, FailingPipeline(failure)).execute(job_lease())

    assert outcome is TaskExecutionOutcome.ACKNOWLEDGED
    assert store.failures == [failure]


def test_heartbeat_renews_the_current_stage_during_long_work() -> None:
    store = RecordingStore()
    pipeline = WaitingPipeline()

    def checkpoint_and_signal(
        lease: JobLease, stage: str, progress_percent: int
    ) -> CheckpointOutcome:
        outcome = RecordingStore.checkpoint(store, lease, stage, progress_percent)
        if len(store.progress) >= 2:
            pipeline.heartbeat_seen.set()
        return outcome

    store.checkpoint = checkpoint_and_signal  # type: ignore[method-assign]

    outcome = TaskExecutor(store, pipeline, heartbeat_interval_seconds=0.01).execute(
        job_lease()
    )

    assert outcome is TaskExecutionOutcome.ACKNOWLEDGED
    assert store.progress[:2] == [
        ("running_workflow", 40),
        ("running_workflow", 40),
    ]
