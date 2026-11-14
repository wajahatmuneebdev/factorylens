import json
import os
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.internal_auth import (
    GoogleServiceIdentityVerifier,
    StaticTokenIdentityVerifier,
)
from factorylens_worker.job_lease import (
    JobLease,
    LeaseDecision,
    LeaseOutcome,
    PostgresJobLeaseStore,
)
from factorylens_worker.media_validation import MediaLimits, MediaValidationStage
from factorylens_worker.media_validation_store import PostgresMediaMetadataStore
from factorylens_worker.observability import write_structured_log
from factorylens_worker.prediction_artifact import PredictionArtifactStage
from factorylens_worker.prediction_artifact_store import (
    PostgresInspectionCompletionStore,
)
from factorylens_worker.processing_pipeline import (
    FfmpegFrameSampler,
    InspectionProcessingPipeline,
)
from factorylens_worker.storage import R2ObjectStorage
from factorylens_worker.task_execution import (
    TaskExecutionOutcome,
    TaskExecutor,
)
from factorylens_worker.workflow import (
    create_workflow_runner,
    workflow_configuration_from_environment,
)

MAX_TASK_BODY_BYTES = 16 * 1024


class JobLeaseStore(Protocol):
    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision: ...


class JobExecutor(Protocol):
    def execute(self, lease: JobLease) -> TaskExecutionOutcome: ...


class InternalIdentityVerifier(Protocol):
    def verify(self, token: str) -> bool: ...


class WorkerServer(ThreadingHTTPServer):
    lease_store: JobLeaseStore
    executor: JobExecutor
    identity_verifier: InternalIdentityVerifier


def json_payload(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def health_payload() -> bytes:
    """Return the worker health response as encoded JSON."""
    return json_payload({"service": "worker", "status": "ok"})


def positive_environment_integer(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


class WorkerHandler(BaseHTTPRequestHandler):
    """Serve worker health and internal task requests."""

    server_version = "FactoryLensWorker"

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def do_GET(self) -> None:
        self._request_id = str(uuid4())
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self._send_json(HTTPStatus.OK, health_payload())

    def do_POST(self) -> None:
        self._request_id = str(uuid4())
        started_at = time.monotonic()
        if self.path != "/internal/tasks/process":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        token = self._bearer_token()
        if (
            self._has_browser_session()
            or token is None
            or not self._worker_server.identity_verifier.verify(token)
        ):
            self._log_request_error(HTTPStatus.UNAUTHORIZED, "authentication_required")
            self._send_error_json(HTTPStatus.UNAUTHORIZED, "authentication_required")
            return

        body = self._read_json_body()
        if body is None:
            return

        try:
            message = ProcessTaskMessage.model_validate_json(body)
        except ValidationError:
            self._log_request_error(HTTPStatus.BAD_REQUEST, "invalid_task_payload")
            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_task_payload")
            return

        task_id = self.headers.get("X-CloudTasks-TaskName")
        context = {
            "correlationId": str(message.correlationId),
            "deliveryAttempt": self._delivery_attempt(),
            "dispatchGeneration": message.dispatchGeneration,
            "jobId": str(message.jobId),
            "requestId": self._request_id,
            "taskId": task_id,
        }
        write_structured_log("info", "task_received", **context)

        try:
            decision = self._worker_server.lease_store.acquire(message)
        except Exception as error:
            write_structured_log(
                "error",
                "task_lease_acquisition_failed",
                **context,
                errorType=type(error).__name__,
            )
            self._send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE, "database_unavailable"
            )
            return

        if decision.outcome is LeaseOutcome.ACQUIRED:
            if decision.lease is None:
                write_structured_log("error", "task_lease_missing", **context)
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE, "lease_unavailable"
                )
                return
            lease_context = {
                **context,
                "attempt": decision.lease.attempt_count,
                "inspectionId": str(decision.lease.inspection_id),
            }
            write_structured_log("info", "task_started", **lease_context)
            try:
                execution = self._worker_server.executor.execute(decision.lease)
            except Exception as error:
                write_structured_log(
                    "error",
                    "task_execution_interrupted",
                    **lease_context,
                    durationMs=round((time.monotonic() - started_at) * 1000),
                    errorType=type(error).__name__,
                )
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE, "processing_interrupted"
                )
                return
            write_structured_log(
                "info" if execution is TaskExecutionOutcome.ACKNOWLEDGED else "error",
                "task_completed",
                **lease_context,
                durationMs=round((time.monotonic() - started_at) * 1000),
                outcome=execution.value,
            )
            if execution is TaskExecutionOutcome.RETRY:
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "processing_retry_scheduled",
                    extra_headers={"Retry-After": "10"},
                )
                return
            self._send_empty(HTTPStatus.NO_CONTENT)
            return
        if decision.outcome is LeaseOutcome.TERMINAL:
            write_structured_log("info", "task_duplicate_acknowledged", **context)
            self._send_empty(HTTPStatus.NO_CONTENT)
            return
        if decision.outcome is LeaseOutcome.BUSY:
            self._send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "lease_conflict",
                extra_headers={"Retry-After": "10"},
            )
            return
        if decision.outcome is LeaseOutcome.GENERATION_MISMATCH:
            self._send_error_json(HTTPStatus.CONFLICT, "dispatch_generation_mismatch")
            return
        if decision.outcome is LeaseOutcome.NOT_FOUND:
            self._send_error_json(HTTPStatus.NOT_FOUND, "job_not_found")
            return

        self._send_error_json(HTTPStatus.CONFLICT, "job_not_eligible")

    def _delivery_attempt(self) -> int | None:
        raw = self.headers.get("X-CloudTasks-TaskRetryCount")
        try:
            return int(raw) + 1 if raw is not None else None
        except ValueError:
            return None

    def _log_request_error(self, status: HTTPStatus, error_code: str) -> None:
        write_structured_log(
            "error" if status >= HTTPStatus.INTERNAL_SERVER_ERROR else "info",
            "worker_request_rejected",
            errorCode=error_code,
            requestId=self._request_id,
            status=int(status),
            taskId=self.headers.get("X-CloudTasks-TaskName"),
        )

    @property
    def _worker_server(self) -> WorkerServer:
        if not isinstance(self.server, WorkerServer):
            raise TypeError("WorkerHandler requires WorkerServer")
        return self.server

    def _read_json_body(self) -> bytes | None:
        if self.headers.get_content_type() != "application/json":
            self._send_error_json(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "content_type_must_be_json"
            )
            return None

        content_length = self.headers.get("Content-Length")
        try:
            length = int(content_length) if content_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._send_error_json(HTTPStatus.LENGTH_REQUIRED, "content_length_required")
            return None
        if length > MAX_TASK_BODY_BYTES:
            self._send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large")
            return None

        return self.rfile.read(length)

    def _bearer_token(self) -> str | None:
        authorization = self.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if separator != " " or scheme.lower() != "bearer" or not token:
            return None
        if any(character.isspace() for character in token):
            return None
        return token

    def _has_browser_session(self) -> bool:
        return any(
            entry.strip().startswith("__Host-factorylens_session=")
            for entry in self.headers.get("Cookie", "").split(";")
        )

    def _send_empty(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_error_json(
        self,
        status: HTTPStatus,
        code: str,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self._send_json(
            status,
            json_payload({"error": code}),
            extra_headers=extra_headers,
        )

    def _send_json(
        self,
        status: HTTPStatus,
        payload: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Request-ID", self._request_id)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    """Start the worker HTTP server."""
    host = os.environ.get("WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("WORKER_PORT", "8000"))
    database_url = os.environ.get("DATABASE_URL")
    if database_url is None:
        raise RuntimeError("DATABASE_URL is required")
    auth_mode = os.environ.get("WORKER_AUTH_MODE", "google")
    if auth_mode == "local":
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError("Local worker authentication requires a loopback host")
        identity_verifier: InternalIdentityVerifier = StaticTokenIdentityVerifier(
            os.environ.get("LOCAL_WORKER_TASK_TOKEN", "")
        )
    elif auth_mode == "google":
        oidc_audience = os.environ.get("WORKER_OIDC_AUDIENCE")
        service_account_email = os.environ.get("CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL")
        if not oidc_audience or not service_account_email:
            raise RuntimeError(
                "WORKER_OIDC_AUDIENCE and "
                "CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL are required"
            )
        identity_verifier = GoogleServiceIdentityVerifier(
            oidc_audience, service_account_email
        )
    else:
        raise RuntimeError("WORKER_AUTH_MODE must be google or local")

    required_r2_values = {
        name: os.environ.get(name)
        for name in (
            "R2_ACCESS_KEY_ID",
            "R2_ACCOUNT_ID",
            "R2_BUCKET",
            "R2_SECRET_ACCESS_KEY",
        )
    }
    missing_r2_values = [
        name for name, value in required_r2_values.items() if not value
    ]
    if missing_r2_values:
        raise RuntimeError(f"{', '.join(missing_r2_values)} are required")

    storage = R2ObjectStorage(
        account_id=required_r2_values["R2_ACCOUNT_ID"] or "",
        access_key_id=required_r2_values["R2_ACCESS_KEY_ID"] or "",
        secret_access_key=required_r2_values["R2_SECRET_ACCESS_KEY"] or "",
        bucket=required_r2_values["R2_BUCKET"] or "",
    )
    workflow_configuration = workflow_configuration_from_environment()
    media_limits = MediaLimits(
        max_size_bytes=positive_environment_integer(
            "MAX_UPLOAD_BYTES", 250 * 1024 * 1024
        ),
        max_duration_ms=positive_environment_integer(
            "MAX_MEDIA_DURATION_MS", 5 * 60 * 1000
        ),
        max_width=positive_environment_integer("MAX_MEDIA_WIDTH", 1920),
        max_height=positive_environment_integer("MAX_MEDIA_HEIGHT", 1080),
    )
    lease_store = PostgresJobLeaseStore(database_url)
    pipeline = InspectionProcessingPipeline(
        storage=storage,
        media_stage=MediaValidationStage(
            storage,
            PostgresMediaMetadataStore(database_url),
            limits=media_limits,
        ),
        frame_sampler=FfmpegFrameSampler(),
        workflow_runner=create_workflow_runner(workflow_configuration),
        workflow_configuration=workflow_configuration,
        artifact_stage=PredictionArtifactStage(
            storage,
            PostgresInspectionCompletionStore(database_url),
        ),
    )

    server = WorkerServer((host, port), WorkerHandler)
    server.lease_store = lease_store
    server.executor = TaskExecutor(lease_store, pipeline)
    server.identity_verifier = identity_verifier
    write_structured_log("info", "worker_listening", host=host, port=port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
