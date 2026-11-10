import { CloudTasksClient } from "@google-cloud/tasks";
import type { google } from "@google-cloud/tasks/build/protos";
import {
  ProcessTaskMessageSchema,
  type ProcessTaskMessage,
} from "@factorylens/contracts";

import {
  deterministicTaskName,
  type TaskDispatcher,
  type TaskDispatchResult,
} from "./task-dispatcher.js";

type CreateTaskRequest = google.cloud.tasks.v2.ICreateTaskRequest;
type GetQueueRequest = google.cloud.tasks.v2.IGetQueueRequest;
type Queue = google.cloud.tasks.v2.IQueue;
type Task = google.cloud.tasks.v2.ITask;
type UpdateQueueRequest = google.cloud.tasks.v2.IUpdateQueueRequest;

const alreadyExistsCode = 6;

export interface CloudTasksRetryConfiguration {
  maxAttempts: number;
  maxBackoffSeconds: number;
  maxDoublings: number;
  maxRetryDurationSeconds: number;
  minBackoffSeconds: number;
}

export interface CloudTasksDispatcherOptions {
  dispatchDeadlineSeconds: number;
  location: string;
  oidcAudience: string;
  projectId: string;
  queue: string;
  retry: CloudTasksRetryConfiguration;
  serviceAccountEmail: string;
  targetUrl: string;
}

export interface CloudTasksQueueConfiguration {
  location: string;
  maxConcurrentDispatches: number;
  maxDispatchesPerSecond: number;
  projectId: string;
  queue: string;
  retry: CloudTasksRetryConfiguration;
}

export interface CloudTasksDispatchClient {
  createTask(
    request: CreateTaskRequest,
  ): Promise<readonly [Task, ...unknown[]]>;
  queuePath(project: string, location: string, queue: string): string;
  taskPath(
    project: string,
    location: string,
    queue: string,
    task: string,
  ): string;
}

export interface CloudTasksQueueClient {
  getQueue(request: GetQueueRequest): Promise<readonly [Queue, ...unknown[]]>;
  queuePath(project: string, location: string, queue: string): string;
  updateQueue(
    request: UpdateQueueRequest,
  ): Promise<readonly [Queue, ...unknown[]]>;
}

function retryConfiguration(
  configuration: CloudTasksRetryConfiguration,
): google.cloud.tasks.v2.IRetryConfig {
  return {
    maxAttempts: configuration.maxAttempts,
    maxBackoff: { seconds: configuration.maxBackoffSeconds },
    maxDoublings: configuration.maxDoublings,
    maxRetryDuration: {
      seconds: configuration.maxRetryDurationSeconds,
    },
    minBackoff: { seconds: configuration.minBackoffSeconds },
  };
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === alreadyExistsCode
  );
}

export class CloudTaskDispatcher implements TaskDispatcher {
  private readonly client: CloudTasksDispatchClient;
  private readonly options: CloudTasksDispatcherOptions;
  private readonly parent: string;

  constructor(
    options: CloudTasksDispatcherOptions,
    client: CloudTasksDispatchClient = new CloudTasksClient(),
  ) {
    this.client = client;
    this.options = options;
    this.parent = client.queuePath(
      options.projectId,
      options.location,
      options.queue,
    );
  }

  async dispatch(message: ProcessTaskMessage): Promise<TaskDispatchResult> {
    const validatedMessage = ProcessTaskMessageSchema.parse(message);
    const taskName = deterministicTaskName(validatedMessage);

    try {
      await this.client.createTask({
        parent: this.parent,
        task: {
          dispatchDeadline: {
            seconds: this.options.dispatchDeadlineSeconds,
          },
          httpRequest: {
            body: Buffer.from(JSON.stringify(validatedMessage)),
            headers: { "Content-Type": "application/json" },
            httpMethod: "POST",
            oidcToken: {
              audience: this.options.oidcAudience,
              serviceAccountEmail: this.options.serviceAccountEmail,
            },
            url: this.options.targetUrl,
          },
          name: this.client.taskPath(
            this.options.projectId,
            this.options.location,
            this.options.queue,
            taskName,
          ),
          retryConfig: retryConfiguration(this.options.retry),
        },
      });
      return { outcome: "dispatched", taskName };
    } catch (error) {
      if (isAlreadyExists(error)) {
        return { outcome: "duplicate", taskName };
      }
      throw error;
    }
  }
}

/**
 * Applies limits to an existing queue. The initial get intentionally prevents
 * this configuration path from provisioning a missing queue.
 */
export async function configureExistingCloudTasksQueue(
  configuration: CloudTasksQueueConfiguration,
  client: CloudTasksQueueClient,
): Promise<void> {
  const name = client.queuePath(
    configuration.projectId,
    configuration.location,
    configuration.queue,
  );
  await client.getQueue({ name });
  await client.updateQueue({
    queue: {
      name,
      rateLimits: {
        maxConcurrentDispatches: configuration.maxConcurrentDispatches,
        maxDispatchesPerSecond: configuration.maxDispatchesPerSecond,
      },
      retryConfig: retryConfiguration(configuration.retry),
    },
    updateMask: { paths: ["rate_limits", "retry_config"] },
  });
}
