import {
  ProcessTaskMessageSchema,
  type ProcessTaskMessage,
} from "@factorylens/contracts";

import { writeStructuredLog } from "./security.js";

export type TaskDispatchOutcome = "dispatched" | "duplicate";

export interface TaskDispatchResult {
  taskName: string;
  outcome: TaskDispatchOutcome;
}

export interface TaskDispatcher {
  dispatch(message: ProcessTaskMessage): Promise<TaskDispatchResult>;
}

export type LocalWorkerInvoker = (
  message: Readonly<ProcessTaskMessage>,
) => void | Promise<void>;

export interface LocalTaskDispatcherOptions {
  invokeWorker: LocalWorkerInvoker;
  simulateDispatchFailure?: (
    message: Readonly<ProcessTaskMessage>,
  ) => Error | undefined;
  onWorkerError?: (
    error: unknown,
    message: Readonly<ProcessTaskMessage>,
  ) => void;
}

export interface LocalWorkerHttpOptions {
  targetUrl: string;
  token: string;
}

export function createLocalWorkerInvoker(
  options: LocalWorkerHttpOptions,
  fetchImplementation: typeof fetch = fetch,
): LocalWorkerInvoker {
  const target = new URL(options.targetUrl);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("LOCAL_WORKER_URL must be a loopback HTTP URL");
  }
  if (options.token.length < 32) {
    throw new Error(
      "LOCAL_WORKER_TASK_TOKEN must contain at least 32 characters",
    );
  }
  return async (message) => {
    const response = await fetchImplementation(target, {
      body: JSON.stringify(message),
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "X-CloudTasks-TaskName": deterministicTaskName(message),
        "X-CloudTasks-TaskRetryCount": "0",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Local worker returned HTTP ${response.status}`);
    }
  };
}

export function deterministicTaskName(message: ProcessTaskMessage): string {
  const validatedMessage = ProcessTaskMessageSchema.parse(message);
  return `process-${validatedMessage.jobId.toLowerCase()}-${validatedMessage.dispatchGeneration}`;
}

export class LocalTaskDispatcher implements TaskDispatcher {
  private readonly dispatches = new Map<string, Promise<TaskDispatchResult>>();
  private readonly invokeWorker: LocalWorkerInvoker;
  private readonly simulateDispatchFailure:
    LocalTaskDispatcherOptions["simulateDispatchFailure"] | undefined;
  private readonly onWorkerError: (
    error: unknown,
    message: Readonly<ProcessTaskMessage>,
  ) => void;

  constructor(options: LocalTaskDispatcherOptions) {
    this.invokeWorker = options.invokeWorker;
    this.simulateDispatchFailure = options.simulateDispatchFailure;
    this.onWorkerError =
      options.onWorkerError ??
      ((error, message) => {
        writeStructuredLog("error", "local_worker_invocation_failed", {
          correlationId: message.correlationId,
          dispatchGeneration: message.dispatchGeneration,
          errorType:
            error instanceof Error ? error.constructor.name : "UnknownError",
          jobId: message.jobId,
        });
      });
  }

  async dispatch(message: ProcessTaskMessage): Promise<TaskDispatchResult> {
    const validatedMessage = ProcessTaskMessageSchema.parse(message);
    const taskName = deterministicTaskName(validatedMessage);
    const existingDispatch = this.dispatches.get(taskName);

    if (existingDispatch !== undefined) {
      await existingDispatch;
      return { taskName, outcome: "duplicate" };
    }

    const dispatch = this.acceptDispatch(validatedMessage, taskName);
    this.dispatches.set(taskName, dispatch);

    try {
      return await dispatch;
    } catch (error) {
      if (this.dispatches.get(taskName) === dispatch) {
        this.dispatches.delete(taskName);
      }
      throw error;
    }
  }

  private async acceptDispatch(
    message: ProcessTaskMessage,
    taskName: string,
  ): Promise<TaskDispatchResult> {
    const simulatedFailure = this.simulateDispatchFailure?.(message);
    if (simulatedFailure !== undefined) {
      throw simulatedFailure;
    }

    setImmediate(() => {
      void Promise.resolve()
        .then(() => this.invokeWorker(message))
        .catch((error: unknown) => this.onWorkerError(error, message));
    });

    return { taskName, outcome: "dispatched" };
  }
}
