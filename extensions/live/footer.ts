/**
 * The facts pi's footer shows, gathered on the host so guests' footers match
 * it. pi's FooterComponent reads the live session, which the relay doesn't
 * have; this follows its rules: usage summed over every entry of the session,
 * the cache hit rate of the latest reply, and ~ for the home directory.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Meta } from "../../src/protocol.ts";

const SettingsSchema = Type.Object({ compaction: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) })) });

type Totals = Meta["usage"];

const add = (totals: Totals, usage: Usage | undefined): Totals =>
  usage === undefined
    ? totals
    : {
        ...totals,
        input: totals.input + usage.input,
        output: totals.output + usage.output,
        cacheRead: totals.cacheRead + usage.cacheRead,
        cacheWrite: totals.cacheWrite + usage.cacheWrite,
        cost: totals.cost + usage.cost.total
      };

/** Usage over the whole session, abandoned branches included, as pi's footer counts it. */
export function usageTotals(entries: readonly SessionEntry[]): Totals {
  let totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;
  for (const entry of entries) {
    if (entry.type === "usage") {
      totals = add(totals, entry.usage);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const { usage } = entry.message;
      totals = add(totals, usage);
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      totals = add(totals, entry.message.usage);
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      totals = add(totals, entry.usage);
    }
  }
  return cacheHitRate === undefined ? totals : { ...totals, cacheHitRate };
}

/** The working directory as pi's footer shows it. */
export function cwdLabel(cwd: string, home: string): string {
  const inHome = relative(resolve(home), resolve(cwd));
  if (inHome === "") {
    return "~";
  }
  return inHome === ".." || inHome.startsWith(`..${sep}`) || isAbsolute(inHome) ? cwd : `~${sep}${inHome}`;
}

function compactionEnabled(path: string): boolean | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Check(SettingsSchema, settings) ? settings.compaction?.enabled : undefined;
  } catch {
    return undefined;
  }
}

/** Whether auto-compaction is on: project settings win over global ones, and it is on unless turned off. */
function autoCompact(cwd: string): boolean {
  return compactionEnabled(join(cwd, ".pi", "settings.json")) ?? compactionEnabled(join(getAgentDir(), "settings.json")) ?? true;
}

/** The current git branch, or undefined outside a repository. */
export function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2_000 }, (err, stdout) => {
      const branch = stdout.trim();
      done(err === null && branch !== "" ? branch : undefined);
    });
  });
}

export function footerMeta(ctx: ExtensionContext, thinking: string, branch: string | undefined): Meta {
  const { model } = ctx;
  const usage = ctx.getContextUsage();
  const providers = new Set(ctx.modelRegistry.getAvailable().map((available) => available.provider));
  const sessionName = ctx.sessionManager.getSessionName();
  return {
    cwd: ctx.cwd,
    cwdLabel: cwdLabel(ctx.cwd, homedir()),
    ...(branch === undefined ? {} : { gitBranch: branch }),
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(model === undefined ? {} : { model: { provider: model.provider, id: model.id, reasoning: model.reasoning } }),
    showProvider: providers.size > 1,
    thinking,
    usage: usageTotals(ctx.sessionManager.getEntries()),
    ...(usage === undefined ? {} : { context: { percent: usage.percent, contextWindow: usage.contextWindow } }),
    autoCompact: autoCompact(ctx.cwd)
  };
}
