import { z } from "zod";

export const ProcessTaskMessageSchema = z
  .object({
    correlationId: z.uuid(),
    dispatchGeneration: z.number().int().positive(),
    jobId: z.uuid(),
  })
  .strict()
  .refine((message) => message.correlationId === message.jobId, {
    message: "correlationId must match the durable job identity",
    path: ["correlationId"],
  });

export type ProcessTaskMessage = z.infer<typeof ProcessTaskMessageSchema>;
