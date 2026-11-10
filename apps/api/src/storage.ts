import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  type CORSConfiguration,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export interface UploadAuthorization {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadAuthorization {
  url: string;
  expiresAt: Date;
}

export interface ObjectAccessAuthorizer {
  authorizeUpload(
    key: string,
    contentType: string,
  ): Promise<UploadAuthorization>;
  authorizeDownload(key: string): Promise<DownloadAuthorization>;
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

const DEFAULT_AUTHORIZATION_TTL_SECONDS = 10 * 60;

export interface R2ObjectStorageOptions {
  accessKeyId: string;
  authorizationTtlSeconds?: number;
  bucket: string;
  endpoint: string;
  forcePathStyle?: boolean;
  now?: () => Date;
  secretAccessKey: string;
}

function isMissingObjectError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

export function factoryLensR2CorsConfiguration(
  appOrigin: URL,
): CORSConfiguration {
  return {
    CORSRules: [
      {
        AllowedHeaders: ["content-type", "range"],
        AllowedMethods: ["GET", "PUT"],
        AllowedOrigins: [appOrigin.origin],
        ExposeHeaders: [
          "accept-ranges",
          "content-length",
          "content-range",
          "etag",
        ],
        MaxAgeSeconds: 3600,
      },
    ],
  };
}

export class R2ObjectStorage implements ObjectStorage, ObjectAccessAuthorizer {
  private readonly authorizationTtlSeconds: number;
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly now: () => Date;

  constructor(options: R2ObjectStorageOptions) {
    const authorizationTtlSeconds =
      options.authorizationTtlSeconds ?? DEFAULT_AUTHORIZATION_TTL_SECONDS;
    if (
      !Number.isSafeInteger(authorizationTtlSeconds) ||
      authorizationTtlSeconds < 1 ||
      authorizationTtlSeconds > 3600
    ) {
      throw new TypeError(
        "authorizationTtlSeconds must be an integer from 1 through 3600",
      );
    }

    this.authorizationTtlSeconds = authorizationTtlSeconds;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
    this.client = new S3Client({
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      region: "auto",
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async put(key: string, source: Readable): Promise<StorageObjectMetadata> {
    validateObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Body: source,
        Bucket: this.bucket,
        Key: key,
      }),
    );
    return this.metadata(key);
  }

  async read(key: string): Promise<Readable> {
    validateObjectKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(response.Body instanceof Readable)) {
        throw new Error("R2 returned an unsupported object body");
      }
      return response.Body;
    } catch (error) {
      if (isMissingObjectError(error)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async metadata(key: string): Promise<StorageObjectMetadata> {
    validateObjectKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (response.ContentLength === undefined) {
        throw new Error("R2 object metadata did not include a content length");
      }
      return { key, sizeBytes: response.ContentLength };
    } catch (error) {
      if (isMissingObjectError(error)) {
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
    validateObjectKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async authorizeUpload(
    key: string,
    contentType: string,
  ): Promise<UploadAuthorization> {
    validateObjectKey(key);
    const signingDate = this.now();
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        ContentType: contentType,
        Key: key,
      }),
      {
        expiresIn: this.authorizationTtlSeconds,
        signableHeaders: new Set(["content-type"]),
        signingDate,
      },
    );
    return {
      method: "PUT",
      url,
      headers: { "Content-Type": contentType },
      expiresAt: new Date(
        signingDate.getTime() + this.authorizationTtlSeconds * 1000,
      ),
    };
  }

  async authorizeDownload(key: string): Promise<DownloadAuthorization> {
    validateObjectKey(key);
    const signingDate = this.now();
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: this.authorizationTtlSeconds,
        signingDate,
      },
    );
    return {
      url,
      expiresAt: new Date(
        signingDate.getTime() + this.authorizationTtlSeconds * 1000,
      ),
    };
  }

  async configureCors(appOrigin: URL): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: factoryLensR2CorsConfiguration(appOrigin),
      }),
    );
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
