import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import psycopg
import pytest

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import (
    CheckpointOutcome,
    FailureOutcome,
    JobFailure,
    LeaseOutcome,
    PostgresJobLeaseStore,
)
from factorylens_worker.media_validation import (
    InspectedMediaMetadata,
    MediaStreamMetadata,
)
from factorylens_worker.media_validation_store import PostgresMediaMetadataStore
from factorylens_worker.prediction_artifact import InspectionCompletion
from factorylens_worker.prediction_artifact_store import (
    PostgresInspectionCompletionStore,
)
from factorylens_worker.storage import processing_object_keys

database_url = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        database_url is None,
        reason=(
            "TEST_DATABASE_URL must identify a migrated disposable PostgreSQL database"
        ),
    ),
]


@pytest.fixture
def queued_job() -> Iterator[UUID]:
    assert database_url is not None
    user_id = uuid4()
    inspection_id = uuid4()
    job_id = uuid4()
    identity_suffix = uuid4()
    with psycopg.connect(database_url) as connection:
        connection.execute(
            """
            insert into users (id, google_subject, email, display_name)
            values (%s, %s, %s, 'Worker Lease Test')
            """,
            (
                user_id,
                f"worker-lease-{identity_suffix}",
                f"worker-lease-{identity_suffix}@example.com",
            ),
        )
        connection.execute(
            """
            insert into inspections (
                id,
                owner_user_id,
                title,
                status,
                source_type,
                workflow_key,
                source_object_key,
                queued_at
            ) values (%s, %s, 'Lease test', 'queued', 'upload',
                'factory-safety-v1', %s, now())
            """,
            (inspection_id, user_id, f"inspections/{inspection_id}/source"),
        )
        connection.execute(
            """
            insert into jobs (
                id,
                inspection_id,
                status,
                dispatch_generation,
                task_enqueued_at
            ) values (%s, %s, 'queued', 1, now())
            """,
            (job_id, inspection_id),
        )

    try:
        yield job_id
    finally:
        with psycopg.connect(database_url) as connection:
            connection.execute(
                "delete from inspections where id = %s", (inspection_id,)
            )
            connection.execute("delete from users where id = %s", (user_id,))


def test_only_one_simultaneous_delivery_acquires_the_job(queued_job: UUID) -> None:
    assert database_url is not None
    store = PostgresJobLeaseStore(database_url)
    message = ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    barrier = Barrier(2)

    def acquire() -> LeaseOutcome:
        barrier.wait()
        return store.acquire(message).outcome

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _: acquire(), range(2)))

    assert sorted(outcomes) == [LeaseOutcome.ACQUIRED, LeaseOutcome.BUSY]


def test_progress_requires_the_current_lease_token(queued_job: UUID) -> None:
    assert database_url is not None
    store = PostgresJobLeaseStore(database_url)
    decision = store.acquire(ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1))
    assert decision.lease is not None

    assert not store.record_progress(queued_job, uuid4(), "download", 10)
    assert store.record_progress(queued_job, decision.lease.token, "download", 10)


def test_cancellation_checkpoint_atomically_finishes_both_states(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    store = PostgresJobLeaseStore(database_url)
    lease = store.acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    ).lease
    assert lease is not None
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "update jobs set cancel_requested_at = now() where id = %s",
            (queued_job,),
        )

    outcome = store.checkpoint(lease, "running_workflow", 40)

    assert outcome is CheckpointOutcome.CANCELLED
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select job.status, job.lease_token, job.error_code, inspection.status,
                   inspection.error_code
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()
    assert row == (
        "cancelled",
        None,
        "inspection_cancelled",
        "cancelled",
        "inspection_cancelled",
    )


def test_terminal_input_failure_is_persisted_without_retry(queued_job: UUID) -> None:
    assert database_url is not None
    store = PostgresJobLeaseStore(database_url)
    lease = store.acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    ).lease
    assert lease is not None

    outcome = store.record_failure(
        lease,
        JobFailure("invalid_media", "The media is invalid.", retryable=False),
    )

    assert outcome is FailureOutcome.TERMINAL
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select job.status, job.error_code, inspection.status,
                   inspection.error_code
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()
    assert row == ("failed", "invalid_media", "failed", "invalid_media")


def test_transient_failures_retry_then_exhaust_the_attempt_limit(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    store = PostgresJobLeaseStore(database_url, retry_base_seconds=1)
    message = ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    failure = JobFailure(
        "provider_unavailable",
        "The provider is temporarily unavailable.",
        retryable=True,
    )

    for expected_attempt in (1, 2, 3):
        lease = store.acquire(message).lease
        assert lease is not None
        assert lease.attempt_count == expected_attempt
        outcome = store.record_failure(lease, failure)
        if expected_attempt < 3:
            assert outcome is FailureOutcome.RETRY
            with psycopg.connect(database_url) as connection:
                row = connection.execute(
                    "select status, error_code from jobs where id = %s",
                    (queued_job,),
                ).fetchone()
                assert row == ("retry_wait", "provider_unavailable")
                connection.execute(
                    "update jobs set available_at = now() where id = %s",
                    (queued_job,),
                )
        else:
            assert outcome is FailureOutcome.TERMINAL

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select job.status, job.error_code, inspection.status,
                   inspection.error_code
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()
    assert row == (
        "failed",
        "processing_attempts_exhausted",
        "failed",
        "processing_attempts_exhausted",
    )


def test_inspected_media_metadata_requires_the_current_lease_token(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    decision = PostgresJobLeaseStore(database_url).acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    )
    assert decision.lease is not None
    metadata = InspectedMediaMetadata(
        size_bytes=4096,
        content_type="video/webm",
        duration_ms=2000,
        width=1840,
        height=1080,
        container="matroska,webm",
        frame_rate="5/1",
        streams=(
            MediaStreamMetadata(
                index=0,
                type="video",
                codec="vp9",
                duration_ms=2000,
                width=1840,
                height=1080,
                frame_rate="5/1",
            ),
        ),
    )
    store = PostgresMediaMetadataStore(database_url)

    assert not store.record(queued_job, uuid4(), metadata, None)
    normalized_object_key = (
        f"inspections/{decision.lease.inspection_id}/generations/1/normalized"
    )
    assert store.record(
        queued_job, decision.lease.token, metadata, normalized_object_key
    )

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select
                inspected_content_type,
                inspected_size_bytes,
                inspected_duration_ms,
                inspected_width,
                inspected_height,
                inspected_container,
                inspected_frame_rate,
                inspected_streams,
                normalized_object_key
            from inspections
            where id = %s
            """,
            (decision.lease.inspection_id,),
        ).fetchone()

    assert row == (
        "video/webm",
        4096,
        2000,
        1840,
        1080,
        "matroska,webm",
        "5/1",
        [
            {
                "index": 0,
                "type": "video",
                "codec": "vp9",
                "durationMs": 2000,
                "width": 1840,
                "height": 1080,
                "frameRate": "5/1",
            }
        ],
        normalized_object_key,
    )


def test_stale_generation_is_rejected_before_leasing(queued_job: UUID) -> None:
    assert database_url is not None
    decision = PostgresJobLeaseStore(database_url).acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=2)
    )

    assert decision.outcome is LeaseOutcome.GENERATION_MISMATCH
    assert decision.lease is None


def test_expired_lease_is_replaced_with_a_unique_token(queued_job: UUID) -> None:
    assert database_url is not None
    expired_token = uuid4()
    with psycopg.connect(database_url) as connection:
        connection.execute(
            """
            update jobs
            set status = 'running',
                attempt_count = 1,
                lease_token = %s,
                lease_expires_at = now() - interval '1 minute'
            where id = %s
            """,
            (expired_token, queued_job),
        )
        connection.execute(
            "update inspections set status = 'processing' where id = "
            "(select inspection_id from jobs where id = %s)",
            (queued_job,),
        )

    decision = PostgresJobLeaseStore(database_url).acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    )

    assert decision.outcome is LeaseOutcome.ACQUIRED
    assert decision.lease is not None
    assert decision.lease.token != expired_token


def test_worker_exit_on_final_attempt_is_terminal_after_lease_expiry(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "update jobs set max_attempts = 1 where id = %s", (queued_job,)
        )
    store = PostgresJobLeaseStore(database_url)
    message = ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    first = store.acquire(message)
    assert first.outcome is LeaseOutcome.ACQUIRED
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "update jobs set lease_expires_at = now() - interval '1 second' "
            "where id = %s",
            (queued_job,),
        )

    redelivery = store.acquire(message)

    assert redelivery.outcome is LeaseOutcome.TERMINAL
    assert redelivery.lease is None
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select job.status, job.error_code, inspection.status
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()
    assert row == ("failed", "processing_attempts_exhausted", "failed")


def test_terminal_job_is_acknowledged_even_for_an_old_generation(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "update jobs set status = 'completed' where id = %s", (queued_job,)
        )
        connection.execute(
            "update inspections set status = 'completed' where id = "
            "(select inspection_id from jobs where id = %s)",
            (queued_job,),
        )

    decision = PostgresJobLeaseStore(database_url).acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=2)
    )

    assert decision.outcome is LeaseOutcome.TERMINAL
    assert decision.lease is None


def completion_for(inspection_id: UUID, generation: int = 1) -> InspectionCompletion:
    return InspectionCompletion(
        prediction_object_key=processing_object_keys(
            inspection_id, generation
        ).prediction,
        prediction_schema_version=1,
        workflow_key="factory-safety-v1",
        workflow_fingerprint=(
            "sha256:6f17fa35c215660fe398df8bd98157759817bfa859be8065ae1c19312ef07d62"
        ),
        missing_hard_hat_event_count=1,
        qualifying_frame_count=10,
        peak_confidence=0.95,
    )


def test_completion_atomically_commits_the_job_and_small_inspection_summary(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    lease = (
        PostgresJobLeaseStore(database_url)
        .acquire(ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1))
        .lease
    )
    assert lease is not None
    artifact_written = False

    def write_artifact() -> None:
        nonlocal artifact_written
        artifact_written = True

    accepted = PostgresInspectionCompletionStore(database_url).complete_with_artifact(
        job_id=queued_job,
        inspection_id=lease.inspection_id,
        dispatch_generation=1,
        lease_token=lease.token,
        completion=completion_for(lease.inspection_id),
        write_artifact=write_artifact,
    )

    assert accepted
    assert artifact_written
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select
                job.status,
                job.stage,
                job.progress_percent,
                job.lease_token,
                job.finished_at is not null,
                inspection.status,
                inspection.prediction_object_key,
                inspection.prediction_schema_version,
                inspection.workflow_fingerprint,
                inspection.missing_hard_hat_event_count,
                inspection.qualifying_frame_count,
                inspection.peak_confidence,
                inspection.completed_at is not null
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()

    assert row == (
        "completed",
        "completed",
        100,
        None,
        True,
        "completed",
        completion_for(lease.inspection_id).prediction_object_key,
        1,
        completion_for(lease.inspection_id).workflow_fingerprint,
        1,
        10,
        0.95,
        True,
    )

    redelivery = PostgresJobLeaseStore(database_url).acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    )
    assert redelivery.outcome is LeaseOutcome.TERMINAL
    assert redelivery.lease is None


def test_stale_lease_cannot_write_over_a_newer_attempt_or_committed_result(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    lease_store = PostgresJobLeaseStore(database_url)
    first = lease_store.acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    ).lease
    assert first is not None
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "update jobs set lease_expires_at = now() - interval '1 second' "
            "where id = %s",
            (queued_job,),
        )
    second = lease_store.acquire(
        ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1)
    ).lease
    assert second is not None
    store = PostgresInspectionCompletionStore(database_url)
    writes: list[str] = []
    completion = completion_for(second.inspection_id)

    assert not store.complete_with_artifact(
        job_id=queued_job,
        inspection_id=first.inspection_id,
        dispatch_generation=1,
        lease_token=first.token,
        completion=completion,
        write_artifact=lambda: writes.append("stale-before"),
    )
    assert store.complete_with_artifact(
        job_id=queued_job,
        inspection_id=second.inspection_id,
        dispatch_generation=1,
        lease_token=second.token,
        completion=completion,
        write_artifact=lambda: writes.append("current"),
    )
    assert not store.complete_with_artifact(
        job_id=queued_job,
        inspection_id=first.inspection_id,
        dispatch_generation=1,
        lease_token=first.token,
        completion=completion,
        write_artifact=lambda: writes.append("stale-after"),
    )
    assert writes == ["current"]


def test_database_failure_after_artifact_write_rolls_back_both_states(
    queued_job: UUID,
) -> None:
    assert database_url is not None
    lease = (
        PostgresJobLeaseStore(database_url)
        .acquire(ProcessTaskMessage(jobId=queued_job, dispatchGeneration=1))
        .lease
    )
    assert lease is not None
    completion = completion_for(lease.inspection_id)
    invalid_completion = InspectionCompletion(
        prediction_object_key="x" * 1025,
        prediction_schema_version=completion.prediction_schema_version,
        workflow_key=completion.workflow_key,
        workflow_fingerprint=completion.workflow_fingerprint,
        missing_hard_hat_event_count=completion.missing_hard_hat_event_count,
        qualifying_frame_count=completion.qualifying_frame_count,
        peak_confidence=completion.peak_confidence,
    )
    artifact_written = False

    def write_artifact() -> None:
        nonlocal artifact_written
        artifact_written = True

    with pytest.raises(psycopg.errors.StringDataRightTruncation):
        PostgresInspectionCompletionStore(database_url).complete_with_artifact(
            job_id=queued_job,
            inspection_id=lease.inspection_id,
            dispatch_generation=1,
            lease_token=lease.token,
            completion=invalid_completion,
            write_artifact=write_artifact,
        )

    assert artifact_written
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            select job.status, inspection.status, inspection.prediction_object_key
            from jobs as job
            join inspections as inspection on inspection.id = job.inspection_id
            where job.id = %s
            """,
            (queued_job,),
        ).fetchone()
    assert row == ("running", "processing", None)
