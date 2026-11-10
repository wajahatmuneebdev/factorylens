from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

import psycopg

from factorylens_worker.contracts import ProcessTaskMessage

DEFAULT_LEASE_SECONDS = 300


class LeaseOutcome(StrEnum):
    ACQUIRED = "acquired"
    BUSY = "busy"
    GENERATION_MISMATCH = "generation_mismatch"
    INELIGIBLE = "ineligible"
    NOT_FOUND = "not_found"
    TERMINAL = "terminal"


@dataclass(frozen=True)
class JobLease:
    job_id: UUID
    inspection_id: UUID
    dispatch_generation: int
    token: UUID
    expires_at: datetime


@dataclass(frozen=True)
class LeaseDecision:
    outcome: LeaseOutcome
    lease: JobLease | None = None


# Locking the candidate first makes the decision deterministic under concurrent
# delivery. A waiter sees the committed lease and cannot also satisfy the update.
_ACQUIRE_LEASE = """
with candidate as materialized (
    select
        job.id,
        job.inspection_id,
        job.status,
        job.dispatch_generation,
        job.attempt_count,
        job.max_attempts,
        job.lease_expires_at,
        job.cancel_requested_at,
        inspection.status as inspection_status
    from jobs as job
    join inspections as inspection on inspection.id = job.inspection_id
    where job.id = %s
    for update of job, inspection
), acquired as (
    update jobs as job
    set
        status = 'running',
        stage = 'starting',
        attempt_count = job.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp() + (%s * interval '1 second'),
        heartbeat_at = statement_timestamp(),
        started_at = coalesce(job.started_at, statement_timestamp()),
        updated_at = statement_timestamp()
    from candidate
    where job.id = candidate.id
      and candidate.dispatch_generation = %s
      and candidate.cancel_requested_at is null
      and candidate.attempt_count < candidate.max_attempts
      and candidate.inspection_status in ('queued', 'processing')
      and (
          candidate.status = 'queued'
          or (
              candidate.status = 'running'
              and candidate.lease_expires_at <= statement_timestamp()
          )
      )
    returning
        job.id,
        job.inspection_id,
        job.dispatch_generation,
        job.lease_token,
        job.lease_expires_at
), started_inspection as (
    update inspections as inspection
    set
        status = 'processing',
        started_at = coalesce(inspection.started_at, statement_timestamp()),
        updated_at = statement_timestamp()
    from acquired
    where inspection.id = acquired.inspection_id
    returning inspection.id
)
select
    candidate.status::text,
    candidate.inspection_status::text,
    candidate.dispatch_generation,
    candidate.cancel_requested_at,
    acquired.id,
    acquired.inspection_id,
    acquired.dispatch_generation,
    acquired.lease_token,
    acquired.lease_expires_at
from candidate
left join acquired on true
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

_TERMINAL_JOB_STATUSES = frozenset({"cancelled", "completed", "failed"})
_TERMINAL_INSPECTION_STATUSES = frozenset({"cancelled", "completed", "failed"})


class PostgresJobLeaseStore:
    def __init__(
        self, database_url: str, lease_seconds: int = DEFAULT_LEASE_SECONDS
    ) -> None:
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        self._database_url = database_url
        self._lease_seconds = lease_seconds

    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision:
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    _ACQUIRE_LEASE,
                    (
                        message.jobId,
                        self._lease_seconds,
                        message.dispatchGeneration,
                    ),
                )
                row = cursor.fetchone()

        if row is None:
            return LeaseDecision(LeaseOutcome.NOT_FOUND)

        return _classify_acquisition(row, message)

    def record_progress(
        self,
        job_id: UUID,
        lease_token: UUID,
        stage: str,
        progress_percent: int,
    ) -> bool:
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


def _classify_acquisition(
    row: tuple[Any, ...], message: ProcessTaskMessage
) -> LeaseDecision:
    job_status = str(row[0])
    inspection_status = str(row[1])
    dispatch_generation = int(row[2])
    cancel_requested_at = row[3]

    if (
        job_status in _TERMINAL_JOB_STATUSES
        or inspection_status in _TERMINAL_INSPECTION_STATUSES
        or cancel_requested_at is not None
    ):
        return LeaseDecision(LeaseOutcome.TERMINAL)

    if dispatch_generation != message.dispatchGeneration:
        return LeaseDecision(LeaseOutcome.GENERATION_MISMATCH)

    acquired_job_id = row[4]
    if acquired_job_id is not None:
        return LeaseDecision(
            LeaseOutcome.ACQUIRED,
            JobLease(
                job_id=UUID(str(acquired_job_id)),
                inspection_id=UUID(str(row[5])),
                dispatch_generation=int(row[6]),
                token=UUID(str(row[7])),
                expires_at=row[8],
            ),
        )

    if job_status == "running":
        return LeaseDecision(LeaseOutcome.BUSY)

    return LeaseDecision(LeaseOutcome.INELIGIBLE)
