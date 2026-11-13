import {
  ErrorResponseSchema,
  GetInspectionResponseSchema,
  INSPECTION_STATUS_PRESENTATION,
  type Inspection,
} from "@factorylens/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";

import { PageState } from "./components/PageState";
import { Badge, Button, Notification, Progress } from "./components/ui";
import { InspectionPlayer } from "./inspection-player";

const POLL_INTERVAL_MS = 5_000;

class InspectionRequestError extends Error {
  constructor(
    readonly status: number,
    message = "Inspection request failed",
  ) {
    super(message);
  }
}

async function inspectionRequest(url: string, method = "GET") {
  const response = await fetch(url, { method });
  if (!response.ok) {
    const body = ErrorResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    throw new InspectionRequestError(
      response.status,
      body.success ? body.data.error.message : undefined,
    );
  }
  return GetInspectionResponseSchema.parse(await response.json());
}

function isActive(inspection: Inspection) {
  return inspection.status === "queued" || inspection.status === "processing";
}

function stageLabel(inspection: Inspection) {
  if (inspection.job?.status === "retry_wait") return "Waiting to retry";
  if (inspection.job?.cancellationRequested) return "Cancellation requested";
  if (inspection.status === "queued") return "Waiting to begin";
  if (inspection.status === "completed") return "Inspection completed";
  if (inspection.status === "failed") return "Inspection failed";
  if (inspection.status === "cancelled") return "Inspection cancelled";
  return (
    {
      validating_media: "Validating media",
      running_workflow: "Analyzing recording",
      writing_artifact: "Saving results",
    }[inspection.progress.stage ?? ""] ?? "Processing inspection"
  );
}

function attemptLabel(inspection: Inspection) {
  if (!inspection.job) return "No processing attempt yet";
  if (inspection.job.attempt === 0) {
    return `Attempt 1 of ${inspection.job.maxAttempts} has not started`;
  }
  return `Attempt ${inspection.job.attempt} of ${inspection.job.maxAttempts}`;
}

export function InspectionStatus({ inspectionId }: { inspectionId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["inspection", inspectionId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => inspectionRequest(`/api/inspections/${inspectionId}`),
    refetchInterval: (currentQuery) => {
      const inspection = currentQuery.state.data?.inspection;
      return inspection &&
        isActive(inspection) &&
        document.visibilityState === "visible"
        ? POLL_INTERVAL_MS
        : false;
    },
    refetchIntervalInBackground: false,
    retry: (failureCount, error) =>
      !(error instanceof InspectionRequestError && error.status === 401) &&
      failureCount < 2,
  });

  const command = useMutation({
    mutationFn: (action: "cancel" | "retry") =>
      inspectionRequest(`/api/inspections/${inspectionId}/${action}`, "POST"),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });

  if (
    query.error instanceof InspectionRequestError &&
    query.error.status === 401
  ) {
    return <Navigate replace to="/sign-in" />;
  }
  if (query.isPending) {
    return <PageState kind="loading" title="Loading inspection status" />;
  }
  if (query.isError) {
    return (
      <PageState
        actionLabel="Try again"
        kind="error"
        onAction={() => void query.refetch()}
        title="Inspection status is unavailable"
      >
        FactoryLens could not load the durable processing state.
      </PageState>
    );
  }

  const inspection = query.data.inspection;
  const presentation = INSPECTION_STATUS_PRESENTATION[inspection.status];
  const canCancel =
    isActive(inspection) && !inspection.job?.cancellationRequested;
  const canRetry =
    inspection.status === "failed" &&
    inspection.error?.category === "retryable";

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Inspection status</p>
          <h1>{inspection.title}</h1>
        </div>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </header>
      <div className="detail-grid">
        {inspection.status === "completed" ? (
          <InspectionPlayer inspectionId={inspection.id} />
        ) : (
          <section aria-labelledby="media-title" className="media-placeholder">
            <div className="media-placeholder__frame">
              <span aria-hidden="true" className="media-placeholder__play">
                ▶
              </span>
              <span>Video available when processing completes</span>
            </div>
            <div className="media-placeholder__caption">
              <div>
                <p className="eyebrow">Inspection identifier</p>
                <strong id="media-title">{inspection.id}</strong>
              </div>
            </div>
          </section>
        )}
        <aside aria-labelledby="status-title" className="panel status-card">
          <div>
            <p className="eyebrow">Current stage</p>
            <h2 id="status-title">{stageLabel(inspection)}</h2>
          </div>
          <Progress
            label="Inspection progress"
            value={inspection.progress.percent}
          />
          <dl className="status-details">
            <div>
              <dt>Stage</dt>
              <dd>{inspection.progress.stage ?? "Not started"}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{attemptLabel(inspection)}</dd>
            </div>
          </dl>
          {inspection.error ? (
            <Notification tone="error">
              <strong>Processing could not continue.</strong>
              <span>{inspection.error.message}</span>
            </Notification>
          ) : null}
          {command.isError ? (
            <Notification tone="error">
              <strong>The command was not applied.</strong>
              <span>{command.error.message}</span>
            </Notification>
          ) : null}
          {canCancel ? (
            <Button
              disabled={command.isPending}
              onClick={() => command.mutate("cancel")}
              variant="danger"
            >
              {command.isPending && command.variables === "cancel"
                ? "Cancelling…"
                : "Cancel inspection"}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              disabled={command.isPending}
              onClick={() => command.mutate("retry")}
            >
              {command.isPending && command.variables === "retry"
                ? "Retrying…"
                : "Retry inspection"}
            </Button>
          ) : null}
        </aside>
      </div>
    </>
  );
}
