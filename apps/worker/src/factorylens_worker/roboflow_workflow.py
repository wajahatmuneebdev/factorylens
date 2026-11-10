from __future__ import annotations

import base64
import binascii
import json
import struct
import zlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from typing import Literal, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from factorylens_worker.contracts import (
    FramePrediction,
    PredictionBox,
    PredictionFrame,
)
from factorylens_worker.workflow import (
    InvalidWorkflowResponseError,
    RetryableWorkflowProviderError,
    TerminalWorkflowProviderError,
    WorkflowCancelledError,
    WorkflowConfiguration,
    WorkflowFrameInput,
    WorkflowProviderRateLimitError,
    WorkflowProviderTimeoutError,
)

MAX_WORKFLOW_RESPONSE_BYTES = 4 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True, slots=True)
class RoboflowWorkflowResponse:
    status_code: int
    body: bytes


class RoboflowWorkflowTransport(Protocol):
    def post(
        self,
        *,
        url: str,
        payload: Mapping[str, object],
        api_key: str | None,
        timeout_seconds: float,
    ) -> RoboflowWorkflowResponse: ...


class _TransportTimeoutError(RuntimeError):
    pass


class _TransportUnavailableError(RuntimeError):
    pass


class _ResponseTooLargeError(RuntimeError):
    pass


class _NoRedirectHandler(HTTPRedirectHandler):
    """Keep authorization headers on the configured origin only."""

    def redirect_request(
        self,
        request: Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> None:
        return None


class UrllibRoboflowWorkflowTransport:
    """Call the documented synchronous Workflow HTTP endpoint."""

    def post(
        self,
        *,
        url: str,
        payload: Mapping[str, object],
        api_key: str | None,
        timeout_seconds: float,
    ) -> RoboflowWorkflowResponse:
        headers = {"Content-Type": "application/json"}
        if api_key is not None:
            headers["Authorization"] = f"Bearer {api_key}"
        request = Request(
            url,
            data=json.dumps(payload, separators=(",", ":")).encode(),
            headers=headers,
            method="POST",
        )
        try:
            opener = build_opener(_NoRedirectHandler())
            with opener.open(request, timeout=timeout_seconds) as response:
                return RoboflowWorkflowResponse(
                    status_code=response.status,
                    body=_read_bounded_response(response.read),
                )
        except HTTPError as error:
            error.close()
            return RoboflowWorkflowResponse(status_code=error.code, body=b"")
        except TimeoutError as error:
            raise _TransportTimeoutError from error
        except URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise _TransportTimeoutError from error
            raise _TransportUnavailableError from error
        except OSError as error:
            raise _TransportUnavailableError from error


class _ProviderModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class _ProviderDetection(_ProviderModel):
    class_name: Literal["Person", "Hardhat", "NO-Hardhat"] = Field(alias="class")
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)


class _ProviderPredictionOutput(_ProviderModel):
    predictions: list[_ProviderDetection]


class _ProviderFrameOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    predictions: _ProviderPredictionOutput


class _ProviderWorkflowResponse(_ProviderModel):
    outputs: list[_ProviderFrameOutput]


class RoboflowWorkflowRunner:
    """Translate the selected Roboflow Workflow into FactoryLens predictions."""

    def __init__(
        self,
        *,
        api_key: str | None,
        transport: RoboflowWorkflowTransport | None = None,
    ) -> None:
        self._api_key = api_key
        self._transport = transport or UrllibRoboflowWorkflowTransport()

    def run_frame(
        self,
        frame: WorkflowFrameInput,
        configuration: WorkflowConfiguration,
        *,
        is_cancelled: Callable[[], bool] = lambda: False,
    ) -> PredictionFrame:
        _raise_if_cancelled(is_cancelled)
        if configuration.workspace is None:
            raise ValueError("Roboflow Workflow runner requires a workspace")

        encoded_image = base64.b64encode(_encode_png(frame)).decode("ascii")
        _raise_if_cancelled(is_cancelled)
        payload: dict[str, object] = {
            "inputs": {"image": {"type": "base64", "value": encoded_image}},
            "workflow_version_id": configuration.workflow_version,
            "use_cache": configuration.use_cache,
            "enable_profiling": False,
            "disable_sinks": True,
        }
        endpoint = configuration.endpoint.rstrip("/")
        url = (
            f"{endpoint}/{quote(configuration.workspace, safe='')}"
            f"/workflows/{quote(configuration.workflow_id, safe='')}"
        )

        try:
            response = self._transport.post(
                url=url,
                payload=payload,
                api_key=self._api_key,
                timeout_seconds=configuration.request_timeout_seconds,
            )
        except _TransportTimeoutError as error:
            raise WorkflowProviderTimeoutError(
                "The Workflow provider request timed out"
            ) from error
        except _TransportUnavailableError as error:
            raise RetryableWorkflowProviderError(
                "The Workflow provider is temporarily unavailable"
            ) from error
        except _ResponseTooLargeError as error:
            raise InvalidWorkflowResponseError(
                "The Workflow provider response exceeded the configured limit"
            ) from error

        _raise_if_cancelled(is_cancelled)
        _raise_for_status(response.status_code)
        detections = _validate_response(response.body)
        _raise_if_cancelled(is_cancelled)
        return _to_prediction_frame(frame, detections)


def _read_bounded_response(read: Callable[[int], bytes]) -> bytes:
    body = read(MAX_WORKFLOW_RESPONSE_BYTES + 1)
    if len(body) > MAX_WORKFLOW_RESPONSE_BYTES:
        raise _ResponseTooLargeError
    return body


def _raise_for_status(status_code: int) -> None:
    if status_code == HTTPStatus.OK:
        return
    if status_code in {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.GATEWAY_TIMEOUT}:
        raise WorkflowProviderTimeoutError("The Workflow provider request timed out")
    if status_code == HTTPStatus.TOO_MANY_REQUESTS:
        raise WorkflowProviderRateLimitError(
            "The Workflow provider rate limit was reached"
        )
    if status_code == HTTPStatus.TOO_EARLY or 500 <= status_code <= 599:
        raise RetryableWorkflowProviderError(
            "The Workflow provider is temporarily unavailable"
        )
    if 400 <= status_code <= 499:
        raise TerminalWorkflowProviderError(
            "The Workflow provider rejected the configured request"
        )
    raise InvalidWorkflowResponseError(
        "The Workflow provider returned an unexpected HTTP status"
    )


def _validate_response(body: bytes) -> list[_ProviderDetection]:
    try:
        value = json.loads(body)
        response = _ProviderWorkflowResponse.model_validate(value)
    except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as error:
        raise InvalidWorkflowResponseError(
            "The Workflow provider returned an invalid response"
        ) from error
    if len(response.outputs) != 1:
        raise InvalidWorkflowResponseError(
            "The Workflow provider returned an invalid response"
        )
    return response.outputs[0].predictions.predictions


def _to_prediction_frame(
    frame: WorkflowFrameInput, detections: list[_ProviderDetection]
) -> PredictionFrame:
    predictions: list[FramePrediction] = []
    for ordinal, detection in enumerate(detections):
        box = _clip_box(
            x=detection.x,
            y=detection.y,
            width=detection.width,
            height=detection.height,
            image_width=frame.image.width,
            image_height=frame.image.height,
        )
        if box is None:
            continue
        predictions.append(
            FramePrediction(
                id=f"f{frame.frame_index:06d}-p{ordinal:03d}",
                className=detection.class_name,
                confidence=detection.confidence,
                box=box,
            )
        )
    return PredictionFrame(
        timestampMs=frame.timestamp_ms,
        predictions=predictions,
    )


def _clip_box(
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    image_width: int,
    image_height: int,
) -> PredictionBox | None:
    left = max(0.0, x - width / 2)
    right = min(float(image_width), x + width / 2)
    top = max(0.0, y - height / 2)
    bottom = min(float(image_height), y + height / 2)
    clipped_width = right - left
    clipped_height = bottom - top
    if clipped_width <= 0 or clipped_height <= 0:
        return None
    return PredictionBox(
        x=(left + right) / 2,
        y=(top + bottom) / 2,
        width=clipped_width,
        height=clipped_height,
    )


def _encode_png(frame: WorkflowFrameInput) -> bytes:
    image = frame.image
    row_size = image.width * 3
    filtered = bytearray((row_size + 1) * image.height)
    for row_index in range(image.height):
        target_start = row_index * (row_size + 1)
        source_start = row_index * row_size
        filtered[target_start] = 0
        filtered[target_start + 1 : target_start + row_size + 1] = image.rgb24[
            source_start : source_start + row_size
        ]

    header = struct.pack(
        ">IIBBBBB",
        image.width,
        image.height,
        8,
        2,
        0,
        0,
        0,
    )
    return b"".join(
        (
            _PNG_SIGNATURE,
            _png_chunk(b"IHDR", header),
            _png_chunk(b"IDAT", zlib.compress(filtered)),
            _png_chunk(b"IEND", b""),
        )
    )


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    checksum = binascii.crc32(chunk_type)
    checksum = binascii.crc32(data, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", checksum)
    )


def _raise_if_cancelled(is_cancelled: Callable[[], bool]) -> None:
    if is_cancelled():
        raise WorkflowCancelledError("Workflow execution was cancelled")
