/**
 * Checks the pi messages a host sends before the relay draws them. Anyone on
 * the network can host a stream, so a message only reaches pi's components
 * once it has every field they read. Extra fields are allowed; pi adds new
 * ones between releases.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, StopReason, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

const loose = { additionalProperties: true } as const;

const TextSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() }, loose);
const ThinkingSchema = Type.Object({ type: Type.Literal("thinking"), thinking: Type.String(), redacted: Type.Optional(Type.Boolean()) }, loose);
const ToolCallSchema = Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }, loose);
const TextOrString = Type.Union([Type.String(), Type.Array(TextSchema)]);
/**
 * Every stop reason pi reports, including "pending" for a message still
 * streaming. A Record, so the typecheck fails when pi adds or drops one.
 */
const STOP_REASONS: Record<StopReason, true> = { pending: true, stop: true, length: true, toolUse: true, error: true, aborted: true, deferred: true };
const StopReasonSchema = Type.Union(Object.keys(STOP_REASONS).map((reason) => Type.Literal(reason)));

const AssistantSchema = Type.Object(
  {
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Union([TextSchema, ThinkingSchema, ToolCallSchema])),
    api: Type.String(),
    provider: Type.String(),
    model: Type.String(),
    stopReason: StopReasonSchema,
    errorMessage: Type.Optional(Type.String()),
    timestamp: Type.Number()
  },
  loose
);

const MessageSchema = Type.Union([
  Type.Object({ role: Type.Literal("user"), content: TextOrString, timestamp: Type.Number() }, loose),
  AssistantSchema,
  Type.Object({ role: Type.Literal("toolResult"), toolCallId: Type.String(), toolName: Type.String(), content: Type.Array(TextSchema), isError: Type.Boolean(), timestamp: Type.Number() }, loose),
  Type.Object({ role: Type.Literal("custom"), customType: Type.String(), content: TextOrString, display: Type.Boolean(), timestamp: Type.Number() }, loose),
  Type.Object({ role: Type.Literal("compactionSummary"), summary: Type.String(), tokensBefore: Type.Number(), timestamp: Type.Number() }, loose),
  Type.Object({ role: Type.Literal("branchSummary"), summary: Type.String(), fromId: Type.Union([Type.String(), Type.Null()]), timestamp: Type.Number() }, loose),
  Type.Object(
    {
      role: Type.Literal("bashExecution"),
      command: Type.String(),
      output: Type.String(),
      exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      cancelled: Type.Boolean(),
      truncated: Type.Boolean(),
      timestamp: Type.Number()
    },
    loose
  )
]);

const ToolProgressSchema = Type.Object({ content: Type.Array(TextSchema), details: Type.Optional(Type.Unknown()) }, loose);

/** A tool's partial or final output, as ToolExecutionComponent.updateResult takes it. */
export interface ToolProgress {
  readonly content: (TextContent | ImageContent)[];
  readonly details?: unknown;
}

export function isAgentMessage(value: unknown): value is AgentMessage {
  return Check(MessageSchema, value);
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return Check(AssistantSchema, value);
}

export function isToolProgress(value: unknown): value is ToolProgress {
  return Check(ToolProgressSchema, value);
}
