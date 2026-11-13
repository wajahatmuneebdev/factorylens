import { z } from "zod";

export const InspectionStateSchema = z.enum([
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export type InspectionState = z.infer<typeof InspectionStateSchema>;

export const INSPECTION_STATUS_PRESENTATION = {
  awaiting_upload: { label: "Awaiting upload", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  completed: { label: "Completed", tone: "positive" },
  failed: { label: "Failed", tone: "critical" },
  cancelled: { label: "Cancelled", tone: "warning" },
} as const satisfies Record<
  InspectionState,
  {
    label: string;
    tone: "neutral" | "positive" | "warning" | "critical" | "info";
  }
>;

export const INSPECTION_TRANSITIONS = {
  awaiting_upload: ["queued"],
  queued: ["processing", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
} as const satisfies Record<InspectionState, readonly InspectionState[]>;

export const JobStateSchema = z.enum([
  "pending_dispatch",
  "queued",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
]);

export type JobState = z.infer<typeof JobStateSchema>;

export const JOB_TRANSITIONS = {
  pending_dispatch: ["queued"],
  queued: ["running", "cancelled"],
  running: ["completed", "retry_wait", "failed", "cancelled"],
  retry_wait: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<JobState, readonly JobState[]>;

export function canTransitionInspection(
  from: InspectionState,
  to: InspectionState,
): boolean {
  return (INSPECTION_TRANSITIONS[from] as readonly InspectionState[]).includes(
    to,
  );
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] as readonly JobState[]).includes(to);
}
