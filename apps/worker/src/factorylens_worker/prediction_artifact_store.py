from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

import psycopg

from factorylens_worker.prediction_artifact import InspectionCompletion

_LOCK_CURRENT_COMPLETION = """
select job.id
from jobs as job
join inspections as inspection on inspection.id = job.inspection_id
where job.id = %s
  and job.inspection_id = %s
  and job.dispatch_generation = %s
  and job.status = 'running'
  and job.lease_token = %s
  and job.lease_expires_at > statement_timestamp()
  and job.cancel_requested_at is null
  and inspection.status = 'processing'
  and inspection.workflow_key = %s
for update of job, inspection
"""

_COMPLETE_JOB = """
update jobs
set
    status = 'completed',
    stage = 'completed',
    progress_percent = 100,
    lease_token = null,
    lease_expires_at = null,
    heartbeat_at = statement_timestamp(),
    error_code = null,
    error_message = null,
    finished_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
  and inspection_id = %s
  and dispatch_generation = %s
  and status = 'running'
  and lease_token = %s
  and lease_expires_at > statement_timestamp()
  and cancel_requested_at is null
returning inspection_id
"""

_COMPLETE_INSPECTION = """
update inspections
set
    status = 'completed',
    prediction_object_key = %s,
    prediction_schema_version = %s,
    workflow_fingerprint = %s,
    missing_hard_hat_event_count = %s,
    qualifying_frame_count = %s,
    peak_confidence = %s,
    error_code = null,
    error_message = null,
    completed_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = %s
  and status = 'processing'
  and workflow_key = %s
returning id
"""


class PostgresInspectionCompletionStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def complete_with_artifact(
        self,
        *,
        job_id: UUID,
        inspection_id: UUID,
        dispatch_generation: int,
        lease_token: UUID,
        completion: InspectionCompletion,
        write_artifact: Callable[[], None],
    ) -> bool:
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    _LOCK_CURRENT_COMPLETION,
                    (
                        job_id,
                        inspection_id,
                        dispatch_generation,
                        lease_token,
                        completion.workflow_key,
                    ),
                )
                if cursor.fetchone() is None:
                    return False

                write_artifact()

                cursor.execute(
                    _COMPLETE_JOB,
                    (
                        job_id,
                        inspection_id,
                        dispatch_generation,
                        lease_token,
                    ),
                )
                if cursor.fetchone() is None:
                    return False

                cursor.execute(
                    _COMPLETE_INSPECTION,
                    (
                        completion.prediction_object_key,
                        completion.prediction_schema_version,
                        completion.workflow_fingerprint,
                        completion.missing_hard_hat_event_count,
                        completion.qualifying_frame_count,
                        completion.peak_confidence,
                        inspection_id,
                        completion.workflow_key,
                    ),
                )
                if cursor.fetchone() is None:
                    raise RuntimeError(
                        "Inspection completion failed after completing its job"
                    )

        return True
