/**
 * One host's live stream on the relay: what guests are shown, held in memory
 * only while the host is connected, and the guests watching it.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Entry, HostMessage, RelayMessage, SuggestionStatus } from "../src/protocol.ts";
import { isAgentMessage, isAssistantMessage, isToolProgress } from "./messages.ts";
import type { ToolProgress } from "./messages.ts";

/** A guest can have this many suggestions waiting on the host at once. */
const MAX_WAITING_PER_GUEST = 3;
const MAX_SUGGESTION_LENGTH = 4000;

export interface ShownEntry {
  readonly id: string;
  readonly messages: readonly AgentMessage[];
}

export interface ToolState {
  started: boolean;
  progress?: ToolProgress;
  end?: { readonly isError: boolean; readonly durationMs?: number };
}

export interface Meta {
  readonly cwd: string;
  readonly model: string;
  readonly thinking: string;
}

/** What the stream needs from each guest's viewer. */
export interface Guest {
  readonly name: string;
  reset(): void;
  append(entries: readonly ShownEntry[]): void;
  tail(): void;
  tool(id: string): void;
  footer(): void;
  suggestionStatus(text: string, status: SuggestionStatus): void;
  end(reason: string): void;
}

export type SuggestResult = "sent" | "too-many";

type StreamUpdate = Exclude<HostMessage, { type: "hello" }>;

const shown = (entries: readonly Entry[]): ShownEntry[] => entries.map((entry) => ({ id: entry.id, messages: entry.messages.filter(isAgentMessage) }));

const resultIds = (entries: readonly ShownEntry[]): string[] => entries.flatMap((entry) => entry.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));

export class Stream {
  public readonly token: string;
  public readonly host: string;
  public meta: Meta = { cwd: "", model: "", thinking: "" };
  public entries: ShownEntry[] = [];
  /** The assistant message being streamed, until its entry arrives. */
  public tail: AssistantMessage | undefined;
  /** Tools that started but whose result entry hasn't arrived yet. */
  public readonly tools = new Map<string, ToolState>();
  readonly #guests = new Set<Guest>();
  readonly #waiting = new Map<string, { readonly guest: Guest; readonly text: string }>();
  readonly #send: (message: RelayMessage) => void;
  readonly #log: (line: string) => void;
  #nextSuggestion = 0;
  #ended = false;

  constructor(token: string, host: string, send: (message: RelayMessage) => void, log: (line: string) => void) {
    this.token = token;
    this.host = host;
    this.#send = send;
    this.#log = log;
  }

  public get guests(): readonly Guest[] {
    return [...this.#guests];
  }

  public apply(update: StreamUpdate): void {
    switch (update.type) {
      case "meta":
        this.meta = { cwd: update.cwd, model: update.model, thinking: update.thinking };
        this.#each((guest) => {
          guest.footer();
        });
        break;
      case "reset":
        this.entries = shown(update.entries);
        this.#settleTools(this.entries);
        this.#each((guest) => {
          guest.reset();
        });
        break;
      case "append": {
        const added = shown(update.entries);
        this.entries.push(...added);
        this.#settleTools(added);
        const tail = this.tail;
        if (tail !== undefined && added.some((entry) => entry.messages.some((m) => m.role === "assistant" && m.timestamp === tail.timestamp))) {
          this.tail = undefined;
        }
        this.#each((guest) => {
          guest.append(added);
        });
        break;
      }
      case "tail":
        this.tail = isAssistantMessage(update.message) ? update.message : undefined;
        this.#each((guest) => {
          guest.tail();
        });
        break;
      case "tool":
        this.#tool(update);
        break;
      case "suggestion_status": {
        const waiting = this.#waiting.get(update.id);
        this.#waiting.delete(update.id);
        if (waiting !== undefined && this.#guests.has(waiting.guest)) {
          waiting.guest.suggestionStatus(waiting.text, update.status);
        }
        break;
      }
    }
  }

  #tool(update: Extract<StreamUpdate, { type: "tool" }>): void {
    const state = this.tools.get(update.id) ?? { started: false };
    this.tools.set(update.id, state);
    state.started = true;
    if (isToolProgress(update.result)) {
      state.progress = update.result;
    }
    if (update.phase === "end") {
      state.end = { isError: update.isError ?? false, ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }) };
    }
    this.#each((guest) => {
      guest.tool(update.id);
    });
  }

  /** Forget the live state of tools whose results are now in the transcript. */
  #settleTools(entries: readonly ShownEntry[]): void {
    for (const id of resultIds(entries)) {
      this.tools.delete(id);
    }
  }

  public join(guest: Guest): void {
    this.#guests.add(guest);
    this.#presence();
  }

  public leave(guest: Guest): void {
    if (!this.#guests.delete(guest)) {
      return;
    }
    for (const [id, waiting] of this.#waiting) {
      if (waiting.guest === guest) {
        this.#waiting.delete(id);
      }
    }
    this.#presence();
  }

  public suggest(guest: Guest, text: string): SuggestResult {
    const mine = [...this.#waiting.values()].filter((waiting) => waiting.guest === guest).length;
    if (mine >= MAX_WAITING_PER_GUEST) {
      return "too-many";
    }
    this.#nextSuggestion += 1;
    const id = String(this.#nextSuggestion);
    const trimmed = text.slice(0, MAX_SUGGESTION_LENGTH);
    this.#waiting.set(id, { guest, text: trimmed });
    this.#send({ type: "suggestion", id, from: guest.name, text: trimmed });
    return "sent";
  }

  /** The host left: tell every guest and let them go. */
  public end(reason: string): void {
    this.#ended = true;
    this.#each((guest) => {
      guest.end(reason);
    });
    this.#guests.clear();
    this.#waiting.clear();
  }

  #presence(): void {
    if (this.#ended) {
      return;
    }
    this.#send({ type: "guests", names: this.guests.map((guest) => guest.name) });
    this.#each((guest) => {
      guest.footer();
    });
  }

  /** One guest's drawing failing must not stop the others. */
  #each(fn: (guest: Guest) => void): void {
    for (const guest of this.#guests) {
      try {
        fn(guest);
      } catch (err) {
        this.#log(`couldn't update ${guest.name}'s view of ${this.host}'s stream: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
