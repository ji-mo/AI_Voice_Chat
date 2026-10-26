import { z } from "zod";

export const modeSchema = z.enum(["mock", "live"]);

export const emotionSchema = z.enum(["neutral", "curious", "warm"]);

export const actionSchema = z.enum(["none", "look_window", "show_photo"]);

export const storySchema = z.enum([
  "arrival",
  "conversation",
  "photo_revealed",
  "farewell",
]);

const cameraEvent = z
  .object({
    kind: z.literal("camera"),
    trigger: z.literal("segment_start"),
    target: z.enum(["table", "window"]),
  })
  .strict();

const photoEvent = z
  .object({
    kind: z.literal("photo"),
    trigger: z.literal("segment_start"),
    operation: z.enum(["reveal", "hide"]),
    assetId: z.literal("lighthouse_photo"),
  })
  .strict();

const storyEvent = z
  .object({
    kind: z.literal("story"),
    trigger: z.literal("segment_end"),
    node: storySchema,
  })
  .strict();

export const modelEventSchema = z.discriminatedUnion("kind", [
  cameraEvent,
  photoEvent,
  storyEvent,
]);

export const eventSchema = z.discriminatedUnion("kind", [
  cameraEvent.extend({ eventId: z.uuid() }),
  photoEvent.extend({ eventId: z.uuid() }),
  storyEvent.extend({ eventId: z.uuid() }),
]);

export const replySegmentSchema = z
  .object({
    text: z.string().trim().min(1).max(60),
    emotion: emotionSchema,
    action: actionSchema,
    events: z.array(modelEventSchema).max(3),
  })
  .strict();

export const modelReplySchema = z
  .object({ segments: z.array(replySegmentSchema).min(1).max(3) })
  .strict();

export const replySchema = modelReplySchema.refine(
  (reply) =>
    reply.segments.reduce(
      (length, segment) => length + segment.text.length,
      0,
    ) <= 120,
  "Reply is too long",
);

export const receiptSchema = z
  .object({
    turnId: z.uuid(),
    completedSegmentIds: z.array(z.uuid()).max(3),
    readSegmentIds: z.array(z.uuid()).max(3),
    appliedEventIds: z.array(z.uuid()).max(9),
  })
  .strict()
  .refine(
    (receipt) =>
      !receipt.completedSegmentIds.some((id) =>
        receipt.readSegmentIds.includes(id),
      ),
    "Receipt sources must be disjoint",
  );

export const faultSchema = z.enum([
  "delay_reply",
  "model_timeout",
  "audio_failure",
]);

const turnFields = {
  turnId: z.uuid(),
  turnSeq: z.number().int().positive().max(1_000_000),
  previousReceipt: receiptSchema.nullable(),
  demoFault: faultSchema.optional(),
};

export const textRequestSchema = z
  .object({ ...turnFields, text: z.string().trim().min(1).max(500) })
  .strict();

export const voiceRequestSchema = z.object(turnFields).strict();

export const interruptSchema = z
  .object({
    nextTurnSeq: z.number().int().positive().max(1_000_000),
    previousReceipt: receiptSchema.nullable(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    storyNode: storySchema,
    camera: z.enum(["table", "window"]),
    photoVisible: z.boolean(),
    emotion: emotionSchema,
  })
  .strict();

const audioSchema = z
  .object({
    audioId: z.uuid(),
    url: z.string().regex(/^\/api\/sessions\/[a-f0-9-]+\/audio\/[a-f0-9-]+$/),
    mimeType: z.enum(["audio/mpeg", "audio/wav"]),
  })
  .strict();

export const turnResponseSchema = z
  .object({
    sessionId: z.uuid(),
    turnId: z.uuid(),
    turnSeq: z.number().int().positive(),
    mode: modeSchema,
    inputText: z.string(),
    segments: z
      .array(
        replySegmentSchema.omit({ events: true }).extend({
          segmentId: z.uuid(),
          events: z.array(eventSchema).max(3),
          audio: audioSchema.nullable(),
        }),
      )
      .min(1)
      .max(3),
    warnings: z.array(z.string()).max(5),
  })
  .strict();

export const sessionSchema = z
  .object({
    sessionId: z.uuid(),
    snapshot: snapshotSchema,
    mode: modeSchema,
    demoFaults: z.boolean(),
  })
  .strict();

export const healthSchema = z
  .object({
    status: z.literal("ok"),
    mode: modeSchema,
    availableModes: z.array(modeSchema),
  })
  .strict();

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  turnId: z.string().nullable(),
});
