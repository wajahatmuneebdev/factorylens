import { z } from "zod";

export const ProcessTaskMessageSchema = z
  .object({
    jobId: z.uuid(),
    dispatchGeneration: z.number().int().positive(),
  })
  .strict();

export type ProcessTaskMessage = z.infer<typeof ProcessTaskMessageSchema>;
