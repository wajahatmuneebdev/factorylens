import type { ProcessTaskMessage } from "@factorylens/contracts";
import { expect, it, vi } from "vitest";

import {
  createLocalWorkerInvoker,
  deterministicTaskName,
  LocalTaskDispatcher,
} from "../src/task-dispatcher.js";
import {
  taskDispatcherContract,
  type TaskDispatcherContractHarness,
} from "./task-dispatcher.contract.js";

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createLocalHarness(): TaskDispatcherContractHarness {
  const deliveredMessages: ProcessTaskMessage[] = [];
  let nextFailure: Error | undefined;
  const dispatcher = new LocalTaskDispatcher({
    invokeWorker(message) {
      deliveredMessages.push({ ...message });
    },
    simulateDispatchFailure() {
      const failure = nextFailure;
      nextFailure = undefined;
      return failure;
    },
  });

  return {
    dispatcher,
    deliveredMessages,
    failNextDispatch(error) {
      nextFailure = error;
    },
    waitForDelivery: nextEventLoopTurn,
  };
}

taskDispatcherContract("local", createLocalHarness);

it("accepts dispatch without waiting for the local worker to finish", async () => {
  let workerStarted = false;
  let finishWorker: (() => void) | undefined;
  const workerFinished = new Promise<void>((resolve) => {
    finishWorker = resolve;
  });
  const dispatcher = new LocalTaskDispatcher({
    async invokeWorker() {
      workerStarted = true;
      await workerFinished;
    },
  });

  await expect(
    dispatcher.dispatch({
      correlationId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
      jobId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
      dispatchGeneration: 1,
    }),
  ).resolves.toMatchObject({ outcome: "dispatched" });
  expect(workerStarted).toBe(false);

  await nextEventLoopTurn();
  expect(workerStarted).toBe(true);
  finishWorker?.();
});

it("posts the correlated task to only a loopback worker", async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const message: ProcessTaskMessage = {
    correlationId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
    dispatchGeneration: 1,
    jobId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
  };
  const invoke = createLocalWorkerInvoker(
    {
      targetUrl: "http://127.0.0.1:8000/internal/tasks/process",
      token: "local-development-token-at-least-32-characters",
    },
    fetchImplementation,
  );

  await invoke(message);

  expect(fetchImplementation).toHaveBeenCalledWith(
    new URL("http://127.0.0.1:8000/internal/tasks/process"),
    expect.objectContaining({
      body: JSON.stringify(message),
      headers: expect.objectContaining({
        Authorization: "Bearer local-development-token-at-least-32-characters",
        "X-CloudTasks-TaskName": deterministicTaskName(message),
      }),
      method: "POST",
    }),
  );
  expect(() =>
    createLocalWorkerInvoker({
      targetUrl: "https://worker.example/internal/tasks/process",
      token: "local-development-token-at-least-32-characters",
    }),
  ).toThrow("loopback");
});
