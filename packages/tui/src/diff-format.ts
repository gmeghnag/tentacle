/**
 * Parse a unified-diff patch into typed lines so the `<Diff>` component can
 * colour them (green additions, red deletions, dim context/hunk headers).
 * Pure and framework-free.
 */
export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
    } else if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("Index:") ||
      line.startsWith("===")
    ) {
      out.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line });
    } else {
      out.push({ kind: "context", text: line });
    }
  }
  // Trim trailing blank context lines produced by the trailing newline.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last && last.kind === "context" && last.text === "") {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}
