import json

from factorylens_worker.observability import redact_log_value, write_structured_log


def test_structured_log_is_json_and_redacts_prohibited_values(capsys) -> None:  # type: ignore[no-untyped-def]
    write_structured_log(
        "error",
        "task_failed",
        authorization="Bearer private-token",
        correlationId="018f4f72-3d3a-7c1c-b10b-f2a7c849e831",
        jobId="018f4f72-3d3a-7c1c-b10b-f2a7c849e831",
        rawPredictions=[{"confidence": 0.99}],
    )

    entry = json.loads(capsys.readouterr().err)
    assert entry["event"] == "task_failed"
    assert entry["service"] == "worker"
    assert entry["authorization"] == "[REDACTED]"
    assert entry["rawPredictions"] == "[REDACTED]"
    assert "private-token" not in json.dumps(entry)
    assert "confidence" not in json.dumps(entry)


def test_redaction_recurses_through_nested_context() -> None:
    assert redact_log_value({"nested": {"sessionToken": "private"}}) == {
        "nested": {"sessionToken": "[REDACTED]"}
    }
