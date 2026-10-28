/**
 * Turns the host's session branch into the entries guests see, and works out
 * what to send so guests catch up with the branch.
 */
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Entry } from "../../src/protocol.ts";
import { scrub } from "../../src/scrub.ts";

/** The messages guests see for one entry: what pi itself shows, minus the system prompt and hidden custom messages. */
export function toEntry(entry: SessionEntry): Entry {
  const shown = sessionEntryToContextMessages(entry).filter((message) => message.role !== "system" && !(message.role === "custom" && !message.display));
  return { id: entry.id, messages: shown.map(scrub) };
}

export interface Change {
  readonly type: "append" | "reset";
  readonly entries: Entry[];
}

/**
 * What to send, given the ids of the entries guests already have, in order.
 * New entries at the end are appended; any other difference (a /tree jump, a
 * new session) resends the whole branch. Returns undefined when nothing changed.
 */
export function catchUp(sent: readonly string[], branch: readonly SessionEntry[]): Change | undefined {
  const extends_ = sent.length <= branch.length && sent.every((id, index) => branch[index]?.id === id);
  if (!extends_) {
    return { type: "reset", entries: branch.map(toEntry).filter((entry) => entry.messages.length > 0) };
  }
  const added = branch
    .slice(sent.length)
    .map(toEntry)
    .filter((entry) => entry.messages.length > 0);
  return added.length === 0 ? undefined : { type: "append", entries: added };
}
