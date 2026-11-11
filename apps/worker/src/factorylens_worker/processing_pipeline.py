from __future__ import annotations

import math
import os
import select
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import IO, BinaryIO, Protocol

from factorylens_worker.job_lease import JobFailure, JobLease
from factorylens_worker.media_validation import (
    InspectedMediaMetadata,
    MediaMetadataPersistenceError,
    MediaValidationCancelled,
    MediaValidationError,
    MediaValidationStage,
)
from factorylens_worker.prediction_artifact import (
    SAMPLE_RATE_FPS,
    InspectionCompletionRejectedError,
    PredictionArtifactStage,
)
from factorylens_worker.storage import (
    ObjectStorage,
    StorageObjectNotFoundError,
    processing_object_keys,
    source_object_key,
)
from factorylens_worker.task_execution import (
    CancellationCheck,
    LeaseLostError,
    ProcessingCancelledError,
    ProcessingFailureError,
    ProgressReporter,
)
from factorylens_worker.workflow import (
    RetryableWorkflowProviderError,
    WorkflowCancelledError,
    WorkflowConfiguration,
    WorkflowFrameInput,
    WorkflowImage,
    WorkflowRunner,
    WorkflowRunnerError,
)

FRAME_READ_POLL_SECONDS = 0.25
MAX_FFMPEG_DIAGNOSTIC_CHARACTERS = 8 * 1024


class FrameExtractionError(RuntimeError):
    pass


class FrameSampler(Protocol):
    def frames(
        self,
        storage: ObjectStorage,
        object_key: str,
        media: InspectedMediaMetadata,
        *,
        is_cancelled: CancellationCheck,
    ) -> AbstractContextManager[Iterator[WorkflowFrameInput]]: ...


class FfmpegFrameSampler:
    def __init__(
        self,
        executable: str = "ffmpeg",
        *,
        temporary_directory: Path | None = None,
    ) -> None:
        if not executable:
            raise ValueError("ffmpeg executable must not be empty")
        self._executable = executable
        self._temporary_directory = temporary_directory

    @contextmanager
    def frames(
        self,
        storage: ObjectStorage,
        object_key: str,
        media: InspectedMediaMetadata,
        *,
        is_cancelled: CancellationCheck,
    ) -> Iterator[Iterator[WorkflowFrameInput]]:
        with tempfile.TemporaryDirectory(
            dir=self._temporary_directory,
            prefix="factorylens-inference-",
        ) as directory:
            source_path = Path(directory) / "source"
            with storage.read(object_key) as source:
                _copy_for_inference(source, source_path, media.size_bytes, is_cancelled)

            diagnostic_path = Path(directory) / "ffmpeg.log"
            with diagnostic_path.open("w+b") as diagnostic:
                process = self._start_process(source_path, media, diagnostic)
                try:
                    yield self._iter_process_frames(process, media, is_cancelled)
                    return_code = process.wait()
                    if return_code != 0:
                        raise FrameExtractionError(
                            _frame_extraction_message(diagnostic_path)
                        )
                except BaseException:
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                    raise
                finally:
                    if process.stdout is not None:
                        process.stdout.close()

    def _start_process(
        self,
        source_path: Path,
        media: InspectedMediaMetadata,
        diagnostic: BinaryIO,
    ) -> subprocess.Popen[bytes]:
        arguments = [
            self._executable,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-vf",
            f"fps={SAMPLE_RATE_FPS:g}",
            "-t",
            f"{media.duration_ms / 1000:.3f}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ]
        try:
            return subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=diagnostic,
            )
        except OSError as error:
            raise RuntimeError("FFmpeg could not be started") from error

    @staticmethod
    def _iter_process_frames(
        process: subprocess.Popen[bytes],
        media: InspectedMediaMetadata,
        is_cancelled: CancellationCheck,
    ) -> Iterator[WorkflowFrameInput]:
        if process.stdout is None:
            raise RuntimeError("FFmpeg frame output was not captured")
        frame_size = media.width * media.height * 3
        frame_index = 0
        while True:
            frame_bytes = _read_frame(process.stdout, frame_size, is_cancelled)
            if frame_bytes is None:
                return
            timestamp_ms = round(frame_index * 1000 / SAMPLE_RATE_FPS)
            if timestamp_ms > media.duration_ms:
                return
            yield WorkflowFrameInput(
                frame_index=frame_index,
                timestamp_ms=timestamp_ms,
                image=WorkflowImage(
                    width=media.width,
                    height=media.height,
                    rgb24=frame_bytes,
                ),
            )
            frame_index += 1


class InspectionProcessingPipeline:
    def __init__(
        self,
        *,
        storage: ObjectStorage,
        media_stage: MediaValidationStage,
        frame_sampler: FrameSampler,
        workflow_runner: WorkflowRunner,
        workflow_configuration: WorkflowConfiguration,
        artifact_stage: PredictionArtifactStage,
    ) -> None:
        self._storage = storage
        self._media_stage = media_stage
        self._frame_sampler = frame_sampler
        self._workflow_runner = workflow_runner
        self._workflow_configuration = workflow_configuration
        self._artifact_stage = artifact_stage

    def run(
        self,
        lease: JobLease,
        *,
        report_progress: ProgressReporter,
        is_cancelled: CancellationCheck,
    ) -> None:
        try:
            report_progress("validating_media", 5)
            media = self._media_stage.run(
                job_id=lease.job_id,
                inspection_id=lease.inspection_id,
                dispatch_generation=lease.dispatch_generation,
                lease_token=lease.token,
                is_cancelled=is_cancelled,
            )

            report_progress("running_workflow", 30)
            normalized_key = processing_object_keys(
                lease.inspection_id, lease.dispatch_generation
            ).normalized
            media_key = (
                normalized_key
                if self._storage.exists(normalized_key)
                else source_object_key(lease.inspection_id)
            )
            frames = []
            expected_frames = max(
                1, math.ceil(media.duration_ms * SAMPLE_RATE_FPS / 1000)
            )
            last_progress = 30
            with self._frame_sampler.frames(
                self._storage,
                media_key,
                media,
                is_cancelled=is_cancelled,
            ) as sampled_frames:
                for frame in sampled_frames:
                    if is_cancelled():
                        raise ProcessingCancelledError(
                            "Inspection processing was cancelled"
                        )
                    frames.append(
                        self._workflow_runner.run_frame(
                            frame,
                            self._workflow_configuration,
                            is_cancelled=is_cancelled,
                        )
                    )
                    progress = min(
                        90,
                        30 + math.floor(len(frames) / expected_frames * 60),
                    )
                    if progress >= last_progress + 5:
                        report_progress("running_workflow", progress)
                        last_progress = progress

            if not frames:
                raise FrameExtractionError("FFmpeg returned no video frames")
            if last_progress < 90:
                report_progress("running_workflow", 90)

            report_progress("writing_artifact", 95)
            self._artifact_stage.run(
                job_id=lease.job_id,
                inspection_id=lease.inspection_id,
                dispatch_generation=lease.dispatch_generation,
                lease_token=lease.token,
                media=media,
                workflow=self._workflow_configuration,
                frames=frames,
            )
        except (MediaValidationCancelled, WorkflowCancelledError) as error:
            raise ProcessingCancelledError(
                "Inspection processing was cancelled"
            ) from error
        except (
            MediaMetadataPersistenceError,
            InspectionCompletionRejectedError,
        ) as error:
            raise LeaseLostError("The processing lease rejected a commit") from error
        except MediaValidationError as error:
            raise ProcessingFailureError(
                JobFailure(error.code, error.safe_message, retryable=False)
            ) from error
        except RetryableWorkflowProviderError as error:
            raise ProcessingFailureError(
                JobFailure(
                    "provider_unavailable",
                    "The inference provider is temporarily unavailable.",
                    retryable=True,
                )
            ) from error
        except WorkflowRunnerError as error:
            raise ProcessingFailureError(
                JobFailure(
                    "provider_response_invalid",
                    "The inference provider could not process this inspection.",
                    retryable=False,
                )
            ) from error
        except FrameExtractionError as error:
            raise ProcessingFailureError(
                JobFailure(
                    "invalid_media",
                    "The uploaded media could not be decoded for inspection.",
                    retryable=False,
                )
            ) from error
        except (StorageObjectNotFoundError, OSError) as error:
            raise ProcessingFailureError(
                JobFailure(
                    "storage_unavailable",
                    "Inspection storage is temporarily unavailable.",
                    retryable=True,
                )
            ) from error
        except ValueError as error:
            raise ProcessingFailureError(
                JobFailure(
                    "provider_response_invalid",
                    "The inference result did not match the inspection contract.",
                    retryable=False,
                )
            ) from error


def _copy_for_inference(
    source: BinaryIO,
    destination: Path,
    expected_size_bytes: int,
    is_cancelled: CancellationCheck,
) -> None:
    copied = 0
    with destination.open("wb") as output:
        while chunk := source.read(1024 * 1024):
            if is_cancelled():
                raise ProcessingCancelledError("Inspection processing was cancelled")
            copied += len(chunk)
            if copied > expected_size_bytes:
                raise FrameExtractionError("Media size changed after validation")
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    if copied != expected_size_bytes:
        raise FrameExtractionError("Media size changed after validation")


def _read_frame(
    output: IO[bytes],
    frame_size: int,
    is_cancelled: CancellationCheck,
) -> bytes | None:
    chunks = bytearray()
    descriptor = output.fileno()
    while len(chunks) < frame_size:
        if is_cancelled():
            raise ProcessingCancelledError("Inspection processing was cancelled")
        readable, _, _ = select.select([descriptor], [], [], FRAME_READ_POLL_SECONDS)
        if not readable:
            continue
        chunk = os.read(descriptor, min(1024 * 1024, frame_size - len(chunks)))
        if not chunk:
            if not chunks:
                return None
            raise FrameExtractionError("FFmpeg returned an incomplete video frame")
        chunks.extend(chunk)
    return bytes(chunks)


def _frame_extraction_message(diagnostic_path: Path) -> str:
    diagnostic = diagnostic_path.read_bytes()[-MAX_FFMPEG_DIAGNOSTIC_CHARACTERS:]
    return diagnostic.decode(errors="replace") or "FFmpeg frame extraction failed"
