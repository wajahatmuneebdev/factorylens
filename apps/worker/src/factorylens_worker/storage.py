from __future__ import annotations

import errno
import io
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Protocol, cast
from uuid import UUID

import boto3  # type: ignore[import-untyped]
from boto3.exceptions import Boto3Error  # type: ignore[import-untyped]
from botocore.client import BaseClient  # type: ignore[import-untyped]
from botocore.exceptions import (  # type: ignore[import-untyped]
    BotoCoreError,
    ClientError,
)


@dataclass(frozen=True, slots=True)
class StorageObjectMetadata:
    key: str
    size_bytes: int


class ObjectStorage(Protocol):
    def put(self, key: str, source: BinaryIO) -> StorageObjectMetadata: ...

    def read(self, key: str) -> BinaryIO: ...

    def metadata(self, key: str) -> StorageObjectMetadata: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...


@dataclass(frozen=True, slots=True)
class ProcessingObjectKeys:
    normalized: str
    thumbnail: str
    prediction: str


class InvalidStorageObjectKeyError(ValueError):
    pass


class StorageObjectNotFoundError(FileNotFoundError):
    def __init__(self, key: str) -> None:
        super().__init__(f"Storage object not found: {key}")
        self.key = key


class StorageUnavailableError(OSError):
    pass


_KEY_SEGMENT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _inspection_prefix(inspection_id: UUID) -> str:
    if not isinstance(inspection_id, UUID):
        raise TypeError("inspection_id must be a UUID")
    return f"inspections/{inspection_id}"


def source_object_key(inspection_id: UUID) -> str:
    return f"{_inspection_prefix(inspection_id)}/source"


def processing_object_keys(
    inspection_id: UUID, generation: int
) -> ProcessingObjectKeys:
    if (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
        or generation > 2**53 - 1
    ):
        raise ValueError("generation must be a positive safe integer")

    generation_prefix = f"{_inspection_prefix(inspection_id)}/generations/{generation}"
    return ProcessingObjectKeys(
        normalized=f"{generation_prefix}/normalized",
        thumbnail=f"{generation_prefix}/thumbnail",
        prediction=f"{generation_prefix}/prediction",
    )


def _validate_object_key(key: str) -> None:
    segments = key.split("/")
    if (
        not key
        or "\\" in key
        or Path(key).is_absolute()
        or any(_KEY_SEGMENT_PATTERN.fullmatch(segment) is None for segment in segments)
    ):
        raise InvalidStorageObjectKeyError(f"Invalid storage object key: {key!r}")


class LocalFilesystemStorage:
    def __init__(self, root_directory: Path) -> None:
        self._root_directory = root_directory.resolve()

    def put(self, key: str, source: BinaryIO) -> StorageObjectMetadata:
        object_path = self._object_path(key)
        object_path.parent.mkdir(parents=True, exist_ok=True)

        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=object_path.parent,
                prefix=f"{object_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                shutil.copyfileobj(source, temporary_file)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, object_path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

        return self.metadata(key)

    def read(self, key: str) -> BinaryIO:
        object_path = self._object_path(key)
        try:
            return object_path.open("rb")
        except (FileNotFoundError, NotADirectoryError) as error:
            raise StorageObjectNotFoundError(key) from error

    def metadata(self, key: str) -> StorageObjectMetadata:
        object_path = self._object_path(key)
        try:
            object_stat = object_path.stat()
        except (FileNotFoundError, NotADirectoryError) as error:
            raise StorageObjectNotFoundError(key) from error
        if not object_path.is_file():
            raise StorageObjectNotFoundError(key)
        return StorageObjectMetadata(key=key, size_bytes=object_stat.st_size)

    def exists(self, key: str) -> bool:
        try:
            self.metadata(key)
        except StorageObjectNotFoundError:
            return False
        return True

    def delete(self, key: str) -> None:
        object_path = self._object_path(key)
        try:
            object_path.unlink()
        except (FileNotFoundError, NotADirectoryError):
            return

        self._remove_empty_parents(object_path.parent)

    def _object_path(self, key: str) -> Path:
        _validate_object_key(key)
        object_path = self._root_directory.joinpath(*key.split("/"))
        if not object_path.is_relative_to(self._root_directory):
            raise InvalidStorageObjectKeyError(f"Invalid storage object key: {key!r}")
        return object_path

    def _remove_empty_parents(self, directory: Path) -> None:
        current_directory = directory
        while current_directory != self._root_directory:
            try:
                current_directory.rmdir()
            except OSError as error:
                if error.errno in {errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST}:
                    return
                raise
            current_directory = current_directory.parent


class R2ObjectStorage:
    """Private S3-compatible object access for the worker's R2 bucket."""

    def __init__(
        self,
        *,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        client: BaseClient | None = None,
    ) -> None:
        if not all((account_id, access_key_id, secret_access_key, bucket)):
            raise ValueError("R2 storage configuration values must not be empty")
        if re.fullmatch(r"[0-9a-fA-F]{32}", account_id) is None:
            raise ValueError("R2 account ID must contain 32 hexadecimal characters")
        self._bucket = bucket
        self._client = client or boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            region_name="auto",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
        )

    def put(self, key: str, source: BinaryIO) -> StorageObjectMetadata:
        _validate_object_key(key)
        try:
            self._client.upload_fileobj(source, self._bucket, key)
        except (Boto3Error, BotoCoreError) as error:
            raise StorageUnavailableError("R2 object write failed") from error
        return self.metadata(key)

    def read(self, key: str) -> BinaryIO:
        _validate_object_key(key)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if _is_missing_r2_object(error):
                raise StorageObjectNotFoundError(key) from error
            raise StorageUnavailableError("R2 object read failed") from error
        except BotoCoreError as error:
            raise StorageUnavailableError("R2 object read failed") from error
        body = response.get("Body")
        if body is None or not hasattr(body, "read"):
            raise StorageUnavailableError(
                "R2 returned an object without a readable body"
            )
        return cast(BinaryIO, _R2ReadStream(body))

    def metadata(self, key: str) -> StorageObjectMetadata:
        _validate_object_key(key)
        try:
            response = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if _is_missing_r2_object(error):
                raise StorageObjectNotFoundError(key) from error
            raise StorageUnavailableError("R2 object metadata failed") from error
        except BotoCoreError as error:
            raise StorageUnavailableError("R2 object metadata failed") from error
        size = response.get("ContentLength")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise StorageUnavailableError("R2 returned invalid object metadata")
        return StorageObjectMetadata(key=key, size_bytes=size)

    def exists(self, key: str) -> bool:
        try:
            self.metadata(key)
        except StorageObjectNotFoundError:
            return False
        return True

    def delete(self, key: str) -> None:
        _validate_object_key(key)
        try:
            self._client.delete_object(Bucket=self._bucket, Key=key)
        except BotoCoreError as error:
            raise StorageUnavailableError("R2 object deletion failed") from error


class _R2ReadStream(io.RawIOBase):
    def __init__(self, body: Any) -> None:
        self._body = body

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        try:
            value = self._body.read(size)
        except BotoCoreError as error:
            raise StorageUnavailableError("R2 object stream failed") from error
        if not isinstance(value, bytes):
            raise StorageUnavailableError("R2 returned invalid object bytes")
        return value

    def close(self) -> None:
        if not self.closed:
            self._body.close()
        super().close()


def _is_missing_r2_object(error: ClientError) -> bool:
    response = error.response
    error_code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return error_code in {"NoSuchKey", "NotFound", "404"} or status == 404
