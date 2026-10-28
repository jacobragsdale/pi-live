/**
 * Prepares pi's messages before they leave the host's machine: masks likely
 * secrets in every string, drops provider signatures guests have no use for,
 * and replaces images with a placeholder so screenshots never reach the relay.
 */
import { redact } from "./redact.ts";

/** Opaque provider blobs: large, meaningless to guests, and not worth scanning. */
const DROPPED_KEYS = new Set(["textSignature", "thinkingSignature", "thoughtSignature", "signature"]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

export function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return redact(value).text;
  }
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (!isObject(value)) {
    return value;
  }
  if (value["type"] === "image") {
    return { type: "text", text: "[image not shared]" };
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DROPPED_KEYS.has(key)) {
      copy[key] = scrub(item);
    }
  }
  return copy;
}
