/**
 * End to end: a real pi in RPC mode with the extension and the scripted
 * provider, a relay in this process, and guests over real SSH connections.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Guest, eventually, startRelay } from "./live.ts";
import type { TestRelay } from "./live.ts";
import { PiRpc, field, isRecord, makeAgentDir, repo, scriptedProvider } from "./pi-rpc.ts";
import type { RpcRecord } from "./pi-rpc.ts";

const extension = join(repo, "extensions/live/index.ts");
const secret = `ghp_${"Zx9Q".repeat(9)}`;

let relay: TestRelay;
const open: { close(): void }[] = [];
const running: PiRpc[] = [];

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  for (const peer of open.splice(0)) {
    peer.close();
  }
  await Promise.all(running.splice(0).map((pi) => pi.close()));
  await relay.relay.close();
});

function startPi(env: Readonly<Record<string, string>> = {}): PiRpc {
  const pi = new PiRpc({ agentDir: makeAgentDir(), extensions: [extension, scriptedProvider], env: { PI_LIVE_URL: `ws://127.0.0.1:${String(relay.http)}/host`, PI_LIVE_NAME: "tester", ...env } });
  running.push(pi);
  return pi;
}

const isUi = (method: string) => (record: RpcRecord) => record["type"] === "extension_ui_request" && record["method"] === method;

/** Start a stream and return the token from the join command pi printed. */
async function goLive(pi: PiRpc): Promise<string> {
  const from = pi.records.length;
  await pi.prompt("/live");
  const notice = pi.notices(from).find((text) => text.startsWith("Live."));
  const token = /ssh -p \d+ ([a-z2-7]{24})@127\.0\.0\.1/.exec(notice ?? "")?.[1];
  assert.ok(token !== undefined, `no join command in ${JSON.stringify(pi.notices(from))}`);
  return token;
}

async function join_(pi: PiRpc, token: string, name: string): Promise<Guest> {
  const guest = await Guest.connect(relay.ssh, token);
  open.push(guest);
  await guest.sees("Type your name");
  guest.type(`${name}\r`);
  await eventually(
    () => (pi.lastStatus("live").includes(name) ? true : undefined),
    () => `status never named ${name}: ${pi.lastStatus("live")}`
  );
  return guest;
}

function lastWidget(pi: PiRpc): readonly unknown[] | undefined {
  const widget = pi.records.filter((r) => isUi("setWidget")(r) && r["widgetKey"] === "live").at(-1);
  const lines = widget?.["widgetLines"];
  return Array.isArray(lines) ? lines : undefined;
}

await test("/live streams the session to an ssh guest, and /live again ends it", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  assert.match(pi.lastStatus("live"), /● live.* · nobody watching yet/);
  const bob = await join_(pi, token, "bob");
  await bob.sees("watching tester's pi session");

  await pi.prompt("Fix the login bug");
  await bob.sees("Fix the login bug");
  await bob.sees("ok");

  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).includes("Stream ended. Its link no longer works."));
  assert.equal(pi.lastStatus("live"), "");
  await bob.sees("tester ended the stream.");
  await bob.waitForEnd();
});

await test("a guest who joins later sees the conversation so far", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  await pi.prompt("What does the cache do?");
  const carol = await join_(pi, token, "carol");
  await carol.sees("What does the cache do?");
  await carol.sees("ok");
});

await test("a suggestion waits above the editor until the host uses or dismisses it", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");

  bob.type("add a test for expiry\r");
  await eventually(
    () => (lastWidget(pi)?.some((line) => typeof line === "string" && line.includes("bob") && line.includes("add a test for expiry")) === true ? true : undefined),
    () => `no suggestion widget: ${JSON.stringify(lastWidget(pi))}`
  );
  let from = pi.records.length;
  await pi.prompt("/live use");
  const edit = await pi.waitFor(isUi("set_editor_text"), from);
  assert.equal(field(edit, "text"), "add a test for expiry");
  assert.equal(lastWidget(pi), undefined);
  await bob.sees('✓ tester took your suggestion: "add a test for expiry"');

  bob.type("rewrite it in rust\r");
  await eventually(
    () => (lastWidget(pi) === undefined ? undefined : true),
    () => "no widget for the second suggestion"
  );
  from = pi.records.length;
  await pi.prompt("/live dismiss");
  assert.equal(
    pi.records.slice(from).some((r) => isUi("set_editor_text")(r)),
    false
  );
  await bob.sees('tester dismissed your suggestion: "rewrite it in rust"');
});

await test("guests see tool calls, and secrets are masked before they leave pi", async () => {
  const pi = startPi({ SCRIPTED_TOOL_TURNS: "1" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  await pi.prompt(`Deploy with token ${secret}`);
  await bob.sees("$ true");
  await bob.sees("Deploy with token [REDACTED:github-token]");
  assert.ok(!bob.received.includes(secret));
});

await test("guests see a reply stream in as the model writes it", async () => {
  const pi = startPi({ SCRIPTED_STREAM_MS: "250" });
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  const from = pi.records.length;
  const done = pi.prompt("Tell me something");
  await bob.sees("Streaming this reply");
  assert.ok(!bob.screen.includes("does."), "the guest saw the reply only once it was finished");
  assert.ok(!pi.records.slice(from).some((r) => r["type"] === "agent_settled"), "the reply finished before the guest saw any of it");
  await done;
  await bob.sees("Streaming this reply in pieces, like a real provider does.");
});

await test("guests see the host's ! commands and their output", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  pi.send({ id: "bash", type: "bash", command: "echo build-is-green" });
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "bash");
  await bob.sees("$ echo build-is-green");
  await bob.sees(/build-is-green[\s\S]*build-is-green/);
});

await test("the stream follows the host into a new session", async () => {
  const pi = startPi();
  const token = await goLive(pi);
  const bob = await join_(pi, token, "bob");
  await pi.prompt("first session");
  await bob.sees("first session");
  pi.send({ id: "new", type: "new_session" });
  await pi.waitFor((r) => r["type"] === "response" && r["id"] === "new");
  await pi.prompt("second session");
  await bob.sees("second session");
  assert.match(pi.lastStatus("live"), /bob/);
});

await test("/live says how to set up a relay when none is configured", async () => {
  const pi = startPi({ PI_LIVE_URL: "" });
  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).some((text) => text.startsWith("No relay is set up.")));
});

await test("/live reports a relay it can't reach", async () => {
  const pi = startPi({ PI_LIVE_URL: "ws://127.0.0.1:9/host" });
  const from = pi.records.length;
  await pi.prompt("/live");
  assert.ok(pi.notices(from).some((text) => text.startsWith("Couldn't reach the relay at ws://127.0.0.1:9/host")));
  assert.equal(pi.lastStatus("live"), "");
});

async function commandNames(pi: PiRpc): Promise<string[]> {
  pi.send({ id: "commands", type: "get_commands" });
  const response = await pi.waitFor((r) => r["type"] === "response" && r["id"] === "commands");
  const data = response["data"];
  const commands: unknown[] = isRecord(data) && Array.isArray(data["commands"]) ? data["commands"] : [];
  return commands.flatMap((c) => (isRecord(c) ? [field(c, "name")] : []));
}

await test("PI_LIVE=0 turns the extension off", async () => {
  assert.ok((await commandNames(startPi())).includes("live"));
  assert.ok(!(await commandNames(startPi({ PI_LIVE: "0" }))).includes("live"));
});
