from __future__ import annotations

import threading
from collections.abc import Callable
from enum import StrEnum
from typing import Protocol

from factorylens_worker.job_lease import (
    CheckpointOutcome,
    FailureOutcome,
    JobFailure,
    JobLease,
)
from factorylens_worker.observability import write_structured_log

DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30.0


class TaskExecutionOutcome(StrEnum):
    ACKNOWLEDGED = "acknowledged"
    RETRY = "retry"


class LeaseLostError(RuntimeError):
    """The current attempt is no longer allowed to make durable commits."""


class ProcessingCancelledError(RuntimeError):
    """Cooperative cancellation was observed by a processing stage."""


class ProcessingFailureError(RuntimeError):
    def __init__(self, failure: JobFailure) -> None:
        super().__init__(failure.safe_message)
        self.failure = failure


class JobExecutionStore(Protocol):
    def checkpoint(
        self, lease: JobLease, stage: str, progress_percent: int
    ) -> CheckpointOutcome: ...

    def record_failure(
        self, lease: JobLease, failure: JobFailure
    ) -> FailureOutcome: ...


ProgressReporter = Callable[[str, int], None]
CancellationCheck = Callable[[], bool]


class ProcessingPipeline(Protocol):
    def run(
        self,
        lease: JobLease,
        *,
        report_progress: ProgressReporter,
        is_cancelled: CancellationCheck,
    ) -> None: ...


class TaskExecutor:
    def __init__(
        self,
        store: JobExecutionStore,
        pipeline: ProcessingPipeline,
        *,
        heartbeat_interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat_interval_seconds must be positive")
        self._store = store
        self._pipeline = pipeline
        self._heartbeat_interval_seconds = heartbeat_interval_seconds

    def execute(self, lease: JobLease) -> TaskExecutionOutcome:
        guard = _LeaseGuard(
            self._store,
            lease,
            heartbeat_interval_seconds=self._heartbeat_interval_seconds,
        )
        guard.start()
        try:
            self._pipeline.run(
                lease,
                report_progress=guard.report_progress,
                is_cancelled=guard.is_cancelled,
            )
            return TaskExecutionOutcome.ACKNOWLEDGED
        except ProcessingCancelledError:
            return TaskExecutionOutcome.ACKNOWLEDGED
        except LeaseLostError:
            return TaskExecutionOutcome.RETRY
        except ProcessingFailureError as error:
            write_structured_log(
                "error",
                "job_processing_failed",
                attempt=lease.attempt_count,
                correlationId=str(lease.correlation_id or lease.job_id),
                errorCode=error.failure.code,
                inspectionId=str(lease.inspection_id),
                jobId=str(lease.job_id),
                retryable=error.failure.retryable,
            )
            return _failure_task_outcome(
                self._store.record_failure(lease, error.failure)
            )
        finally:
            guard.stop()


def _failure_task_outcome(outcome: FailureOutcome) -> TaskExecutionOutcome:
    if outcome in {FailureOutcome.TERMINAL, FailureOutcome.CANCELLED}:
        return TaskExecutionOutcome.ACKNOWLEDGED
    return TaskExecutionOutcome.RETRY


class _LeaseGuard:
    def __init__(
        self,
        store: JobExecutionStore,
        lease: JobLease,
        *,
        heartbeat_interval_seconds: float,
    ) -> None:
        self._store = store
        self._lease = lease
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._stage = "starting"
        self._progress_percent = 0
        self._outcome = CheckpointOutcome.ACTIVE
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"factorylens-heartbeat-{lease.job_id}",
            daemon=True,
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join()

    def report_progress(self, stage: str, progress_percent: int) -> None:
        with self._lock:
            self._raise_if_stopped()
            self._stage = stage
            self._progress_percent = progress_percent
            self._outcome = self._store.checkpoint(self._lease, stage, progress_percent)
            self._raise_if_stopped()

    def is_cancelled(self) -> bool:
        with self._lock:
            if self._outcome is CheckpointOutcome.LOST:
                raise LeaseLostError("The processing lease was lost")
            return self._outcome is CheckpointOutcome.CANCELLED

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self._heartbeat_interval_seconds):
            with self._lock:
                if self._outcome is not CheckpointOutcome.ACTIVE:
                    return
                try:
                    self._outcome = self._store.checkpoint(
                        self._lease, self._stage, self._progress_percent
                    )
                except Exception as error:
                    write_structured_log(
                        "error",
                        "job_heartbeat_failed",
                        attempt=self._lease.attempt_count,
                        correlationId=str(
                            self._lease.correlation_id or self._lease.job_id
                        ),
                        errorType=type(error).__name__,
                        inspectionId=str(self._lease.inspection_id),
                        jobId=str(self._lease.job_id),
                    )
                    self._outcome = CheckpointOutcome.LOST
                    return

    def _raise_if_stopped(self) -> None:
        if self._outcome is CheckpointOutcome.CANCELLED:
            raise ProcessingCancelledError("Inspection processing was cancelled")
        if self._outcome is CheckpointOutcome.LOST:
            raise LeaseLostError("The processing lease was lost")
