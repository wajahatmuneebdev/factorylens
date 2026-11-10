import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import psycopg
import pytest

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import LeaseOutcome, PostgresJobLeaseStore

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
