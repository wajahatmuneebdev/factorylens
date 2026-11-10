import os

import pytest

from factorylens_worker.workflow import (
    FIXTURE_WORKFLOW_ENDPOINT,
    WorkflowFrameInput,
    WorkflowImage,
    create_workflow_runner,
    workflow_configuration_from_environment,
)

pytestmark = pytest.mark.roboflow_integration


def test_selected_roboflow_workflow() -> None:
    if os.environ.get("RUN_ROBOFLOW_INTEGRATION") != "1":
        pytest.skip("set RUN_ROBOFLOW_INTEGRATION=1 to call the configured Workflow")

    configuration = workflow_configuration_from_environment()
    if configuration.endpoint == FIXTURE_WORKFLOW_ENDPOINT:
        pytest.fail("WORKFLOW_ENDPOINT must select Roboflow Cloud or Inference")

    runner = create_workflow_runner(configuration)
    frame = WorkflowFrameInput(
        frame_index=0,
        timestamp_ms=0,
        image=WorkflowImage(
            width=64,
            height=64,
            rgb24=bytes(64 * 64 * 3),
        ),
    )

    result = runner.run_frame(frame, configuration)

    assert result.timestampMs == 0
    assert all(
        prediction.className in {"Person", "Hardhat", "NO-Hardhat"}
        for prediction in result.predictions
    )
