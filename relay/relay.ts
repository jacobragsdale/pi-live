/**
 * The pi-live relay. A host's pi connects to /host over a WebSocket and gets a
 * stream with an unguessable token. Guests run `ssh <token>@<relay>` and see
 * that stream drawn with pi's own components. Streams live only in memory and
 * end when the host disconnects; the relay stores nothing.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION, initTheme } from "@earendil-works/pi-coding-agent";
import ssh2 from "ssh2";
import type { Connection, ServerChannel } from "ssh2";
import { Check } from "typebox/value";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { HostMessageSchema, PROTOCOL_VERSION } from "../src/protocol.ts";
import type { HostMessage, RelayMessage } from "../src/protocol.ts";
import { Stream } from "./stream.ts";
import { Viewer } from "./viewer.ts";

const MAX_STREAMS = 50;
const MAX_GUESTS = 20;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
/** Under the 60-second idle timeout of common ingress controllers. */
const PING_MS = 20_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface RelayOptions {
  /** 0 picks a free port. */
  readonly httpPort: number;
  readonly sshPort: number;
  /** The SSH host key, in OpenSSH or PEM format. */
  readonly hostKey: string;
  /** The host name in the join command guests run. */
  readonly joinHost: string;
  /** The port in the join command; defaults to the port the SSH server listens on. */
  readonly joinPort?: number;
  readonly log?: (line: string) => void;
}

/** 120 random bits as 24 lowercase letters and digits, safe as an SSH user name. */
function newToken(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let token = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      token += BASE32.charAt((value >> bits) & 31);
    }
  }
  return token;
}

const boundPort = (address: AddressInfo | string | null, fallback: number): number => (address !== null && typeof address === "object" ? address.port : fallback);

function text(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
}

function parseHostMessage(data: RawData): HostMessage | undefined {
  try {
    const value: unknown = JSON.parse(text(data));
    return Check(HostMessageSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, message: RelayMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Tell a guest why they can't watch, then hang up. */
function refuseGuest(channel: ServerChannel, reason: string): void {
  channel.write(`${reason}\r\n`);
  channel.exit(1);
  channel.end();
}

export class Relay {
  readonly #options: RelayOptions;
  readonly #log: (line: string) => void;
  readonly #streams = new Map<string, Stream>();
  readonly #http = createServer((request, response) => {
    this.#onRequest(request, response);
  });
  readonly #hosts = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  readonly #ssh: ssh2.Server;
  #guestCount = 0;
  #sshPort = 0;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#log =
      options.log ??
      ((line): void => {
        console.log(`${new Date().toISOString()} ${line}`);
      });
    initTheme("dark", false);
    // Every guest's TUI adds a process exit listener.
    process.setMaxListeners(0);
    this.#http.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://relay").pathname !== "/host") {
        socket.destroy();
        return;
      }
      this.#hosts.handleUpgrade(request, socket, head, (host) => {
        this.#onHost(host);
      });
    });
    this.#ssh = new ssh2.Server({ hostKeys: [options.hostKey], ident: "pi-live" }, (client) => {
      this.#onGuest(client);
    });
  }

  /** Start listening; resolves with the ports actually bound. */
  public async listen(): Promise<{ http: number; ssh: number }> {
    await new Promise<void>((resolve) => {
      this.#http.listen(this.#options.httpPort, resolve);
    });
    await new Promise<void>((resolve) => {
      this.#ssh.listen(this.#options.sshPort, resolve);
    });
    this.#sshPort = boundPort(this.#ssh.address(), this.#options.sshPort);
    return { http: boundPort(this.#http.address(), this.#options.httpPort), ssh: this.#sshPort };
  }

  public async close(): Promise<void> {
    for (const stream of this.#streams.values()) {
      stream.end("The relay is shutting down.");
    }
    this.#streams.clear();
    for (const host of this.#hosts.clients) {
      host.close(1001, "relay shutting down");
    }
    await Promise.all([
      new Promise<void>((resolve) => {
        this.#ssh.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        this.#http.closeAllConnections();
        this.#http.close(() => {
          resolve();
        });
      })
    ]);
  }

  public joinCommand(token: string): string {
    const port = this.#options.joinPort ?? this.#sshPort;
    return `ssh ${port === 22 ? "" : `-p ${String(port)} `}${token}@${this.#options.joinHost}`;
  }

  #onRequest(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://relay").pathname;
    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else if (path === "/") {
      response.writeHead(200, { "content-type": "text/plain" }).end("pi-live relay. Hosts connect here from pi with /live; guests join with the ssh command the host sends them.\n");
    } else {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    }
  }

  #onHost(socket: WebSocket): void {
    let stream: Stream | undefined;
    let alive = true;
    const refuse = (reason: string): void => {
      send(socket, { type: "error", message: reason });
      socket.close(1008, "refused");
    };
    const helloTimer = setTimeout(() => {
      refuse("no hello message");
    }, HELLO_TIMEOUT_MS);
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("message", (data) => {
      alive = true;
      const message = parseHostMessage(data);
      if (message === undefined) {
        this.#log(`ignored a malformed message from ${stream?.host ?? "a host"}`);
        return;
      }
      if (stream !== undefined) {
        if (message.type !== "hello") {
          stream.apply(message);
        }
        return;
      }
      if (message.type !== "hello") {
        refuse("the first message must be hello");
        return;
      }
      clearTimeout(helloTimer);
      stream = this.#open(message, socket, refuse);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      if (stream !== undefined && this.#streams.get(stream.token) === stream) {
        this.#streams.delete(stream.token);
        stream.end(`${stream.host} ended the stream.`);
        this.#log(`${stream.host}'s stream ended (${String(this.#streams.size)} open)`);
      }
    });
    socket.on("error", (err) => {
      this.#log(`host connection error: ${err.message}`);
    });
  }

  #open(hello: Extract<HostMessage, { type: "hello" }>, socket: WebSocket, refuse: (reason: string) => void): Stream | undefined {
    if (hello.protocol !== PROTOCOL_VERSION) {
      refuse(`this relay speaks pi-live protocol ${String(PROTOCOL_VERSION)} and your pi-live speaks ${String(hello.protocol)}; update pi-live`);
      return undefined;
    }
    if (this.#streams.size >= MAX_STREAMS) {
      refuse(`the relay already has ${String(MAX_STREAMS)} streams open`);
      return undefined;
    }
    const token = newToken();
    const stream = new Stream(
      token,
      hello.host,
      (message) => {
        send(socket, message);
      },
      this.#log
    );
    this.#streams.set(token, stream);
    send(socket, { type: "ready", token, join: this.joinCommand(token), piVersion: VERSION });
    this.#log(`${hello.host} opened a stream with pi ${hello.piVersion} (${String(this.#streams.size)} open)`);
    return stream;
  }

  #onGuest(client: Connection): void {
    let token = "";
    client.on("authentication", (auth) => {
      // The user name is the stream's token; there is nothing else to check.
      token = auth.username;
      auth.accept();
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        let size: { columns: number; rows: number } | undefined;
        let viewer: Viewer | undefined;
        // ssh2 passes no accept when the client wants no reply (always, for
        // window-change), though its types say it always does.
        session.on("pty", (accept: (() => void) | undefined, _reject, info) => {
          size = { columns: info.cols, rows: info.rows };
          accept?.();
        });
        session.on("window-change", (accept: (() => void) | undefined, _reject, info) => {
          viewer?.resize(info.cols, info.rows);
          accept?.();
        });
        session.on("shell", (accept) => {
          viewer = this.#watch(token, accept(), size);
        });
        session.on("exec", (accept) => {
          refuseGuest(accept(), "pi-live only shows the stream. Run the ssh command without anything after it.");
        });
      });
    });
    client.on("error", (err) => {
      this.#log(`guest connection error: ${err.message}`);
    });
  }

  #watch(token: string, channel: ServerChannel, size: { columns: number; rows: number } | undefined): Viewer | undefined {
    const stream = this.#streams.get(token);
    if (size === undefined) {
      refuseGuest(channel, "pi-live needs a terminal. Run the ssh command without -T.");
      return undefined;
    }
    if (stream === undefined) {
      refuseGuest(channel, "This pi-live link has ended, or the address is wrong. Ask the host for a new one.");
      return undefined;
    }
    if (stream.guests.length >= MAX_GUESTS) {
      refuseGuest(channel, `This stream already has ${String(MAX_GUESTS)} guests.`);
      return undefined;
    }
    this.#guestCount += 1;
    const viewer = new Viewer({ channel, columns: size.columns, rows: size.rows, stream, number: this.#guestCount });
    channel.on("close", () => {
      viewer.dispose();
    });
    return viewer;
  }
}
