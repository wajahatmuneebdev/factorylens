import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def health_payload() -> bytes:
    """Return the worker health response as encoded JSON."""
    return json.dumps({"service": "worker", "status": "ok"}).encode()


class HealthHandler(BaseHTTPRequestHandler):
    """Serve the worker's placeholder health endpoint."""

    server_version = "FactoryLensWorker"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        payload = health_payload()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    """Start the placeholder worker HTTP server."""
    host = os.environ.get("WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("WORKER_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), HealthHandler)
    print(f"FactoryLens worker listening on http://{host}:{port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
