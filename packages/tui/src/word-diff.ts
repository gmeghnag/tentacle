/**
 * Word-level diffing of two strings, for highlighting exactly which words
 * changed between a removed line and its paired added line (Claude-Code-style).
 *
 * A classic token LCS: the text is split into tokens (word runs, whitespace
 * runs, single punctuation), the longest common subsequence of tokens is kept
 * as `same`, and the rest is marked `remove`/`add`. Pure and framework-free.
 */

export type WordKind = "same" | "add" | "remove";

export interface WordOp {
  readonly value: string;
  readonly kind: WordKind;
}

// Word runs, whitespace runs, and otherwise single characters — this keeps
// identifiers and spacing intact while still diffing punctuation finely.
const TOKEN_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

/** Split text into diff tokens. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** Compute the word-level diff from `before` to `after`. */
export function diffWords(before: string, after: string): WordOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const m = a.length;
  const n = b.length;

  // LCS length table, flattened to one array: dp[i*(n+1)+j].
  const stride = n + 1;
  const dp = new Array<number>((m + 1) * stride).fill(0);
  const at = (i: number, j: number): number => dp[i * stride + j] ?? 0;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * stride + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: WordOp[] = [];
  const push = (kind: WordKind, value: string): void => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) {
      ops[ops.length - 1] = { kind, value: last.value + value };
    } else {
      ops.push({ kind, value });
    }
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      push("same", ai);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push("remove", ai);
      i++;
    } else {
      push("add", bj);
      j++;
    }
  }
  while (i < m) {
    push("remove", a[i] ?? "");
    i++;
  }
  while (j < n) {
    push("add", b[j] ?? "");
    j++;
  }
  return ops;
}

/** Fraction (0–1) of the two strings' characters that changed. */
export function changeRatio(ops: readonly WordOp[]): number {
  // Denominator is both lines' lengths combined, so an unchanged span counts
  // once per side (matching the "how much of the two lines differs" intuition).
  let total = 0;
  let changed = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      total += op.value.length * 2;
    } else {
      total += op.value.length;
      changed += op.value.length;
    }
  }
  return total === 0 ? 0 : changed / total;
}
