import json
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO
from uuid import UUID

import pytest
from boto3.exceptions import S3UploadFailedError  # type: ignore[import-untyped]
from botocore.exceptions import EndpointConnectionError  # type: ignore[import-untyped]

from factorylens_worker.storage import (
    InvalidStorageObjectKeyError,
    LocalFilesystemStorage,
    R2ObjectStorage,
    StorageObjectMetadata,
    StorageObjectNotFoundError,
    StorageUnavailableError,
    processing_object_keys,
    source_object_key,
)

FIXTURE_PATH = Path(__file__).parents[3] / "fixtures" / "storage" / "contract-v1.json"


def load_fixture() -> dict[str, Any]:
    value: object = json.loads(FIXTURE_PATH.read_text())
    assert isinstance(value, dict)
    return value


def test_generates_shared_keys_only_from_application_identifiers() -> None:
    fixture = load_fixture()

    inspection_id = UUID(fixture["inspectionId"])
    keys = {
        "source": source_object_key(inspection_id),
        **asdict(processing_object_keys(inspection_id, fixture["generation"])),
    }

    assert keys == fixture["keys"]
    with pytest.raises(ValueError, match="positive safe integer"):
        processing_object_keys(inspection_id, 0)


def test_local_storage_contract_for_every_object_kind(tmp_path: Path) -> None:
    fixture = load_fixture()
    storage = LocalFilesystemStorage(tmp_path)

    for kind, key in fixture["keys"].items():
        content = fixture["objects"][kind].encode()

        metadata = storage.put(key, BytesIO(content))

        assert metadata.key == key
        assert metadata.size_bytes == len(content)
        assert storage.exists(key)
        assert storage.metadata(key) == metadata
        with storage.read(key) as stored:
            assert stored.read() == content

    source_key = fixture["keys"]["source"]
    replacement = fixture["replacement"].encode()
    replaced = storage.put(source_key, BytesIO(replacement))
    assert replaced.size_bytes == len(replacement)
    with storage.read(source_key) as stored:
        assert stored.read() == replacement

    for key in fixture["keys"].values():
        storage.delete(key)
        storage.delete(key)
        assert not storage.exists(key)
    assert list(tmp_path.iterdir()) == []


def test_reports_missing_objects_consistently(tmp_path: Path) -> None:
    fixture = load_fixture()
    storage = LocalFilesystemStorage(tmp_path)
    missing_key = fixture["missingKey"]

    with pytest.raises(StorageObjectNotFoundError):
        storage.read(missing_key)
    with pytest.raises(StorageObjectNotFoundError):
        storage.metadata(missing_key)
    assert not storage.exists(missing_key)
    storage.delete(missing_key)


def test_rejects_traversal_keys(tmp_path: Path) -> None:
    fixture = load_fixture()
    storage = LocalFilesystemStorage(tmp_path)

    for key in fixture["invalidKeys"]:
        with pytest.raises(InvalidStorageObjectKeyError):
            storage.put(key, BytesIO(b"unsafe"))


class FailingReader(BytesIO):
    def read(self, size: int | None = -1) -> bytes:
        if self.tell() > 0:
            raise OSError("fixture stream failed")
        return super().read(4 if size is None or size < 0 else min(size, 4))


def test_failed_replacement_preserves_the_previous_object(tmp_path: Path) -> None:
    fixture = load_fixture()
    storage = LocalFilesystemStorage(tmp_path)
    key = fixture["keys"]["source"]
    initial = fixture["objects"]["source"].encode()
    storage.put(key, BytesIO(initial))

    with pytest.raises(OSError, match="fixture stream failed"):
        storage.put(key, FailingReader(b"partial replacement"))

    with storage.read(key) as stored:
        assert stored.read() == initial
    stored_directory = tmp_path.joinpath(*key.split("/")[:-1])
    assert [path.name for path in stored_directory.iterdir()] == ["source"]


class FakeR2Client:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def upload_fileobj(self, source: BinaryIO, bucket: str, key: str) -> None:
        del bucket
        self.objects[key] = source.read()

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        del Bucket
        return {"Body": BytesIO(self.objects[Key])}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        del Bucket
        return {"ContentLength": len(self.objects[Key])}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        del Bucket
        self.objects.pop(Key, None)


def test_r2_storage_uses_private_s3_object_operations() -> None:
    fixture = load_fixture()
    client = FakeR2Client()
    storage = R2ObjectStorage(
        account_id="a" * 32,
        access_key_id="access",
        secret_access_key="secret",
        bucket="private",
        client=client,
    )
    key = fixture["keys"]["source"]

    metadata = storage.put(key, BytesIO(b"video"))

    assert metadata == StorageObjectMetadata(key=key, size_bytes=5)
    assert storage.exists(key)
    with storage.read(key) as stored:
        assert stored.read() == b"video"
    storage.delete(key)
    assert client.objects == {}


class UnavailableR2Client(FakeR2Client):
    def head_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        del Bucket, Key
        raise EndpointConnectionError(endpoint_url="https://r2.example.test")


def test_r2_transport_errors_are_normalized_for_retry_classification() -> None:
    storage = R2ObjectStorage(
        account_id="a" * 32,
        access_key_id="access",
        secret_access_key="secret",
        bucket="private",
        client=UnavailableR2Client(),
    )

    with pytest.raises(StorageUnavailableError):
        storage.metadata("inspections/00000000-0000-0000-0000-000000000000/source")


class FailingR2UploadClient(FakeR2Client):
    def upload_fileobj(self, source: BinaryIO, bucket: str, key: str) -> None:
        del source, bucket, key
        raise S3UploadFailedError("simulated upload failure")


def test_r2_transfer_errors_are_normalized_for_retry_classification() -> None:
    storage = R2ObjectStorage(
        account_id="a" * 32,
        access_key_id="access",
        secret_access_key="secret",
        bucket="private",
        client=FailingR2UploadClient(),
    )

    with pytest.raises(StorageUnavailableError):
        storage.put(
            "inspections/00000000-0000-0000-0000-000000000000/source",
            BytesIO(b"video"),
        )
