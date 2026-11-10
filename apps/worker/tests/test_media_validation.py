import json
import subprocess
from collections.abc import Callable
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest

from factorylens_worker.media_validation import (
    FfmpegRunner,
    FfprobeRunner,
    InspectedMediaMetadata,
    MediaLimits,
    MediaMetadataPersistenceError,
    MediaNormalizationError,
    MediaValidationCancelled,
    MediaValidationError,
    MediaValidationStage,
    is_playback_compatible,
    parse_and_validate_probe,
)
from factorylens_worker.storage import (
    LocalFilesystemStorage,
    StorageObjectMetadata,
    processing_object_keys,
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
    def __init__(
        self, payload: dict[str, object] | list[dict[str, object]] | None = None
    ) -> None:
        if isinstance(payload, list):
            self.payloads = iter(payload)
        else:
            self.payloads = iter([payload or valid_probe()])
        self.last_payload: dict[str, object] | None = None
        self.calls: list[tuple[Path, float, bytes]] = []

    def probe(self, source_path: Path, timeout_seconds: float) -> dict[str, object]:
        self.calls.append((source_path, timeout_seconds, source_path.read_bytes()))
        self.last_payload = next(self.payloads, self.last_payload)
        assert self.last_payload is not None
        return self.last_payload


class FixtureNormalizationRunner:
    def __init__(
        self,
        output: bytes = b"normalized media",
        failure: Exception | None = None,
    ) -> None:
        self.output = output
        self.failure = failure
        self.calls: list[tuple[Path, Path, float, int, bytes]] = []

    def normalize(
        self,
        source_path: Path,
        destination_path: Path,
        *,
        timeout_seconds: float,
        max_output_size_bytes: int,
        is_cancelled: Callable[[], bool],
    ) -> None:
        self.calls.append(
            (
                source_path,
                destination_path,
                timeout_seconds,
                max_output_size_bytes,
                source_path.read_bytes(),
            )
        )
        destination_path.write_bytes(self.output)
        if self.failure is not None:
            raise self.failure


class MockFfmpegProcess:
    def __init__(self, *, returncode: int | None, diagnostic: str) -> None:
        self.returncode = returncode
        self.diagnostic = diagnostic
        self.killed = False
        self.communicate_timeouts: list[float | None] = []
        self.communicate_side_effects: list[Exception] = []

    def communicate(self, timeout: float | None = None) -> tuple[None, str]:
        self.communicate_timeouts.append(timeout)
        if self.communicate_side_effects:
            raise self.communicate_side_effects.pop(0)
        return None, self.diagnostic

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class RecordingMetadataStore:
    def __init__(self, accepted: bool = True) -> None:
        self.accepted = accepted
        self.records: list[tuple[UUID, UUID, InspectedMediaMetadata, str | None]] = []

    def record(
        self,
        job_id: UUID,
        lease_token: UUID,
        metadata: InspectedMediaMetadata,
        normalized_object_key: str | None,
    ) -> bool:
        self.records.append((job_id, lease_token, metadata, normalized_object_key))
        return self.accepted


def configured_stage(
    tmp_path: Path,
    *,
    source: bytes = b"bounded source",
    runner: FixtureProbeRunner | None = None,
    normalization_runner: FixtureNormalizationRunner | None = None,
    store: RecordingMetadataStore | None = None,
    limits: MediaLimits | None = None,
) -> tuple[
    MediaValidationStage,
    FixtureProbeRunner,
    FixtureNormalizationRunner,
    RecordingMetadataStore,
    LocalFilesystemStorage,
    Path,
]:
    storage = LocalFilesystemStorage(tmp_path / "objects")
    storage.put(source_object_key(INSPECTION_ID), BytesIO(source))
    probe_runner = runner or FixtureProbeRunner()
    converter = normalization_runner or FixtureNormalizationRunner()
    metadata_store = store or RecordingMetadataStore()
    temporary_directory = tmp_path / "temporary"
    temporary_directory.mkdir()
    return (
        MediaValidationStage(
            storage,
            metadata_store,
            limits=limits,
            probe_runner=probe_runner,
            normalization_runner=converter,
            ffprobe_timeout_seconds=3.5,
            ffmpeg_timeout_seconds=12.0,
            temporary_directory=temporary_directory,
        ),
        probe_runner,
        converter,
        metadata_store,
        storage,
        temporary_directory,
    )


def test_valid_fixture_is_downloaded_probed_and_recorded(tmp_path: Path) -> None:
    stage, runner, converter, store, _, temporary_directory = configured_stage(tmp_path)
    job_id = uuid4()
    lease_token = uuid4()

    metadata = stage.run(
        job_id=job_id,
        inspection_id=INSPECTION_ID,
        dispatch_generation=2,
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
    assert converter.calls == []
    assert store.records == [(job_id, lease_token, metadata, None)]
    assert list(temporary_directory.iterdir()) == []


@pytest.mark.parametrize(
    ("container", "video_codec", "audio_codec", "compatible"),
    [
        ("matroska,webm", "vp8", "vorbis", True),
        ("matroska,webm", "vp9", "opus", True),
        ("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac", True),
        ("matroska,webm", "h264", "opus", False),
        ("mov,mp4,m4a,3gp,3g2,mj2", "hevc", "aac", False),
        ("avi", "mpeg4", "mp3", False),
    ],
)
def test_compatibility_decision_maps_containers_and_codecs(
    container: str, video_codec: str, audio_codec: str, compatible: bool
) -> None:
    probe = valid_probe()
    format_metadata = probe["format"]
    streams = probe["streams"]
    assert isinstance(format_metadata, dict)
    assert isinstance(streams, list)
    assert isinstance(streams[0], dict)
    assert isinstance(streams[1], dict)
    format_metadata["format_name"] = container
    streams[0]["codec_name"] = video_codec
    streams[1]["codec_name"] = audio_codec

    metadata = parse_and_validate_probe(probe, size_bytes=100, limits=MediaLimits())

    assert is_playback_compatible(metadata) is compatible


def test_incompatible_media_is_normalized_reprobed_and_stored_by_generation(
    tmp_path: Path,
) -> None:
    source_probe = valid_probe()
    source_format = source_probe["format"]
    source_streams = source_probe["streams"]
    assert isinstance(source_format, dict)
    assert isinstance(source_streams, list)
    assert isinstance(source_streams[0], dict)
    assert isinstance(source_streams[1], dict)
    source_format["format_name"] = "avi"
    source_streams[0]["codec_name"] = "mpeg4"
    source_streams[1]["codec_name"] = "mp3"
    runner = FixtureProbeRunner([source_probe, valid_probe()])
    stage, _, converter, store, storage, temporary_directory = configured_stage(
        tmp_path, runner=runner
    )
    job_id = uuid4()
    lease_token = uuid4()
    normalized_key = processing_object_keys(INSPECTION_ID, 3).normalized

    metadata = stage.run(
        job_id=job_id,
        inspection_id=INSPECTION_ID,
        dispatch_generation=3,
        lease_token=lease_token,
    )

    assert metadata.container == "avi"
    assert len(converter.calls) == 1
    assert converter.calls[0][2:] == (
        12.0,
        MediaLimits().max_size_bytes,
        b"bounded source",
    )
    assert [call[2] for call in runner.calls] == [
        b"bounded source",
        b"normalized media",
    ]
    assert store.records == [(job_id, lease_token, metadata, normalized_key)]
    with storage.read(normalized_key) as normalized:
        assert normalized.read() == b"normalized media"
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


def test_ffmpeg_uses_bounded_arguments_resources_and_captured_diagnostics() -> None:
    process = MockFfmpegProcess(returncode=0, diagnostic="diagnostic output")
    with patch(
        "factorylens_worker.media_validation.subprocess.Popen", return_value=process
    ) as popen:
        FfmpegRunner("/usr/bin/ffmpeg", threads=3).normalize(
            Path("source with spaces.avi"),
            Path("normalized output.mp4"),
            timeout_seconds=9.0,
            max_output_size_bytes=12345,
            is_cancelled=lambda: False,
        )

    arguments = popen.call_args.args[0]
    assert isinstance(arguments, list)
    assert arguments[0] == "/usr/bin/ffmpeg"
    assert arguments[arguments.index("-threads") + 1] == "3"
    assert arguments[arguments.index("-filter_threads") + 1] == "3"
    assert arguments[arguments.index("-max_muxing_queue_size") + 1] == "1024"
    assert arguments[arguments.index("-fs") + 1] == "12345"
    assert arguments[-1] == "normalized output.mp4"
    assert "shell" not in popen.call_args.kwargs
    assert popen.call_args.kwargs["stdin"] is subprocess.DEVNULL
    assert popen.call_args.kwargs["stdout"] is subprocess.DEVNULL
    assert popen.call_args.kwargs["stderr"] is subprocess.PIPE
    assert process.communicate_timeouts == [0.25]


def test_ffmpeg_timeout_is_a_stable_terminal_failure_with_diagnostics() -> None:
    process = MockFfmpegProcess(returncode=None, diagnostic="conversion stalled")
    process.communicate_side_effects = [subprocess.TimeoutExpired(["ffmpeg"], 1)]
    with (
        patch(
            "factorylens_worker.media_validation.subprocess.Popen", return_value=process
        ),
        patch(
            "factorylens_worker.media_validation.time.monotonic",
            side_effect=[0.0, 0.0, 2.0],
        ),
    ):
        with pytest.raises(MediaNormalizationError) as failure:
            FfmpegRunner().normalize(
                Path("slow.avi"),
                Path("normalized.mp4"),
                timeout_seconds=1.0,
                max_output_size_bytes=100,
                is_cancelled=lambda: False,
            )

    assert failure.value.code == "unsupported_media"
    assert failure.value.category == "terminal"
    assert not failure.value.retryable
    assert failure.value.diagnostic == "conversion stalled"
    assert "conversion stalled" not in failure.value.safe_message
    assert process.killed


def test_ffmpeg_failure_is_classified_without_exposing_diagnostics() -> None:
    process = MockFfmpegProcess(returncode=1, diagnostic="private file details")
    with patch(
        "factorylens_worker.media_validation.subprocess.Popen", return_value=process
    ):
        with pytest.raises(MediaNormalizationError) as failure:
            FfmpegRunner().normalize(
                Path("unsupported.avi"),
                Path("normalized.mp4"),
                timeout_seconds=4.0,
                max_output_size_bytes=100,
                is_cancelled=lambda: False,
            )

    assert failure.value.code == "unsupported_media"
    assert failure.value.diagnostic == "private file details"
    assert "private file details" not in failure.value.safe_message


def test_ffmpeg_cancellation_terminates_the_child_process() -> None:
    process = MockFfmpegProcess(returncode=None, diagnostic="cancelled conversion")
    process.communicate_side_effects = [subprocess.TimeoutExpired(["ffmpeg"], 1)]
    cancellation_checks = iter([False, True])
    with patch(
        "factorylens_worker.media_validation.subprocess.Popen", return_value=process
    ):
        with pytest.raises(MediaValidationCancelled):
            FfmpegRunner().normalize(
                Path("slow.avi"),
                Path("normalized.mp4"),
                timeout_seconds=4.0,
                max_output_size_bytes=100,
                is_cancelled=lambda: next(cancellation_checks),
            )

    assert process.killed


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
            dispatch_generation=1,
            lease_token=uuid4(),
        )

    assert failure.value.code == "media_limit_exceeded"
    assert runner.calls == []
    assert store.records == []
    assert list(temporary_directory.iterdir()) == []


def test_cancellation_after_download_skips_probe_and_cleans_temporary_file(
    tmp_path: Path,
) -> None:
    stage, runner, _, store, _, temporary_directory = configured_stage(tmp_path)
    cancellation_checks = iter([False, True])

    with pytest.raises(MediaValidationCancelled) as failure:
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=1,
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
    stage, _, _, store, _, temporary_directory = configured_stage(
        tmp_path, runner=FixtureProbeRunner(probe)
    )

    with pytest.raises(MediaValidationError):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=1,
            lease_token=uuid4(),
        )

    assert store.records == []
    assert list(temporary_directory.iterdir()) == []


def test_stale_lease_rejects_metadata_after_temporary_cleanup(tmp_path: Path) -> None:
    stage, _, _, store, _, temporary_directory = configured_stage(
        tmp_path, store=RecordingMetadataStore(accepted=False)
    )

    with pytest.raises(MediaMetadataPersistenceError):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=1,
            lease_token=uuid4(),
        )

    assert len(store.records) == 1
    assert list(temporary_directory.iterdir()) == []


def test_normalization_failure_removes_partial_temporary_output(
    tmp_path: Path,
) -> None:
    source_probe = valid_probe()
    format_metadata = source_probe["format"]
    assert isinstance(format_metadata, dict)
    format_metadata["format_name"] = "avi"
    failure = MediaNormalizationError("Conversion failed.", "fixture details")
    converter = FixtureNormalizationRunner(failure=failure)
    stage, _, _, store, storage, temporary_directory = configured_stage(
        tmp_path,
        runner=FixtureProbeRunner(source_probe),
        normalization_runner=converter,
    )
    normalized_key = processing_object_keys(INSPECTION_ID, 4).normalized

    with pytest.raises(MediaNormalizationError) as raised:
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=4,
            lease_token=uuid4(),
        )

    assert raised.value is failure
    assert store.records == []
    assert not storage.exists(normalized_key)
    assert list(temporary_directory.iterdir()) == []


def test_cancellation_after_upload_removes_normalized_storage_object(
    tmp_path: Path,
) -> None:
    source_probe = valid_probe()
    format_metadata = source_probe["format"]
    assert isinstance(format_metadata, dict)
    format_metadata["format_name"] = "avi"
    stage, _, converter, store, storage, temporary_directory = configured_stage(
        tmp_path,
        runner=FixtureProbeRunner([source_probe, valid_probe()]),
    )
    cancellation_checks = iter([False, False, False, False, False, True])
    normalized_key = processing_object_keys(INSPECTION_ID, 5).normalized

    with pytest.raises(MediaValidationCancelled):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=5,
            lease_token=uuid4(),
            is_cancelled=lambda: next(cancellation_checks),
        )

    assert len(converter.calls) == 1
    assert store.records == []
    assert not storage.exists(normalized_key)
    assert list(temporary_directory.iterdir()) == []


def test_rejected_lease_removes_uploaded_normalized_object(tmp_path: Path) -> None:
    source_probe = valid_probe()
    format_metadata = source_probe["format"]
    assert isinstance(format_metadata, dict)
    format_metadata["format_name"] = "avi"
    store = RecordingMetadataStore(accepted=False)
    stage, _, _, _, storage, temporary_directory = configured_stage(
        tmp_path,
        runner=FixtureProbeRunner([source_probe, valid_probe()]),
        store=store,
    )
    normalized_key = processing_object_keys(INSPECTION_ID, 6).normalized

    with pytest.raises(MediaMetadataPersistenceError):
        stage.run(
            job_id=uuid4(),
            inspection_id=INSPECTION_ID,
            dispatch_generation=6,
            lease_token=uuid4(),
        )

    assert len(store.records) == 1
    assert not storage.exists(normalized_key)
    assert list(temporary_directory.iterdir()) == []
