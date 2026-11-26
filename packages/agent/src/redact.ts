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
}

/** High-signal secret patterns. Each `pattern` is global (and case-insensitive
 * where appropriate); `replacement` may reference capture groups. */
export const DEFAULT_REDACT_RULES: readonly RedactRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED: private key]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED: jwt]",
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

/**
 * Where `text` looks like it holds a secret, by the same rules redaction uses:
 * the rule's name and the 1-based line, in reading order, at most `max` — NEVER
 * the matched value (it goes into a prompt that travels to phones;
 * docs/feat/session-apps-publish.md D5). Pure.
 */
export function findSecrets(
  text: string,
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
  max = 20,
): SecretFinding[] {
  const hits: { rule: string; at: number }[] = [];
  for (const rule of rules) {
    // `matchAll` works on a copy of the rule's global pattern (no shared
    // `lastIndex`) and is lazy: one rule contributes at most `max` hits.
    let found = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (found >= max) break;
      found += 1;
      hits.push({ rule: rule.name, at: match.index });
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
