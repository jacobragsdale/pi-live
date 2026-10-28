/**
 * pi's theme, as initTheme() set it up for pi's own components, so the
 * relay's own lines use the same colors as the transcript around them.
 */
import { Theme } from "@earendil-works/pi-coding-agent";

/** Where pi keeps its theme; pi's components read it from here too. */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export function piTheme(): Theme {
  const value: unknown = Reflect.get(globalThis, THEME_KEY);
  if (!(value instanceof Theme)) {
    throw new Error("pi's theme isn't set up: call initTheme() first");
  }
  return value;
}
