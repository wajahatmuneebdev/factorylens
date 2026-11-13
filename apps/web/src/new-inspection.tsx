import {
  CreateInspectionRequestSchema,
  CreateInspectionResponseSchema,
  UploadCompleteResponseSchema,
  type CreateInspectionRequest,
  type UploadAuthorization,
} from "@factorylens/contracts";
import { type FormEvent, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Badge, Button, Field, Notification, Progress } from "./components/ui";

type UploadStage =
  "editing" | "creating" | "uploading" | "verifying" | "expired" | "failed";
type SafeErrorResponse = { error?: { message?: string } };

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function uploadFile(
  file: File,
  authorization: { headers: Record<string, string>; url: string },
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
  const attemptRef = useRef<{
    inspectionId: string;
    upload: UploadAuthorization;
    uploaded: boolean;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<UploadStage>("editing");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy =
    stage === "creating" || stage === "uploading" || stage === "verifying";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const request: CreateInspectionRequest = {
      title,
      workflowKey: "factory-safety-v1",
      source: file
        ? {
            sourceType: "upload",
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }
        : ({ sourceType: "upload" } as never),
    };
    const validation = CreateInspectionRequestSchema.safeParse(request);
    if (!validation.success) {
      setError(
        !file
          ? "Choose a supported video file."
          : "Enter a name and choose a video up to 250 MB.",
      );
      setStage("editing");
      return;
    }

    const abortController = new AbortController();
    abortRef.current = abortController;
    setError(null);
    setProgress(0);
    setStage("creating");
    try {
      if (!attemptRef.current) {
        const createResponse = await fetch("/api/inspections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validation.data),
          signal: abortController.signal,
        });
        const createBody = await responseJson(createResponse);
        if (!createResponse.ok)
          throw new Error(
            (createBody as SafeErrorResponse | null)?.error?.message ??
              "Inspection creation is temporarily unavailable.",
          );
        const created = CreateInspectionResponseSchema.parse(createBody);
        if (!created.upload)
          throw new Error("Upload authorization was not provided.");
        attemptRef.current = {
          inspectionId: created.inspection.id,
          upload: created.upload,
          uploaded: false,
        };
      }
      const attempt = attemptRef.current;
      if (new Date(attempt.upload.expiresAt).getTime() <= Date.now())
        throw new Error("expired");
      if (!attempt.uploaded) {
        setStage("uploading");
        await uploadFile(
          file!,
          attempt.upload,
          setProgress,
          abortController.signal,
        );
        attempt.uploaded = true;
      }
      setProgress(100);
      setStage("verifying");
      const completeResponse = await fetch(
        `/api/inspections/${attempt.inspectionId}/upload-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: abortController.signal,
        },
      );
      const completeBody = await responseJson(completeResponse);
      if (!completeResponse.ok)
        throw new Error(
          (completeBody as SafeErrorResponse | null)?.error?.message ??
            "Video verification is temporarily unavailable.",
        );
      UploadCompleteResponseSchema.parse(completeBody);
      navigate(`/inspections/${attempt.inspectionId}`, {
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
              : "Upload not completed"}
          </strong>
          <span>{error}</span>
        </Notification>
      ) : null}
      <form className="panel form-stack" noValidate onSubmit={handleSubmit}>
        <div className="section-heading section-heading--bordered">
          <div>
            <p className="eyebrow">Details</p>
            <h2>Upload a recording</h2>
          </div>
          <Badge>Video upload</Badge>
        </div>
        <Field
          hint="Use a name that will be easy to find in history."
          label="Inspection name"
        >
          <input
            disabled={busy}
            maxLength={160}
            name="title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Packaging line check"
            value={title}
          />
        </Field>
        <div className="form-grid">
          <Field label="Workflow">
            <select
              defaultValue="factory-safety-v1"
              disabled={busy}
              name="workflow"
            >
              <option value="factory-safety-v1">Factory safety review</option>
            </select>
          </Field>
          <Field hint="Video files up to 250 MB." label="Video file">
            <input
              accept="video/*"
              disabled={busy}
              name="video"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </Field>
        </div>
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
          <Button disabled={busy} type="submit">
            Create and upload
          </Button>
        </div>
      </form>
    </>
  );
}
