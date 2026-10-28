/**
 * One guest's view of a stream, drawn with pi's own transcript components on
 * the guest's SSH channel. The transcript logic follows pi's interactive
 * mode: entries render as pi renders a resumed session, and the streamed
 * assistant message and running tools update in place like a live run.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  parseSkillBlock
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, TruncatedText, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SuggestionStatus } from "../src/protocol.ts";
import type { Guest, ShownEntry, Stream, ToolState } from "./stream.ts";
import { ChannelTerminal } from "./terminal.ts";
import type { Channel } from "./terminal.ts";

const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;
const green = (text: string): string => `\x1b[32m${text}\x1b[39m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;

const shortText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
};

/** What ToolExecutionComponent takes to draw a tool's calls and results. */
type ToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

/** A guest's SSH channel: a terminal, plus the calls that end the session. */
export interface GuestChannel extends Channel {
  exit(code: number): unknown;
  end(): unknown;
}

interface Expandable {
  setExpanded(expanded: boolean): void;
}

/** Draws a placeholder instead of letting one bad message break the guest's screen. */
class Guarded implements Component {
  readonly #inner: Component;

  constructor(inner: Component) {
    this.#inner = inner;
  }

  public render(width: number): string[] {
    try {
      return this.#inner.render(width);
    } catch {
      return [dim(" (pi-live couldn't draw this part)")];
    }
  }

  public invalidate(): void {
    this.#inner.invalidate();
  }
}

/** The renderers of pi's built-in tools, so guests see reads, edits and commands as the host does. */
function builtInTools(cwd: string): ReadonlyMap<string, ToolDefinition> {
  const definitions = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd)
  ];
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") {
    return "";
  }
  return typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const failure = (message: AssistantMessage): string => (message.stopReason === "aborted" ? "Operation aborted" : (message.errorMessage ?? "Error"));

export interface ViewerOptions {
  readonly channel: GuestChannel;
  readonly columns: number;
  readonly rows: number;
  readonly stream: Stream;
  /** Used for the name of a guest who doesn't type one. */
  readonly number: number;
}

export class Viewer implements Guest {
  public name = "";
  readonly #stream: Stream;
  readonly #channel: GuestChannel;
  readonly #terminal: ChannelTerminal;
  readonly #tui: TuiMainScreen;
  readonly #chat = new Container();
  readonly #feedback = new Text("", 1, 0);
  readonly #input = new Input({ prompt: "suggest › ", placeholder: "a prompt for the host; Enter sends it to them" });
  /** Holds one TruncatedText, replaced on each change, so the footer stays one line. */
  readonly #footer = new Container();
  readonly #wrappers = new Map<Component, Component>();
  readonly #pending = new Map<string, ToolExecutionComponent>();
  readonly #expandables = new Set<Expandable>();
  #tools: ReadonlyMap<string, ToolDefinition> = new Map();
  #toolsCwd: string | undefined;
  #tail: { readonly timestamp: number; readonly component: AssistantMessageComponent; readonly tools: Map<string, ToolExecutionComponent> } | undefined;
  #expanded = false;
  #watching = false;
  #closed = false;

  constructor(options: ViewerOptions) {
    this.#stream = options.stream;
    this.#channel = options.channel;
    this.#terminal = new ChannelTerminal(options.channel, options.columns, options.rows);
    this.#tui = new TuiMainScreen(this.#terminal);
    this.#tui.addInputListener((data) => this.#onKey(data));
    this.#askName(options.number);
    this.#tui.start();
  }

  #askName(number: number): void {
    const host = this.#stream.host;
    const nameInput = new Input({ prompt: "Your name: " });
    nameInput.onSubmit = (value): void => {
      const name = value.trim().slice(0, 32);
      this.#watch(name === "" ? `guest-${String(number)}` : name);
    };
    this.#tui.addChild(new Text(`${bold(`Joining ${host}'s pi session.`)}\nType your name so ${host} knows who's watching, then press Enter.`, 1, 1));
    this.#tui.addChild(nameInput);
    this.#tui.setFocus(nameInput);
  }

  #watch(name: string): void {
    this.name = name;
    this.#watching = true;
    this.#tui.clear();
    for (const component of [this.#chat, new Spacer(1), this.#feedback, this.#input, this.#footer]) {
      this.#tui.addChild(component);
    }
    this.#tui.setFocus(this.#input);
    this.#input.onSubmit = (value): void => {
      this.#suggest(value);
    };
    this.#stream.join(this);
    this.reset();
  }

  #onKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && this.#input.getValue() === "")) {
      this.#close("You left the stream.");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o") && this.#watching) {
      this.#expanded = !this.#expanded;
      for (const component of this.#expandables) {
        component.setExpanded(this.#expanded);
      }
      this.#tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }

  #suggest(value: string): void {
    const text = value.trim();
    if (text === "") {
      return;
    }
    const host = this.#stream.host;
    if (this.#stream.suggest(this, text) === "too-many") {
      this.#feedback.setText(dim(`You have 3 suggestions waiting. Wait for ${host} to get to them.`));
    } else {
      this.#input.setValue("");
      this.#feedback.setText(dim(`Sent to ${host}: "${shortText(text)}". It waits above their editor until they use or dismiss it.`));
    }
    this.#tui.requestRender();
  }

  public suggestionStatus(text: string, status: SuggestionStatus): void {
    const host = this.#stream.host;
    this.#feedback.setText(status === "used" ? green(`✓ ${host} took your suggestion: "${shortText(text)}"`) : dim(`${host} dismissed your suggestion: "${shortText(text)}"`));
    this.#tui.requestRender();
  }

  public resize(columns: number, rows: number): void {
    this.#terminal.resize(columns, rows);
  }

  // Transcript

  public reset(): void {
    if (!this.#watching) {
      return;
    }
    this.#chat.clear();
    this.#wrappers.clear();
    this.#pending.clear();
    this.#expandables.clear();
    this.#tail = undefined;
    for (const entry of this.#stream.entries) {
      this.#addMessages(entry.messages);
    }
    for (const id of this.#stream.tools.keys()) {
      this.tool(id);
    }
    this.tail();
    this.footer();
  }

  public append(entries: readonly ShownEntry[]): void {
    if (!this.#watching) {
      return;
    }
    for (const entry of entries) {
      this.#addMessages(entry.messages);
    }
    this.#tui.requestRender();
  }

  public tail(): void {
    if (!this.#watching) {
      return;
    }
    const message = this.#stream.tail;
    if (this.#tail !== undefined && this.#tail.timestamp !== message?.timestamp) {
      this.#dropTail();
    }
    if (message === undefined) {
      this.#tui.requestRender();
      return;
    }
    if (this.#tail === undefined) {
      const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
      this.#add(component);
      this.#tail = { timestamp: message.timestamp, component, tools: new Map() };
    }
    const tail = this.#tail;
    tail.component.updateContent(message, true);
    for (const part of message.content) {
      if (part.type !== "toolCall") {
        continue;
      }
      const existing = tail.tools.get(part.id);
      if (existing === undefined) {
        const component = this.#newTool(part.name, part.id, part.arguments);
        tail.tools.set(part.id, component);
        this.#pending.set(part.id, component);
      } else {
        existing.updateArgs(part.arguments);
      }
    }
    this.#tui.requestRender();
  }

  public tool(id: string): void {
    const state = this.#stream.tools.get(id);
    const component = this.#pending.get(id);
    if (!this.#watching || state === undefined || component === undefined) {
      return;
    }
    applyTool(component, state);
    this.#tui.requestRender();
  }

  public footer(): void {
    if (!this.#watching) {
      return;
    }
    const { meta, host } = this.#stream;
    const cwd = meta.cwd.replace(/^(\/home|\/Users)\/[^/]+/, "~");
    const model = meta.model === "" ? "" : ` · ${meta.model}${meta.thinking === "" || meta.thinking === "off" ? "" : ` (${meta.thinking})`}`;
    const watching = `${String(this.#stream.guests.length)} watching`;
    this.#footer.clear();
    this.#footer.addChild(new TruncatedText(dim(`${green("● live")} · ${host}'s pi · ${cwd}${model} · ${watching} · ctrl+o tools · ctrl+c leave`), 1, 0));
    this.#tui.requestRender();
  }

  #addMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      this.#addMessage(message);
    }
  }

  #addMessage(message: AgentMessage): void {
    const markdown = getMarkdownTheme();
    switch (message.role) {
      case "assistant":
        this.#addAssistant(message);
        break;
      case "toolResult": {
        const component = this.#pending.get(message.toolCallId);
        component?.updateResult(message);
        this.#pending.delete(message.toolCallId);
        break;
      }
      case "user":
        this.#addUser(userText(message));
        break;
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command, this.#tui, message.excludeFromContext);
        if (message.output !== "") {
          component.appendOutput(message.output);
        }
        component.setComplete(message.exitCode ?? undefined, message.cancelled, undefined, message.fullOutputPath);
        this.#addExpandable(component);
        break;
      }
      case "custom":
        if (message.display) {
          this.#addExpandable(new CustomMessageComponent(message, undefined, markdown));
        }
        break;
      case "compactionSummary":
        this.#add(new Spacer(1));
        this.#addExpandable(new CompactionSummaryMessageComponent(message, markdown));
        break;
      case "branchSummary":
        this.#add(new Spacer(1));
        this.#addExpandable(new BranchSummaryMessageComponent(message, markdown));
        break;
      case "system":
        break;
    }
  }

  #addUser(text: string): void {
    if (text === "") {
      return;
    }
    const markdown = getMarkdownTheme();
    if (this.#chat.children.length > 0) {
      this.#add(new Spacer(1));
    }
    const skill = parseSkillBlock(text);
    if (skill === null) {
      this.#add(new UserMessageComponent(text, markdown));
      return;
    }
    this.#addExpandable(new SkillInvocationMessageComponent(skill, markdown));
    if (skill.userMessage !== undefined) {
      this.#add(new Spacer(1));
      this.#add(new UserMessageComponent(skill.userMessage, markdown));
    }
  }

  /** A finished assistant message: the streamed one, finalized in place, or a new one. */
  #addAssistant(message: AssistantMessage): void {
    const streamed = this.#tail?.timestamp === message.timestamp ? this.#tail : undefined;
    if (this.#tail !== undefined && streamed === undefined) {
      this.#dropTail();
    }
    this.#tail = undefined;
    if (streamed === undefined) {
      this.#add(new AssistantMessageComponent(message, false, getMarkdownTheme()));
    } else {
      streamed.component.updateContent(message, false);
    }
    const failed = message.stopReason === "aborted" || message.stopReason === "error";
    for (const part of message.content) {
      if (part.type !== "toolCall") {
        continue;
      }
      const component = streamed?.tools.get(part.id) ?? this.#newTool(part.name, part.id, part.arguments);
      if (failed) {
        component.updateResult({ content: [{ type: "text", text: failure(message) }], isError: true });
        this.#pending.delete(part.id);
      } else {
        component.setArgsComplete();
        this.#pending.set(part.id, component);
      }
    }
  }

  #dropTail(): void {
    if (this.#tail === undefined) {
      return;
    }
    this.#remove(this.#tail.component);
    for (const [id, component] of this.#tail.tools) {
      this.#remove(component);
      this.#pending.delete(id);
    }
    this.#tail = undefined;
  }

  #newTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const cwd = this.#stream.meta.cwd;
    if (this.#toolsCwd !== cwd) {
      this.#tools = builtInTools(cwd);
      this.#toolsCwd = cwd;
    }
    const component = new ToolExecutionComponent(name, id, args, { showImages: false }, this.#tools.get(name), this.#tui, cwd);
    this.#addExpandable(component);
    return component;
  }

  #add(component: Component): void {
    const wrapper = new Guarded(component);
    this.#wrappers.set(component, wrapper);
    this.#chat.addChild(wrapper);
  }

  #addExpandable(component: Component & Expandable): void {
    component.setExpanded(this.#expanded);
    this.#expandables.add(component);
    this.#add(component);
  }

  #remove(component: Component): void {
    const wrapper = this.#wrappers.get(component);
    if (wrapper !== undefined) {
      this.#chat.removeChild(wrapper);
    }
    this.#wrappers.delete(component);
  }

  // Ending

  /** The host left or the relay is stopping. */
  public end(reason: string): void {
    this.#close(reason);
  }

  /** The guest's connection closed. */
  public dispose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#terminal.close();
    this.#tui.stop();
    this.#stream.leave(this);
  }

  #close(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stream.leave(this);
    this.#tui.stop();
    this.#terminal.write(`\r\n${reason}\r\n`);
    this.#terminal.close();
    this.#channel.exit(0);
    this.#channel.end();
  }
}

function applyTool(component: ToolExecutionComponent, state: ToolState): void {
  if (state.started) {
    component.markExecutionStarted();
  }
  if (state.progress !== undefined) {
    const isError = state.end?.isError ?? false;
    component.updateResult({ ...state.progress, isError, ...(state.end?.durationMs === undefined ? {} : { durationMs: state.end.durationMs }) }, state.end === undefined);
  }
}
