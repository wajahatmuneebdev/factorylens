import type { ProcessTaskMessage } from "@factorylens/contracts";
import { describe, expect, it } from "vitest";

import {
  deterministicTaskName,
  type TaskDispatcher,
} from "../src/task-dispatcher.js";

export interface TaskDispatcherContractHarness {
  dispatcher: TaskDispatcher;
  deliveredMessages: ProcessTaskMessage[];
  failNextDispatch(error: Error): void;
  waitForDelivery(): Promise<void>;
}

export type TaskDispatcherContractHarnessFactory = () =>
  TaskDispatcherContractHarness | Promise<TaskDispatcherContractHarness>;

const message: ProcessTaskMessage = {
  correlationId: "c96f4f59-e47f-4d31-8d16-963ca3e4063e",
  jobId: "c96f4f59-e47f-4d31-8d16-963ca3e4063e",
  dispatchGeneration: 2,
};

/**
 * Shared behavior required of both local and Cloud Tasks dispatch adapters.
 */
export function taskDispatcherContract(
  adapterName: string,
  createHarness: TaskDispatcherContractHarnessFactory,
): void {
  describe(`${adapterName} task dispatcher contract`, () => {
    it("dispatches only the job identity contract with a deterministic task name", async () => {
      const harness = await createHarness();

      const result = await harness.dispatcher.dispatch(message);
      await harness.waitForDelivery();

      expect(result).toEqual({
        taskName: deterministicTaskName(message),
        outcome: "dispatched",
      });
      expect(harness.deliveredMessages).toEqual([message]);
    });

    it("treats a repeated deterministic task identity as a successful duplicate", async () => {
      const harness = await createHarness();

      const first = await harness.dispatcher.dispatch(message);
      const duplicate = await harness.dispatcher.dispatch({ ...message });
      await harness.waitForDelivery();

      expect(first.taskName).toBe(duplicate.taskName);
      expect(duplicate).toEqual({
        taskName: first.taskName,
        outcome: "duplicate",
      });
      expect(harness.deliveredMessages).toEqual([message]);
    });

    it("dispatches a new task identity when the generation changes", async () => {
      const harness = await createHarness();
      const nextGeneration = {
        ...message,
        dispatchGeneration: message.dispatchGeneration + 1,
      };

      const first = await harness.dispatcher.dispatch(message);
      const next = await harness.dispatcher.dispatch(nextGeneration);
      await harness.waitForDelivery();

      expect(first.outcome).toBe("dispatched");
      expect(next).toEqual({
        taskName: deterministicTaskName(nextGeneration),
        outcome: "dispatched",
      });
      expect(next.taskName).not.toBe(first.taskName);
      expect(harness.deliveredMessages).toEqual([message, nextGeneration]);
    });

    it("reports dispatch failure without reserving the task identity", async () => {
      const harness = await createHarness();
      const failure = new Error("simulated dispatch failure");
      harness.failNextDispatch(failure);

      await expect(harness.dispatcher.dispatch(message)).rejects.toBe(failure);
      expect(harness.deliveredMessages).toEqual([]);

      await expect(harness.dispatcher.dispatch(message)).resolves.toEqual({
        taskName: deterministicTaskName(message),
        outcome: "dispatched",
      });
      await harness.waitForDelivery();
      expect(harness.deliveredMessages).toEqual([message]);
    });

    it("rejects fields outside the worker task contract", async () => {
      const harness = await createHarness();
      const invalidMessage = {
        ...message,
        inspectionId: "f29c7b8c-d2ce-4a37-93bd-2d34ea89bb25",
      } as ProcessTaskMessage;

      await expect(
        harness.dispatcher.dispatch(invalidMessage),
      ).rejects.toThrow();
      expect(harness.deliveredMessages).toEqual([]);
    });
  });
}
