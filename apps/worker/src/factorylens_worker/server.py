import json
import logging
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol

from pydantic import ValidationError

from factorylens_worker.contracts import ProcessTaskMessage
from factorylens_worker.job_lease import (
    LeaseDecision,
    LeaseOutcome,
    PostgresJobLeaseStore,
)

MAX_TASK_BODY_BYTES = 16 * 1024
logger = logging.getLogger(__name__)


class JobLeaseStore(Protocol):
    def acquire(self, message: ProcessTaskMessage) -> LeaseDecision: ...


class WorkerServer(ThreadingHTTPServer):
    lease_store: JobLeaseStore


def json_payload(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def health_payload() -> bytes:
    """Return the worker health response as encoded JSON."""
    return json_payload({"service": "worker", "status": "ok"})


class WorkerHandler(BaseHTTPRequestHandler):
    """Serve worker health and internal task requests."""

    server_version = "FactoryLensWorker"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self._send_json(HTTPStatus.OK, health_payload())

    def do_POST(self) -> None:
        if self.path != "/internal/tasks/process":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        body = self._read_json_body()
        if body is None:
            return

        try:
            message = ProcessTaskMessage.model_validate_json(body)
        except ValidationError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_task_payload")
            return

        try:
            decision = self._worker_server.lease_store.acquire(message)
        except Exception:
            logger.exception("Task lease acquisition failed")
            self._send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE, "database_unavailable"
            )
            return

        if decision.outcome is LeaseOutcome.ACQUIRED:
            self._send_json(HTTPStatus.ACCEPTED, json_payload({"outcome": "acquired"}))
            return
        if decision.outcome is LeaseOutcome.TERMINAL:
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

    server = WorkerServer((host, port), WorkerHandler)
    server.lease_store = PostgresJobLeaseStore(database_url)
    print(f"FactoryLens worker listening on http://{host}:{port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
