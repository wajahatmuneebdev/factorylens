import type { ProcessTaskMessage } from "@factorylens/contracts";
import { expect, it } from "vitest";

import { LocalTaskDispatcher } from "../src/task-dispatcher.js";
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
      jobId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
      dispatchGeneration: 1,
    }),
  ).resolves.toMatchObject({ outcome: "dispatched" });
  expect(workerStarted).toBe(false);

  await nextEventLoopTurn();
  expect(workerStarted).toBe(true);
  finishWorker?.();
});
