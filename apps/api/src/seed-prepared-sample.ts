import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { writeStructuredLog } from "./security.js";
import { R2ObjectStorage } from "./storage.js";

const execFileAsync = promisify(execFile);
const SAMPLE_OBJECT_KEY = "samples/assembly-line-no-hard-hat.webm";
const SOURCE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/a/a4/Assembly_line.webm";
const SOURCE_SHA1 = "b73f54759ad8832f4547dd13b656c10ae3e5723a";
let currentStage = "environment";

const environmentSchema = z.object({
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/i),
  R2_BUCKET: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

const probeSchema = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.object({
      codec_name: z.string().optional(),
      codec_type: z.string(),
      height: z.number().int().optional(),
      nb_read_frames: z.string().optional(),
      r_frame_rate: z.string().optional(),
      width: z.number().int().optional(),
    }),
  ),
});

async function run(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const directory = await mkdtemp(join(tmpdir(), "factorylens-sample-"));
  try {
    const sourcePath = join(directory, "source.webm");
    const samplePath = join(directory, "prepared.webm");
    currentStage = "download";
    await execFileAsync(
      "curl",
      [
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--retry",
        "2",
        "--retry-all-errors",
        "--max-time",
        "120",
        "--output",
        sourcePath,
        SOURCE_URL,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const source = await readFile(sourcePath);
    const sourceHash = createHash("sha1").update(source).digest("hex");
    if (sourceHash !== SOURCE_SHA1) {
      throw new Error(
        "Sample source checksum did not match the reviewed media",
      );
    }
    currentStage = "transcode";
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourcePath,
        "-t",
        "2",
        "-an",
        "-vf",
        "fps=5,scale=1840:1080:force_original_aspect_ratio=decrease,pad=1840:1080:(ow-iw)/2:(oh-ih)/2",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuv420p",
        "-metadata",
        "title=FactoryLens prepared sample derived from Assembly line.webm",
        "-metadata",
        "artist=Automotive garage",
        "-metadata",
        "comment=Source: Wikimedia Commons; license: CC BY 4.0",
        "-y",
        samplePath,
      ],
      { maxBuffer: 1024 * 1024 },
    );

    currentStage = "validate";
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        samplePath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const probe = probeSchema.parse(JSON.parse(stdout));
    const videos = probe.streams.filter(
      (stream) => stream.codec_type === "video",
    );
    const audio = probe.streams.filter(
      (stream) => stream.codec_type === "audio",
    );
    const duration = Number(probe.format.duration);
    const video = videos[0];
    if (
      videos.length !== 1 ||
      audio.length !== 0 ||
      video?.codec_name !== "vp9" ||
      video.width !== 1840 ||
      video.height !== 1080 ||
      video.r_frame_rate !== "5/1" ||
      video.nb_read_frames !== "10" ||
      !Number.isFinite(duration) ||
      duration < 1.9 ||
      duration > 2.1
    ) {
      throw new Error("Generated sample did not match the inspection contract");
    }

    currentStage = "upload";
    const storage = new R2ObjectStorage({
      accessKeyId: environment.R2_ACCESS_KEY_ID,
      bucket: environment.R2_BUCKET,
      endpoint: `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
    });
    const uploaded = await storage.put(
      SAMPLE_OBJECT_KEY,
      createReadStream(samplePath),
    );
    if (uploaded.sizeBytes < 1) {
      throw new Error("Prepared sample upload was empty");
    }
    writeStructuredLog("info", "prepared_sample_seeded", {
      sizeBytes: uploaded.sizeBytes,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

void run().catch((error: unknown) => {
  writeStructuredLog("error", "prepared_sample_seed_failed", {
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
    stage: currentStage,
  });
  process.exitCode = 1;
});
