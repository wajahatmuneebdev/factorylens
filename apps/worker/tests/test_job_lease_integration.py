import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import psycopg
import pytest

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import LeaseOutcome, PostgresJobLeaseStore
from factorylens_worker.media_validation import (
    InspectedMediaMetadata,
    MediaStreamMetadata,
)
from factorylens_worker.media_validation_store import PostgresMediaMetadataStore

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

    assert not store.record(queued_job, uuid4(), metadata)
    assert store.record(queued_job, decision.lease.token, metadata)

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
                inspected_streams
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
