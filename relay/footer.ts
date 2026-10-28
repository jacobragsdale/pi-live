/**
 * A guest's footer, drawn the way pi draws its own from the facts the host
 * sends: directory and branch, token use and cost, context, model. Its last
 * line, where pi shows extension statuses, says whose stream this is.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Meta } from "../src/protocol.ts";
import { piTheme } from "./theme.ts";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const thinkingLevel = (level: string): ThinkingLevel => LEVELS.find((known) => known === level) ?? "off";

/** pi's compact token counts: 940, 2.8k, 97k, 1.0M. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${String(Math.round(count / 1000))}k`;
  }
  return count < 10_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : `${String(Math.round(count / 1_000_000))}M`;
}

function stats(meta: Meta): string {
  const { usage } = meta;
  const parts: string[] = [];
  const counts: [string, number][] = [
    ["↑", usage.input],
    ["↓", usage.output],
    ["R", usage.cacheRead],
    ["W", usage.cacheWrite]
  ];
  for (const [label, count] of counts) {
    if (count > 0) {
      parts.push(`${label}${formatTokens(count)}`);
    }
  }
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined) {
    parts.push(`CH${usage.cacheHitRate.toFixed(1)}%`);
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(3)}`);
  }
  parts.push(contextLabel(meta));
  return parts.join(" ");
}

/** Context use, amber above 70% and red above 90%, as pi colors it. */
function contextLabel(meta: Meta): string {
  const theme = piTheme();
  const percent = meta.context?.percent ?? null;
  const shown = `${percent === null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(meta.context?.contextWindow ?? 0)}${meta.autoCompact ? " (auto)" : ""}`;
  if (percent !== null && percent > 90) {
    return theme.fg("error", shown);
  }
  return percent !== null && percent > 70 ? theme.fg("warning", shown) : shown;
}

function modelLabel(meta: Meta): { readonly short: string; readonly full: string } {
  const { model } = meta;
  if (model === undefined) {
    return { short: "no-model", full: "no-model" };
  }
  const level = meta.thinking === "" ? "off" : meta.thinking;
  const short = model.reasoning ? `${model.id} • ${level === "off" ? "thinking off" : level}` : model.id;
  return { short, full: meta.showProvider ? `(${model.provider}) ${short}` : short };
}

export class GuestFooter implements Component {
  readonly #state: () => { readonly meta: Meta; readonly host: string; readonly watching: number };

  constructor(state: () => { readonly meta: Meta; readonly host: string; readonly watching: number }) {
    this.#state = state;
  }

  public invalidate(): void {
    // Rendered from the stream's state on every frame.
  }

  public render(width: number): string[] {
    const theme = piTheme();
    const { meta, host, watching } = this.#state();
    const branch = meta.gitBranch === undefined ? "" : ` (${meta.gitBranch})`;
    const name = meta.sessionName === undefined ? "" : ` • ${meta.sessionName}`;
    const pwd = truncateToWidth(theme.fg("dim", `${meta.cwdLabel}${branch}${name}`), width, theme.fg("dim", "..."));

    let left = stats(meta);
    if (visibleWidth(left) > width) {
      left = truncateToWidth(left, width, "...");
    }
    const labels = modelLabel(meta);
    const leftWidth = visibleWidth(left);
    const right = leftWidth + 2 + visibleWidth(labels.full) <= width ? labels.full : truncateToWidth(labels.short, Math.max(0, width - leftWidth - 2), "");
    const gap = " ".repeat(Math.max(width - leftWidth - visibleWidth(right), right === "" ? 0 : 2));
    const statsLine = theme.fg("dim", left) + theme.fg("dim", `${gap}${right}`);

    const status = `${theme.fg("success", "● live")} ${theme.fg("dim", `· ${host}'s session · ${String(watching)} watching · ctrl+o tools · ctrl+c leave`)}`;
    return [pwd, statsLine, truncateToWidth(status, width, theme.fg("dim", "..."))];
  }
}
