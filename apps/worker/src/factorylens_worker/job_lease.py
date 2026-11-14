from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

import psycopg

from factorylens_worker.contracts import ProcessTaskMessage

DEFAULT_LEASE_SECONDS = 300
DEFAULT_RETRY_BASE_SECONDS = 10
DEFAULT_RETRY_MAX_SECONDS = 5 * 60


class LeaseOutcome(StrEnum):
    ACQUIRED = "acquired"
    BUSY = "busy"
    GENERATION_MISMATCH = "generation_mismatch"
    INELIGIBLE = "ineligible"
    NOT_FOUND = "not_found"
    TERMINAL = "terminal"


class CheckpointOutcome(StrEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"
    LOST = "lost"


class FailureOutcome(StrEnum):
    RETRY = "retry"
    TERMINAL = "terminal"
    CANCELLED = "cancelled"
    LOST = "lost"


@dataclass(frozen=True)
class JobLease:
    job_id: UUID
    inspection_id: UUID
    dispatch_generation: int
    attempt_count: int
    max_attempts: int
    token: UUID
    expires_at: datetime
    correlation_id: UUID | None = None


@dataclass(frozen=True)
class LeaseDecision:
    outcome: LeaseOutcome
    lease: JobLease | None = None


@dataclass(frozen=True)
class JobFailure:
    code: str
    safe_message: str
    retryable: bool

    def __post_init__(self) -> None:
        if not self.code or len(self.code) > 64:
            raise ValueError("failure code must contain between 1 and 64 characters")
        if not self.safe_message or len(self.safe_message) > 240:
            raise ValueError(
                "safe failure message must contain between 1 and 240 characters"
            )


_LOCK_JOB = """
select
    job.id,
    job.inspection_id,
    job.status::text,
    job.dispatch_generation,
    job.attempt_count,
    job.max_attempts,
    job.available_at,
    job.lease_expires_at,
    job.cancel_requested_at,
    inspection.status::text
from jobs as job
join inspections as inspection on inspection.id = job.inspection_id
where job.id = %s
for update of job, inspection
"""

_ACQUIRE_JOB = """
update jobs
set
    status = 'running',
    stage = 'starting',
    progress_percent = 0,
    attempt_count = attempt_count + 1,
    lease_token = gen_random_uuid(),
    lease_expires_at = statement_timestamp() + (%s * interval '1 second'),
    heartbeat_at = statement_timestamp(),
    error_code = null,
    error_message = null,
    started_at = coalesce(started_at, statement_timestamp()),
    updated_at = statement_timestamp()
where id = %s
returning attempt_count, max_attempts, lease_token, lease_expires_at
"""

_START_INSPECTION = """
update inspections
set
    status = 'processing',
    error_code = null,
    error_message = null,
    started_at = coalesce(started_at, statement_timestamp()),
    updated_at = statement_timestamp()
where id = %s
"""

_QUEUE_AVAILABLE_RETRY = """
update jobs
set
    status = 'queued',
    updated_at = statement_timestamp()
where id = %s
  and status = 'retry_wait'
"""

_LOCK_CURRENT_LEASE = """
select
    job.cancel_requested_at,
    job.attempt_count,
    job.max_attempts
from jobs as job
join inspections as inspection on inspection.id = job.inspection_id
where job.id = %s
  and job.inspection_id = %s
  and job.dispatch_generation = %s
  and job.status = 'running'
  and job.lease_token = %s
  and job.lease_expires_at > statement_timestamp()
  and inspection.status = 'processing'
for update of job, inspection
"""

_RECORD_PROGRESS = """
update jobs
set
    stage = %s,
    progress_percent = %s,
    heartbeat_at = statement_timestamp(),
    lease_expires_at = statement_timestamp() + (%s * interval '1 second'),
    updated_at = statement_timestamp()
where id = %s
  and status = 'running'
  and lease_token = %s
  and lease_expires_at > statement_timestamp()
  and cancel_requested_at is null
returning id
"""

_CANCEL_JOB = """
update jobs
set
    status = 'cancelled',
    stage = 'cancelled',
    lease_token = null,
    lease_expires_at = null,
    heartbeat_at = statement_timestamp(),
    error_code = 'inspection_cancelled',
    error_message = 'Inspection processing was cancelled.',
    finished_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
"""

_CANCEL_INSPECTION = """
update inspections
set
    status = 'cancelled',
    error_code = 'inspection_cancelled',
    error_message = 'Inspection processing was cancelled.',
    completed_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
  and status in ('queued', 'processing')
"""

_RETRY_JOB = """
update jobs
set
    status = 'retry_wait',
    stage = 'retry_wait',
    lease_token = null,
    lease_expires_at = null,
    heartbeat_at = statement_timestamp(),
    error_code = %s,
    error_message = %s,
    available_at = statement_timestamp() + (%s * interval '1 second'),
    updated_at = statement_timestamp()
where id = %s
"""

_FAIL_JOB = """
update jobs
set
    status = 'failed',
    stage = 'failed',
    lease_token = null,
    lease_expires_at = null,
    heartbeat_at = statement_timestamp(),
    error_code = %s,
    error_message = %s,
    finished_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
"""

_FAIL_INSPECTION = """
update inspections
set
    status = 'failed',
    error_code = %s,
    error_message = %s,
    completed_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
  and status in ('queued', 'processing')
"""

_TERMINAL_JOB_STATUSES = frozenset({"cancelled", "completed", "failed"})
_TERMINAL_INSPECTION_STATUSES = frozenset({"cancelled", "completed", "failed"})


class PostgresJobLeaseStore:
    def __init__(
        self,
        database_url: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        *,
        retry_base_seconds: int = DEFAULT_RETRY_BASE_SECONDS,
        retry_max_seconds: int = DEFAULT_RETRY_MAX_SECONDS,
    ) -> None:
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        if retry_base_seconds <= 0:
            raise ValueError("retry_base_seconds must be positive")
        if retry_max_seconds < retry_base_seconds:
            raise ValueError(
                "retry_max_seconds must not be less than retry_base_seconds"
            )
        self._database_url = database_url
        self._lease_seconds = lease_seconds
        self._retry_base_seconds = retry_base_seconds
        self._retry_max_seconds = retry_max_seconds

    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(_LOCK_JOB, (message.jobId,))
                row = cursor.fetchone()
                if row is None:
                    return LeaseDecision(LeaseOutcome.NOT_FOUND)

                job_id = UUID(str(row[0]))
                inspection_id = UUID(str(row[1]))
                job_status = str(row[2])
                dispatch_generation = int(row[3])
                attempt_count = int(row[4])
                max_attempts = int(row[5])
                available_at = row[6]
                lease_expires_at = row[7]
                cancel_requested_at = row[8]
                inspection_status = str(row[9])

                if (
                    job_status in _TERMINAL_JOB_STATUSES
                    or inspection_status in _TERMINAL_INSPECTION_STATUSES
                ):
                    return LeaseDecision(LeaseOutcome.TERMINAL)
                if dispatch_generation != message.dispatchGeneration:
                    return LeaseDecision(LeaseOutcome.GENERATION_MISMATCH)
                if cancel_requested_at is not None:
                    self._cancel_locked(cursor, job_id, inspection_id)
                    return LeaseDecision(LeaseOutcome.TERMINAL)

                now = _database_now(cursor)
                can_run = job_status == "queued" or (
                    job_status == "retry_wait" and available_at <= now
                )
                expired_running = (
                    job_status == "running"
                    and lease_expires_at is not None
                    and lease_expires_at <= now
                )
                if attempt_count >= max_attempts and (can_run or expired_running):
                    self._fail_locked(
                        cursor,
                        job_id,
                        inspection_id,
                        "processing_attempts_exhausted",
                        "Processing could not complete within the allowed attempts.",
                    )
                    return LeaseDecision(LeaseOutcome.TERMINAL)
                if job_status == "running" and not expired_running:
                    return LeaseDecision(LeaseOutcome.BUSY)
                if job_status == "retry_wait" and not can_run:
                    return LeaseDecision(LeaseOutcome.BUSY)
                if not can_run and not expired_running:
                    return LeaseDecision(LeaseOutcome.INELIGIBLE)
                if inspection_status not in {"queued", "processing"}:
                    return LeaseDecision(LeaseOutcome.INELIGIBLE)

                if job_status == "retry_wait":
                    cursor.execute(_QUEUE_AVAILABLE_RETRY, (job_id,))
                cursor.execute(_ACQUIRE_JOB, (self._lease_seconds, job_id))
                acquired = cursor.fetchone()
                if acquired is None:
                    raise RuntimeError(
                        "Locked job disappeared during lease acquisition"
                    )
                cursor.execute(_START_INSPECTION, (inspection_id,))

                return LeaseDecision(
                    LeaseOutcome.ACQUIRED,
                    JobLease(
                        job_id=job_id,
                        inspection_id=inspection_id,
                        dispatch_generation=dispatch_generation,
                        attempt_count=int(acquired[0]),
                        max_attempts=int(acquired[1]),
                        token=UUID(str(acquired[2])),
                        expires_at=acquired[3],
                        correlation_id=message.correlationId,
                    ),
                )

    def checkpoint(
        self,
        lease: JobLease,
        stage: str,
        progress_percent: int,
    ) -> CheckpointOutcome:
        if not stage or len(stage) > 64:
            raise ValueError("stage must contain between 1 and 64 characters")
        if isinstance(progress_percent, bool) or not 0 <= progress_percent <= 100:
            raise ValueError("progress_percent must be between 0 and 100")

        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                current = self._lock_current(cursor, lease)
                if current is None:
                    return CheckpointOutcome.LOST
                if current[0] is not None:
                    self._cancel_locked(cursor, lease.job_id, lease.inspection_id)
                    return CheckpointOutcome.CANCELLED

                cursor.execute(
                    _RECORD_PROGRESS,
                    (
                        stage,
                        progress_percent,
                        self._lease_seconds,
                        lease.job_id,
                        lease.token,
                    ),
                )
                if cursor.fetchone() is None:
                    return CheckpointOutcome.LOST
                return CheckpointOutcome.ACTIVE

    def record_progress(
        self,
        job_id: UUID,
        lease_token: UUID,
        stage: str,
        progress_percent: int,
    ) -> bool:
        """Compatibility helper for narrow lease tests and stage adapters."""
        if not stage or len(stage) > 64:
            raise ValueError("stage must contain between 1 and 64 characters")
        if isinstance(progress_percent, bool) or not 0 <= progress_percent <= 100:
            raise ValueError("progress_percent must be between 0 and 100")
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    _RECORD_PROGRESS,
                    (
                        stage,
                        progress_percent,
                        self._lease_seconds,
                        job_id,
                        lease_token,
                    ),
                )
                return cursor.fetchone() is not None

    def record_failure(self, lease: JobLease, failure: JobFailure) -> FailureOutcome:
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                current = self._lock_current(cursor, lease)
                if current is None:
                    return FailureOutcome.LOST
                if current[0] is not None:
                    self._cancel_locked(cursor, lease.job_id, lease.inspection_id)
                    return FailureOutcome.CANCELLED

                attempt_count = int(current[1])
                max_attempts = int(current[2])
                if failure.retryable and attempt_count < max_attempts:
                    delay_seconds = min(
                        self._retry_base_seconds * (2 ** (attempt_count - 1)),
                        self._retry_max_seconds,
                    )
                    cursor.execute(
                        _RETRY_JOB,
                        (
                            failure.code,
                            failure.safe_message,
                            delay_seconds,
                            lease.job_id,
                        ),
                    )
                    return FailureOutcome.RETRY

                code = failure.code
                message = failure.safe_message
                if failure.retryable:
                    code = "processing_attempts_exhausted"
                    message = (
                        "Processing could not complete within the allowed attempts."
                    )
                self._fail_locked(
                    cursor,
                    lease.job_id,
                    lease.inspection_id,
                    code,
                    message,
                )
                return FailureOutcome.TERMINAL

    def _lock_current(
        self, cursor: psycopg.Cursor[Any], lease: JobLease
    ) -> tuple[Any, ...] | None:
        cursor.execute(
            _LOCK_CURRENT_LEASE,
            (
                lease.job_id,
                lease.inspection_id,
                lease.dispatch_generation,
                lease.token,
            ),
        )
        return cursor.fetchone()

    @staticmethod
    def _cancel_locked(
        cursor: psycopg.Cursor[Any], job_id: UUID, inspection_id: UUID
    ) -> None:
        cursor.execute(_CANCEL_JOB, (job_id,))
        cursor.execute(_CANCEL_INSPECTION, (inspection_id,))

    @staticmethod
    def _fail_locked(
        cursor: psycopg.Cursor[Any],
        job_id: UUID,
        inspection_id: UUID,
        code: str,
        message: str,
    ) -> None:
        cursor.execute(_FAIL_JOB, (code, message, job_id))
        cursor.execute(_FAIL_INSPECTION, (code, message, inspection_id))


def _database_now(cursor: psycopg.Cursor[Any]) -> datetime:
    cursor.execute("select statement_timestamp()")
    row = cursor.fetchone()
    if row is None:
        raise RuntimeError("Database did not return its current time")
    return cast(datetime, row[0])
