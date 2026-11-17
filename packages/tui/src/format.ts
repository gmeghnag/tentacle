/**
 * Compact numbers for the status line and timers. Pure.
 *
 * Owner rule (2026-10-25): past 1000 a token count reads `1.2k`, never a long
 * number; past 60 seconds a duration reads `1m 50s`.
 */

/** Moved to core (docs/feat/harness-notices.md S1: the compaction separator shares it with mobile). */
export { formatTokens } from "@tentacle/core";

/**
 * A character count, one decimal (owner, docs/feat/tui-spill-note.md Q3):
 * 999 → "999", 16000 → "16k", 40800 → "40.8k", 1234567 → "1.2M".
 */
export function formatChars(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const k = (n / 1000).toFixed(1);
  // 999,960 would read "1000k": switch to M once k rounds to 1000.
  const [value, suffix] = Number(k) < 1000 ? [k, "k"] : [(n / 1_000_000).toFixed(1), "M"];
  return `${value.endsWith(".0") ? value.slice(0, -2) : value}${suffix}`;
}

/** Whole seconds: 59 → "59s", 110 → "1m 50s", 3900 → "1h 5m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Milliseconds, tenths kept under a minute: 1234 → "1.2s", 110400 → "1m 50s". */
export function formatDurationMs(ms: number): string {
  const tenths = (Math.max(0, ms) / 1000).toFixed(1);
  return Number(tenths) < 60 ? `${tenths}s` : formatDuration(Math.round(ms / 1000));
}
