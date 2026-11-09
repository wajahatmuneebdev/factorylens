import json
from pathlib import Path
from typing import Any

import pytest

from factorylens_worker.contracts import PredictionArtifactV1
from factorylens_worker.workflow import (
    FIXTURE_WORKFLOW_ENDPOINT,
    FixtureFailureMode,
    InvalidWorkflowResponseError,
    RetryableWorkflowProviderError,
    UnsupportedWorkflowEndpointError,
    WorkflowConfiguration,
    WorkflowFrameInput,
    WorkflowImage,
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


def test_runner_selection_uses_the_configured_endpoint() -> None:
    configuration = workflow_configuration_from_environment(
        {"WORKFLOW_ENDPOINT": "https://inference.example.test"}
    )

    with pytest.raises(
        UnsupportedWorkflowEndpointError, match="inference.example.test"
    ):
        create_workflow_runner(configuration)


def test_image_input_rejects_incomplete_rgb_data() -> None:
    with pytest.raises(ValueError, match="exactly 12 bytes"):
        WorkflowImage(width=2, height=2, rgb24=b"incomplete")
