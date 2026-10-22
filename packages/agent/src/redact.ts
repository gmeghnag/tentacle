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

/** A transform that redacts secrets from a tool result's content. */
export function redactSecrets(
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
): ResultTransform {
  return (result) => {
    const content = redactText(result.content, rules);
    return content === result.content ? result : { ...result, content };
  };
}
