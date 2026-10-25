/**
 * Compact numbers for the status line and timers. Pure.
 *
 * Owner rule (2026-10-25): past 1000 a token count reads `1.2k`, never a long
 * number; past 60 seconds a duration reads `1m 50s`.
 */

function compact(n: number, unit: number, suffix: string): string {
  const v = n / unit;
  // One decimal while it stays under 10 once rounded (9.96k is "10k", not "10.0k").
  // A whole value drops its ".0": 1000 → "1k".
  const one = v.toFixed(1);
  if (Number(one) < 10) {
    return `${one.endsWith(".0") ? one.slice(0, -2) : one}${suffix}`;
  }
  return `${Math.round(v)}${suffix}`;
}

/** 999 → "999", 1000 → "1k", 1234 → "1.2k", 54000 → "54k", 1234567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  // 999,600 would round to "1000k": switch to M once k rounds to 1000.
  if (Math.round(n / 1000) < 1000) {
    return compact(n, 1000, "k");
  }
  return compact(n, 1_000_000, "M");
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
