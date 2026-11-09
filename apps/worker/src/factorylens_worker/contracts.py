from __future__ import annotations

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ContractModel(BaseModel):
    """Reject coercion and undeclared fields at worker contract boundaries."""

    model_config = ConfigDict(extra="forbid", strict=True)


PositiveInt = Annotated[int, Field(gt=0)]
NonNegativeInt = Annotated[int, Field(ge=0)]
Confidence = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
PositiveNumber = Annotated[float, Field(gt=0, allow_inf_nan=False)]
NonNegativeNumber = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class ProcessTaskMessage(ContractModel):
    jobId: UUID
    dispatchGeneration: PositiveInt


class PredictionBox(ContractModel):
    x: NonNegativeNumber
    y: NonNegativeNumber
    width: PositiveNumber
    height: PositiveNumber


class FramePrediction(ContractModel):
    id: Annotated[str, Field(min_length=1, max_length=128)]
    className: Literal["Person", "Hardhat", "NO-Hardhat"]
    confidence: Confidence
    box: PredictionBox


class PredictionFrame(ContractModel):
    timestampMs: NonNegativeInt
    predictions: list[FramePrediction]


class PredictionEvent(ContractModel):
    id: Annotated[str, Field(min_length=1, max_length=128)]
    type: Literal["missing_hard_hat"]
    label: Literal["Missing hard hat"]
    startMs: NonNegativeInt
    endMs: NonNegativeInt
    peakConfidence: Confidence
    qualifyingFrameCount: PositiveInt

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if self.startMs > self.endMs:
            raise ValueError("Event startMs must not be after endMs")
        return self


class ArtifactSource(ContractModel):
    width: PositiveInt
    height: PositiveInt
    durationMs: PositiveInt
    timeBase: Literal["milliseconds"]
    sampleRateFps: PositiveNumber


class ArtifactWorkflow(ContractModel):
    key: Literal["factory-safety-v1"]
    workflowId: Literal["hard-hat-compliance-v1"]
    workflowVersion: Literal["1"]
    modelId: Literal["construction-site-safety/27"]
    fingerprint: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]


class ArtifactSummary(ContractModel):
    missingHardHatEventCount: NonNegativeInt
    qualifyingFrameCount: NonNegativeInt
    peakConfidence: Confidence | None


class PredictionArtifactV1(ContractModel):
    schemaVersion: Literal[1]
    inspectionId: UUID
    source: ArtifactSource
    workflow: ArtifactWorkflow
    classes: tuple[Literal["Person"], Literal["Hardhat"], Literal["NO-Hardhat"]]
    frames: list[PredictionFrame]
    events: list[PredictionEvent]
    summary: ArtifactSummary

    @model_validator(mode="after")
    def validate_artifact_invariants(self) -> Self:
        timestamps = [frame.timestampMs for frame in self.frames]
        if any(
            current <= previous for previous, current in zip(timestamps, timestamps[1:])
        ):
            raise ValueError("Frame timestamps must be strictly increasing")
        if timestamps and timestamps[-1] > self.source.durationMs:
            raise ValueError("Frame timestamp exceeds source duration")

        prediction_ids: list[str] = []
        for frame in self.frames:
            for prediction in frame.predictions:
                prediction_ids.append(prediction.id)
                box = prediction.box
                if (
                    box.x - box.width / 2 < 0
                    or box.x + box.width / 2 > self.source.width
                    or box.y - box.height / 2 < 0
                    or box.y + box.height / 2 > self.source.height
                ):
                    raise ValueError(
                        "Prediction box must be clipped to the source dimensions"
                    )
        if len(prediction_ids) != len(set(prediction_ids)):
            raise ValueError("Prediction IDs must be unique within the artifact")

        event_ids = [event.id for event in self.events]
        if len(event_ids) != len(set(event_ids)):
            raise ValueError("Event IDs must be unique within the artifact")
        if any(event.endMs > self.source.durationMs for event in self.events):
            raise ValueError("Event endMs exceeds source duration")
        if self.summary.missingHardHatEventCount != len(self.events):
            raise ValueError("Summary event count must match the events array")
        qualifying_predictions = [
            prediction
            for frame in self.frames
            for prediction in frame.predictions
            if prediction.className == "NO-Hardhat" and prediction.confidence >= 0.6
        ]
        qualifying_frame_count = sum(
            any(
                prediction.className == "NO-Hardhat" and prediction.confidence >= 0.6
                for prediction in frame.predictions
            )
            for frame in self.frames
        )
        if self.summary.qualifyingFrameCount != qualifying_frame_count:
            raise ValueError("Summary qualifying frame count must match the events")

        peak = max(
            (prediction.confidence for prediction in qualifying_predictions),
            default=None,
        )
        if peak is None:
            if self.summary.peakConfidence is not None:
                raise ValueError("Summary peak confidence must be null without events")
        elif self.summary.peakConfidence != peak:
            raise ValueError("Summary peak confidence must match the event peak")

        return self
