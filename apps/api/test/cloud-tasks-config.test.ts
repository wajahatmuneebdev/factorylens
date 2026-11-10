import { expect, it } from "vitest";

import {
  cloudTasksConfigurationFromEnvironment,
  taskDispatcherModeFromEnvironment,
} from "../src/cloud-tasks-config.js";

const requiredEnvironment = {
  CLOUD_TASKS_LOCATION: "us-central1",
  CLOUD_TASKS_PROJECT_ID: "factorylens-test",
  CLOUD_TASKS_QUEUE: "processing",
  CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL:
    "factorylens-tasks@factorylens-test.iam.gserviceaccount.com",
  CLOUD_TASKS_TARGET_URL: "https://worker.example/internal/tasks/process",
};

it("loads Cloud Tasks target, queue, deadline, rate, concurrency, and retry configuration", () => {
  expect(cloudTasksConfigurationFromEnvironment(requiredEnvironment)).toEqual({
    dispatcher: {
      dispatchDeadlineSeconds: 1_800,
      location: "us-central1",
      oidcAudience: "https://worker.example",
      projectId: "factorylens-test",
      queue: "processing",
      retry: {
        maxAttempts: 3,
        maxBackoffSeconds: 300,
        maxDoublings: 3,
        maxRetryDurationSeconds: 0,
        minBackoffSeconds: 10,
      },
      serviceAccountEmail:
        "factorylens-tasks@factorylens-test.iam.gserviceaccount.com",
      targetUrl: "https://worker.example/internal/tasks/process",
    },
    queue: {
      location: "us-central1",
      maxConcurrentDispatches: 1,
      maxDispatchesPerSecond: 1,
      projectId: "factorylens-test",
      queue: "processing",
      retry: {
        maxAttempts: 3,
        maxBackoffSeconds: 300,
        maxDoublings: 3,
        maxRetryDurationSeconds: 0,
        minBackoffSeconds: 10,
      },
    },
  });
});

it("rejects unsafe target URLs and inverted retry backoff", () => {
  expect(() =>
    cloudTasksConfigurationFromEnvironment({
      ...requiredEnvironment,
      CLOUD_TASKS_TARGET_URL: "http://worker.example/tasks/process",
    }),
  ).toThrow(/HTTPS URL/);
  expect(() =>
    cloudTasksConfigurationFromEnvironment({
      ...requiredEnvironment,
      CLOUD_TASKS_MAX_BACKOFF_SECONDS: "5",
      CLOUD_TASKS_MIN_BACKOFF_SECONDS: "10",
    }),
  ).toThrow(/must not exceed/);
});

it("uses Cloud Tasks in production and does not permit the local dispatcher there", () => {
  expect(taskDispatcherModeFromEnvironment({ NODE_ENV: "production" })).toBe(
    "cloud-tasks",
  );
  expect(() =>
    taskDispatcherModeFromEnvironment({
      NODE_ENV: "production",
      TASK_DISPATCHER: "local",
    }),
  ).toThrow(/Production requires/);
  expect(taskDispatcherModeFromEnvironment({})).toBe("local");
});
