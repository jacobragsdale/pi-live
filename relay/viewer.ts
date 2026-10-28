/**
 * One guest's view of a stream: a full-screen pi on the guest's SSH channel.
 * The layout is pi's own fullscreen layout, a scrolling transcript above a
 * fixed dock with the working indicator, the editor and the footer, drawn
 * with pi's components and theme. The transcript logic follows pi's
 * interactive mode: entries render as pi renders a resumed session, and the
 * streamed assistant message and running tools update in place like a live run.
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
  getSelectListTheme,
  parseSkillBlock
} from "@earendil-works/pi-coding-agent";
import { Container, Editor, Loader, ScrollView, Spacer, Text, TuiAltScreen, VStack, matchesKey } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SuggestionStatus } from "../src/protocol.ts";
import { GuestFooter, thinkingLevel } from "./footer.ts";
import type { Guest, ShownEntry, Stream, ToolState } from "./stream.ts";
import { ChannelTerminal } from "./terminal.ts";
import type { Channel } from "./terminal.ts";
import { piTheme } from "./theme.ts";

const shortText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
};

/** Copy to the guest's own clipboard: OSC 52 asks their terminal to do it. */
const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

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
      return [piTheme().fg("dim", " (pi-live couldn't draw this part)")];
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
  readonly #tui: TuiAltScreen;
  readonly #chat = new Container();
  readonly #status = new Container();
  readonly #feedback = new Text("", 1, 0);
  readonly #editor: Editor;
  readonly #wrappers = new Map<Component, Component>();
  readonly #pending = new Map<string, ToolExecutionComponent>();
  readonly #expandables = new Set<Expandable>();
  readonly #number: number;
  #loader: Loader | undefined;
  #tools: ReadonlyMap<string, ToolDefinition> = new Map();
  #toolsCwd: string | undefined;
  #tail: { readonly timestamp: number; readonly component: AssistantMessageComponent; readonly tools: Map<string, ToolExecutionComponent> } | undefined;
  #expanded = false;
  #watching = false;
  #closed = false;

  constructor(options: ViewerOptions) {
    this.#stream = options.stream;
    this.#channel = options.channel;
    this.#number = options.number;
    this.#terminal = new ChannelTerminal(options.channel, options.columns, options.rows);
    const theme = piTheme();
    const searchMatch = (text: string): string => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
    this.#tui = new TuiAltScreen(this.#terminal, false, undefined, {
      wheelScrollLines: "auto",
      searchMatchStyle: (text) => theme.underline(searchMatch(text)),
      searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(searchMatch(text))),
      searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
      scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest message · ctrl+end ")),
      copySelection: (text) => {
        this.#terminal.write(osc52(text));
        return Promise.resolve(true);
      }
    });
    this.#editor = new Editor(this.#tui, { borderColor: theme.getThinkingBorderColor(thinkingLevel(this.#stream.meta.thinking)), selectList: getSelectListTheme() });
    this.#editor.onSubmit = (text): void => {
      this.#submit(text);
    };
    const footer = new GuestFooter(() => ({ meta: this.#stream.meta, host: this.#stream.host, watching: this.#stream.guests.length }));
    const transcript = new ScrollView(this.#chat, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
    const dock = new VStack([
      { component: this.#status, shrink: 1, minSize: 0 },
      { component: this.#feedback, shrink: 1, minSize: 0 },
      { component: this.#editor, shrink: 1, minSize: 3 },
      { component: footer, shrink: 1, minSize: 0 }
    ]);
    for (const component of [this.#chat, this.#status, this.#feedback, this.#editor, footer]) {
      this.#tui.addChild(component);
    }
    this.#tui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 }
      ])
    );
    this.#tui.setFocus(this.#editor);
    this.#tui.addInputListener((data) => this.#onKey(data));
    this.#header();
    this.#chat.addChild(new Text(`Type your name so ${this.#stream.host} knows who's watching, then press Enter.`, 1, 0));
    this.#tui.start();
  }

  #header(): void {
    const theme = piTheme();
    const host = this.#stream.host;
    const hints = [`Enter sends ${host} a suggestion`, "pgup/pgdn or the wheel scroll", "ctrl+o expands tools", "ctrl+c leaves"];
    this.#chat.addChild(new Text(`${theme.bold(theme.fg("accent", "pi-live"))} ${theme.fg("dim", `· watching ${host}'s pi session`)}\n${theme.fg("dim", hints.join(" · "))}`, 1, 1));
  }

  #submit(text: string): void {
    if (this.#watching) {
      this.#suggest(text);
      return;
    }
    const name = text.trim().slice(0, 32);
    this.name = name === "" ? `guest-${String(this.#number)}` : name;
    this.#watching = true;
    this.#stream.join(this);
    this.reset();
    this.activity();
  }

  #onKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && this.#editor.getText() === "")) {
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
    const theme = piTheme();
    const host = this.#stream.host;
    if (this.#stream.suggest(this, text) === "too-many") {
      this.#editor.setText(value);
      this.#feedback.setText(theme.fg("warning", `You have 3 suggestions waiting. Wait for ${host} to get to them.`));
    } else {
      this.#feedback.setText(theme.fg("dim", `Sent to ${host}: "${shortText(text)}". It waits above their editor until they use or dismiss it.`));
    }
    this.#tui.requestRender();
  }

  public suggestionStatus(text: string, status: SuggestionStatus): void {
    const theme = piTheme();
    const host = this.#stream.host;
    this.#feedback.setText(
      status === "used" ? theme.fg("success", `✓ ${host} took your suggestion: "${shortText(text)}"`) : theme.fg("dim", `${host} dismissed your suggestion: "${shortText(text)}"`)
    );
    this.#tui.requestRender();
  }

  public resize(columns: number, rows: number): void {
    this.#terminal.resize(columns, rows);
  }

  // Dock

  public activity(): void {
    if (!this.#watching) {
      return;
    }
    if (this.#stream.working && this.#loader === undefined) {
      const theme = piTheme();
      this.#loader = new Loader(
        this.#tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "Working"
      );
      this.#loader.start();
      this.#status.addChild(this.#loader);
    } else if (!this.#stream.working && this.#loader !== undefined) {
      this.#stopLoader();
    }
    this.#tui.requestRender();
  }

  #stopLoader(): void {
    this.#loader?.stop();
    this.#loader = undefined;
    this.#status.clear();
  }

  public footer(): void {
    this.#editor.borderColor = piTheme().getThinkingBorderColor(thinkingLevel(this.#stream.meta.thinking));
    this.#tui.requestRender();
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
    this.#header();
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
    this.#add(new Spacer(1));
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
    this.#stopLoader();
    this.#terminal.close();
    this.#tui.stop();
    this.#stream.leave(this);
  }

  #close(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stopLoader();
    this.#stream.leave(this);
    this.#tui.stop();
    this.#terminal.write(`${reason}\r\n`);
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
