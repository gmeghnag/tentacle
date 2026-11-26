/**
 * Secret redaction — a result transform that masks credentials in tool output
 * before it enters the conversation (and, since it runs before the spill
 * transform, before anything is written to disk either).
 *
 * This is defence-in-depth, not a guarantee: patterns catch common, high-signal
 * secret shapes (keys, tokens, private-key blocks, URL credentials, obvious
 * `KEY=value` assignments). It errs toward masking. Opt-in: `tools.redactSecrets`
 * in the config enables it (off by default).
 */
import type { SecretFinding } from "@tentacle/core";
import type { ResultTransform } from "./result-pipeline.ts";

export interface RedactRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  /**
   * Where `pattern` matches, for `findSecrets`, in time LINEAR in the text: set
   * on a rule whose pattern backtracks quadratically on a crafted run. It must
   * yield what `matchAll(pattern)` would, in order.
   */
  readonly starts?: (text: string) => Iterable<number>;
}

// The linear scans. `findSecrets` runs synchronously on a page the model wrote,
// before anyone is asked (docs/feat/session-apps-publish.md fix round 1).

function* privateKeyStarts(text: string): Iterable<number> {
  const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
  const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
  for (let open = begin.exec(text); open; open = begin.exec(text)) {
    end.lastIndex = begin.lastIndex;
    // No END after this header: there is none after a later one either.
    if (!end.exec(text)) return;
    yield open.index;
    begin.lastIndex = end.lastIndex;
  }
}

function* jwtStarts(text: string): Iterable<number> {
  // Each first segment is taken once, from its own start; the other two are
  // checked in place after its dot.
  const first = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}(?=\.)/g;
  const rest = /\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/y;
  let from = 0;
  for (const segment of text.matchAll(first)) {
    // The earliest header leaves the longest tail: if it is short, all are.
    const header = /\beyJ/.exec(segment[0]);
    if (!header || segment[0].length - header.index < "eyJ".length + 8) continue;
    const at = segment.index + header.index;
    if (at < from) continue;
    rest.lastIndex = segment.index + segment[0].length;
    if (!rest.test(text)) continue;
    from = rest.lastIndex;
    yield at;
  }
}

function* urlCredentialStarts(text: string): Iterable<number> {
  // From each "://": neither it nor user/password can span a ":" or "/", so no
  // two candidates — nor their walks back over the scheme — share a stretch.
  for (const match of text.matchAll(/:\/\/[^\s:@/]+:[^\s:@/]+@/g)) {
    let start = -1;
    for (let i = match.index - 1; i >= 0 && /[A-Za-z0-9+.-]/.test(text.charAt(i)); i--) {
      // The leftmost letter on a word boundary begins the scheme.
      if (/[A-Za-z]/.test(text.charAt(i)) && !/\w/.test(text.charAt(i - 1))) start = i;
    }
    if (start >= 0) yield start;
  }
}

/** High-signal secret patterns. Each `pattern` is global (and case-insensitive
 * where appropriate); `replacement` may reference capture groups. */
export const DEFAULT_REDACT_RULES: readonly RedactRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED: private key]",
    starts: privateKeyStarts,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED: jwt]",
    starts: jwtStarts,
  },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED]" },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED]" },
  {
    name: "openai-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    name: "bearer",
    pattern: /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi,
    replacement: "$1[REDACTED]@",
    starts: urlCredentialStarts,
  },
  {
    name: "assignment",
    pattern:
      /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi,
    replacement: "$1$2[REDACTED]",
  },
];

/** Apply every rule to `text`. Pure. */
export function redactText(
  text: string,
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

function* patternStarts(text: string, pattern: RegExp): Iterable<number> {
  // `matchAll` works on a copy of the global pattern (no shared `lastIndex`).
  for (const match of text.matchAll(pattern)) yield match.index;
}

/**
 * Where `text` looks like it holds a secret, by the same rules redaction uses:
 * the rule's name and the 1-based line, in reading order, at most `max` — NEVER
 * the matched value (it goes into a prompt that travels to phones;
 * docs/feat/session-apps-publish.md D5). Linear in `text` for the default rules.
 * Pure.
 */
export function findSecrets(
  text: string,
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
  max = 20,
): SecretFinding[] {
  const hits: { rule: string; at: number }[] = [];
  for (const rule of rules) {
    // Both scans are lazy: one rule contributes at most `max` hits.
    let found = 0;
    for (const at of rule.starts?.(text) ?? patternStarts(text, rule.pattern)) {
      if (found >= max) break;
      found += 1;
      hits.push({ rule: rule.name, at });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  let line = 1;
  let scanned = 0;
  return hits.slice(0, max).map(({ rule, at }) => {
    for (let i = text.indexOf("\n", scanned); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) {
      line += 1;
      scanned = i + 1;
    }
    return { rule, line };
  });
}

/** A transform that redacts secrets from a tool result's content. */
export function redactSecrets(
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
): ResultTransform {
  return (result) => {
    const content = redactText(result.content, rules);
    return content === result.content ? result : { ...result, content };
  };
}
