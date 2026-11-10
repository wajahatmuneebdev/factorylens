from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Literal, Protocol, cast
from uuid import UUID

from factorylens_worker.storage import (
    ObjectStorage,
    processing_object_keys,
    source_object_key,
)

DEFAULT_MAX_SIZE_BYTES = 250 * 1024 * 1024
DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000
DEFAULT_MAX_WIDTH = 1920
DEFAULT_MAX_HEIGHT = 1080
DEFAULT_FFPROBE_TIMEOUT_SECONDS = 15.0
DEFAULT_FFMPEG_TIMEOUT_SECONDS = 10 * 60.0
DEFAULT_FFMPEG_THREADS = 2
FFMPEG_CANCELLATION_POLL_SECONDS = 0.25
MAX_FFMPEG_DIAGNOSTIC_CHARACTERS = 8 * 1024

MediaErrorCode = Literal[
    "invalid_media",
    "unsupported_media",
    "media_limit_exceeded",
]
StreamType = Literal["video", "audio"]


class MediaValidationError(Exception):
    """A stable terminal failure caused by the inspected source media."""

    category: Literal["terminal"] = "terminal"
    retryable = False

    def __init__(self, code: MediaErrorCode, safe_message: str) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message


class MediaValidationCancelled(Exception):
    """Cancellation observed at a media-processing stage boundary."""

    code: Literal["inspection_cancelled"] = "inspection_cancelled"
    category: Literal["cancelled"] = "cancelled"
    retryable = False


class MediaMetadataPersistenceError(RuntimeError):
    """The current lease could not persist inspected media metadata."""


class MediaNormalizationError(MediaValidationError):
    """A stable terminal failure while converting unsupported source media."""

    diagnostic: str

    def __init__(self, safe_message: str, diagnostic: str = "") -> None:
        super().__init__("unsupported_media", safe_message)
        self.diagnostic = diagnostic[-MAX_FFMPEG_DIAGNOSTIC_CHARACTERS:]


@dataclass(frozen=True, slots=True)
class MediaLimits:
    max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES
    max_duration_ms: int = DEFAULT_MAX_DURATION_MS
    max_width: int = DEFAULT_MAX_WIDTH
    max_height: int = DEFAULT_MAX_HEIGHT
    max_video_streams: int = 1
    max_audio_streams: int = 1

    def __post_init__(self) -> None:
        values = (
            self.max_size_bytes,
            self.max_duration_ms,
            self.max_width,
            self.max_height,
            self.max_video_streams,
            self.max_audio_streams,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 1
            for value in values
        ):
            raise ValueError("Media limits must be positive integers")


@dataclass(frozen=True, slots=True)
class MediaStreamMetadata:
    index: int
    type: StreamType
    codec: str
    duration_ms: int | None
    width: int | None = None
    height: int | None = None
    frame_rate: str | None = None

    def as_json(self) -> dict[str, int | str | None]:
        return {
            "index": self.index,
            "type": self.type,
            "codec": self.codec,
            "durationMs": self.duration_ms,
            "width": self.width,
            "height": self.height,
            "frameRate": self.frame_rate,
        }


@dataclass(frozen=True, slots=True)
class InspectedMediaMetadata:
    size_bytes: int
    content_type: str
    duration_ms: int
    width: int
    height: int
    container: str
    frame_rate: str
    streams: tuple[MediaStreamMetadata, ...]


class ProbeRunner(Protocol):
    def probe(
        self, source_path: Path, timeout_seconds: float
    ) -> Mapping[str, object]: ...


class MediaMetadataStore(Protocol):
    def record(
        self,
        job_id: UUID,
        lease_token: UUID,
        metadata: InspectedMediaMetadata,
        normalized_object_key: str | None,
    ) -> bool: ...


class NormalizationRunner(Protocol):
    def normalize(
        self,
        source_path: Path,
        destination_path: Path,
        *,
        timeout_seconds: float,
        max_output_size_bytes: int,
        is_cancelled: Callable[[], bool],
    ) -> None: ...


class FfprobeRunner:
    def __init__(self, executable: str = "ffprobe") -> None:
        if not executable:
            raise ValueError("ffprobe executable must not be empty")
        self._executable = executable

    def probe(self, source_path: Path, timeout_seconds: float) -> Mapping[str, object]:
        arguments = [
            self._executable,
            "-v",
            "error",
            "-show_entries",
            (
                "format=format_name,duration:"
                "stream=index,codec_type,codec_name,width,height,"
                "avg_frame_rate,r_frame_rate,duration"
            ),
            "-of",
            "json",
            str(source_path),
        ]
        try:
            result = subprocess.run(
                arguments,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise MediaValidationError(
                "invalid_media", "Media inspection exceeded the allowed time."
            ) from error

        if result.returncode != 0:
            raise MediaValidationError(
                "invalid_media", "The uploaded file is not valid readable media."
            )

        try:
            payload = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError) as error:
            raise MediaValidationError(
                "invalid_media", "Media inspection returned invalid metadata."
            ) from error
        if not isinstance(payload, dict):
            raise MediaValidationError(
                "invalid_media", "Media inspection returned invalid metadata."
            )
        return cast(dict[str, object], payload)


class FfmpegRunner:
    def __init__(
        self,
        executable: str = "ffmpeg",
        *,
        threads: int = DEFAULT_FFMPEG_THREADS,
    ) -> None:
        if not executable:
            raise ValueError("ffmpeg executable must not be empty")
        if isinstance(threads, bool) or not isinstance(threads, int) or threads < 1:
            raise ValueError("ffmpeg threads must be a positive integer")
        self._executable = executable
        self._threads = threads

    def normalize(
        self,
        source_path: Path,
        destination_path: Path,
        *,
        timeout_seconds: float,
        max_output_size_bytes: int,
        is_cancelled: Callable[[], bool],
    ) -> None:
        arguments = [
            self._executable,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-map_metadata",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-threads",
            str(self._threads),
            "-filter_threads",
            str(self._threads),
            "-filter_complex_threads",
            str(self._threads),
            "-max_muxing_queue_size",
            "1024",
            "-fs",
            str(max_output_size_bytes),
            str(destination_path),
        ]
        try:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as error:
            raise RuntimeError("FFmpeg could not be started") from error

        deadline = time.monotonic() + timeout_seconds
        while True:
            if is_cancelled():
                process.kill()
                process.communicate()
                raise MediaValidationCancelled()
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                process.kill()
                _, diagnostic = process.communicate()
                raise MediaNormalizationError(
                    "Media normalization exceeded the allowed time.",
                    diagnostic or "",
                )
            try:
                _, diagnostic = process.communicate(
                    timeout=min(FFMPEG_CANCELLATION_POLL_SECONDS, remaining_seconds)
                )
                break
            except subprocess.TimeoutExpired:
                continue

        if process.returncode != 0:
            raise MediaNormalizationError(
                "The uploaded media could not be converted to a supported format.",
                diagnostic or "",
            )


class MediaValidationStage:
    def __init__(
        self,
        storage: ObjectStorage,
        metadata_store: MediaMetadataStore,
        *,
        limits: MediaLimits | None = None,
        probe_runner: ProbeRunner | None = None,
        normalization_runner: NormalizationRunner | None = None,
        ffprobe_timeout_seconds: float = DEFAULT_FFPROBE_TIMEOUT_SECONDS,
        ffmpeg_timeout_seconds: float = DEFAULT_FFMPEG_TIMEOUT_SECONDS,
        temporary_directory: Path | None = None,
    ) -> None:
        if not math.isfinite(ffprobe_timeout_seconds) or ffprobe_timeout_seconds <= 0:
            raise ValueError("ffprobe timeout must be a positive finite number")
        if not math.isfinite(ffmpeg_timeout_seconds) or ffmpeg_timeout_seconds <= 0:
            raise ValueError("ffmpeg timeout must be a positive finite number")
        self._storage = storage
        self._metadata_store = metadata_store
        self._limits = limits or MediaLimits()
        self._probe_runner = probe_runner or FfprobeRunner()
        self._normalization_runner = normalization_runner or FfmpegRunner()
        self._ffprobe_timeout_seconds = ffprobe_timeout_seconds
        self._ffmpeg_timeout_seconds = ffmpeg_timeout_seconds
        self._temporary_directory = temporary_directory

    def run(
        self,
        *,
        job_id: UUID,
        inspection_id: UUID,
        dispatch_generation: int,
        lease_token: UUID,
        is_cancelled: Callable[[], bool] = lambda: False,
    ) -> InspectedMediaMetadata:
        if is_cancelled():
            raise MediaValidationCancelled()

        source_key = source_object_key(inspection_id)
        object_metadata = self._storage.metadata(source_key)
        self._enforce_size(object_metadata.size_bytes)

        normalized_key: str | None = None
        normalization_upload_attempted = False
        media_recorded = False
        try:
            with tempfile.TemporaryDirectory(
                dir=self._temporary_directory,
                prefix="factorylens-media-",
            ) as directory:
                source_path = Path(directory) / "source"
                with self._storage.read(source_key) as source:
                    downloaded_size = _copy_bounded(
                        source, source_path, self._limits.max_size_bytes
                    )
                self._enforce_size(downloaded_size)

                self._raise_if_cancelled(is_cancelled)
                probe = self._probe_runner.probe(
                    source_path, self._ffprobe_timeout_seconds
                )
                metadata = parse_and_validate_probe(
                    probe,
                    size_bytes=downloaded_size,
                    limits=self._limits,
                )

                if not is_playback_compatible(metadata):
                    normalized_key = processing_object_keys(
                        inspection_id, dispatch_generation
                    ).normalized
                    normalized_path = Path(directory) / "normalized.mp4"
                    self._raise_if_cancelled(is_cancelled)
                    self._normalization_runner.normalize(
                        source_path,
                        normalized_path,
                        timeout_seconds=self._ffmpeg_timeout_seconds,
                        max_output_size_bytes=self._limits.max_size_bytes,
                        is_cancelled=is_cancelled,
                    )
                    self._raise_if_cancelled(is_cancelled)
                    normalized_size = normalized_path.stat().st_size
                    self._enforce_size(normalized_size)
                    normalized_probe = self._probe_runner.probe(
                        normalized_path, self._ffprobe_timeout_seconds
                    )
                    normalized_metadata = parse_and_validate_probe(
                        normalized_probe,
                        size_bytes=normalized_size,
                        limits=self._limits,
                    )
                    if not is_playback_compatible(normalized_metadata):
                        raise MediaNormalizationError(
                            "Media normalization produced an unsupported format."
                        )
                    self._raise_if_cancelled(is_cancelled)
                    normalization_upload_attempted = True
                    with normalized_path.open("rb") as normalized:
                        self._storage.put(normalized_key, normalized)
                    self._raise_if_cancelled(is_cancelled)

            if not self._metadata_store.record(
                job_id, lease_token, metadata, normalized_key
            ):
                raise MediaMetadataPersistenceError(
                    "The inspected media metadata was rejected by the active lease"
                )
            media_recorded = True
            return metadata
        finally:
            if (
                normalized_key is not None
                and normalization_upload_attempted
                and not media_recorded
            ):
                self._storage.delete(normalized_key)

    def _enforce_size(self, size_bytes: int) -> None:
        if size_bytes <= 0:
            raise MediaValidationError(
                "invalid_media", "The uploaded media file is empty."
            )
        if size_bytes > self._limits.max_size_bytes:
            raise MediaValidationError(
                "media_limit_exceeded",
                "The uploaded media exceeds the configured size limit.",
            )

    @staticmethod
    def _raise_if_cancelled(is_cancelled: Callable[[], bool]) -> None:
        if is_cancelled():
            raise MediaValidationCancelled()


def is_playback_compatible(metadata: InspectedMediaMetadata) -> bool:
    """Return whether inspected codecs can be used without normalization.

    FactoryLens passes through WebM containing VP8/VP9 and optional Opus/Vorbis
    audio, or MP4-family media containing H.264 and optional AAC audio. All
    other valid input is normalized to H.264/AAC MP4.
    """

    video = next(stream for stream in metadata.streams if stream.type == "video")
    audio = next(
        (stream for stream in metadata.streams if stream.type == "audio"), None
    )
    containers = set(metadata.container.split(","))
    if "webm" in containers:
        return video.codec in {"vp8", "vp9"} and (
            audio is None or audio.codec in {"opus", "vorbis"}
        )
    if containers.intersection({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}):
        return video.codec == "h264" and (audio is None or audio.codec == "aac")
    return False


def parse_and_validate_probe(
    probe: Mapping[str, object],
    *,
    size_bytes: int,
    limits: MediaLimits,
) -> InspectedMediaMetadata:
    format_value = probe.get("format")
    streams_value = probe.get("streams")
    if (
        not isinstance(format_value, Mapping)
        or not isinstance(streams_value, Sequence)
        or isinstance(streams_value, (str, bytes))
    ):
        raise MediaValidationError(
            "invalid_media", "Media inspection returned incomplete metadata."
        )

    format_metadata = cast(Mapping[str, object], format_value)
    container = _required_string(format_metadata.get("format_name"), "container")

    streams = tuple(
        _parse_stream(cast(object, stream_value)) for stream_value in streams_value
    )
    video_streams = [stream for stream in streams if stream.type == "video"]
    audio_streams = [stream for stream in streams if stream.type == "audio"]
    if len(video_streams) != 1:
        raise MediaValidationError(
            "unsupported_media", "Media must contain exactly one video stream."
        )
    if (
        len(video_streams) > limits.max_video_streams
        or len(audio_streams) > limits.max_audio_streams
    ):
        raise MediaValidationError(
            "unsupported_media", "Media contains too many audio or video streams."
        )

    video = video_streams[0]
    if video.width is None or video.height is None or video.frame_rate is None:
        raise MediaValidationError(
            "invalid_media", "The video stream has incomplete display metadata."
        )
    duration_ms = _required_duration_ms(
        format_metadata.get("duration"), video.duration_ms
    )

    if duration_ms > limits.max_duration_ms:
        raise MediaValidationError(
            "media_limit_exceeded",
            "The uploaded media exceeds the configured duration limit.",
        )
    if not (
        (video.width <= limits.max_width and video.height <= limits.max_height)
        or (video.width <= limits.max_height and video.height <= limits.max_width)
    ):
        raise MediaValidationError(
            "media_limit_exceeded",
            "The uploaded media exceeds the configured resolution limit.",
        )

    return InspectedMediaMetadata(
        size_bytes=size_bytes,
        content_type=_content_type(container),
        duration_ms=duration_ms,
        width=video.width,
        height=video.height,
        container=container,
        frame_rate=video.frame_rate,
        streams=streams,
    )


def _copy_bounded(source: BinaryIO, destination: Path, max_size_bytes: int) -> int:
    size_bytes = 0
    with destination.open("wb") as output:
        while chunk := source.read(min(1024 * 1024, max_size_bytes + 1 - size_bytes)):
            size_bytes += len(chunk)
            if size_bytes > max_size_bytes:
                raise MediaValidationError(
                    "media_limit_exceeded",
                    "The uploaded media exceeds the configured size limit.",
                )
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return size_bytes


def _parse_stream(value: object) -> MediaStreamMetadata:
    if not isinstance(value, Mapping):
        raise MediaValidationError(
            "invalid_media", "Media inspection returned invalid stream metadata."
        )
    stream = cast(Mapping[str, object], value)
    index = _positive_or_zero_int(stream.get("index"), "stream index")
    stream_type = stream.get("codec_type")
    if stream_type not in {"video", "audio"}:
        raise MediaValidationError(
            "unsupported_media", "Media contains an unsupported stream type."
        )
    codec = _required_string(stream.get("codec_name"), "stream codec")
    stream_duration = _optional_duration_ms(stream.get("duration"))

    if stream_type == "video":
        width = _positive_int(stream.get("width"), "video width")
        height = _positive_int(stream.get("height"), "video height")
        frame_rate = _frame_rate(
            stream.get("avg_frame_rate"), stream.get("r_frame_rate")
        )
        return MediaStreamMetadata(
            index=index,
            type="video",
            codec=codec,
            duration_ms=stream_duration,
            width=width,
            height=height,
            frame_rate=frame_rate,
        )

    return MediaStreamMetadata(
        index=index,
        type="audio",
        codec=codec,
        duration_ms=stream_duration,
    )


def _required_duration_ms(primary: object, fallback: int | None) -> int:
    duration = _optional_duration_ms(primary)
    if duration is None:
        duration = fallback
    if duration is None or duration <= 0:
        raise MediaValidationError(
            "invalid_media", "Media duration is missing or invalid."
        )
    return duration


def _optional_duration_ms(value: object) -> int | None:
    if value is None or value == "N/A":
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise MediaValidationError("invalid_media", "Media duration is invalid.")
    try:
        seconds = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise MediaValidationError(
            "invalid_media", "Media duration is invalid."
        ) from error
    if not seconds.is_finite() or seconds < 0:
        raise MediaValidationError("invalid_media", "Media duration is invalid.")
    return int((seconds * 1000).to_integral_value(rounding=ROUND_CEILING))


def _frame_rate(average: object, nominal: object) -> str:
    for value in (average, nominal):
        if not isinstance(value, str):
            continue
        try:
            frame_rate = Fraction(value)
        except (ValueError, ZeroDivisionError):
            continue
        if frame_rate > 0:
            return f"{frame_rate.numerator}/{frame_rate.denominator}"
    raise MediaValidationError(
        "invalid_media", "The video frame rate is missing or invalid."
    )


def _required_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 120:
        raise MediaValidationError(
            "invalid_media", f"Media {field} is missing or invalid."
        )
    return value


def _positive_int(value: object, field: str) -> int:
    parsed = _positive_or_zero_int(value, field)
    if parsed == 0:
        raise MediaValidationError(
            "invalid_media", f"Media {field} is missing or invalid."
        )
    return parsed


def _positive_or_zero_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MediaValidationError(
            "invalid_media", f"Media {field} is missing or invalid."
        )
    return value


def _content_type(container: str) -> str:
    formats = set(container.split(","))
    if "webm" in formats:
        return "video/webm"
    if formats.intersection({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}):
        return "video/mp4"
    if "matroska" in formats:
        return "video/x-matroska"
    if "avi" in formats:
        return "video/x-msvideo"
    if "mpegts" in formats:
        return "video/mp2t"
    return "application/octet-stream"
