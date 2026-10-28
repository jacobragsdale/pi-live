import assert from "node:assert/strict";
import { test } from "node:test";
import { scrub } from "../src/scrub.ts";

const secret = `ghp_${"a1B2".repeat(9)}`;

await test("masks secrets in every string, however deep", () => {
  const message = { role: "toolResult", content: [{ type: "text", text: `GITHUB_TOKEN=${secret}` }], details: { nested: [`token ${secret}`] } };
  assert.deepEqual(scrub(message), { role: "toolResult", content: [{ type: "text", text: "GITHUB_TOKEN=[REDACTED:github-token]" }], details: { nested: ["token [REDACTED:github-token]"] } });
});

await test("replaces images and drops provider signatures", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm", thinkingSignature: "opaque" },
      { type: "text", text: "done", textSignature: "opaque" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }
    ]
  };
  assert.deepEqual(scrub(message), {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "done" },
      { type: "text", text: "[image not shared]" }
    ]
  });
});

await test("leaves numbers, booleans and null alone", () => {
  assert.deepEqual(scrub({ a: 1, b: true, c: null }), { a: 1, b: true, c: null });
});
