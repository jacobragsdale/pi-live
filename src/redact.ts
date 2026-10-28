/**
 * Masks secrets that commonly turn up in agent sessions: tokens, keys,
 * passwords in connection strings and URLs. Copied from pi-config. It is a
 * safety net, not a guarantee: anything it misses reaches every guest.
 */

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Builds the replacement from the match groups. Defaults to a plain marker. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

const marker = (name: string): string => `[REDACTED:${name}]`;

const RULES: readonly Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "bearer", pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, replace: (_m, word = "Bearer") => `${word} ${marker("bearer")}` },
  { name: "url-password", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, replace: (_m, prefix = "") => `${prefix}:${marker("url-password")}@` },
  { name: "connection-string", pattern: /\b(AccountKey|SharedAccessKey|Password|Pwd)=[^;\s"']+/gi, replace: (_m, key = "") => `${key}=${marker("connection-string")}` },
  {
    name: "assignment",
    pattern: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi,
    replace: (_m, key = "", separator = "=") => `${key}${separator}${marker("assignment")}`
  }
];

export interface Redacted {
  readonly text: string;
  readonly count: number;
}

function applyRule(text: string, rule: Rule): Redacted {
  let count = 0;
  const result = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
    // Already masked by an earlier rule.
    if (match.includes("[REDACTED:")) {
      return match;
    }
    count += 1;
    const groups = rest.filter((value): value is string => typeof value === "string");
    return rule.replace === undefined ? marker(rule.name) : rule.replace(match, ...groups);
  });
  return { text: result, count };
}

export function redact(text: string): Redacted {
  return RULES.reduce<Redacted>(
    (acc, rule) => {
      const next = applyRule(acc.text, rule);
      return { text: next.text, count: acc.count + next.count };
    },
    { text, count: 0 }
  );
}
