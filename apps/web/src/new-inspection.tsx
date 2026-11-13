import {
  CreateInspectionRequestSchema,
  CreateInspectionResponseSchema,
  UploadCompleteResponseSchema,
  type CreateInspectionRequest,
} from "@factorylens/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Badge, Button, Field, Notification, Progress } from "./components/ui";

type SourceMode = "upload" | "recording" | "sample";
type Stage =
  "editing" | "creating" | "uploading" | "verifying" | "expired" | "failed";
type SafeError = { error?: { message?: string } };
const MAX_BYTES = 250 * 1024 * 1024;
const MAX_SECONDS = 300;
const RECORDING_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function upload(
  file: File,
  authorization: { headers: Record<string, string>; url: string },
  onProgress: (value: number) => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", authorization.url);
    Object.entries(authorization.headers).forEach(([name, value]) =>
      request.setRequestHeader(name, value),
    );
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else
        reject(
          new Error(
            request.status === 401 || request.status === 403
              ? "expired"
              : "The video upload was interrupted. Try again.",
          ),
        );
    });
    request.addEventListener("error", () =>
      reject(new Error("The video upload was interrupted. Try again.")),
    );
    request.addEventListener("abort", () =>
      reject(new DOMException("Upload cancelled", "AbortError")),
    );
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

export function NewInspectionForm() {
  const navigate = useNavigate();
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef<{
    id: string;
    upload: NonNullable<
      ReturnType<typeof CreateInspectionResponseSchema.parse>["upload"]
    >;
    uploaded: boolean;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SourceMode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [stage, setStage] = useState<Stage>("editing");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const supportedType = recordingType();
  const busy = ["creating", "uploading", "verifying"].includes(stage);

  function releaseCapture() {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(
    () => () => {
      releaseCapture();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function discardRecording() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setRecordedFile(null);
    setPreviewUrl(null);
    setSeconds(0);
    setError(null);
  }

  async function startRecording() {
    if (!supportedType)
      return setError(
        "This browser does not support a compatible recording format.",
      );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      streamRef.current = stream;
      chunksRef.current = [];
      discardRecording();
      const recorder = new MediaRecorder(stream, { mimeType: supportedType });
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        releaseCapture();
        setIsRecording(false);
        const mimeType = recorder.mimeType || supportedType;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (!blob.size)
          return setError(
            "No video was captured. Discard this recording and try again.",
          );
        if (blob.size > MAX_BYTES)
          return setError("The recording exceeds the 250 MB upload limit.");
        const captured = new File(
          [blob],
          `factorylens-recording.${mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`,
          { type: mimeType },
        );
        setRecordedFile(captured);
        setPreviewUrl(URL.createObjectURL(captured));
      });
      recorder.start(1000);
      setError(null);
      setSeconds(0);
      setIsRecording(true);
      timerRef.current = window.setInterval(
        () =>
          setSeconds((value) => {
            const next = value + 1;
            if (next >= MAX_SECONDS && recorder.state === "recording")
              recorder.stop();
            return next;
          }),
        1000,
      );
    } catch (caught) {
      releaseCapture();
      setIsRecording(false);
      setError(
        caught instanceof DOMException &&
          ["NotAllowedError", "SecurityError"].includes(caught.name)
          ? "Camera or microphone permission was denied. Allow access and try again."
          : "The camera could not be started. Check that it is available and try again.",
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || isRecording) return;
    const selected = mode === "recording" ? recordedFile : file;
    const request: CreateInspectionRequest = {
      title,
      workflowKey: "factory-safety-v1",
      source:
        mode === "sample"
          ? { sourceType: "sample", sampleKey: "assembly-line-no-hard-hat" }
          : selected
            ? {
                sourceType: mode,
                fileName: selected.name,
                contentType: selected.type,
                sizeBytes: selected.size,
              }
            : ({ sourceType: mode } as never),
    };
    const validation = CreateInspectionRequestSchema.safeParse(request);
    if (!validation.success) {
      setError(
        mode === "recording" && !recordedFile
          ? "Record and review a video before uploading it."
          : mode === "upload" && !file
            ? "Choose a supported video file."
            : "Enter a name and choose a video up to 250 MB.",
      );
      return setStage("editing");
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress(0);
    setStage("creating");
    try {
      if (!attemptRef.current) {
        const response = await fetch("/api/inspections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validation.data),
          signal: controller.signal,
        });
        const body = await json(response);
        if (!response.ok)
          throw new Error(
            (body as SafeError | null)?.error?.message ??
              "Inspection creation is temporarily unavailable.",
          );
        const created = CreateInspectionResponseSchema.parse(body);
        if (mode === "sample") {
          navigate(`/inspections/${created.inspection.id}`, {
            replace: true,
            state: { queuedInspection: { title: validation.data.title } },
          });
          return;
        }
        if (!created.upload)
          throw new Error("Upload authorization was not provided.");
        attemptRef.current = {
          id: created.inspection.id,
          upload: created.upload,
          uploaded: false,
        };
      }
      const attempt = attemptRef.current!;
      if (new Date(attempt.upload.expiresAt).getTime() <= Date.now())
        throw new Error("expired");
      if (!attempt.uploaded) {
        setStage("uploading");
        await upload(selected!, attempt.upload, setProgress, controller.signal);
        attempt.uploaded = true;
      }
      setProgress(100);
      setStage("verifying");
      const response = await fetch(
        `/api/inspections/${attempt.id}/upload-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        },
      );
      const body = await json(response);
      if (!response.ok)
        throw new Error(
          (body as SafeError | null)?.error?.message ??
            "Video verification is temporarily unavailable.",
        );
      UploadCompleteResponseSchema.parse(body);
      navigate(`/inspections/${attempt.id}`, {
        replace: true,
        state: { queuedInspection: { title: validation.data.title } },
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStage("editing");
        setProgress(0);
        setError(
          "Upload cancelled. Your file has not been submitted for processing.",
        );
      } else if (caught instanceof Error && caught.message === "expired") {
        attemptRef.current = null;
        setStage("expired");
        setError(
          "Upload authorization expired. Start again to request a new secure upload.",
        );
      } else {
        setStage("failed");
        setError(
          caught instanceof Error
            ? caught.message
            : "The upload could not be completed.",
        );
      }
    } finally {
      abortRef.current = null;
    }
  }

  const stageLabel =
    stage === "creating"
      ? "Creating inspection…"
      : stage === "uploading"
        ? `Uploading video… ${progress}%`
        : "Verifying upload…";
  return (
    <>
      {error ? (
        <Notification tone={stage === "expired" ? "warning" : "error"}>
          <strong>
            {stage === "expired"
              ? "Authorization expired"
              : "Action not completed"}
          </strong>
          <span>{error}</span>
        </Notification>
      ) : null}
      <form className="panel form-stack" noValidate onSubmit={submit}>
        <div className="section-heading section-heading--bordered">
          <div>
            <p className="eyebrow">Details</p>
            <h2>Choose a video source</h2>
          </div>
          <Badge>Recorded video</Badge>
        </div>
        <Field
          hint="Use a name that will be easy to find in history."
          label="Inspection name"
        >
          <input
            disabled={busy}
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Packaging line check"
            value={title}
          />
        </Field>
        <Field label="Workflow">
          <select defaultValue="factory-safety-v1" disabled={busy}>
            <option value="factory-safety-v1">Factory safety review</option>
          </select>
        </Field>
        <fieldset className="source-picker" disabled={busy || isRecording}>
          <legend>Video source</legend>
          {(["upload", "recording", "sample"] as const).map((source) => (
            <label className="source-picker__option" key={source}>
              <input
                checked={mode === source}
                name="source"
                onChange={() => {
                  attemptRef.current = null;
                  setMode(source);
                  setError(null);
                }}
                type="radio"
                value={source}
              />
              <span>
                <strong>
                  {source === "upload"
                    ? "Upload a file"
                    : source === "recording"
                      ? "Record now"
                      : "Prepared sample"}
                </strong>
                <small>
                  {source === "upload"
                    ? "Choose an existing video"
                    : source === "recording"
                      ? "Use this camera and microphone"
                      : "Try the curated 2-second example"}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "upload" ? (
          <Field
            hint="Video files up to 250 MB and 5 minutes."
            label="Video file"
          >
            <input
              accept="video/*"
              disabled={busy}
              onChange={(event) => {
                attemptRef.current = null;
                setFile(event.target.files?.[0] ?? null);
              }}
              type="file"
            />
          </Field>
        ) : null}
        {mode === "recording" ? (
          <section
            aria-labelledby="recording-title"
            className="recording-panel"
          >
            <div>
              <strong id="recording-title">Browser recording</strong>
              <p>
                Up to 5 minutes and 250 MB. Captured media remains subject to
                worker validation.
              </p>
            </div>
            {!supportedType ? (
              <p role="status">
                Recording is unavailable in this browser. Upload a file or use
                the prepared sample.
              </p>
            ) : isRecording ? (
              <div className="recording-panel__controls" aria-live="polite">
                <span>Recording · {duration(seconds)} / 5:00</span>
                <Button
                  onClick={() => recorderRef.current?.stop()}
                  variant="secondary"
                >
                  Stop recording
                </Button>
              </div>
            ) : recordedFile && previewUrl ? (
              <>
                <video
                  aria-label="Recorded video preview"
                  controls
                  src={previewUrl}
                />
                <div className="recording-panel__controls">
                  <span>Ready to upload · {duration(seconds)}</span>
                  <Button onClick={discardRecording} variant="secondary">
                    Discard recording
                  </Button>
                </div>
              </>
            ) : (
              <Button onClick={startRecording} variant="secondary">
                Start recording
              </Button>
            )}
          </section>
        ) : null}
        {mode === "sample" ? (
          <article className="sample-card">
            <div>
              <Badge tone="info">Prepared example</Badge>
              <h3>Assembly line — missing hard hat</h3>
              <p>
                A 2-second, 1840 × 1080 WebM excerpt with no audio. It is a
                positive synthetic contract signal, not a model-accuracy
                benchmark.
              </p>
            </div>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>Automotive garage</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>
                  <a
                    href="https://creativecommons.org/licenses/by/4.0/"
                    rel="noreferrer"
                    target="_blank"
                  >
                    CC BY 4.0
                  </a>
                </dd>
              </div>
              <div>
                <dt>Changes</dt>
                <dd>Trimmed, muted, sampled, and scaled</dd>
              </div>
            </dl>
          </article>
        ) : null}
        {busy ? (
          <div className="upload-status" aria-live="polite">
            <Progress
              label={stageLabel}
              value={
                stage === "uploading"
                  ? progress
                  : stage === "verifying"
                    ? 100
                    : 0
              }
            />
            <Button
              onClick={() => abortRef.current?.abort()}
              variant="secondary"
            >
              Cancel upload
            </Button>
          </div>
        ) : null}
        <div className="form-actions">
          <Link className="button button--quiet" to="/dashboard">
            Cancel
          </Link>
          {stage === "expired" || stage === "failed" ? (
            <Button
              onClick={() => {
                setStage("editing");
                setError(null);
                setProgress(0);
              }}
              variant="secondary"
            >
              Try again
            </Button>
          ) : null}
          <Button
            disabled={
              busy || isRecording || (mode === "recording" && !recordedFile)
            }
            type="submit"
          >
            {mode === "sample" ? "Inspect sample" : "Create and upload"}
          </Button>
        </div>
      </form>
    </>
  );
}
