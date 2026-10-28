/**
 * /live: stream this pi session to colleagues through a pi-live relay. Guests
 * join with the ssh command /live prints, watch the conversation as it
 * happens, and can suggest prompts. Suggestions wait above the editor until
 * you put one in your editor (alt+s) or dismiss it (alt+x); nothing a guest
 * types reaches the agent unless you send it yourself.
 *
 * Run /live again to end the stream; quitting pi ends it too. The stream
 * follows you across /new, /resume, /fork and /tree.
 *
 * The relay's address comes from PI_LIVE_URL, or from url in
 * ~/.pi/agent/live.json. PI_LIVE=0 turns the extension off.
 */
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { VERSION, copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJson } from "../../src/json.ts";
import { PROTOCOL_VERSION, RelayMessageSchema } from "../../src/protocol.ts";
import type { HostMessage, RelayMessage, SuggestionStatus } from "../../src/protocol.ts";
import { scrub } from "../../src/scrub.ts";
import { footerMeta, gitBranch } from "./footer.ts";
import { catchUp } from "./transcript.ts";

const ConfigSchema = Type.Object({ url: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

const KEY = "live";
const USE_KEY = "alt+s";
const DISMISS_KEY = "alt+x";
/** Streaming text and tool output are sent at most this often. */
const THROTTLE_MS = 100;
/** Catches entries no event announces, such as ! commands. */
const SYNC_MS = 500;
const READY_TIMEOUT_MS = 10_000;
const SHOWN_SUGGESTIONS = 3;

interface Suggestion {
  readonly id: string;
  readonly from: string;
  readonly text: string;
}

/** One live stream. It lives on globalThis because /new, /resume, /fork and /reload load a fresh copy of this extension. */
interface Live {
  readonly socket: WebSocket;
  readonly join: string;
  guests: readonly string[];
  readonly suggestions: Suggestion[];
  /** Ids of the branch entries guests have, in order. */
  sent: string[];
}

declare global {
  var piLiveStream: Live | undefined;
}

type Ready = Extract<RelayMessage, { type: "ready" }>;

function relayUrl(): string | undefined {
  const fromEnv = process.env["PI_LIVE_URL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const path = join(getAgentDir(), "live.json");
  return existsSync(path) ? parseJson(ConfigSchema, readFileSync(path, "utf8"), path).url : undefined;
}

function hostName(): string {
  const name = process.env["PI_LIVE_NAME"] ?? userInfo().username;
  const trimmed = name.slice(0, 64);
  return trimmed === "" ? "host" : trimmed;
}

function parseRelayMessage(data: unknown): RelayMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(data);
    return Check(RelayMessageSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** Open a socket to the relay and wait for it to hand out the join command. */
function connect(url: string): Promise<{ socket: WebSocket; ready: Ready }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const fail = (message: string): void => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      fail(`The relay at ${url} didn't answer within ${String(READY_TIMEOUT_MS / 1000)} seconds.`);
    }, READY_TIMEOUT_MS);
    socket.onopen = (): void => {
      const hello: HostMessage = { type: "hello", protocol: PROTOCOL_VERSION, piVersion: VERSION, host: hostName() };
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event): void => {
      const message = parseRelayMessage(event.data);
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve({ socket, ready: message });
      } else if (message?.type === "error") {
        fail(`The relay refused the stream: ${message.message}`);
      }
    };
    socket.onclose = (): void => {
      fail(`Couldn't reach the relay at ${url}.`);
    };
  });
}

/** Runs the latest call at most once per THROTTLE_MS. */
class Throttle {
  #timer: NodeJS.Timeout | undefined;
  #last = 0;

  public run(fn: () => void): void {
    clearTimeout(this.#timer);
    const wait = THROTTLE_MS - (Date.now() - this.#last);
    if (wait <= 0) {
      this.#last = Date.now();
      fn();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#last = Date.now();
      fn();
    }, wait);
  }

  public cancel(): void {
    clearTimeout(this.#timer);
  }
}

export default function live(pi: ExtensionAPI): void {
  if (process.env["PI_LIVE"] === "0") {
    return;
  }
  /** The latest context this copy of the extension saw; undefined until its session starts. */
  let ctx: ExtensionContext | undefined;
  let attached = false;
  let branch: string | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  const tail = new Throttle();
  const tools = new Map<string, Throttle>();

  const current = (): Live | undefined => globalThis.piLiveStream;

  function send(message: HostMessage): void {
    const socket = current()?.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sync(): void {
    const stream = current();
    if (stream === undefined || ctx === undefined || !attached) {
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const change = catchUp(stream.sent, branch);
    stream.sent = branch.map((entry) => entry.id);
    if (change !== undefined) {
      send(change);
    }
  }

  function sendMeta(): void {
    if (ctx !== undefined && current() !== undefined) {
      send({ type: "meta", ...footerMeta(ctx, pi.getThinkingLevel(), branch) });
    }
  }

  /** Look up the git branch, which the agent may have changed, then resend the footer. */
  function refreshBranch(): void {
    if (ctx === undefined) {
      return;
    }
    gitBranch(ctx.cwd).then(
      (found) => {
        branch = found;
        sendMeta();
      },
      () => undefined
    );
  }

  function showState(): void {
    const stream = current();
    if (ctx === undefined || !attached || stream === undefined) {
      return;
    }
    const { theme } = ctx.ui;
    const watching = stream.guests.length === 0 ? "nobody watching yet" : stream.guests.join(", ");
    ctx.ui.setStatus(KEY, `${theme.fg("success", "● live")} · ${watching}`);
    if (stream.suggestions.length === 0) {
      ctx.ui.setWidget(KEY, undefined);
      return;
    }
    const shown = stream.suggestions.slice(0, SHOWN_SUGGESTIONS).map((s) => `${theme.fg("accent", s.from)}: ${oneLine(s.text)}`);
    const more = stream.suggestions.length > SHOWN_SUGGESTIONS ? [theme.fg("dim", `and ${String(stream.suggestions.length - SHOWN_SUGGESTIONS)} more`)] : [];
    ctx.ui.setWidget(KEY, [theme.fg("dim", `Suggestions · ${USE_KEY} puts the first in your editor · ${DISMISS_KEY} dismisses it`), ...shown, ...more]);
  }

  function clearState(): void {
    ctx?.ui.setStatus(KEY, undefined);
    ctx?.ui.setWidget(KEY, undefined);
  }

  function onRelayMessage(socket: WebSocket, data: unknown): void {
    const stream = current();
    const message = parseRelayMessage(data);
    if (stream?.socket !== socket) {
      return;
    }
    switch (message?.type) {
      case "guests":
        stream.guests = message.names;
        break;
      case "suggestion":
        stream.suggestions.push({ id: message.id, from: message.from, text: message.text });
        break;
      case "error":
        ctx?.ui.notify(`pi-live relay: ${message.message}`, "error");
        break;
      case "ready":
      case undefined:
        break;
    }
    showState();
  }

  function onRelayClosed(stream: Live): void {
    if (current() !== stream) {
      return;
    }
    globalThis.piLiveStream = undefined;
    detach();
    clearState();
    ctx?.ui.notify("The live stream dropped: the relay closed the connection. Run /live to start a new one.", "warning");
  }

  /** Bind the stream to this copy of the extension and bring guests up to date. */
  function attach(): void {
    const stream = current();
    if (stream === undefined) {
      return;
    }
    attached = true;
    stream.socket.onmessage = (event): void => {
      onRelayMessage(stream.socket, event.data);
    };
    stream.socket.onclose = (): void => {
      onRelayClosed(stream);
    };
    stream.sent = [];
    clearInterval(syncTimer);
    syncTimer = setInterval(sync, SYNC_MS);
    sendMeta();
    refreshBranch();
    send({ type: "activity", working: !(ctx?.isIdle() ?? true) });
    sync();
    showState();
  }

  function detach(): void {
    attached = false;
    clearInterval(syncTimer);
    tail.cancel();
    for (const throttle of tools.values()) {
      throttle.cancel();
    }
    tools.clear();
  }

  function end(notify: boolean): void {
    const stream = current();
    if (stream === undefined) {
      return;
    }
    globalThis.piLiveStream = undefined;
    detach();
    stream.socket.close(1000, "host ended the stream");
    clearState();
    if (notify) {
      ctx?.ui.notify("Stream ended. Its link no longer works.", "info");
    }
  }

  async function copyJoin(join: string): Promise<string> {
    // Over SSH, pi copies by writing an escape sequence to stdout, which only the TUI can do safely.
    if (ctx?.mode !== "tui") {
      return "";
    }
    try {
      await copyToClipboard(join);
      return " (copied)";
    } catch {
      return "";
    }
  }

  async function start(): Promise<void> {
    const url = relayUrl();
    if (url === undefined) {
      ctx?.ui.notify('No relay is set up. Set PI_LIVE_URL, or put {"url": "wss://<relay>/host"} in ~/.pi/agent/live.json.', "error");
      return;
    }
    const { socket, ready } = await connect(url);
    globalThis.piLiveStream = { socket, join: ready.join, guests: [], suggestions: [], sent: [] };
    attach();
    const copied = await copyJoin(ready.join);
    const skew = ready.piVersion === VERSION ? "" : `\nThe relay draws with pi ${ready.piVersion} and you run ${VERSION}, so guests may see small differences.`;
    ctx?.ui.notify(`Live. Send this to whoever should watch${copied}:\n  ${ready.join}\nRun /live again to end the stream.${skew}`, "info");
  }

  function resolve(status: SuggestionStatus, context: ExtensionContext): void {
    const next = current()?.suggestions.shift();
    if (next === undefined) {
      context.ui.notify("No suggestions are waiting.", "info");
      return;
    }
    if (status === "used") {
      if (context.ui.getEditorText().trim() === "") {
        context.ui.setEditorText(next.text);
      } else {
        context.ui.pasteToEditor(next.text);
      }
    }
    send({ type: "suggestion_status", id: next.id, status });
    showState();
  }

  pi.registerCommand("live", {
    description: "Stream this session to colleagues over ssh; run it again to end the stream",
    getArgumentCompletions: (prefix) => ["link", "use", "dismiss"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
    handler: async (args, context) => {
      ctx = context;
      if (!context.hasUI) {
        context.ui.notify("/live needs the interactive UI.", "error");
        return;
      }
      const stream = current();
      switch (args.trim()) {
        case "":
          if (stream === undefined) {
            await start().catch((err: unknown) => {
              context.ui.notify(err instanceof Error ? err.message : String(err), "error");
            });
          } else {
            end(true);
          }
          return;
        case "link":
          context.ui.notify(stream === undefined ? "Not live. Run /live to start a stream." : `Guests join with:\n  ${stream.join}${await copyJoin(stream.join)}`, "info");
          return;
        case "use":
          resolve("used", context);
          return;
        case "dismiss":
          resolve("dismissed", context);
          return;
        default:
          context.ui.notify("Usage: /live (start or end), /live link, /live use, /live dismiss", "warning");
      }
    }
  });

  pi.registerShortcut(USE_KEY, {
    description: "Put the first live-stream suggestion in the editor",
    handler: (context) => {
      ctx = context;
      resolve("used", context);
    }
  });
  pi.registerShortcut(DISMISS_KEY, {
    description: "Dismiss the first live-stream suggestion",
    handler: (context) => {
      ctx = context;
      resolve("dismissed", context);
    }
  });

  pi.on("session_start", (_event, context) => {
    ctx = context;
    attach();
  });

  pi.on("session_shutdown", (event, context) => {
    ctx = context;
    if (event.reason === "quit") {
      end(false);
    } else {
      detach();
    }
  });

  pi.on("message_start", (event, context) => {
    ctx = context;
    if (event.message.role === "assistant") {
      sync();
      send({ type: "tail", message: scrub(event.message) });
    }
  });

  pi.on("message_update", (event, context) => {
    ctx = context;
    if (event.message.role === "assistant") {
      const { message } = event;
      tail.run(() => {
        send({ type: "tail", message: scrub(message) });
      });
    }
  });

  pi.on("message_end", (event, context) => {
    ctx = context;
    const isAssistant = event.message.role === "assistant";
    if (isAssistant) {
      tail.cancel();
    }
    // Pi saves the message after its handlers return, so look at the branch on the next tick.
    setTimeout(() => {
      sync();
      if (isAssistant) {
        send({ type: "tail", message: null });
        sendMeta();
      }
    }, 0);
  });

  pi.on("tool_execution_start", (event, context) => {
    ctx = context;
    if (event.parentToolCallId === undefined) {
      sync();
      send({ type: "tool", phase: "start", id: event.toolCallId });
    }
  });

  pi.on("tool_execution_update", (event, context) => {
    ctx = context;
    if (event.parentToolCallId !== undefined) {
      return;
    }
    const throttle = tools.get(event.toolCallId) ?? new Throttle();
    tools.set(event.toolCallId, throttle);
    const result: unknown = event.partialResult;
    throttle.run(() => {
      send({ type: "tool", phase: "update", id: event.toolCallId, result: scrub(result) });
    });
  });

  pi.on("tool_execution_end", (event, context) => {
    ctx = context;
    if (event.parentToolCallId !== undefined) {
      return;
    }
    tools.get(event.toolCallId)?.cancel();
    tools.delete(event.toolCallId);
    const result: unknown = event.result;
    send({ type: "tool", phase: "end", id: event.toolCallId, result: scrub(result), isError: event.isError, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) });
  });

  pi.on("model_select", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("thinking_level_select", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("session_tree", (_event, context) => {
    ctx = context;
    sync();
  });
  pi.on("session_compact", (_event, context) => {
    ctx = context;
    sync();
    sendMeta();
  });
  pi.on("session_info_changed", (_event, context) => {
    ctx = context;
    sendMeta();
  });
  pi.on("agent_start", (_event, context) => {
    ctx = context;
    send({ type: "activity", working: true });
  });
  pi.on("agent_settled", (_event, context) => {
    ctx = context;
    sync();
    send({ type: "tail", message: null });
    send({ type: "activity", working: false });
    refreshBranch();
  });
}
