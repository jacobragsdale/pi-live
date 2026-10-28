import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { catchUp, toEntry } from "../extensions/live/transcript.ts";

const at = "2026-10-27T12:00:00.000Z";

function message(id: string, parentId: string | null, role: "user" | "system", text: string): SessionEntry {
  return { type: "message", id, parentId, timestamp: at, message: { role, content: text, timestamp: 1 } };
}

const custom = (id: string, display: boolean): SessionEntry => ({ type: "custom_message", id, parentId: null, timestamp: at, customType: "note", content: "hidden context", display });

const branch = [message("a", null, "user", "one"), message("b", "a", "user", "two")];

await test("toEntry leaves out the system prompt and hidden custom messages", () => {
  assert.deepEqual(toEntry(message("s", null, "system", "You are pi.")).messages, []);
  assert.deepEqual(toEntry(custom("h", false)).messages, []);
  assert.equal(toEntry(custom("v", true)).messages.length, 1);
});

await test("new entries at the end are appended", () => {
  const change = catchUp(["a"], branch);
  assert.equal(change?.type, "append");
  assert.deepEqual(
    change.entries.map((e) => e.id),
    ["b"]
  );
});

await test("nothing new means nothing to send", () => {
  assert.equal(catchUp(["a", "b"], branch), undefined);
});

await test("a different branch resends everything, even when it is empty", () => {
  const change = catchUp(["a", "x"], branch);
  assert.equal(change?.type, "reset");
  assert.deepEqual(
    change.entries.map((e) => e.id),
    ["a", "b"]
  );
  assert.deepEqual(catchUp(["a"], []), { type: "reset", entries: [] });
});
