import {
  ProcessTaskMessageSchema,
  type ProcessTaskMessage,
} from "@factorylens/contracts";

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
  onWorkerError?: (error: unknown) => void;
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
  private readonly onWorkerError: (error: unknown) => void;

  constructor(options: LocalTaskDispatcherOptions) {
    this.invokeWorker = options.invokeWorker;
    this.simulateDispatchFailure = options.simulateDispatchFailure;
    this.onWorkerError =
      options.onWorkerError ??
      (() => {
        console.error("Local worker invocation failed");
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
        .catch(this.onWorkerError);
    });

    return { taskName, outcome: "dispatched" };
  }
}
