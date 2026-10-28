import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeHost, Guest, assistant, eventually, startRelay, user } from "./live.ts";
import type { TestRelay } from "./live.ts";

let relay: TestRelay;
const open: { close(): void }[] = [];

beforeEach(async () => {
  relay = await startRelay();
});

afterEach(async () => {
  for (const peer of open.splice(0)) {
    peer.close();
  }
  await relay.relay.close();
});

async function host(name = "jacob"): Promise<{ host: FakeHost; token: string; join: string }> {
  const fake = new FakeHost(relay.http);
  open.push(fake);
  const ready = await fake.hello(name);
  return { host: fake, token: ready.token, join: ready.join };
}

async function guest(token: string, name = "alice"): Promise<Guest> {
  const joined = await Guest.connect(relay.ssh, token);
  open.push(joined);
  await joined.sees("Your name:");
  joined.type(`${name}\r`);
  await joined.sees("1 watching");
  return joined;
}

await test("a host gets a join command with an unguessable token", async () => {
  const { token, join } = await host();
  assert.match(token, /^[a-z2-7]{24}$/);
  assert.equal(join, `ssh -p ${String(relay.ssh)} ${token}@127.0.0.1`);
});

await test("a guest sees the transcript, the streamed reply, and who is hosting", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "meta", cwd: "/home/jacob/dev/shop", model: "github-copilot/claude-haiku-5.5", thinking: "xhigh" });
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("Fix the login bug")] }] });
  const alice = await guest(token);
  await alice.sees("Fix the login bug");
  await alice.sees("jacob's pi · ~/dev/shop · github-copilot/claude-haiku-5.5 (xhigh)");

  fake.send({ type: "tail", message: assistant([{ type: "text", text: "Looking at the session code" }], 5) });
  await alice.sees("Looking at the session code");
  fake.send({ type: "append", entries: [{ id: "b", messages: [assistant([{ type: "text", text: "Found it: the cookie expires early." }], 5)] }] });
  fake.send({ type: "tail", message: null });
  await alice.sees("Found it: the cookie expires early.");
});

await test("the host learns who is watching, and a guest's suggestion round-trips", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  await fake.waitFor((m) => m.type === "guests" && m.names.join() === "alice", "guests [alice]");

  alice.type("run the migration tests\r");
  const suggestion = await fake.waitFor((m) => m.type === "suggestion", "suggestion");
  assert.equal(suggestion.type, "suggestion");
  assert.equal(suggestion.from, "alice");
  assert.equal(suggestion.text, "run the migration tests");
  await alice.sees("It waits above their editor");

  fake.send({ type: "suggestion_status", id: suggestion.id, status: "used" });
  await alice.sees('✓ jacob took your suggestion: "run the migration tests"');
});

await test("a guest can have only three suggestions waiting", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  for (const text of ["one", "two", "three", "four"]) {
    alice.type(`${text}\r`);
  }
  await alice.sees("You have 3 suggestions waiting");
  await eventually(
    () => (fake.received.filter((m) => m.type === "suggestion").length === 3 ? true : undefined),
    () => "three suggestions"
  );
});

await test("a tool call shows its command, its live output, and its result", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "meta", cwd: "/repo", model: "m", thinking: "off" });
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "append", entries: [{ id: "a", messages: [assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }], 3, "toolUse")] }] });
  await alice.sees("$ npm test");
  fake.send({ type: "tool", phase: "start", id: "call-1" });
  fake.send({ type: "tool", phase: "update", id: "call-1", result: { content: [{ type: "text", text: "running 12 tests" }] } });
  await alice.sees("running 12 tests");
  fake.send({ type: "tool", phase: "end", id: "call-1", result: { content: [{ type: "text", text: "12 passed" }] }, isError: false, durationMs: 1200 });
  fake.send({
    type: "append",
    entries: [{ id: "b", messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "12 passed" }], isError: false, timestamp: 4 }] }]
  });
  await alice.sees("12 passed");
});

await test("a guest who joins mid-run catches up on the streamed reply", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("Explain the cache")] }] });
  fake.send({ type: "tail", message: assistant([{ type: "text", text: "The cache keeps rendered pages" }], 7) });
  const bob = await guest(token, "bob");
  await bob.sees("Explain the cache");
  await bob.sees("The cache keeps rendered pages");
});

await test("messages the relay can't draw are dropped, and the stream carries on", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "append", entries: [{ id: "x", messages: [{ role: "assistant", content: "not an array" }, { role: "nonsense" }] }] });
  fake.send({ type: "nonsense" });
  fake.send({ type: "append", entries: [{ id: "y", messages: [user("still streaming")] }] });
  await alice.sees("still streaming");
  assert.ok(relay.logs.some((line) => line.startsWith("ignored a malformed message")));
});

await test("when the host leaves, guests are told and disconnected", async () => {
  const { host: fake, token } = await host("sam");
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.close();
  await alice.sees("sam ended the stream.");
  await alice.waitForEnd();
  const late = await Guest.connect(relay.ssh, token);
  open.push(late);
  await late.sees("This pi-live link has ended");
  await late.waitForEnd();
});

await test("a guest can leave with ctrl+c", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  alice.type("\x03");
  await alice.sees("You left the stream.");
  await alice.waitForEnd();
  await fake.waitFor((m) => m.type === "guests" && m.names.length === 0, "no guests");
});

await test("a host on another protocol version is refused", async () => {
  const fake = new FakeHost(relay.http);
  open.push(fake);
  await fake.open();
  fake.send({ type: "hello", protocol: 99, piVersion: "9.9.9", host: "future" });
  const refusal = await fake.waitFor((m) => m.type === "error", "error");
  assert.equal(refusal.type, "error");
  assert.match(refusal.message, /protocol 1 and your pi-live speaks 99/);
  await eventually(
    () => (fake.closed ? true : undefined),
    () => "socket closed"
  );
});

await test("an empty name becomes guest-N", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const joined = await Guest.connect(relay.ssh, token);
  open.push(joined);
  await joined.sees("Your name:");
  joined.type("\r");
  const guests = await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  assert.equal(guests.type, "guests");
  assert.match(guests.names[0] ?? "", /^guest-\d+$/);
});
