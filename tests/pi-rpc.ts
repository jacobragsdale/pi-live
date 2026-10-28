/**
 * Drives a real pi process in RPC mode for integration tests. Each instance
 * gets its own agent directory, so tests never touch a person's pi config.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
export const scriptedProvider = join(repo, "tests/fixtures/scripted-provider.ts");

export type RpcRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is RpcRecord => typeof value === "object" && value !== null && !Array.isArray(value);

export function field(record: RpcRecord, name: string): string {
  const value = record[name];
  return typeof value === "string" ? value : "";
}

/** A temporary agent directory whose default model is the scripted test provider. */
export function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-live-test-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "model" }));
  return dir;
}

/** Number of requests the scripted provider received. */
export function requestCount(log: string): number {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
}

export interface StartOptions {
  readonly agentDir: string;
  readonly extensions: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
}

export class PiRpc {
  public readonly records: RpcRecord[] = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #listeners = new Set<() => void>();
  #buffer = "";
  #nextId = 0;
  /**
   * Answers for dialogs, consumed in order per kind. A missing answer
   * declines a confirm and cancels the other dialogs. An editor answer
   * receives the prefilled text and returns the edited text, or undefined
   * to cancel.
   */
  public readonly answers: { confirm: boolean[]; select: string[]; input: string[]; editor: ((prefill: string) => string | undefined)[] } = { confirm: [], select: [], input: [], editor: [] };

  constructor(options: StartOptions) {
    const cwd = join(options.agentDir, "work");
    mkdirSync(cwd, { recursive: true });
    const args = ["--mode", "rpc", ...options.extensions.flatMap((path) => ["-e", path]), ...(options.args ?? ["--no-session"])];
    this.#child = spawn("pi", args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, ...options.env } });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#onData(chunk);
    });
    this.#child.stderr.resume();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      const parsed: unknown = line === "" ? undefined : JSON.parse(line);
      if (isRecord(parsed)) {
        this.#receive(parsed);
      }
    }
  }

  #receive(record: RpcRecord): void {
    this.records.push(record);
    if (record["type"] === "extension_ui_request") {
      this.#answer(record);
    }
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #answer(request: RpcRecord): void {
    const id = request["id"];
    const reply = (fields: RpcRecord): void => {
      this.send({ type: "extension_ui_response", id, ...fields });
    };
    const value = (answer: string | undefined): void => {
      reply(answer === undefined ? { cancelled: true } : { value: answer });
    };
    switch (request["method"]) {
      case "confirm":
        reply({ confirmed: this.answers.confirm.shift() ?? false });
        break;
      case "select":
        value(this.answers.select.shift());
        break;
      case "input":
        value(this.answers.input.shift());
        break;
      case "editor":
        value(this.answers.editor.shift()?.(field(request, "prefill")));
        break;
      default:
        break;
    }
  }

  public send(record: RpcRecord): void {
    this.#child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Resolve with the first record at or after index `from` that matches. */
  public waitFor(match: (record: RpcRecord) => boolean, from = 0, timeoutMs = 20_000): Promise<RpcRecord> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const found = this.records.slice(from).find(match);
        if (found !== undefined) {
          cleanup();
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${String(timeoutMs)}ms; records:\n${this.records.map((r) => JSON.stringify(r)).join("\n")}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(check);
      };
      this.#listeners.add(check);
      check();
    });
  }

  /** Send a prompt and wait until pi has finished with it. Returns its disposition. */
  public async prompt(message: string): Promise<string> {
    const from = this.records.length;
    this.#nextId += 1;
    const id = `prompt-${String(this.#nextId)}`;
    this.send({ id, type: "prompt", message });
    const response = await this.waitFor((r) => r["type"] === "response" && r["id"] === id, from);
    const data = response["data"];
    const disposition = isRecord(data) ? field(data, "disposition") : "";
    if (disposition !== "handled") {
      await this.waitFor((r) => r["type"] === "agent_settled", from);
    }
    return disposition;
  }

  /** Messages of the notify and setStatus UI records received since index `from`. */
  public notices(from = 0): string[] {
    return this.records.slice(from).flatMap((r) => (r["type"] === "extension_ui_request" && r["method"] === "notify" ? [field(r, "message")] : []));
  }

  public confirmTitles(from = 0): string[] {
    return this.records.slice(from).flatMap((r) => (r["type"] === "extension_ui_request" && r["method"] === "confirm" ? [field(r, "title")] : []));
  }

  public lastStatus(key: string): string {
    const status = this.records.filter((r) => r["type"] === "extension_ui_request" && r["method"] === "setStatus" && r["statusKey"] === key).at(-1);
    return status === undefined ? "" : field(status, "statusText");
  }

  public async close(): Promise<void> {
    if (this.#child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.#child.once("exit", () => {
        resolve();
      });
    });
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    await exited;
  }
}
