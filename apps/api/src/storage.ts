import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StorageObjectMetadata {
  key: string;
  sizeBytes: number;
}

export interface ObjectStorage {
  put(key: string, source: Readable): Promise<StorageObjectMetadata>;
  read(key: string): Promise<Readable>;
  metadata(key: string): Promise<StorageObjectMetadata>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface ProcessingObjectKeys {
  normalized: string;
  thumbnail: string;
  prediction: string;
}

export class InvalidStorageObjectKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage object key: ${JSON.stringify(key)}`);
    this.name = "InvalidStorageObjectKeyError";
  }
}

export class StorageObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
    this.key = key;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function inspectionPrefix(inspectionId: string): string {
  if (!UUID_PATTERN.test(inspectionId)) {
    throw new TypeError("inspectionId must be a UUID");
  }
  return `inspections/${inspectionId.toLowerCase()}`;
}

export function sourceObjectKey(inspectionId: string): string {
  return `${inspectionPrefix(inspectionId)}/source`;
}

export function processingObjectKeys(
  inspectionId: string,
  generation: number,
): ProcessingObjectKeys {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("generation must be a positive safe integer");
  }

  const generationPrefix = `${inspectionPrefix(inspectionId)}/generations/${generation}`;
  return {
    normalized: `${generationPrefix}/normalized`,
    thumbnail: `${generationPrefix}/thumbnail`,
    prediction: `${generationPrefix}/prediction`,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function validateObjectKey(key: string): void {
  const segments = key.split("/");
  if (
    key.length === 0 ||
    key.includes("\\") ||
    isAbsolute(key) ||
    segments.some((segment) => !KEY_SEGMENT_PATTERN.test(segment))
  ) {
    throw new InvalidStorageObjectKeyError(key);
  }
}

export class LocalFilesystemStorage implements ObjectStorage {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async put(key: string, source: Readable): Promise<StorageObjectMetadata> {
    const objectPath = this.objectPath(key);
    const parentDirectory = dirname(objectPath);
    await mkdir(parentDirectory, { recursive: true });

    const temporaryPath = `${objectPath}.${randomUUID()}.tmp`;
    try {
      await pipeline(
        source,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporaryPath, objectPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return this.metadata(key);
  }

  async read(key: string): Promise<Readable> {
    const objectPath = this.objectPath(key);
    try {
      const file = await open(objectPath, "r");
      return file.createReadStream();
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async metadata(key: string): Promise<StorageObjectMetadata> {
    const objectPath = this.objectPath(key);
    try {
      const objectStat = await stat(objectPath);
      if (!objectStat.isFile()) {
        throw new StorageObjectNotFoundError(key);
      }
      return { key, sizeBytes: objectStat.size };
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.metadata(key);
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const objectPath = this.objectPath(key);
    try {
      await unlink(objectPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    await this.removeEmptyParents(dirname(objectPath));
  }

  private objectPath(key: string): string {
    validateObjectKey(key);
    const objectPath = resolve(this.rootDirectory, ...key.split("/"));
    const relativePath = relative(this.rootDirectory, objectPath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      throw new InvalidStorageObjectKeyError(key);
    }
    return objectPath;
  }

  private async removeEmptyParents(directory: string): Promise<void> {
    let currentDirectory = directory;
    while (currentDirectory !== this.rootDirectory) {
      try {
        await rmdir(currentDirectory);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTEMPTY")
        ) {
          return;
        }
        throw error;
      }
      currentDirectory = dirname(currentDirectory);
    }
  }
}
