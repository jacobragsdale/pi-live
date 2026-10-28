import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeHost, Guest, assistant, eventually, meta, startRelay, user } from "./live.ts";
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
  await joined.sees("Type your name");
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
  fake.send(
    meta({
      gitBranch: "main",
      model: { provider: "github-copilot", id: "claude-haiku-5.5", reasoning: true },
      showProvider: true,
      thinking: "xhigh",
      usage: { input: 2800, output: 40, cacheRead: 97_000, cacheWrite: 75, cost: 0.0123, cacheHitRate: 97.3 },
      context: { percent: 12.5, contextWindow: 84_000 }
    })
  );
  fake.send({ type: "reset", entries: [{ id: "a", messages: [user("Fix the login bug")] }] });
  const alice = await guest(token);
  await alice.sees("Fix the login bug");
  await alice.sees("~/dev/shop (main)");
  await alice.sees(/↑2\.8k ↓40 R97k W75 CH97\.3% \$0\.012 12\.5%\/84k \(auto\) +\(github-copilot\) claude-haiku-5\.5 • xhigh/);
  await alice.sees("● live · jacob's session · 1 watching");

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
  fake.send(meta({ cwd: "/repo", cwdLabel: "/repo" }));
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
  assert.match(refusal.message, /protocol 2 and your pi-live speaks 99/);
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
  await joined.sees("Type your name");
  joined.type("\r");
  const guests = await fake.waitFor((m) => m.type === "guests" && m.names.length === 1, "one guest");
  assert.equal(guests.type, "guests");
  assert.match(guests.names[0] ?? "", /^guest-\d+$/);
});

await test("guests see pi's working indicator while the host's agent runs", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: [] });
  const alice = await guest(token);
  fake.send({ type: "activity", working: true });
  await alice.sees("Working");
  fake.send({ type: "activity", working: false });
  await eventually(
    () => (alice.screen.includes("Working") ? undefined : true),
    () => `the indicator stayed:\n${alice.screen}`
  );
});

await test("a guest scrolls the transcript with PgUp, the mouse wheel, and ctrl+end", async () => {
  const { host: fake, token } = await host();
  fake.send({ type: "reset", entries: Array.from({ length: 60 }, (_, i) => ({ id: `e${String(i)}`, messages: [user(`message number ${String(i)}`, i)] })) });
  const alice = await guest(token);
  await alice.sees("message number 59");
  assert.ok(!alice.screen.includes("message number 30"));
  alice.type("\x1b[5~\x1b[5~"); // PgUp twice
  await alice.sees(/message number [2-4]\d\b/);
  assert.ok(!alice.screen.includes("message number 59"));
  alice.type("\x1b[1;5F"); // ctrl+end
  await alice.sees("message number 59");
  alice.type("\x1b[<64;10;10M".repeat(10)); // mouse wheel up
  await eventually(
    () => (alice.screen.includes("message number 59") ? undefined : true),
    () => `the wheel didn't scroll:\n${alice.screen}`
  );
});
