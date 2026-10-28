import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cwdLabel, usageTotals } from "../extensions/live/footer.ts";
import { formatTokens } from "../relay/footer.ts";

const at = "2026-10-27T12:00:00.000Z";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }
});

function reply(id: string, spent: Usage): SessionEntry {
  const message: AssistantMessage = { role: "assistant", content: [], api: "test", provider: "test", model: "m", usage: spent, stopReason: "stop", timestamp: 1 };
  return { type: "message", id, parentId: null, timestamp: at, message };
}

await test("usage adds up every reply, and the cache hit rate is the latest reply's", () => {
  const entries = [reply("a", usage(1000, 100, 0, 500, 0.01)), reply("b", usage(200, 50, 1500, 0, 0.002))];
  assert.deepEqual(usageTotals(entries), { input: 1200, output: 150, cacheRead: 1500, cacheWrite: 500, cost: 0.012, cacheHitRate: (1500 / 1700) * 100 });
});

await test("usage outside replies counts too", () => {
  const warm: SessionEntry = { type: "usage", id: "w", parentId: null, timestamp: at, kind: "cache_warm", provider: "test", model: "m", usage: usage(0, 0, 900, 0, 0.001) };
  assert.equal(usageTotals([warm]).cacheRead, 900);
  assert.equal(usageTotals([warm]).cacheHitRate, undefined);
});

await test("the directory is shown with ~ for home, as pi shows it", () => {
  assert.equal(cwdLabel("/home/jacob", "/home/jacob"), "~");
  assert.equal(cwdLabel("/home/jacob/dev/shop", "/home/jacob"), "~/dev/shop");
  assert.equal(cwdLabel("/srv/shop", "/home/jacob"), "/srv/shop");
  assert.equal(cwdLabel("/home/jacobs-old", "/home/jacob"), "/home/jacobs-old");
});

await test("token counts are compact, as pi shows them", () => {
  assert.deepEqual([940, 2800, 97_000, 1_000_000, 12_000_000].map(formatTokens), ["940", "2.8k", "97k", "1.0M", "12M"]);
});
