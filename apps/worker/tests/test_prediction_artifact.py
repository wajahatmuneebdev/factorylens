import gzip
import json
from collections.abc import Callable, Sequence
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, Literal
from uuid import UUID, uuid4

import pytest

from factorylens_worker.contracts import PredictionArtifactV1, PredictionFrame
from factorylens_worker.media_validation import (
    InspectedMediaMetadata,
    MediaStreamMetadata,
)
from factorylens_worker.prediction_artifact import (
    InspectionCompletion,
    InspectionCompletionRejectedError,
    PredictionArtifactStage,
    build_prediction_artifact,
    compress_prediction_artifact,
)
from factorylens_worker.storage import (
    LocalFilesystemStorage,
    ObjectStorage,
    StorageObjectMetadata,
    processing_object_keys,
)
from factorylens_worker.workflow import WorkflowConfiguration

FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "fixtures"
    / "predictions"
    / "assembly-line-no-hard-hat.expected.json"
)


def load_expected_artifact() -> PredictionArtifactV1:
    return PredictionArtifactV1.model_validate_json(FIXTURE_PATH.read_text())


def inspected_media(
    *,
    width: int = 1840,
    height: int = 1080,
    duration_ms: int = 2000,
) -> InspectedMediaMetadata:
    return InspectedMediaMetadata(
        size_bytes=4096,
        content_type="video/webm",
        duration_ms=duration_ms,
        width=width,
        height=height,
        container="matroska,webm",
        frame_rate="5/1",
        streams=(
            MediaStreamMetadata(
                index=0,
                type="video",
                codec="vp9",
                duration_ms=duration_ms,
                width=width,
                height=height,
                frame_rate="5/1",
            ),
        ),
    )


class RecordingCompletionStore:
    def __init__(
        self,
        mode: Literal["complete", "reject", "fail_after_write"] = "complete",
    ) -> None:
        self.mode = mode
        self.completions: list[InspectionCompletion] = []
        self.completed = False

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
        del job_id, inspection_id, dispatch_generation, lease_token
        self.completions.append(completion)
        if self.mode == "reject":
            return False
        write_artifact()
        if self.mode == "fail_after_write":
            raise RuntimeError("simulated transaction failure")
        self.completed = True
        return True


class FailingPutStorage:
    def put(self, key: str, source: BinaryIO) -> StorageObjectMetadata:
        del key, source
        raise OSError("simulated artifact write failure")

    def read(self, key: str) -> BinaryIO:
        raise AssertionError(key)

    def metadata(self, key: str) -> StorageObjectMetadata:
        raise AssertionError(key)

    def exists(self, key: str) -> bool:
        raise AssertionError(key)

    def delete(self, key: str) -> None:
        raise AssertionError(key)


def run_stage(
    storage: ObjectStorage,
    completion_store: RecordingCompletionStore,
    frames: Sequence[PredictionFrame] | None = None,
    *,
    inspection_id: UUID | None = None,
    dispatch_generation: int = 3,
) -> PredictionArtifactV1:
    expected = load_expected_artifact()
    return PredictionArtifactStage(storage, completion_store).run(
        job_id=uuid4(),
        inspection_id=inspection_id or expected.inspectionId,
        dispatch_generation=dispatch_generation,
        lease_token=uuid4(),
        media=inspected_media(),
        workflow=WorkflowConfiguration(endpoint="fixture://assembly-line-no-hard-hat"),
        frames=expected.frames if frames is None else frames,
    )


def test_workflow_frames_are_converted_to_prediction_schema_v1() -> None:
    expected = load_expected_artifact()

    artifact = build_prediction_artifact(
        inspection_id=expected.inspectionId,
        media=inspected_media(),
        workflow=WorkflowConfiguration(endpoint="fixture://assembly-line-no-hard-hat"),
        frames=expected.frames,
    )

    assert artifact == expected
    assert artifact.events[0].model_dump() == {
        "id": "event-000",
        "type": "missing_hard_hat",
        "label": "Missing hard hat",
        "startMs": 0,
        "endMs": 2000,
        "peakConfidence": 0.95,
        "qualifyingFrameCount": 10,
    }


def test_frame_timestamps_are_normalized_from_the_first_displayed_frame() -> None:
    expected = load_expected_artifact()
    shifted = [
        PredictionFrame(
            timestampMs=frame.timestampMs + 720,
            predictions=frame.predictions,
        )
        for frame in expected.frames
    ]

    artifact = build_prediction_artifact(
        inspection_id=expected.inspectionId,
        media=inspected_media(),
        workflow=WorkflowConfiguration(endpoint="fixture://assembly-line-no-hard-hat"),
        frames=shifted,
    )

    assert [frame.timestampMs for frame in artifact.frames] == list(range(0, 2000, 200))
    assert (artifact.source.width, artifact.source.height) == (1840, 1080)


def test_event_requires_three_of_five_frames_and_ends_after_five_gaps() -> None:
    expected = load_expected_artifact()
    qualifying = expected.frames[0].predictions
    pattern = [True, False, True, True, False, False, False, False, False]
    frames = []
    for index, is_qualifying in enumerate(pattern):
        predictions = [
            prediction.model_copy(update={"id": f"f{index:06d}-p{ordinal:03d}"})
            for ordinal, prediction in enumerate(qualifying)
        ]
        frames.append(
            PredictionFrame(
                timestampMs=index * 200,
                predictions=predictions if is_qualifying else [],
            )
        )

    artifact = build_prediction_artifact(
        inspection_id=expected.inspectionId,
        media=inspected_media(),
        workflow=WorkflowConfiguration(endpoint="fixture://assembly-line-no-hard-hat"),
        frames=frames,
    )

    assert [event.model_dump() for event in artifact.events] == [
        {
            "id": "event-000",
            "type": "missing_hard_hat",
            "label": "Missing hard hat",
            "startMs": 0,
            "endMs": 600,
            "peakConfidence": 0.91,
            "qualifyingFrameCount": 3,
        }
    ]
    assert artifact.summary.qualifyingFrameCount == 3


def test_compression_is_valid_and_deterministic() -> None:
    artifact = load_expected_artifact()

    first = compress_prediction_artifact(artifact)
    second = compress_prediction_artifact(artifact)

    assert first == second
    assert first[:2] == b"\x1f\x8b"
    assert first[4:8] == b"\x00\x00\x00\x00"
    assert json.loads(gzip.decompress(first)) == artifact.model_dump(mode="json")


def test_artifact_write_failure_does_not_complete_the_inspection() -> None:
    completion_store = RecordingCompletionStore()

    with pytest.raises(OSError, match="artifact write failure"):
        run_stage(FailingPutStorage(), completion_store)

    assert len(completion_store.completions) == 1
    assert not completion_store.completed


def test_transaction_failure_keeps_deterministic_artifact_for_retry(
    tmp_path: Path,
) -> None:
    storage = LocalFilesystemStorage(tmp_path)
    expected = load_expected_artifact()
    key = processing_object_keys(expected.inspectionId, 3).prediction
    failing_store = RecordingCompletionStore("fail_after_write")

    with pytest.raises(RuntimeError, match="transaction failure"):
        run_stage(storage, failing_store)

    with storage.read(key) as written:
        first_attempt = written.read()
    assert not failing_store.completed

    successful_store = RecordingCompletionStore()
    artifact = run_stage(storage, successful_store)

    with storage.read(key) as written:
        retry = written.read()
    assert retry == first_attempt
    assert gzip.decompress(retry) == gzip.decompress(
        compress_prediction_artifact(artifact)
    )
    assert successful_store.completions[0].prediction_object_key == key
    assert successful_store.completed


def test_rejected_lease_does_not_write_or_replace_an_artifact(tmp_path: Path) -> None:
    storage = LocalFilesystemStorage(tmp_path)
    expected = load_expected_artifact()
    key = processing_object_keys(expected.inspectionId, 3).prediction
    storage.put(key, BytesIO(b"committed artifact"))

    with pytest.raises(InspectionCompletionRejectedError):
        run_stage(storage, RecordingCompletionStore("reject"))

    with storage.read(key) as stored:
        assert stored.read() == b"committed artifact"
