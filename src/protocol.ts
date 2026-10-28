/**
 * The JSON messages a host's pi and the relay exchange over one WebSocket.
 * Every message is a JSON object with a "type". Bump PROTOCOL_VERSION on any
 * change a peer on the old version would misread.
 *
 * Host to relay:
 *   hello              first message: protocol version, pi version, the host's name
 *   meta               what pi's footer shows: directory, git branch, token use, context, model
 *   activity           whether the agent is working, for the guests' "Working" indicator
 *   reset              the whole current branch, replacing what guests have
 *   append             entries added to the end of the branch
 *   tail               the assistant message being streamed, or null once it is finished
 *   tool               a running tool's progress (start, partial result, end)
 *   suggestion_status  the host used or dismissed a guest's suggestion
 *
 * Relay to host:
 *   ready              the stream is open; carries the guests' join command
 *   guests             the names of everyone watching
 *   suggestion         a guest suggested a prompt
 *   error              the relay refused something; the connection closes after it
 *
 * Messages inside entries, tail and tool results are pi's own AgentMessage and
 * tool result objects, already scrubbed by the host. The relay checks them
 * against relay/messages.ts before drawing them.
 */
import type { Static } from "typebox";
import { Type } from "typebox";

export const PROTOCOL_VERSION = 2;

/** One session entry: its id and the messages pi would show for it (often none). */
const EntrySchema = Type.Object({ id: Type.String({ minLength: 1 }), messages: Type.Array(Type.Unknown()) }, { additionalProperties: false });

const strict = { additionalProperties: false } as const;

/** The facts pi's footer is drawn from, so guests' footers match the host's. */
const MetaSchema = Type.Object(
  {
    type: Type.Literal("meta"),
    /** The working directory, for tool output paths. */
    cwd: Type.String(),
    /** The working directory as pi's footer shows it, with ~ for the host's home. */
    cwdLabel: Type.String(),
    gitBranch: Type.Optional(Type.String()),
    sessionName: Type.Optional(Type.String()),
    model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String(), reasoning: Type.Boolean() }, strict)),
    /** Whether pi's footer would show the provider: the host has more than one. */
    showProvider: Type.Boolean(),
    thinking: Type.String(),
    usage: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(), cacheHitRate: Type.Optional(Type.Number()) }, strict),
    context: Type.Optional(Type.Object({ percent: Type.Union([Type.Number(), Type.Null()]), contextWindow: Type.Number() }, strict)),
    autoCompact: Type.Boolean()
  },
  strict
);

export const HostMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("hello"), protocol: Type.Number(), piVersion: Type.String(), host: Type.String({ minLength: 1, maxLength: 64 }) }, strict),
  MetaSchema,
  Type.Object({ type: Type.Literal("activity"), working: Type.Boolean() }, strict),
  Type.Object({ type: Type.Literal("reset"), entries: Type.Array(EntrySchema) }, strict),
  Type.Object({ type: Type.Literal("append"), entries: Type.Array(EntrySchema) }, strict),
  Type.Object({ type: Type.Literal("tail"), message: Type.Unknown() }, strict),
  Type.Object(
    {
      type: Type.Literal("tool"),
      phase: Type.Union([Type.Literal("start"), Type.Literal("update"), Type.Literal("end")]),
      id: Type.String({ minLength: 1 }),
      result: Type.Optional(Type.Unknown()),
      isError: Type.Optional(Type.Boolean()),
      durationMs: Type.Optional(Type.Number())
    },
    strict
  ),
  Type.Object({ type: Type.Literal("suggestion_status"), id: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("used"), Type.Literal("dismissed")]) }, strict)
]);

export const RelayMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready"), token: Type.String({ minLength: 1 }), join: Type.String({ minLength: 1 }), piVersion: Type.String() }, strict),
  Type.Object({ type: Type.Literal("guests"), names: Type.Array(Type.String()) }, strict),
  Type.Object({ type: Type.Literal("suggestion"), id: Type.String({ minLength: 1 }), from: Type.String(), text: Type.String() }, strict),
  Type.Object({ type: Type.Literal("error"), message: Type.String() }, strict)
]);

export type Entry = Static<typeof EntrySchema>;
export type HostMessage = Static<typeof HostMessageSchema>;
export type RelayMessage = Static<typeof RelayMessageSchema>;
export type ToolPhase = Extract<HostMessage, { type: "tool" }>["phase"];
export type SuggestionStatus = Extract<HostMessage, { type: "suggestion_status" }>["status"];
export type Meta = Omit<Static<typeof MetaSchema>, "type">;
