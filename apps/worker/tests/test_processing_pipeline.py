from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import BinaryIO
from uuid import uuid4

import pytest

from factorylens_worker.contracts import PredictionFrame
from factorylens_worker.job_lease import JobLease
from factorylens_worker.media_validation import (
    InspectedMediaMetadata,
    MediaStreamMetadata,
)
from factorylens_worker.processing_pipeline import InspectionProcessingPipeline
from factorylens_worker.storage import (
    ObjectStorage,
    StorageObjectMetadata,
    processing_object_keys,
)
from factorylens_worker.task_execution import ProcessingFailureError
from factorylens_worker.workflow import (
    RetryableWorkflowProviderError,
    WorkflowConfiguration,
    WorkflowFrameInput,
    WorkflowImage,
)


def media() -> InspectedMediaMetadata:
    return InspectedMediaMetadata(
        size_bytes=3,
        content_type="video/webm",
        duration_ms=200,
        width=1,
        height=1,
        container="matroska,webm",
        frame_rate="5/1",
        streams=(
            MediaStreamMetadata(
                index=0,
                type="video",
                codec="vp9",
                duration_ms=200,
                width=1,
                height=1,
                frame_rate="5/1",
            ),
        ),
    )


class FakeStorage:
    def __init__(self, normalized_exists: bool = False) -> None:
        self.normalized_exists = normalized_exists

    def put(self, key: str, source: BinaryIO) -> StorageObjectMetadata:
        raise AssertionError((key, source))

    def read(self, key: str) -> BinaryIO:
        raise AssertionError(key)

    def metadata(self, key: str) -> StorageObjectMetadata:
        raise AssertionError(key)

    def exists(self, key: str) -> bool:
        del key
        return self.normalized_exists

    def delete(self, key: str) -> None:
        raise AssertionError(key)


class FakeMediaStage:
    def run(self, **values: object) -> InspectedMediaMetadata:
        self.values = values
        return media()


class FakeFrameSampler:
    def __init__(self, *, empty: bool = False) -> None:
        self.object_keys: list[str] = []
        self.empty = empty

    @contextmanager
    def frames(
        self,
        storage: ObjectStorage,
        object_key: str,
        inspected_media: InspectedMediaMetadata,
        *,
        is_cancelled: Callable[[], bool],
    ) -> Iterator[Iterator[WorkflowFrameInput]]:
        del storage, inspected_media, is_cancelled
        self.object_keys.append(object_key)
        if self.empty:
            yield iter([])
            return
        yield iter(
            [
                WorkflowFrameInput(
                    frame_index=0,
                    timestamp_ms=0,
                    image=WorkflowImage(width=1, height=1, rgb24=b"\x00\x00\x00"),
                )
            ]
        )


class FakeWorkflowRunner:
    def __init__(self, failure: Exception | None = None) -> None:
        self.failure = failure
        self.calls = 0
        self.configurations: list[WorkflowConfiguration] = []

    def run_frame(
        self,
        frame: WorkflowFrameInput,
        configuration: WorkflowConfiguration,
        *,
        is_cancelled: Callable[[], bool] = lambda: False,
    ) -> PredictionFrame:
        del is_cancelled
        self.calls += 1
        self.configurations.append(configuration)
        if self.failure is not None:
            raise self.failure
        return PredictionFrame(timestampMs=frame.timestamp_ms, predictions=[])


class FakeArtifactStage:
    def __init__(self) -> None:
        self.values: dict[str, object] | None = None

    def run(self, **values: object) -> None:
        self.values = values


def lease(
    *,
    source_type: str = "upload",
    source_object_key: str = "inspections/upload/source",
) -> JobLease:
    from datetime import UTC, datetime, timedelta

    return JobLease(
        job_id=uuid4(),
        inspection_id=uuid4(),
        source_type=source_type,
        source_object_key=source_object_key,
        dispatch_generation=2,
        attempt_count=1,
        max_attempts=3,
        token=uuid4(),
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )


def pipeline(
    storage: FakeStorage,
    sampler: FakeFrameSampler,
    runner: FakeWorkflowRunner,
    artifact: FakeArtifactStage,
    *,
    sample_runner: FakeWorkflowRunner | None = None,
) -> InspectionProcessingPipeline:
    sample_configuration = WorkflowConfiguration(
        endpoint="fixture://assembly-line-no-hard-hat"
    )
    return InspectionProcessingPipeline(
        storage=storage,
        media_stage=FakeMediaStage(),  # type: ignore[arg-type]
        frame_sampler=sampler,
        workflow_runner=runner,
        workflow_configuration=WorkflowConfiguration(
            endpoint="https://serverless.roboflow.com",
            workspace="factorylens-test",
            provider_version_id="1",
        ),
        sample_workflow_runner=sample_runner or FakeWorkflowRunner(),
        sample_workflow_configuration=sample_configuration,
        artifact_stage=artifact,  # type: ignore[arg-type]
    )


def test_pipeline_runs_documented_stages_and_commits_the_artifact() -> None:
    storage = FakeStorage(normalized_exists=True)
    sampler = FakeFrameSampler()
    runner = FakeWorkflowRunner()
    artifact = FakeArtifactStage()
    progress: list[tuple[str, int]] = []
    current_lease = lease()

    pipeline(storage, sampler, runner, artifact).run(
        current_lease,
        report_progress=lambda stage, percent: progress.append((stage, percent)),
        is_cancelled=lambda: False,
    )

    assert progress == [
        ("validating_media", 5),
        ("running_workflow", 30),
        ("running_workflow", 90),
        ("writing_artifact", 95),
    ]
    assert sampler.object_keys == [
        processing_object_keys(
            current_lease.inspection_id, current_lease.dispatch_generation
        ).normalized
    ]
    assert runner.calls == 1
    assert artifact.values is not None
    assert artifact.values["frames"] == [PredictionFrame(timestampMs=0, predictions=[])]


def test_prepared_sample_uses_shared_source_and_fixture_workflow() -> None:
    storage = FakeStorage()
    sampler = FakeFrameSampler()
    production_runner = FakeWorkflowRunner()
    sample_runner = FakeWorkflowRunner()
    artifact = FakeArtifactStage()
    current_lease = lease(
        source_type="sample",
        source_object_key="samples/assembly-line-no-hard-hat.webm",
    )

    pipeline(
        storage,
        sampler,
        production_runner,
        artifact,
        sample_runner=sample_runner,
    ).run(
        current_lease,
        report_progress=lambda _stage, _percent: None,
        is_cancelled=lambda: False,
    )

    assert sampler.object_keys == ["samples/assembly-line-no-hard-hat.webm"]
    assert production_runner.calls == 0
    assert sample_runner.calls == 1
    assert sample_runner.configurations[0].endpoint == (
        "fixture://assembly-line-no-hard-hat"
    )
    assert artifact.values is not None
    workflow = artifact.values["workflow"]
    assert isinstance(workflow, WorkflowConfiguration)
    assert workflow.endpoint == "fixture://assembly-line-no-hard-hat"


def test_retryable_provider_failure_is_sanitized_and_classified() -> None:
    runner = FakeWorkflowRunner(
        RetryableWorkflowProviderError("private provider diagnostic")
    )

    with pytest.raises(ProcessingFailureError) as raised:
        pipeline(FakeStorage(), FakeFrameSampler(), runner, FakeArtifactStage()).run(
            lease(),
            report_progress=lambda _stage, _percent: None,
            is_cancelled=lambda: False,
        )

    assert raised.value.failure.code == "provider_unavailable"
    assert raised.value.failure.retryable
    assert "private provider diagnostic" not in raised.value.failure.safe_message


def test_video_without_decoded_frames_is_a_terminal_input_failure() -> None:
    with pytest.raises(ProcessingFailureError) as raised:
        pipeline(
            FakeStorage(),
            FakeFrameSampler(empty=True),
            FakeWorkflowRunner(),
            FakeArtifactStage(),
        ).run(
            lease(),
            report_progress=lambda _stage, _percent: None,
            is_cancelled=lambda: False,
        )

    assert raised.value.failure.code == "invalid_media"
    assert not raised.value.failure.retryable
