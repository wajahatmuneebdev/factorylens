import { z } from "zod";

import type {
  CloudTasksDispatcherOptions,
  CloudTasksQueueConfiguration,
} from "./cloud-task-dispatcher.js";

const taskDispatcherEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  TASK_DISPATCHER: z.enum(["local", "cloud-tasks"]).optional(),
});

const cloudTasksEnvironmentSchema = z
  .object({
    CLOUD_TASKS_DISPATCH_DEADLINE_SECONDS: z.coerce
      .number()
      .int()
      .min(15)
      .max(1_800)
      .default(1_800),
    CLOUD_TASKS_LOCATION: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .min(1),
    CLOUD_TASKS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    CLOUD_TASKS_MAX_BACKOFF_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(300),
    CLOUD_TASKS_MAX_CONCURRENT_DISPATCHES: z.coerce
      .number()
      .int()
      .min(1)
      .max(5_000)
      .default(1),
    CLOUD_TASKS_MAX_DISPATCHES_PER_SECOND: z.coerce
      .number()
      .positive()
      .max(500)
      .default(1),
    CLOUD_TASKS_MAX_DOUBLINGS: z.coerce.number().int().nonnegative().default(3),
    CLOUD_TASKS_MAX_RETRY_DURATION_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0),
    CLOUD_TASKS_MIN_BACKOFF_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10),
    CLOUD_TASKS_OIDC_AUDIENCE: z.string().min(1).optional(),
    CLOUD_TASKS_PROJECT_ID: z.string().min(1),
    CLOUD_TASKS_QUEUE: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
    CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL: z
      .email()
      .endsWith(".gserviceaccount.com"),
    CLOUD_TASKS_TARGET_URL: z.url(),
  })
  .superRefine((environment, context) => {
    if (
      environment.CLOUD_TASKS_MIN_BACKOFF_SECONDS >
      environment.CLOUD_TASKS_MAX_BACKOFF_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "CLOUD_TASKS_MIN_BACKOFF_SECONDS must not exceed CLOUD_TASKS_MAX_BACKOFF_SECONDS",
        path: ["CLOUD_TASKS_MIN_BACKOFF_SECONDS"],
      });
    }
  });

export interface CloudTasksConfiguration {
  dispatcher: CloudTasksDispatcherOptions;
  queue: CloudTasksQueueConfiguration;
}

export function taskDispatcherModeFromEnvironment(
  environment: NodeJS.ProcessEnv,
): "local" | "cloud-tasks" {
  const parsed = taskDispatcherEnvironmentSchema.parse(environment);
  const mode =
    parsed.TASK_DISPATCHER ??
    (parsed.NODE_ENV === "production" ? "cloud-tasks" : "local");
  if (parsed.NODE_ENV === "production" && mode !== "cloud-tasks") {
    throw new Error("Production requires the cloud-tasks dispatcher");
  }
  return mode;
}

export function cloudTasksConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): CloudTasksConfiguration {
  const parsed = cloudTasksEnvironmentSchema.parse(environment);
  const targetUrl = new URL(parsed.CLOUD_TASKS_TARGET_URL);
  if (
    targetUrl.protocol !== "https:" ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.search ||
    targetUrl.hash
  ) {
    throw new Error(
      "CLOUD_TASKS_TARGET_URL must be an HTTPS URL without credentials, query, or fragment",
    );
  }

  const retry = {
    maxAttempts: parsed.CLOUD_TASKS_MAX_ATTEMPTS,
    maxBackoffSeconds: parsed.CLOUD_TASKS_MAX_BACKOFF_SECONDS,
    maxDoublings: parsed.CLOUD_TASKS_MAX_DOUBLINGS,
    maxRetryDurationSeconds: parsed.CLOUD_TASKS_MAX_RETRY_DURATION_SECONDS,
    minBackoffSeconds: parsed.CLOUD_TASKS_MIN_BACKOFF_SECONDS,
  };

  return {
    dispatcher: {
      dispatchDeadlineSeconds: parsed.CLOUD_TASKS_DISPATCH_DEADLINE_SECONDS,
      location: parsed.CLOUD_TASKS_LOCATION,
      oidcAudience: parsed.CLOUD_TASKS_OIDC_AUDIENCE ?? targetUrl.origin,
      projectId: parsed.CLOUD_TASKS_PROJECT_ID,
      queue: parsed.CLOUD_TASKS_QUEUE,
      retry,
      serviceAccountEmail: parsed.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL,
      targetUrl: targetUrl.toString(),
    },
    queue: {
      location: parsed.CLOUD_TASKS_LOCATION,
      maxConcurrentDispatches: parsed.CLOUD_TASKS_MAX_CONCURRENT_DISPATCHES,
      maxDispatchesPerSecond: parsed.CLOUD_TASKS_MAX_DISPATCHES_PER_SECOND,
      projectId: parsed.CLOUD_TASKS_PROJECT_ID,
      queue: parsed.CLOUD_TASKS_QUEUE,
      retry,
    },
  };
}
