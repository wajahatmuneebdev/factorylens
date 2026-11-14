import {
  ProcessTaskMessageSchema,
  type ProcessTaskMessage,
} from "@factorylens/contracts";
import { describe, expect, it } from "vitest";

import {
  CloudTaskDispatcher,
  configureExistingCloudTasksQueue,
  type CloudTasksDispatchClient,
  type CloudTasksDispatcherOptions,
  type CloudTasksQueueClient,
  type CloudTasksQueueConfiguration,
} from "../src/cloud-task-dispatcher.js";
import { deterministicTaskName } from "../src/task-dispatcher.js";
import {
  taskDispatcherContract,
  type TaskDispatcherContractHarness,
} from "./task-dispatcher.contract.js";

type CreateTaskRequest = Parameters<CloudTasksDispatchClient["createTask"]>[0];
type UpdateQueueRequest = Parameters<CloudTasksQueueClient["updateQueue"]>[0];

const options: CloudTasksDispatcherOptions = {
  dispatchDeadlineSeconds: 900,
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
};

function queuePath(project: string, location: string, queue: string): string {
  return `projects/${project}/locations/${location}/queues/${queue}`;
}

function taskPath(
  project: string,
  location: string,
  queue: string,
  task: string,
): string {
  return `${queuePath(project, location, queue)}/tasks/${task}`;
}

class FakeDispatchClient implements CloudTasksDispatchClient {
  readonly createdRequests: CreateTaskRequest[] = [];
  readonly deliveredMessages: ProcessTaskMessage[] = [];
  private readonly taskNames = new Set<string>();
  private nextFailure: Error | undefined;

  failNext(error: Error): void {
    this.nextFailure = error;
  }

  async createTask(
    request: CreateTaskRequest,
  ): Promise<readonly [{ name: string }]> {
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      throw failure;
    }

    const name = request.task?.name;
    if (!name) {
      throw new Error("Cloud Task has no name");
    }
    if (this.taskNames.has(name)) {
      throw Object.assign(new Error("task already exists"), { code: 6 });
    }

    this.taskNames.add(name);
    this.createdRequests.push(request);
    const body = request.task?.httpRequest?.body;
    if (!body) {
      throw new Error("Cloud Task has no body");
    }
    this.deliveredMessages.push(
      ProcessTaskMessageSchema.parse(
        JSON.parse(Buffer.from(body).toString("utf8")),
      ),
    );
    return [{ name }];
  }

  queuePath = queuePath;
  taskPath = taskPath;
}

function createCloudTasksHarness(): TaskDispatcherContractHarness {
  const client = new FakeDispatchClient();
  return {
    deliveredMessages: client.deliveredMessages,
    dispatcher: new CloudTaskDispatcher(options, client),
    failNextDispatch(error) {
      client.failNext(error);
    },
    waitForDelivery: () => Promise.resolve(),
  };
}

taskDispatcherContract("Cloud Tasks", createCloudTasksHarness);

describe("CloudTaskDispatcher", () => {
  it("creates an authenticated HTTP task with the configured identity and limits", async () => {
    const client = new FakeDispatchClient();
    const dispatcher = new CloudTaskDispatcher(options, client);
    const message: ProcessTaskMessage = {
      correlationId: "c96f4f59-e47f-4d31-8d16-963ca3e4063e",
      dispatchGeneration: 4,
      jobId: "c96f4f59-e47f-4d31-8d16-963ca3e4063e",
    };

    await expect(dispatcher.dispatch(message)).resolves.toEqual({
      outcome: "dispatched",
      taskName: deterministicTaskName(message),
    });

    expect(client.createdRequests).toHaveLength(1);
    const request = client.createdRequests[0];
    expect(request).toMatchObject({
      parent:
        "projects/factorylens-test/locations/us-central1/queues/processing",
      task: {
        dispatchDeadline: { seconds: 900 },
        httpRequest: {
          headers: { "Content-Type": "application/json" },
          httpMethod: "POST",
          oidcToken: {
            audience: "https://worker.example",
            serviceAccountEmail:
              "factorylens-tasks@factorylens-test.iam.gserviceaccount.com",
          },
          url: "https://worker.example/internal/tasks/process",
        },
        name: `projects/factorylens-test/locations/us-central1/queues/processing/tasks/${deterministicTaskName(message)}`,
        retryConfig: {
          maxAttempts: 3,
          maxBackoff: { seconds: 300 },
          maxDoublings: 3,
          maxRetryDuration: { seconds: 0 },
          minBackoff: { seconds: 10 },
        },
      },
    });
    expect(
      JSON.parse(
        Buffer.from(request?.task?.httpRequest?.body ?? []).toString("utf8"),
      ),
    ).toEqual(message);
  });

  it("does not mistake another provider error for a duplicate", async () => {
    const client = new FakeDispatchClient();
    const dispatcher = new CloudTaskDispatcher(options, client);
    const failure = Object.assign(new Error("provider unavailable"), {
      code: 14,
    });
    client.failNext(failure);

    await expect(
      dispatcher.dispatch({
        correlationId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
        dispatchGeneration: 1,
        jobId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
      }),
    ).rejects.toBe(failure);
  });
});

class FakeQueueClient implements CloudTasksQueueClient {
  readonly calls: Array<"get" | "update"> = [];
  getFailure: Error | undefined;
  updateRequest: UpdateQueueRequest | undefined;

  async getQueue(): Promise<readonly [{ name: string }]> {
    this.calls.push("get");
    if (this.getFailure) {
      throw this.getFailure;
    }
    return [{ name: "existing-queue" }];
  }

  queuePath = queuePath;

  async updateQueue(
    request: UpdateQueueRequest,
  ): Promise<readonly [{ name: string }]> {
    this.calls.push("update");
    this.updateRequest = request;
    return [{ name: request.queue?.name ?? "" }];
  }
}

const queueConfiguration: CloudTasksQueueConfiguration = {
  location: options.location,
  maxConcurrentDispatches: 2,
  maxDispatchesPerSecond: 1.5,
  projectId: options.projectId,
  queue: options.queue,
  retry: options.retry,
};

describe("configureExistingCloudTasksQueue", () => {
  it("updates an existing queue with explicit rate, concurrency, and retry settings", async () => {
    const client = new FakeQueueClient();

    await configureExistingCloudTasksQueue(queueConfiguration, client);

    expect(client.calls).toEqual(["get", "update"]);
    expect(client.updateRequest).toEqual({
      queue: {
        name: "projects/factorylens-test/locations/us-central1/queues/processing",
        rateLimits: {
          maxConcurrentDispatches: 2,
          maxDispatchesPerSecond: 1.5,
        },
        retryConfig: {
          maxAttempts: 3,
          maxBackoff: { seconds: 300 },
          maxDoublings: 3,
          maxRetryDuration: { seconds: 0 },
          minBackoff: { seconds: 10 },
        },
      },
      updateMask: { paths: ["rate_limits", "retry_config"] },
    });
  });

  it("does not provision a queue when the configured queue is missing", async () => {
    const client = new FakeQueueClient();
    const failure = new Error("queue not found");
    client.getFailure = failure;

    await expect(
      configureExistingCloudTasksQueue(queueConfiguration, client),
    ).rejects.toBe(failure);
    expect(client.calls).toEqual(["get"]);
  });
});
