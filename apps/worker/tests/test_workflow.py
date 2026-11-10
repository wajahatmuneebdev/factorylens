import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request

import pytest

from factorylens_worker import roboflow_workflow
from factorylens_worker.contracts import PredictionArtifactV1
from factorylens_worker.roboflow_workflow import (
    RoboflowWorkflowResponse,
    UrllibRoboflowWorkflowTransport,
    _TransportTimeoutError,
)
from factorylens_worker.workflow import (
    FIXTURE_WORKFLOW_ENDPOINT,
    FixtureFailureMode,
    InvalidWorkflowResponseError,
    RetryableWorkflowProviderError,
    TerminalWorkflowProviderError,
    WorkflowCancelledError,
    WorkflowConfiguration,
    WorkflowCredentialSource,
    WorkflowFrameInput,
    WorkflowImage,
    WorkflowProviderRateLimitError,
    WorkflowProviderTimeoutError,
    WorkflowRunner,
    create_workflow_runner,
    workflow_configuration_from_environment,
)

FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "fixtures"
    / "predictions"
    / "assembly-line-no-hard-hat.expected.json"
)
SAMPLE_RGB_FRAME = bytes(1840 * 1080 * 3)
PRODUCTION_FINGERPRINT = f"sha256:{'1' * 64}"


@dataclass
class RecordingTransport:
    response: RoboflowWorkflowResponse = RoboflowWorkflowResponse(
        status_code=200,
        body=b'{"outputs":[{"predictions":{"predictions":[]}}]}',
    )
    error: Exception | None = None
    calls: list[dict[str, object]] = field(default_factory=list)

    def post(
        self,
        *,
        url: str,
        payload: Mapping[str, object],
        api_key: str | None,
        timeout_seconds: float,
    ) -> RoboflowWorkflowResponse:
        self.calls.append(
            {
                "url": url,
                "payload": payload,
                "api_key": api_key,
                "timeout_seconds": timeout_seconds,
            }
        )
        if self.error is not None:
            raise self.error
        return self.response


class StubHttpResponse:
    status = 200

    def __init__(self) -> None:
        self.read_sizes: list[int] = []

    def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        return b'{"outputs":[]}'

    def __enter__(self) -> "StubHttpResponse":
        return self

    def __exit__(
        self,
        exception_type: object,
        exception: object,
        traceback: object,
    ) -> None:
        return None


class StubOpener:
    def __init__(self, response: StubHttpResponse) -> None:
        self.response = response
        self.request: object | None = None
        self.timeout: float | None = None

    def open(self, request: object, timeout: float) -> StubHttpResponse:
        self.request = request
        self.timeout = timeout
        return self.response


def load_fixture() -> dict[str, Any]:
    value: object = json.loads(FIXTURE_PATH.read_text())
    assert isinstance(value, dict)
    return value


def sample_input(frame_index: int) -> WorkflowFrameInput:
    return WorkflowFrameInput(
        frame_index=frame_index,
        timestamp_ms=frame_index * 200,
        image=WorkflowImage(
            width=1840,
            height=1080,
            rgb24=SAMPLE_RGB_FRAME,
        ),
    )


def production_input() -> WorkflowFrameInput:
    return WorkflowFrameInput(
        frame_index=7,
        timestamp_ms=1400,
        image=WorkflowImage(
            width=4,
            height=3,
            rgb24=bytes(range(36)),
        ),
    )


def production_configuration() -> WorkflowConfiguration:
    return WorkflowConfiguration(
        endpoint="https://serverless.roboflow.com",
        workspace="factory-lens",
        credential_source=WorkflowCredentialSource.ROBOFLOW_API_KEY,
        request_timeout_seconds=12.5,
        use_cache=False,
        fingerprint=PRODUCTION_FINGERPRINT,
    )


def test_fixture_output_is_deterministic_and_satisfies_prediction_v1() -> None:
    payload = load_fixture()
    configuration = workflow_configuration_from_environment(
        {"WORKFLOW_ENDPOINT": FIXTURE_WORKFLOW_ENDPOINT}
    )
    runner: WorkflowRunner = create_workflow_runner(configuration)

    frames = [
        runner.run_frame(sample_input(index), configuration) for index in range(10)
    ]
    repeated_frame = runner.run_frame(sample_input(4), configuration)

    assert [frame.model_dump() for frame in frames] == payload["frames"]
    assert repeated_frame == frames[4]
    artifact = PredictionArtifactV1.model_validate_json(json.dumps(payload))
    assert artifact.frames == frames
    assert artifact.events[0].startMs == 0
    assert artifact.events[0].endMs == 2000
    assert artifact.summary.missingHardHatEventCount == 1


@pytest.mark.parametrize(
    ("mode", "error_type", "code", "retryable"),
    [
        (
            FixtureFailureMode.RETRYABLE_PROVIDER_ERROR,
            RetryableWorkflowProviderError,
            "provider_unavailable",
            True,
        ),
        (
            FixtureFailureMode.TERMINAL_INVALID_RESPONSE,
            InvalidWorkflowResponseError,
            "provider_response_invalid",
            False,
        ),
    ],
)
def test_fixture_simulates_classified_provider_failures(
    mode: FixtureFailureMode,
    error_type: type[RetryableWorkflowProviderError]
    | type[InvalidWorkflowResponseError],
    code: str,
    retryable: bool,
) -> None:
    configuration = WorkflowConfiguration(endpoint=FIXTURE_WORKFLOW_ENDPOINT)
    runner = create_workflow_runner(configuration, fixture_failure_mode=mode)

    with pytest.raises(error_type) as raised:
        runner.run_frame(sample_input(0), configuration)

    assert raised.value.code == code
    assert raised.value.retryable is retryable


def test_runner_selection_uses_the_configured_endpoint_and_credential_source() -> None:
    configuration = workflow_configuration_from_environment(
        {
            "WORKFLOW_ENDPOINT": "https://inference.example.test/",
            "WORKFLOW_WORKSPACE": "factory-lens",
            "WORKFLOW_CREDENTIAL_SOURCE": "roboflow-api-key",
            "WORKFLOW_FINGERPRINT": PRODUCTION_FINGERPRINT,
            "WORKFLOW_REQUEST_TIMEOUT_SECONDS": "12.5",
            "WORKFLOW_USE_CACHE": "false",
        }
    )
    transport = RecordingTransport()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "private-api-key"},
        roboflow_transport=transport,
    )

    result = runner.run_frame(production_input(), configuration)

    assert result.timestampMs == 1400
    assert result.predictions == []
    assert transport.calls[0]["url"] == (
        "https://inference.example.test/factory-lens/workflows/hard-hat-compliance-v1"
    )
    assert transport.calls[0]["api_key"] == "private-api-key"
    assert transport.calls[0]["timeout_seconds"] == 12.5
    payload = transport.calls[0]["payload"]
    assert isinstance(payload, dict)
    assert payload["workflow_version_id"] == "1"
    assert payload["use_cache"] is False
    assert payload["enable_profiling"] is False
    assert payload["disable_sinks"] is True
    inputs = payload["inputs"]
    assert isinstance(inputs, dict)
    image = inputs["image"]
    assert isinstance(image, dict)
    assert image["type"] == "base64"
    assert isinstance(image["value"], str)
    assert image["value"].startswith("iVBORw0KGgo")
    assert "private-api-key" not in json.dumps(payload)


def test_http_transport_uses_header_auth_timeout_and_bounded_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = StubHttpResponse()
    opener = StubOpener(response)
    handlers: tuple[object, ...] = ()

    def build_stub_opener(*configured_handlers: object) -> StubOpener:
        nonlocal handlers
        handlers = configured_handlers
        return opener

    monkeypatch.setattr(roboflow_workflow, "build_opener", build_stub_opener)
    transport = UrllibRoboflowWorkflowTransport()

    result = transport.post(
        url="https://inference.example.test/workspace/workflows/workflow",
        payload={"inputs": {}},
        api_key="private-api-key",
        timeout_seconds=4.5,
    )

    assert result.status_code == 200
    assert opener.timeout == 4.5
    assert isinstance(opener.request, Request)
    assert opener.request.get_header("Authorization") == "Bearer private-api-key"
    assert "private-api-key" not in opener.request.full_url
    assert response.read_sizes == [roboflow_workflow.MAX_WORKFLOW_RESPONSE_BYTES + 1]
    assert len(handlers) == 1
    assert isinstance(handlers[0], roboflow_workflow._NoRedirectHandler)


def test_http_runner_can_use_a_credential_free_compatible_endpoint() -> None:
    configuration = WorkflowConfiguration(
        endpoint="http://127.0.0.1:9001",
        workspace="factory-lens",
        credential_source=WorkflowCredentialSource.NONE,
        fingerprint=PRODUCTION_FINGERPRINT,
    )
    transport = RecordingTransport()
    runner = create_workflow_runner(
        configuration,
        environment={},
        roboflow_transport=transport,
    )

    runner.run_frame(production_input(), configuration)

    assert transport.calls[0]["api_key"] is None


def test_configured_credential_must_be_present() -> None:
    configuration = production_configuration()

    with pytest.raises(ValueError, match="ROBOFLOW_API_KEY"):
        create_workflow_runner(configuration, environment={})


def test_provider_output_is_validated_clipped_and_mapped() -> None:
    response = {
        "outputs": [
            {
                "predictions": {
                    "image": {"width": 4, "height": 3},
                    "predictions": [
                        {
                            "class": "NO-Hardhat",
                            "confidence": 0.91,
                            "x": 1.0,
                            "y": 1.0,
                            "width": 4.0,
                            "height": 4.0,
                            "detection_id": "provider-private-id",
                        },
                        {
                            "class": "Person",
                            "confidence": 0.8,
                            "x": 20.0,
                            "y": 20.0,
                            "width": 2.0,
                            "height": 2.0,
                        },
                    ],
                }
            }
        ],
        "profiler_trace": [{"private": "ignored"}],
    }
    transport = RecordingTransport(
        response=RoboflowWorkflowResponse(
            status_code=200,
            body=json.dumps(response).encode(),
        )
    )
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "secret"},
        roboflow_transport=transport,
    )

    result = runner.run_frame(production_input(), configuration)

    assert result.model_dump() == {
        "timestampMs": 1400,
        "predictions": [
            {
                "id": "f000007-p000",
                "className": "NO-Hardhat",
                "confidence": 0.91,
                "box": {"x": 1.5, "y": 1.5, "width": 3.0, "height": 3.0},
            }
        ],
    }


@pytest.mark.parametrize(
    "body",
    [
        b"not-json",
        b'{"outputs":[]}',
        b'{"outputs":[{"predictions":{"predictions":[]}},'
        b'{"predictions":{"predictions":[]}}]}',
        b'{"outputs":[{"predictions":{"predictions":['
        b'{"class":"Worker","confidence":0.9,"x":1.0,"y":1.0,'
        b'"width":1.0,"height":1.0}]}}]}',
        b'{"outputs":[{"predictions":{"predictions":['
        b'{"class":"Person","confidence":"0.9","x":1.0,"y":1.0,'
        b'"width":1.0,"height":1.0}]}}]}',
        b'{"outputs":[{"predictions":{"predictions":[]},"raw":"private"}]}',
    ],
)
def test_invalid_provider_responses_are_terminal(body: bytes) -> None:
    transport = RecordingTransport(
        response=RoboflowWorkflowResponse(status_code=200, body=body)
    )
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "secret"},
        roboflow_transport=transport,
    )

    with pytest.raises(InvalidWorkflowResponseError) as raised:
        runner.run_frame(production_input(), configuration)

    assert raised.value.code == "provider_response_invalid"
    assert raised.value.retryable is False


@pytest.mark.parametrize(
    ("status", "error_type", "code", "retryable"),
    [
        (408, WorkflowProviderTimeoutError, "provider_timeout", True),
        (429, WorkflowProviderRateLimitError, "provider_rate_limited", True),
        (503, RetryableWorkflowProviderError, "provider_unavailable", True),
        (401, TerminalWorkflowProviderError, "provider_request_rejected", False),
    ],
)
def test_http_failures_are_classified_without_exposing_private_data(
    status: int,
    error_type: type[Exception],
    code: str,
    retryable: bool,
) -> None:
    transport = RecordingTransport(
        response=RoboflowWorkflowResponse(
            status_code=status,
            body=b'{"raw_private_payload":"do-not-log"}',
        )
    )
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "do-not-log-secret"},
        roboflow_transport=transport,
    )

    with pytest.raises(error_type) as raised:
        runner.run_frame(production_input(), configuration)

    error = raised.value
    assert getattr(error, "code") == code
    assert getattr(error, "retryable") is retryable
    assert "do-not-log" not in str(error)


def test_transport_timeout_is_retryable() -> None:
    transport = RecordingTransport(error=_TransportTimeoutError())
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "secret"},
        roboflow_transport=transport,
    )

    with pytest.raises(WorkflowProviderTimeoutError) as raised:
        runner.run_frame(production_input(), configuration)

    assert raised.value.retryable is True


def test_cancellation_before_request_skips_provider() -> None:
    transport = RecordingTransport()
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "secret"},
        roboflow_transport=transport,
    )

    with pytest.raises(WorkflowCancelledError) as raised:
        runner.run_frame(production_input(), configuration, is_cancelled=lambda: True)

    assert raised.value.category == "cancelled"
    assert raised.value.retryable is False
    assert transport.calls == []


def test_cancellation_after_provider_response_discards_output() -> None:
    checks = iter([False, False, True])
    transport = RecordingTransport()
    configuration = production_configuration()
    runner = create_workflow_runner(
        configuration,
        environment={"ROBOFLOW_API_KEY": "secret"},
        roboflow_transport=transport,
    )

    with pytest.raises(WorkflowCancelledError):
        runner.run_frame(
            production_input(),
            configuration,
            is_cancelled=lambda: next(checks),
        )

    assert len(transport.calls) == 1


def test_image_input_rejects_incomplete_rgb_data() -> None:
    with pytest.raises(ValueError, match="exactly 12 bytes"):
        WorkflowImage(width=2, height=2, rgb24=b"incomplete")
