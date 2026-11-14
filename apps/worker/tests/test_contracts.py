import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from factorylens_worker.contracts import PredictionArtifactV1, ProcessTaskMessage

FIXTURES = Path(__file__).parents[3] / "fixtures" / "contracts"


def load_fixture(name: str) -> dict[str, Any]:
    value: object = json.loads((FIXTURES / name).read_text())
    assert isinstance(value, dict)
    return value


def test_task_fixture_validates_and_rejects_extra_payload() -> None:
    payload = load_fixture("process-task-message.json")

    task = ProcessTaskMessage.model_validate_json(json.dumps(payload))

    assert task.dispatchGeneration == 2
    with pytest.raises(ValidationError):
        ProcessTaskMessage.model_validate_json(
            json.dumps({**payload, "inspectionId": str(task.jobId)})
        )
    with pytest.raises(ValidationError):
        ProcessTaskMessage.model_validate_json(
            json.dumps({**payload, "dispatchGeneration": 2**53})
        )
    with pytest.raises(ValidationError, match="durable job identity"):
        ProcessTaskMessage.model_validate_json(
            json.dumps(
                {
                    **payload,
                    "correlationId": "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
                }
            )
        )


def test_prediction_fixture_validates() -> None:
    artifact = PredictionArtifactV1.model_validate_json(
        json.dumps(load_fixture("prediction-artifact-v1.json"))
    )

    assert artifact.schemaVersion == 1
    assert artifact.source.sampleRateFps == 5
    assert artifact.summary.missingHardHatEventCount == 1


def test_prediction_artifact_rejects_non_monotonic_timestamps() -> None:
    payload = load_fixture("prediction-artifact-v1.json")
    frames = payload["frames"]
    assert isinstance(frames, list)
    second_frame = frames[1]
    assert isinstance(second_frame, dict)
    second_frame["timestampMs"] = 0

    with pytest.raises(ValidationError, match="strictly increasing"):
        PredictionArtifactV1.model_validate_json(json.dumps(payload))


def test_prediction_artifact_allows_unconfirmed_qualifying_frames() -> None:
    payload = load_fixture("prediction-artifact-v1.json")
    frames = payload["frames"]
    assert isinstance(frames, list)
    third_frame = frames[2]
    assert isinstance(third_frame, dict)
    third_frame["predictions"] = []
    payload["events"] = []
    payload["summary"] = {
        "missingHardHatEventCount": 0,
        "qualifyingFrameCount": 2,
        "peakConfidence": 0.93,
    }

    artifact = PredictionArtifactV1.model_validate_json(json.dumps(payload))

    assert artifact.events == []
