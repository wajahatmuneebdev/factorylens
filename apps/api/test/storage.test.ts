import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidStorageObjectKeyError,
  LocalFilesystemStorage,
  StorageObjectNotFoundError,
  processingObjectKeys,
  sourceObjectKey,
} from "../src/storage.js";

interface StorageFixture {
  version: number;
  inspectionId: string;
  generation: number;
  keys: Record<"source" | "normalized" | "thumbnail" | "prediction", string>;
  objects: Record<"source" | "normalized" | "thumbnail" | "prediction", string>;
  replacement: string;
  missingKey: string;
  invalidKeys: string[];
}

const fixtureUrl = new URL(
  "../../../fixtures/storage/contract-v1.json",
  import.meta.url,
);
const fixture = JSON.parse(
  await readFile(fixtureUrl, "utf8"),
) as StorageFixture;
const temporaryDirectories: string[] = [];

async function createStorage(): Promise<{
  rootDirectory: string;
  storage: LocalFilesystemStorage;
}> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "factorylens-storage-"));
  temporaryDirectories.push(rootDirectory);
  return {
    rootDirectory,
    storage: new LocalFilesystemStorage(rootDirectory),
  };
}

async function readText(
  storage: LocalFilesystemStorage,
  key: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  const source = await storage.read(key);
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local filesystem storage contract", () => {
  it("generates the shared keys only from application identifiers", () => {
    expect({
      source: sourceObjectKey(fixture.inspectionId),
      ...processingObjectKeys(fixture.inspectionId, fixture.generation),
    }).toEqual(fixture.keys);
    expect(() => sourceObjectKey("not-an-id")).toThrow(TypeError);
    expect(() => processingObjectKeys(fixture.inspectionId, 0)).toThrow(
      TypeError,
    );
  });

  it("puts, reads, describes, replaces, and cleans up every object kind", async () => {
    const { rootDirectory, storage } = await createStorage();

    for (const kind of Object.keys(
      fixture.keys,
    ) as (keyof typeof fixture.keys)[]) {
      const key = fixture.keys[kind];
      const content = fixture.objects[kind];

      const metadata = await storage.put(key, Readable.from([content]));

      expect(metadata).toEqual({
        key,
        sizeBytes: Buffer.byteLength(content),
      });
      await expect(storage.exists(key)).resolves.toBe(true);
      await expect(storage.metadata(key)).resolves.toEqual(metadata);
      await expect(readText(storage, key)).resolves.toBe(content);
    }

    const replaced = await storage.put(
      fixture.keys.source,
      Readable.from([fixture.replacement]),
    );
    expect(replaced.sizeBytes).toBe(Buffer.byteLength(fixture.replacement));
    await expect(readText(storage, fixture.keys.source)).resolves.toBe(
      fixture.replacement,
    );

    for (const key of Object.values(fixture.keys)) {
      await storage.delete(key);
      await storage.delete(key);
      await expect(storage.exists(key)).resolves.toBe(false);
    }
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("reports missing objects consistently", async () => {
    const { storage } = await createStorage();

    await expect(storage.read(fixture.missingKey)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    await expect(storage.metadata(fixture.missingKey)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    await expect(storage.exists(fixture.missingKey)).resolves.toBe(false);
    await expect(storage.delete(fixture.missingKey)).resolves.toBeUndefined();
  });

  it("rejects traversal keys before writing outside the root", async () => {
    const { storage } = await createStorage();

    for (const key of fixture.invalidKeys) {
      await expect(
        storage.put(key, Readable.from(["unsafe"])),
      ).rejects.toBeInstanceOf(InvalidStorageObjectKeyError);
    }
  });

  it("keeps the previous object when a replacement stream fails", async () => {
    const { rootDirectory, storage } = await createStorage();
    const key = fixture.keys.source;
    await storage.put(key, Readable.from([fixture.objects.source]));
    const failedReplacement = Readable.from(
      (async function* () {
        yield "partial";
        throw new Error("fixture stream failed");
      })(),
    );

    await expect(storage.put(key, failedReplacement)).rejects.toThrow(
      "fixture stream failed",
    );

    await expect(readText(storage, key)).resolves.toBe(fixture.objects.source);
    const storedDirectory = join(rootDirectory, ...key.split("/").slice(0, -1));
    await expect(readdir(storedDirectory)).resolves.toEqual(["source"]);
  });
});
