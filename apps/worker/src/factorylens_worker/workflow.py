from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar, Literal, Protocol
from urllib.parse import urlsplit

from factorylens_worker.contracts import (
    FramePrediction,
    PredictionBox,
    PredictionFrame,
)

FIXTURE_WORKFLOW_ENDPOINT = "fixture://assembly-line-no-hard-hat"
DEFAULT_WORKFLOW_ENDPOINT = FIXTURE_WORKFLOW_ENDPOINT
FIXTURE_WORKFLOW_FINGERPRINT = (
    "sha256:6f17fa35c215660fe398df8bd98157759817bfa859be8065ae1c19312ef07d62"
)

SAMPLE_WIDTH = 1840
SAMPLE_HEIGHT = 1080
SAMPLE_FRAME_COUNT = 10
SAMPLE_FRAME_INTERVAL_MS = 200


@dataclass(frozen=True, slots=True)
class WorkflowConfiguration:
    """Provider-neutral identity and endpoint for one Workflow execution."""

    endpoint: str
    key: Literal["factory-safety-v1"] = "factory-safety-v1"
    workflow_id: Literal["hard-hat-compliance-v1"] = "hard-hat-compliance-v1"
    workflow_version: Literal["1"] = "1"
    model_id: Literal["construction-site-safety/27"] = "construction-site-safety/27"
    fingerprint: str = FIXTURE_WORKFLOW_FINGERPRINT

    def __post_init__(self) -> None:
        if not isinstance(self.endpoint, str):
            raise TypeError("Workflow endpoint must be a string")
        endpoint = urlsplit(self.endpoint)
        if not endpoint.scheme:
            raise ValueError("Workflow endpoint must be an absolute URL")
        if re.fullmatch(r"sha256:[0-9a-f]{64}", self.fingerprint) is None:
            raise ValueError("Workflow fingerprint must be a SHA-256 fingerprint")


@dataclass(frozen=True, slots=True)
class WorkflowImage:
    """One decoded RGB frame without a provider SDK image type."""

    width: int
    height: int
    rgb24: bytes

    def __post_init__(self) -> None:
        if (
            isinstance(self.width, bool)
            or isinstance(self.height, bool)
            or not isinstance(self.width, int)
            or not isinstance(self.height, int)
            or self.width <= 0
            or self.height <= 0
        ):
            raise ValueError("Workflow image dimensions must be positive integers")
        if not isinstance(self.rgb24, bytes):
            raise TypeError("Workflow RGB image data must be bytes")
        expected_size = self.width * self.height * 3
        if len(self.rgb24) != expected_size:
            raise ValueError(
                f"Workflow RGB image must contain exactly {expected_size} bytes"
            )


@dataclass(frozen=True, slots=True)
class WorkflowFrameInput:
    """Presentation metadata and decoded image for a sampled video frame."""

    frame_index: int
    timestamp_ms: int
    image: WorkflowImage

    def __post_init__(self) -> None:
        if (
            isinstance(self.frame_index, bool)
            or not isinstance(self.frame_index, int)
            or self.frame_index < 0
        ):
            raise ValueError("Workflow frame index must be a non-negative integer")
        if (
            isinstance(self.timestamp_ms, bool)
            or not isinstance(self.timestamp_ms, int)
            or self.timestamp_ms < 0
        ):
            raise ValueError("Workflow timestamp must be a non-negative integer")


class WorkflowRunner(Protocol):
    def run_frame(
        self, frame: WorkflowFrameInput, configuration: WorkflowConfiguration
    ) -> PredictionFrame: ...


class WorkflowRunnerError(RuntimeError):
    code: ClassVar[str]
    retryable: ClassVar[bool]


class RetryableWorkflowProviderError(WorkflowRunnerError):
    code = "provider_unavailable"
    retryable = True


class InvalidWorkflowResponseError(WorkflowRunnerError):
    code = "provider_response_invalid"
    retryable = False


class UnsupportedWorkflowEndpointError(ValueError):
    pass


class FixtureFailureMode(StrEnum):
    NONE = "none"
    RETRYABLE_PROVIDER_ERROR = "retryable_provider_error"
    TERMINAL_INVALID_RESPONSE = "terminal_invalid_response"


_NO_HARD_HAT_CONFIDENCES = (0.91, 0.93, 0.94, 0.92, 0.95, 0.93, 0.91, 0.94, 0.92, 0.93)


class FixtureWorkflowRunner:
    """Deterministic adapter for the selected assembly-line sample."""

    def __init__(
        self, failure_mode: FixtureFailureMode = FixtureFailureMode.NONE
    ) -> None:
        self._failure_mode = failure_mode

    def run_frame(
        self, frame: WorkflowFrameInput, configuration: WorkflowConfiguration
    ) -> PredictionFrame:
        self._validate_selected_fixture(frame, configuration)

        if self._failure_mode is FixtureFailureMode.RETRYABLE_PROVIDER_ERROR:
            raise RetryableWorkflowProviderError(
                "The fixture simulated a temporary Workflow provider failure"
            )
        if self._failure_mode is FixtureFailureMode.TERMINAL_INVALID_RESPONSE:
            raise InvalidWorkflowResponseError(
                "The fixture simulated an invalid Workflow response"
            )

        frame_prefix = f"f{frame.frame_index:06d}"
        offset = frame.frame_index * 4
        predictions = [
            FramePrediction(
                id=f"{frame_prefix}-p000",
                className="Person",
                confidence=0.96,
                box=PredictionBox(
                    x=610.0 + offset,
                    y=565.0,
                    width=230.0,
                    height=650.0,
                ),
            ),
            FramePrediction(
                id=f"{frame_prefix}-p001",
                className="NO-Hardhat",
                confidence=_NO_HARD_HAT_CONFIDENCES[frame.frame_index],
                box=PredictionBox(
                    x=614.0 + offset,
                    y=238.0,
                    width=92.0,
                    height=108.0,
                ),
            ),
            FramePrediction(
                id=f"{frame_prefix}-p002",
                className="Hardhat",
                confidence=0.88,
                box=PredictionBox(
                    x=1310.0 - offset,
                    y=250.0,
                    width=104.0,
                    height=94.0,
                ),
            ),
        ]
        return PredictionFrame(
            timestampMs=frame.timestamp_ms,
            predictions=predictions,
        )

    @staticmethod
    def _validate_selected_fixture(
        frame: WorkflowFrameInput, configuration: WorkflowConfiguration
    ) -> None:
        if configuration.endpoint != FIXTURE_WORKFLOW_ENDPOINT:
            raise UnsupportedWorkflowEndpointError(
                f"Fixture runner cannot use endpoint {configuration.endpoint!r}"
            )
        if (
            configuration.key != "factory-safety-v1"
            or configuration.workflow_id != "hard-hat-compliance-v1"
            or configuration.workflow_version != "1"
            or configuration.model_id != "construction-site-safety/27"
        ):
            raise ValueError(
                "Fixture runner requires the selected Workflow configuration"
            )
        if frame.image.width != SAMPLE_WIDTH or frame.image.height != SAMPLE_HEIGHT:
            raise ValueError("Fixture runner requires the selected sample dimensions")
        if frame.frame_index >= SAMPLE_FRAME_COUNT:
            raise ValueError(
                "Fixture runner received a frame outside the selected sample"
            )
        expected_timestamp = frame.frame_index * SAMPLE_FRAME_INTERVAL_MS
        if frame.timestamp_ms != expected_timestamp:
            raise ValueError("Fixture runner requires the selected sample timestamps")


def workflow_configuration_from_environment(
    environment: Mapping[str, str] | None = None,
) -> WorkflowConfiguration:
    values = os.environ if environment is None else environment
    return WorkflowConfiguration(
        endpoint=values.get("WORKFLOW_ENDPOINT", DEFAULT_WORKFLOW_ENDPOINT)
    )


def create_workflow_runner(
    configuration: WorkflowConfiguration,
    *,
    fixture_failure_mode: FixtureFailureMode = FixtureFailureMode.NONE,
) -> WorkflowRunner:
    if configuration.endpoint == FIXTURE_WORKFLOW_ENDPOINT:
        return FixtureWorkflowRunner(fixture_failure_mode)
    raise UnsupportedWorkflowEndpointError(
        f"No WorkflowRunner is configured for endpoint {configuration.endpoint!r}"
    )
