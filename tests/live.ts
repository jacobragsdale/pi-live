/**
 * Test helpers: a relay on free ports, a fake host on a WebSocket, and a
 * guest on a real SSH connection whose screen output is collected as text.
 */
import ssh2 from "ssh2";
import type { ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import { Check } from "typebox/value";
import { RelayMessageSchema } from "../src/protocol.ts";
import type { HostMessage, RelayMessage } from "../src/protocol.ts";
import { Relay } from "../relay/relay.ts";

const WAIT_MS = 15_000;

/** Remove escape sequences. (pi-tui's stripTerminalSequences drops text that follows "\x1b[...l\r\n".) */
// eslint-disable-next-line no-control-regex -- escape sequences are what this removes
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[@-_]/g;
const plain = (text: string): string => text.replace(ESCAPES, "");

/** Resolve once check() returns a value, polling until WAIT_MS. */
export async function eventually<T>(check: () => T | undefined, describe: () => string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${describe()}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

export interface TestRelay {
  readonly relay: Relay;
  readonly http: number;
  readonly ssh: number;
  readonly logs: string[];
}

export async function startRelay(): Promise<TestRelay> {
  const logs: string[] = [];
  const { private: hostKey } = ssh2.utils.generateKeyPairSync("ed25519");
  const relay = new Relay({
    httpPort: 0,
    sshPort: 0,
    hostKey,
    joinHost: "127.0.0.1",
    log: (line) => {
      logs.push(line);
    }
  });
  const ports = await relay.listen();
  return { relay, ...ports, logs };
}

export class FakeHost {
  public readonly received: RelayMessage[] = [];
  readonly #socket: WebSocket;
  #closed = false;

  constructor(httpPort: number) {
    this.#socket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/host`);
    this.#socket.on("message", (data: Buffer) => {
      const parsed: unknown = JSON.parse(data.toString("utf8"));
      if (Check(RelayMessageSchema, parsed)) {
        this.received.push(parsed);
      }
    });
    this.#socket.on("close", () => {
      this.#closed = true;
    });
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public async open(): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.#socket.once("open", () => {
          resolve();
        });
      });
    }
  }

  public send(message: HostMessage | Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(message));
  }

  /** Send hello and wait for the join command. */
  public async hello(host = "jacob", protocol = 1): Promise<Extract<RelayMessage, { type: "ready" }>> {
    await this.open();
    this.send({ type: "hello", protocol, piVersion: "1.4.0", host });
    return eventually(
      () => this.received.find((m): m is Extract<RelayMessage, { type: "ready" }> => m.type === "ready"),
      () => `no ready; got ${JSON.stringify(this.received)}`
    );
  }

  public waitFor(match: (message: RelayMessage) => boolean, describe = "a matching message"): Promise<RelayMessage> {
    return eventually(
      () => this.received.find(match),
      () => `no ${describe}; got ${JSON.stringify(this.received)}`
    );
  }

  public close(): void {
    this.#socket.close();
  }
}

/** A guest connected over SSH with a terminal of the given size. */
export class Guest {
  #output = "";
  #ended = false;
  readonly #client = new ssh2.Client();
  #channel: ClientChannel | undefined;

  public static connect(sshPort: number, token: string, size = { cols: 120, rows: 40 }): Promise<Guest> {
    const guest = new Guest();
    return new Promise((resolve, reject) => {
      guest.#client.on("ready", () => {
        guest.#client.shell({ term: "xterm-256color", ...size }, (err, channel) => {
          if (err !== undefined) {
            reject(err);
            return;
          }
          guest.#channel = channel;
          channel.on("data", (data: Buffer) => {
            guest.#output += data.toString("utf8");
          });
          channel.on("close", () => {
            guest.#ended = true;
          });
          resolve(guest);
        });
      });
      guest.#client.on("error", reject);
      guest.#client.connect({ host: "127.0.0.1", port: sshPort, username: token, hostVerifier: () => true });
    });
  }

  /** Everything the guest's terminal received, with escape sequences removed. */
  public get screen(): string {
    return plain(this.#output);
  }

  public get ended(): boolean {
    return this.#ended;
  }

  public type(text: string): void {
    this.#channel?.write(text);
  }

  public sees(text: string | RegExp): Promise<true> {
    return eventually(
      () => ((typeof text === "string" ? this.screen.includes(text) : text.test(this.screen)) ? true : undefined),
      () => `guest never saw ${String(text)}; screen:\n${this.screen.slice(-3000)}`
    );
  }

  public waitForEnd(): Promise<true> {
    return eventually(
      () => (this.#ended ? true : undefined),
      () => `guest's session never closed; screen:\n${this.screen.slice(-2000)}`
    );
  }

  public close(): void {
    this.#client.end();
  }
}

export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const user = (text: string, timestamp = 1): Record<string, unknown> => ({ role: "user", content: text, timestamp });

export const assistant = (content: unknown[], timestamp = 2, stopReason = "stop"): Record<string, unknown> => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "m",
  usage,
  stopReason,
  timestamp
});
