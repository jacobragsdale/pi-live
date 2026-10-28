import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../src/redact.ts";

const ghToken = `ghp_${"a1B2".repeat(9)}`;

const cases: readonly (readonly [string, string, string])[] = [
  ["GitHub token", `token is ${ghToken} ok`, "token is [REDACTED:github-token] ok"],
  ["Anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "key [REDACTED:api-key]"],
  ["AWS access key", "AKIAABCDEFGHIJKLMNOP", "[REDACTED:aws-key]"],
  ["bearer header", "Authorization: Bearer abc.def-ghi_jkl.mnopqrstu", "Authorization: Bearer [REDACTED:bearer]"],
  ["URL password", "postgres://app:hunter2secret@db.contoso.com/app", "postgres://app:[REDACTED:url-password]@db.contoso.com/app"],
  ["connection string", "Server=db;User Id=app;Password=hunter2;", "Server=db;User Id=app;Password=[REDACTED:connection-string];"],
  ["storage key", "AccountName=x;AccountKey=abc123+/==;", "AccountName=x;AccountKey=[REDACTED:connection-string];"],
  ["env assignment", "export DB_PASSWORD='correct-horse-battery'", "export DB_PASSWORD='[REDACTED:assignment]'"],
  ["JSON field", '"apiKey": "0123456789abcdef"', '"apiKey": "[REDACTED:assignment]"'],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "[REDACTED:private-key]"]
];

for (const [name, input, expected] of cases) {
  await test(`redacts a ${name}`, () => {
    assert.equal(redact(input).text, expected);
  });
}

await test("counts each secret once, even when two rules match it", () => {
  const result = redact(`GITHUB_TOKEN=${ghToken}`);
  assert.equal(result.text, "GITHUB_TOKEN=[REDACTED:github-token]");
  assert.equal(result.count, 1);
});

await test("leaves ordinary text alone", () => {
  const text = "Refactor the token parser; the password field is optional. See https://contoso.com/docs.";
  assert.deepEqual(redact(text), { text, count: 0 });
});
