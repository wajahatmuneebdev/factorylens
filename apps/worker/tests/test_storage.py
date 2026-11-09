import json
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from factorylens_worker.storage import (
    InvalidStorageObjectKeyError,
    LocalFilesystemStorage,
    StorageObjectNotFoundError,
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
