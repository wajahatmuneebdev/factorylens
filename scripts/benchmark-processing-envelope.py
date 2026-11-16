#!/usr/bin/env python3
"""Benchmark the credential-free FactoryLens media-processing envelope."""

from __future__ import annotations

import argparse
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Literal
from uuid import UUID, uuid4

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "apps" / "worker" / "src"))

from factorylens_worker.contracts import (
    FramePrediction,
    PredictionBox,
    PredictionFrame,
)
from factorylens_worker.media_validation import (
    FfmpegRunner,
    FfprobeRunner,
    InspectedMediaMetadata,
    MediaLimits,
    MediaValidationStage,
)
from factorylens_worker.prediction_artifact import (
    InspectionCompletion,
    PredictionArtifactStage,
)
from factorylens_worker.processing_pipeline import FfmpegFrameSampler
from factorylens_worker.storage import (
    LocalFilesystemStorage,
    processing_object_keys,
    source_object_key,
)
from factorylens_worker.workflow import (
    WorkflowConfiguration,
    WorkflowFrameInput,
)


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    name: str
    duration_seconds: int
    width: int
    height: int
    container: Literal["mp4", "webm", "avi"]
    video_codec: Literal["h264", "vp8", "vp9", "mpeg4"]
    audio_codec: Literal["aac", "opus", "none"]
    prediction_density: int
    role: Literal["short", "average", "boundary", "normalization"]


CASES = (
    BenchmarkCase("short-vp8-webm", 10, 640, 360, "webm", "vp8", "none", 1, "short"),
    BenchmarkCase(
        "average-vp9-webm", 60, 1280, 720, "webm", "vp9", "opus", 4, "average"
    ),
    BenchmarkCase(
        "average-h264-mp4", 60, 1280, 720, "mp4", "h264", "aac", 8, "average"
    ),
    BenchmarkCase(
        "boundary-h264-mp4", 300, 1920, 1080, "mp4", "h264", "aac", 12, "boundary"
    ),
    BenchmarkCase(
        "normalize-mpeg4-avi", 60, 1280, 720, "avi", "mpeg4", "none", 4, "normalization"
    ),
)
MAX_UPLOAD_BYTES = 250 * 1024 * 1024


class RecordingMetadataStore:
    normalized_object_key: str | None = None

    def record(
        self,
        job_id: UUID,
        lease_token: UUID,
        metadata: InspectedMediaMetadata,
        normalized_object_key: str | None,
    ) -> bool:
        del job_id, lease_token, metadata
        self.normalized_object_key = normalized_object_key
        return True


class RecordingCompletionStore:
    def complete_with_artifact(
        self,
        *,
        job_id: UUID,
        inspection_id: UUID,
        dispatch_generation: int,
        lease_token: UUID,
        completion: InspectionCompletion,
        write_artifact: Callable[[], None],
    ) -> bool:
        del job_id, inspection_id, dispatch_generation, lease_token, completion
        write_artifact()
        return True


class TimedProbeRunner:
    def __init__(self) -> None:
        self.elapsed_ms = 0.0
        self._runner = FfprobeRunner()

    def probe(self, source_path: Path, timeout_seconds: float) -> dict[str, object]:
        started = time.perf_counter()
        try:
            return dict(self._runner.probe(source_path, timeout_seconds))
        finally:
            self.elapsed_ms += elapsed_ms(started)


class TimedNormalizationRunner:
    def __init__(self) -> None:
        self.elapsed_ms = 0.0
        self._runner = FfmpegRunner()

    def normalize(
        self,
        source_path: Path,
        destination_path: Path,
        *,
        timeout_seconds: float,
        max_output_size_bytes: int,
        is_cancelled: Callable[[], bool],
    ) -> None:
        started = time.perf_counter()
        try:
            self._runner.normalize(
                source_path,
                destination_path,
                timeout_seconds=timeout_seconds,
                max_output_size_bytes=max_output_size_bytes,
                is_cancelled=is_cancelled,
            )
        finally:
            self.elapsed_ms += elapsed_ms(started)


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)


def ffmpeg_arguments(case: BenchmarkCase, output: Path) -> list[str]:
    codecs = {
        "h264": ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"],
        "vp8": [
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-crf",
            "36",
            "-b:v",
            "0",
        ],
        "vp9": [
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-crf",
            "38",
            "-b:v",
            "0",
        ],
        "mpeg4": ["-c:v", "mpeg4", "-q:v", "8"],
    }
    arguments = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={case.width}x{case.height}:rate=5:duration={case.duration_seconds}",
    ]
    if case.audio_codec != "none":
        arguments.extend(
            [
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r=48000:cl=stereo:d={case.duration_seconds}",
                "-shortest",
            ]
        )
    arguments.extend(codecs[case.video_codec])
    if case.audio_codec == "aac":
        arguments.extend(["-c:a", "aac", "-b:a", "64k"])
    elif case.audio_codec == "opus":
        arguments.extend(["-c:a", "libopus", "-b:a", "64k"])
    arguments.extend(["-pix_fmt", "yuv420p", str(output)])
    return arguments


def generate_media(case: BenchmarkCase, destination: Path) -> dict[str, object]:
    started = time.perf_counter()
    subprocess.run(ffmpeg_arguments(case, destination), check=True)
    if case.role == "boundary":
        # High-entropy factory footage can reach the byte ceiling before the
        # duration ceiling. ffprobe tolerates trailing zero bytes, which still
        # exercise the application's bounded object copies.
        with destination.open("ab") as output:
            output.truncate(MAX_UPLOAD_BYTES)
    return {
        "generationMs": elapsed_ms(started),
        "sourceBytes": destination.stat().st_size,
    }


def predictions_for_frame(frame: WorkflowFrameInput, density: int) -> PredictionFrame:
    predictions: list[FramePrediction] = []
    for index in range(density):
        predictions.append(
            FramePrediction(
                id=f"f{frame.frame_index:06d}-p{index:03d}",
                className="NO-Hardhat" if index % 3 == 0 else "Person",
                confidence=round(0.7 + (index % 25) / 100, 2),
                box=PredictionBox(
                    x=float(50 + (index * 37) % max(1, frame.image.width - 100)),
                    y=float(50 + (index * 29) % max(1, frame.image.height - 100)),
                    width=80.0,
                    height=80.0,
                ),
            )
        )
    return PredictionFrame(timestampMs=frame.timestamp_ms, predictions=predictions)


def max_rss_bytes(usage: resource.struct_rusage) -> int:
    return int(
        usage.ru_maxrss if platform.system() == "Darwin" else usage.ru_maxrss * 1024
    )


def copy_stream(source: BinaryIO, destination: BinaryIO) -> None:
    while chunk := source.read(1024 * 1024):
        destination.write(chunk)


def run_case(
    case: BenchmarkCase, source: Path, artifact_destination: Path
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(
        prefix=f"factorylens-benchmark-{case.name}-"
    ) as directory:
        storage = LocalFilesystemStorage(Path(directory) / "storage")
        inspection_id, job_id, lease_token = uuid4(), uuid4(), uuid4()
        started = time.perf_counter()
        with source.open("rb") as stream:
            uploaded = storage.put(source_object_key(inspection_id), stream)
        upload_ms = elapsed_ms(started)

        probe = TimedProbeRunner()
        normalization = TimedNormalizationRunner()
        metadata_store = RecordingMetadataStore()
        stage = MediaValidationStage(
            storage,
            metadata_store,  # type: ignore[arg-type]
            limits=MediaLimits(),
            probe_runner=probe,
            normalization_runner=normalization,
        )
        started = time.perf_counter()
        media = stage.run(
            job_id=job_id,
            inspection_id=inspection_id,
            dispatch_generation=1,
            lease_token=lease_token,
        )
        media_stage_ms = elapsed_ms(started)

        media_key = metadata_store.normalized_object_key or source_object_key(
            inspection_id
        )
        frames: list[PredictionFrame] = []
        workflow_call_ms = 0.0
        started = time.perf_counter()
        with FfmpegFrameSampler().frames(
            storage, media_key, media, is_cancelled=lambda: False
        ) as sampled:
            for frame in sampled:
                workflow_started = time.perf_counter()
                frames.append(predictions_for_frame(frame, case.prediction_density))
                workflow_call_ms += elapsed_ms(workflow_started)
        workflow_stage_ms = elapsed_ms(started)

        started = time.perf_counter()
        artifact = PredictionArtifactStage(
            storage,
            RecordingCompletionStore(),  # type: ignore[arg-type]
        ).run(
            job_id=job_id,
            inspection_id=inspection_id,
            dispatch_generation=1,
            lease_token=lease_token,
            media=media,
            workflow=WorkflowConfiguration(
                endpoint="fixture://assembly-line-no-hard-hat"
            ),
            frames=frames,
        )
        artifact_ms = elapsed_ms(started)
        artifact_key = processing_object_keys(inspection_id, 1).prediction
        artifact_metadata = storage.metadata(artifact_key)
        artifact_destination.parent.mkdir(parents=True, exist_ok=True)
        with (
            storage.read(artifact_key) as source_stream,
            artifact_destination.open("wb") as output_stream,
        ):
            copy_stream(source_stream, output_stream)

        return {
            "case": asdict(case),
            "sourceBytes": uploaded.size_bytes,
            "normalized": metadata_store.normalized_object_key is not None,
            "normalizedBytes": media.size_bytes
            if metadata_store.normalized_object_key
            else None,
            "frameCount": len(frames),
            "predictionCount": sum(len(frame.predictions) for frame in frames),
            "artifactBytesGzip": artifact_metadata.size_bytes,
            "artifactBytesJson": len(artifact.model_dump_json()),
            "timingsMs": {
                "uploadLocalFilesystem": upload_ms,
                "mediaStage": media_stage_ms,
                "ffprobe": round(probe.elapsed_ms, 3),
                "normalization": round(normalization.elapsed_ms, 3),
                "frameSamplingAndWorkflow": workflow_stage_ms,
                "syntheticWorkflowCalls": round(workflow_call_ms, 3),
                "artifact": artifact_ms,
                "endToEnd": round(
                    upload_ms + media_stage_ms + workflow_stage_ms + artifact_ms, 3
                ),
            },
            "peakRssBytes": max_rss_bytes(resource.getrusage(resource.RUSAGE_SELF)),
            "peakChildRssBytes": max_rss_bytes(
                resource.getrusage(resource.RUSAGE_CHILDREN)
            ),
        }


def case_by_name(name: str) -> BenchmarkCase:
    for case in CASES:
        if case.name == name:
            return case
    raise ValueError(f"Unknown benchmark case: {name}")


def selected_cases(names: Sequence[str]) -> tuple[BenchmarkCase, ...]:
    return tuple(case_by_name(name) for name in names) if names else CASES


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("benchmark-results.json"))
    parser.add_argument("--work-directory", type=Path)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--child-case")
    parser.add_argument("--source")
    parser.add_argument("--artifact")
    arguments = parser.parse_args()
    if arguments.child_case:
        result = run_case(
            case_by_name(arguments.child_case),
            Path(arguments.source),
            Path(arguments.artifact),
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0

    temporary: tempfile.TemporaryDirectory[str] | None = None
    if arguments.work_directory is None:
        temporary = tempfile.TemporaryDirectory(prefix="factorylens-envelope-")
        work_directory = Path(temporary.name)
    else:
        work_directory = arguments.work_directory.resolve()
        work_directory.mkdir(parents=True, exist_ok=True)

    generation: dict[str, object] = {}
    results: list[object] = []
    try:
        for case in selected_cases(arguments.case):
            source = work_directory / "media" / f"{case.name}.{case.container}"
            source.parent.mkdir(parents=True, exist_ok=True)
            generation[case.name] = generate_media(case, source)
            artifact = work_directory / "artifacts" / f"{case.name}.json.gz"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--child-case",
                    case.name,
                    "--source",
                    str(source),
                    "--artifact",
                    str(artifact),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            results.append(json.loads(completed.stdout))

        largest_artifact = max(
            results,
            key=lambda result: result["artifactBytesGzip"],  # type: ignore[index]
        )
        largest_case_name = largest_artifact["case"]["name"]  # type: ignore[index]
        browser_completed = subprocess.run(
            [
                "node",
                str(REPOSITORY_ROOT / "scripts" / "benchmark-browser-artifact.mjs"),
                str(work_directory / "artifacts" / f"{largest_case_name}.json.gz"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        payload = {
            "schemaVersion": 1,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "environment": {
                "platform": platform.platform(),
                "machine": platform.machine(),
                "python": platform.python_version(),
                "cpuCount": os.cpu_count(),
                "ffmpeg": subprocess.run(
                    ["ffmpeg", "-version"], check=True, capture_output=True, text=True
                ).stdout.splitlines()[0],
            },
            "generation": generation,
            "cases": results,
            "browser": {
                "case": largest_case_name,
                **json.loads(browser_completed.stdout),
            },
            "limitations": [
                "Local filesystem upload does not measure browser-to-R2 network throughput.",
                "Synthetic Workflow timings exclude Roboflow network latency and quota use.",
                "Database, queue, and Cloud Run measurements require the controlled deployed run.",
            ],
        }
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(json.dumps(payload, indent=2) + "\n")
        print(arguments.output)
        return 0
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
