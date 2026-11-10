import json
import subprocess
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest

from factorylens_worker.media_validation import (
    FfprobeRunner,
    InspectedMediaMetadata,
    MediaLimits,
    MediaMetadataPersistenceError,
    MediaValidationCancelled,
    MediaValidationError,
    MediaValidationStage,
    parse_and_validate_probe,
)
from factorylens_worker.storage import (
    LocalFilesystemStorage,
    StorageObjectMetadata,
    source_object_key,
)

FIXTURE_PATH = Path(__file__).parents[3] / "fixtures" / "media" / "valid-ffprobe.json"
INSPECTION_ID = UUID("018f4f72-3d3a-7c1c-b10b-f2a7c849e830")


class UnderreportingStorage(LocalFilesystemStorage):
    def metadata(self, key: str) -> StorageObjectMetadata:
        metadata = super().metadata(key)
        return StorageObjectMetadata(key=metadata.key, size_bytes=1)


def valid_probe() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text())  # type: ignore[no-any-return]


class FixtureProbeRunner:
    def __init__(self, payload: dict[str, object] | None = None) -> None:
        self.payload = payload or valid_probe()
        self.calls: list[tuple[Path, float, bytes]] = []

    def probe(self, source_path: Path, timeout_seconds: float) -> dict[str, object]:
        self.calls.append((source_path, timeout_seconds, source_path.read_bytes()))
        return self.payload


class RecordingMetadataStore:
    def __init__(self, accepted: bool = True) -> None:
        self.accepted = accepted
        self.records: list[tuple[UUID, UUID, InspectedMediaMetadata]] = []

    def record(
        self,
        job_id: UUID,
        lease_token: UUID,
        metadata: InspectedMediaMetadata,
    ) -> bool:
        self.records.append((job_id, lease_token, metadata))
        return self.accepted


def configured_stage(
    tmp_path: Path,
    *,
    source: bytes = b"bounded source",
    runner: FixtureProbeRunner | None = None,
    store: RecordingMetadataStore | None = None,
    limits: MediaLimits | None = None,
) -> tuple[MediaValidationStage, FixtureProbeRunner, RecordingMetadataStore, Path]:
    storage = LocalFilesystemStorage(tmp_path / "objects")
    storage.put(source_object_key(INSPECTION_ID), BytesIO(source))
    probe_runner = runner or FixtureProbeRunner()
    metadata_store = store or RecordingMetadataStore()
    temporary_directory = tmp_path / "temporary"
    temporary_directory.mkdir()
    return (
        MediaValidationStage(
            storage,
            metadata_store,
            limits=limits,
            probe_runner=probe_runner,
            ffprobe_timeout_seconds=3.5,
            temporary_directory=temporary_directory,
        ),
        probe_runner,
        metadata_store,
        temporary_directory,
    )


def test_valid_fixture_is_downloaded_probed_and_recorded(tmp_path: Path) -> None:
    stage, runner, store, temporary_directory = configured_stage(tmp_path)
    job_id = uuid4()
    lease_token = uuid4()

    metadata = stage.run(
        job_id=job_id,
        inspection_id=INSPECTION_ID,
        lease_token=lease_token,
    )

    assert metadata == InspectedMediaMetadata(
        size_bytes=len(b"bounded source"),
        content_type="video/webm",
        duration_ms=2000,
        width=1840,
        height=1080,
        container="matroska,webm",
        frame_rate="5/1",
        streams=metadata.streams,
    )
    assert [(stream.type, stream.codec) for stream in metadata.streams] == [
        ("video", "vp9"),
        ("audio", "opus"),
    ]
    assert runner.calls[0][1:] == (3.5, b"bounded source")
    assert store.records == [(job_id, lease_token, metadata)]
    assert list(temporary_directory.iterdir()) == []


def test_ffprobe_uses_an_argument_array_without_a_shell() -> None:
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=json.dumps(valid_probe()), stderr=""
    )
    with patch(
        "factorylens_worker.media_validation.subprocess.run", return_value=completed
    ) as run:
        result = FfprobeRunner("/usr/bin/ffprobe").probe(
            Path("source with spaces.webm"), 4.0
        )

    arguments = run.call_args.args[0]
    assert isinstance(arguments, list)
    assert arguments[0] == "/usr/bin/ffprobe"
    assert arguments[-1] == "source with spaces.webm"
    assert "shell" not in run.call_args.kwargs
    assert run.call_args.kwargs["timeout"] == 4.0
    assert result == valid_probe()


def test_corrupt_media_is_a_stable_terminal_error() -> None:
    completed = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="Invalid data found"
    )
    with patch(
        "factorylens_worker.media_validation.subprocess.run", return_value=completed
    ):
        with pytest.raises(MediaValidationError) as failure:
            FfprobeRunner().probe(Path("corrupt.webm"), 4.0)

    assert failure.value.code == "invalid_media"
    assert failure.value.category == "terminal"
    assert not failure.value.retryable
    assert "Invalid data found" not in failure.value.safe_message


def test_ffprobe_timeout_is_a_stable_terminal_error() -> None:
    with patch(
        "factorylens_worker.media_validation.subprocess.run",
        side_effect=subprocess.TimeoutExpired(["ffprobe"], 1),
    ):
        with pytest.raises(MediaValidationError) as failure:
            FfprobeRunner().probe(Path("slow.webm"), 1.0)

    assert failure.value.code == "invalid_media"
    assert not failure.value.retryable


@pytest.mark.parametrize("stream_type", ["subtitle", "data", "attachment"])
def test_unsupported_streams_are_rejected(stream_type: str) -> None:
    probe = valid_probe()
    streams = probe["streams"]
    assert isinstance(streams, list)
    streams.append({"index": 2, "codec_name": "unknown", "codec_type": stream_type})

    with pytest.raises(MediaValidationError) as failure:
        parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert failure.value.code == "unsupported_media"
    assert not failure.value.retryable


def test_configured_stream_count_limit_is_enforced() -> None:
    probe = valid_probe()
    streams = probe["streams"]
    assert isinstance(streams, list)
    second_audio = deepcopy(streams[1])
    assert isinstance(second_audio, dict)
    second_audio["index"] = 2
    streams.append(second_audio)

    with pytest.raises(MediaValidationError) as failure:
        parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert failure.value.code == "unsupported_media"


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        (("format", "duration", "300.001000"), "media_limit_exceeded"),
        (("stream", "width", 1921), "media_limit_exceeded"),
        (("stream", "avg_frame_rate", "0/0"), "invalid_media"),
    ],
)
def test_duration_resolution_and_frame_rate_rules_are_enforced(
    mutation: tuple[str, str, object], expected_code: str
) -> None:
    probe = valid_probe()
    target, field, value = mutation
    if target == "format":
        format_metadata = probe["format"]
        assert isinstance(format_metadata, dict)
        format_metadata[field] = value
    else:
        streams = probe["streams"]
        assert isinstance(streams, list)
        video = streams[0]
        assert isinstance(video, dict)
        video[field] = value
        if field == "avg_frame_rate":
            video["r_frame_rate"] = value

    with pytest.raises(MediaValidationError) as failure:
        parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert failure.value.code == expected_code


def test_portrait_video_within_the_configured_envelope_is_accepted() -> None:
    probe = valid_probe()
    streams = probe["streams"]
    assert isinstance(streams, list)
    video = streams[0]
    assert isinstance(video, dict)
    video["width"], video["height"] = 1080, 1920

    metadata = parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert (metadata.width, metadata.height) == (1080, 1920)


def test_video_stream_duration_is_used_when_container_duration_is_absent() -> None:
    probe = valid_probe()
    format_metadata = probe["format"]
    assert isinstance(format_metadata, dict)
    format_metadata["duration"] = "N/A"

    metadata = parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert metadata.duration_ms == 2000


def test_invalid_duration_shape_is_a_stable_terminal_error() -> None:
    probe = valid_probe()
    format_metadata = probe["format"]
    assert isinstance(format_metadata, dict)
    format_metadata["duration"] = {"seconds": 2}

    with pytest.raises(MediaValidationError) as failure:
        parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert failure.value.code == "invalid_media"
    assert not failure.value.retryable


def test_actual_download_size_is_bounded_when_storage_metadata_is_wrong(
    tmp_path: Path,
) -> None:
    storage = UnderreportingStorage(tmp_path / "objects")
    storage.put(source_object_key(INSPECTION_ID), BytesIO(b"123456"))
    runner = FixtureProbeRunner()
    store = RecordingMetadataStore()
    temporary_directory = tmp_path / "temporary"
    temporary_directory.mkdir()
    stage = MediaValidationStage(
        storage,
        store,
        limits=MediaLimits(max_size_bytes=5),
        probe_runner=runner,
        temporary_directory=temporary_directory,
    )

    with pytest.raises(MediaValidationError) as failure:
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            lease_token=uuid4(),
        )

    assert failure.value.code == "media_limit_exceeded"
    assert runner.calls == []
    assert store.records == []
    assert list(temporary_directory.iterdir()) == []


def test_cancellation_after_download_skips_probe_and_cleans_temporary_file(
    tmp_path: Path,
) -> None:
    stage, runner, store, temporary_directory = configured_stage(tmp_path)
    cancellation_checks = iter([False, True])

    with pytest.raises(MediaValidationCancelled) as failure:
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            lease_token=uuid4(),
            is_cancelled=lambda: next(cancellation_checks),
        )

    assert failure.value.category == "cancelled"
    assert runner.calls == []
    assert store.records == []
    assert list(temporary_directory.iterdir()) == []


def test_probe_failure_cleans_temporary_file(tmp_path: Path) -> None:
    probe = deepcopy(valid_probe())
    probe["streams"] = []
    stage, _, store, temporary_directory = configured_stage(
        tmp_path, runner=FixtureProbeRunner(probe)
    )

    with pytest.raises(MediaValidationError):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            lease_token=uuid4(),
        )

    assert store.records == []
    assert list(temporary_directory.iterdir()) == []


def test_stale_lease_rejects_metadata_after_temporary_cleanup(tmp_path: Path) -> None:
    stage, _, store, temporary_directory = configured_stage(
        tmp_path, store=RecordingMetadataStore(accepted=False)
    )

    with pytest.raises(MediaMetadataPersistenceError):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            lease_token=uuid4(),
        )

    assert len(store.records) == 1
    assert list(temporary_directory.iterdir()) == []
