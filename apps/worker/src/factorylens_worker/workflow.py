from __future__ import annotations

import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, ClassVar, Literal, Protocol
from urllib.parse import urlsplit

from factorylens_worker.contracts import (
    FramePrediction,
    PredictionBox,
    PredictionFrame,
)

if TYPE_CHECKING:
    from factorylens_worker.roboflow_workflow import RoboflowWorkflowTransport

FIXTURE_WORKFLOW_ENDPOINT = "fixture://assembly-line-no-hard-hat"
DEFAULT_WORKFLOW_ENDPOINT = FIXTURE_WORKFLOW_ENDPOINT
FIXTURE_WORKFLOW_FINGERPRINT = (
    "sha256:6f17fa35c215660fe398df8bd98157759817bfa859be8065ae1c19312ef07d62"
)

SAMPLE_WIDTH = 1840
SAMPLE_HEIGHT = 1080
SAMPLE_FRAME_COUNT = 10
SAMPLE_FRAME_INTERVAL_MS = 200
DEFAULT_WORKFLOW_REQUEST_TIMEOUT_SECONDS = 30.0


class WorkflowCredentialSource(StrEnum):
    NONE = "none"
    ROBOFLOW_API_KEY = "roboflow-api-key"


@dataclass(frozen=True, slots=True)
class WorkflowConfiguration:
    """Provider-neutral identity and endpoint for one Workflow execution."""

    endpoint: str
    key: Literal["factory-safety-v1"] = "factory-safety-v1"
    workflow_id: Literal["hard-hat-compliance-v1"] = "hard-hat-compliance-v1"
    workflow_version: Literal["1"] = "1"
    model_id: Literal["construction-site-safety/27"] = "construction-site-safety/27"
    fingerprint: str = FIXTURE_WORKFLOW_FINGERPRINT
    workspace: str | None = None
    credential_source: WorkflowCredentialSource = WorkflowCredentialSource.NONE
    request_timeout_seconds: float = DEFAULT_WORKFLOW_REQUEST_TIMEOUT_SECONDS
    use_cache: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.endpoint, str):
            raise TypeError("Workflow endpoint must be a string")
        endpoint = urlsplit(self.endpoint)
        if not endpoint.scheme:
            raise ValueError("Workflow endpoint must be an absolute URL")
        if self.endpoint != FIXTURE_WORKFLOW_ENDPOINT:
            if endpoint.scheme not in {"http", "https"} or endpoint.netloc == "":
                raise ValueError("Workflow endpoint must use HTTP or HTTPS")
            if endpoint.username is not None or endpoint.password is not None:
                raise ValueError("Workflow endpoint must not contain credentials")
            if endpoint.query or endpoint.fragment:
                raise ValueError(
                    "Workflow endpoint must not contain a query or fragment"
                )
            if (
                self.workspace is None
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", self.workspace)
                is None
            ):
                raise ValueError(
                    "Workflow workspace must be configured for an HTTP endpoint"
                )
        elif self.workspace is not None:
            raise ValueError("Fixture Workflow endpoint does not use a workspace")
        if re.fullmatch(r"sha256:[0-9a-f]{64}", self.fingerprint) is None:
            raise ValueError("Workflow fingerprint must be a SHA-256 fingerprint")
        if (
            isinstance(self.request_timeout_seconds, bool)
            or not isinstance(self.request_timeout_seconds, (int, float))
            or not math.isfinite(self.request_timeout_seconds)
            or self.request_timeout_seconds <= 0
        ):
            raise ValueError("Workflow request timeout must be positive")
        if not isinstance(self.use_cache, bool):
            raise TypeError("Workflow cache setting must be a boolean")


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
        self,
        frame: WorkflowFrameInput,
        configuration: WorkflowConfiguration,
        *,
        is_cancelled: Callable[[], bool] = lambda: False,
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


class TerminalWorkflowProviderError(WorkflowRunnerError):
    code = "provider_request_rejected"
    retryable = False


class WorkflowProviderTimeoutError(RetryableWorkflowProviderError):
    code = "provider_timeout"


class WorkflowProviderRateLimitError(RetryableWorkflowProviderError):
    code = "provider_rate_limited"


class WorkflowCancelledError(WorkflowRunnerError):
    code = "inspection_cancelled"
    category: ClassVar[Literal["cancelled"]] = "cancelled"
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
        self,
        frame: WorkflowFrameInput,
        configuration: WorkflowConfiguration,
        *,
        is_cancelled: Callable[[], bool] = lambda: False,
    ) -> PredictionFrame:
        if is_cancelled():
            raise WorkflowCancelledError("Workflow execution was cancelled")
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
    endpoint = values.get("WORKFLOW_ENDPOINT", DEFAULT_WORKFLOW_ENDPOINT)
    if endpoint == FIXTURE_WORKFLOW_ENDPOINT:
        return WorkflowConfiguration(endpoint=endpoint)

    credential_source_value = values.get(
        "WORKFLOW_CREDENTIAL_SOURCE", WorkflowCredentialSource.ROBOFLOW_API_KEY.value
    )
    try:
        credential_source = WorkflowCredentialSource(credential_source_value)
    except ValueError as error:
        raise ValueError(
            "WORKFLOW_CREDENTIAL_SOURCE must be 'none' or 'roboflow-api-key'"
        ) from error

    timeout_value = values.get(
        "WORKFLOW_REQUEST_TIMEOUT_SECONDS",
        str(DEFAULT_WORKFLOW_REQUEST_TIMEOUT_SECONDS),
    )
    try:
        request_timeout_seconds = float(timeout_value)
    except ValueError as error:
        raise ValueError("WORKFLOW_REQUEST_TIMEOUT_SECONDS must be a number") from error

    return WorkflowConfiguration(
        endpoint=endpoint,
        workspace=values.get("WORKFLOW_WORKSPACE"),
        credential_source=credential_source,
        request_timeout_seconds=request_timeout_seconds,
        use_cache=_environment_boolean(values, "WORKFLOW_USE_CACHE", default=True),
        fingerprint=values.get("WORKFLOW_FINGERPRINT", ""),
    )


def create_workflow_runner(
    configuration: WorkflowConfiguration,
    *,
    fixture_failure_mode: FixtureFailureMode = FixtureFailureMode.NONE,
    environment: Mapping[str, str] | None = None,
    roboflow_transport: RoboflowWorkflowTransport | None = None,
) -> WorkflowRunner:
    if configuration.endpoint == FIXTURE_WORKFLOW_ENDPOINT:
        return FixtureWorkflowRunner(fixture_failure_mode)

    values = os.environ if environment is None else environment
    api_key: str | None = None
    if configuration.credential_source is WorkflowCredentialSource.ROBOFLOW_API_KEY:
        api_key = values.get("ROBOFLOW_API_KEY")
        if api_key is None or api_key == "":
            raise ValueError(
                "ROBOFLOW_API_KEY is required by WORKFLOW_CREDENTIAL_SOURCE"
            )

    from factorylens_worker.roboflow_workflow import RoboflowWorkflowRunner

    return RoboflowWorkflowRunner(
        api_key=api_key,
        transport=roboflow_transport,
    )


def _environment_boolean(
    environment: Mapping[str, str], name: str, *, default: bool
) -> bool:
    value = environment.get(name)
    if value is None:
        return default
    normalized = value.lower()
    if normalized in {"1", "true"}:
        return True
    if normalized in {"0", "false"}:
        return False
    raise ValueError(f"{name} must be true or false")
