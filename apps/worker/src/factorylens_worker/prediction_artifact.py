from __future__ import annotations

import gzip
import json
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from io import BytesIO
from typing import Literal, Protocol
from uuid import UUID

from factorylens_worker.contracts import (
    ArtifactSource,
    ArtifactSummary,
    ArtifactWorkflow,
    PredictionArtifactV1,
    PredictionEvent,
    PredictionFrame,
)
from factorylens_worker.media_validation import InspectedMediaMetadata
from factorylens_worker.storage import ObjectStorage, processing_object_keys
from factorylens_worker.workflow import WorkflowConfiguration

PREDICTION_SCHEMA_VERSION: Literal[1] = 1
SAMPLE_RATE_FPS = 5.0
QUALIFYING_CONFIDENCE = 0.6
CONFIRMING_FRAME_COUNT = 3
CONFIRMING_WINDOW_SIZE = 5
ENDING_GAP_FRAME_COUNT = 5
MERGE_GAP_MS = 1_000


@dataclass(frozen=True, slots=True)
class InspectionCompletion:
    prediction_object_key: str
    prediction_schema_version: Literal[1]
    workflow_key: Literal["factory-safety-v1"]
    workflow_fingerprint: str
    missing_hard_hat_event_count: int
    qualifying_frame_count: int
    peak_confidence: float | None


class InspectionCompletionStore(Protocol):
    def complete_with_artifact(
        self,
        *,
        job_id: UUID,
        inspection_id: UUID,
        dispatch_generation: int,
        lease_token: UUID,
        completion: InspectionCompletion,
        write_artifact: Callable[[], None],
    ) -> bool: ...


class InspectionCompletionRejectedError(RuntimeError):
    """The active lease no longer authorizes result completion."""


def build_prediction_artifact(
    *,
    inspection_id: UUID,
    media: InspectedMediaMetadata,
    workflow: WorkflowConfiguration,
    frames: Sequence[PredictionFrame],
) -> PredictionArtifactV1:
    normalized_frames = _normalize_frame_timestamps(frames, media.duration_ms)
    events = _build_missing_hard_hat_events(normalized_frames, media.duration_ms)
    qualifying_confidences = [
        prediction.confidence
        for frame in normalized_frames
        for prediction in frame.predictions
        if prediction.className == "NO-Hardhat"
        and prediction.confidence >= QUALIFYING_CONFIDENCE
    ]
    qualifying_frame_count = sum(
        _qualifying_confidence(frame) is not None for frame in normalized_frames
    )

    return PredictionArtifactV1(
        schemaVersion=PREDICTION_SCHEMA_VERSION,
        inspectionId=inspection_id,
        source=ArtifactSource(
            width=media.width,
            height=media.height,
            durationMs=media.duration_ms,
            timeBase="milliseconds",
            sampleRateFps=SAMPLE_RATE_FPS,
        ),
        workflow=ArtifactWorkflow(
            key=workflow.key,
            workflowId=workflow.workflow_id,
            workflowVersion=workflow.workflow_version,
            modelId=workflow.model_id,
            fingerprint=workflow.fingerprint,
        ),
        classes=("Person", "Hardhat", "NO-Hardhat"),
        frames=normalized_frames,
        events=events,
        summary=ArtifactSummary(
            missingHardHatEventCount=len(events),
            qualifyingFrameCount=qualifying_frame_count,
            peakConfidence=max(qualifying_confidences, default=None),
        ),
    )


def compress_prediction_artifact(artifact: PredictionArtifactV1) -> bytes:
    serialized = json.dumps(
        artifact.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    compressed = BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", mtime=0) as output:
        output.write(serialized)
    return compressed.getvalue()


class PredictionArtifactStage:
    def __init__(
        self,
        storage: ObjectStorage,
        completion_store: InspectionCompletionStore,
    ) -> None:
        self._storage = storage
        self._completion_store = completion_store

    def run(
        self,
        *,
        job_id: UUID,
        inspection_id: UUID,
        dispatch_generation: int,
        lease_token: UUID,
        media: InspectedMediaMetadata,
        workflow: WorkflowConfiguration,
        frames: Sequence[PredictionFrame],
    ) -> PredictionArtifactV1:
        artifact = build_prediction_artifact(
            inspection_id=inspection_id,
            media=media,
            workflow=workflow,
            frames=frames,
        )
        artifact_bytes = compress_prediction_artifact(artifact)
        artifact_key = processing_object_keys(
            inspection_id, dispatch_generation
        ).prediction
        completion = InspectionCompletion(
            prediction_object_key=artifact_key,
            prediction_schema_version=artifact.schemaVersion,
            workflow_key=artifact.workflow.key,
            workflow_fingerprint=artifact.workflow.fingerprint,
            missing_hard_hat_event_count=artifact.summary.missingHardHatEventCount,
            qualifying_frame_count=artifact.summary.qualifyingFrameCount,
            peak_confidence=artifact.summary.peakConfidence,
        )

        def write_artifact() -> None:
            self._storage.put(artifact_key, BytesIO(artifact_bytes))

        if not self._completion_store.complete_with_artifact(
            job_id=job_id,
            inspection_id=inspection_id,
            dispatch_generation=dispatch_generation,
            lease_token=lease_token,
            completion=completion,
            write_artifact=write_artifact,
        ):
            raise InspectionCompletionRejectedError(
                "Inspection completion was rejected by the active lease"
            )

        return artifact


def _normalize_frame_timestamps(
    frames: Sequence[PredictionFrame], duration_ms: int
) -> list[PredictionFrame]:
    if not frames:
        return []

    first_timestamp = frames[0].timestampMs
    normalized: list[PredictionFrame] = []
    previous_timestamp = -1
    for frame in frames:
        timestamp = frame.timestampMs - first_timestamp
        if timestamp <= previous_timestamp:
            raise ValueError("Workflow frame timestamps must be strictly increasing")
        if timestamp > duration_ms:
            raise ValueError("Workflow frame timestamp exceeds media duration")
        normalized.append(
            PredictionFrame(
                timestampMs=timestamp,
                predictions=frame.predictions,
            )
        )
        previous_timestamp = timestamp
    return normalized


@dataclass(frozen=True, slots=True)
class _QualifyingFrame:
    timestamp_ms: int
    peak_confidence: float


@dataclass(frozen=True, slots=True)
class _EventValues:
    start_ms: int
    end_ms: int
    peak_confidence: float
    qualifying_frame_count: int


def _build_missing_hard_hat_events(
    frames: Sequence[PredictionFrame], duration_ms: int
) -> list[PredictionEvent]:
    confirmation_window: deque[_QualifyingFrame | None] = deque(
        maxlen=CONFIRMING_WINDOW_SIZE
    )
    events: list[_EventValues] = []
    active_frames: list[_QualifyingFrame] | None = None
    consecutive_gaps = 0

    for frame in frames:
        confidence = _qualifying_confidence(frame)
        qualifying = (
            _QualifyingFrame(frame.timestampMs, confidence)
            if confidence is not None
            else None
        )

        if active_frames is None:
            confirmation_window.append(qualifying)
            candidate_frames = [
                candidate for candidate in confirmation_window if candidate is not None
            ]
            if len(candidate_frames) >= CONFIRMING_FRAME_COUNT:
                active_frames = candidate_frames
                consecutive_gaps = 0 if qualifying is not None else 1
                confirmation_window.clear()
            continue

        if qualifying is not None:
            active_frames.append(qualifying)
            consecutive_gaps = 0
            continue

        consecutive_gaps += 1
        if consecutive_gaps >= ENDING_GAP_FRAME_COUNT:
            events.append(_event_values(active_frames, active_frames[-1].timestamp_ms))
            active_frames = None
            confirmation_window.clear()
            consecutive_gaps = 0

    if active_frames is not None:
        events.append(_event_values(active_frames, duration_ms))

    merged: list[_EventValues] = []
    for event in events:
        if merged and event.start_ms - merged[-1].end_ms < MERGE_GAP_MS:
            previous = merged[-1]
            merged[-1] = _EventValues(
                start_ms=previous.start_ms,
                end_ms=event.end_ms,
                peak_confidence=max(previous.peak_confidence, event.peak_confidence),
                qualifying_frame_count=(
                    previous.qualifying_frame_count + event.qualifying_frame_count
                ),
            )
        else:
            merged.append(event)

    return [
        PredictionEvent(
            id=f"event-{index:03d}",
            type="missing_hard_hat",
            label="Missing hard hat",
            startMs=event.start_ms,
            endMs=event.end_ms,
            peakConfidence=event.peak_confidence,
            qualifyingFrameCount=event.qualifying_frame_count,
        )
        for index, event in enumerate(merged)
    ]


def _qualifying_confidence(frame: PredictionFrame) -> float | None:
    return max(
        (
            prediction.confidence
            for prediction in frame.predictions
            if prediction.className == "NO-Hardhat"
            and prediction.confidence >= QUALIFYING_CONFIDENCE
        ),
        default=None,
    )


def _event_values(
    qualifying_frames: Sequence[_QualifyingFrame], end_ms: int
) -> _EventValues:
    return _EventValues(
        start_ms=qualifying_frames[0].timestamp_ms,
        end_ms=end_ms,
        peak_confidence=max(frame.peak_confidence for frame in qualifying_frames),
        qualifying_frame_count=len(qualifying_frames),
    )
