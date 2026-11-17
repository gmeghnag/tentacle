/**
 * docs/feat/model-artifacts.md S6a — the TUI CARD (T6a's first half), pure.
 *
 * Under a `present` tool row the transcript shows ONE card row instead of the
 * generic tool body (chosen variant A: two lines total, the header plus this
 * row): `▣ <title>  <line2> · ^X^O open`. The view-model is `@tentacle/core`'s
 * `artifactCard`; this pins what `render-lines.ts` maps it to, the width fit at
 * 80 and 120, and the states that change the tail (`other` is save-only,
 * `unavailable` says so, `pod` is marked).
 *
 * Also pins the RESUME join: a reloaded transcript has no `details` (they are
 * not in `ChatMessage`), so `messagesToItems` takes the daemon's list and
 * attaches each version's meta to the tool row its `callId` names.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import stringWidth from "string-width";
import { artifactsByCall, withArtifactDetails } from "../src/artifacts-panel.ts";
import { itemLines } from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";
import type { ToolItem } from "../src/state.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "latency-p99",
    version: 1,
    sha256: "a".repeat(64),
    size: 240_000,
    mimeType: "image/png",
    kind: "image",
    title: "latency-p99.png",
    callId: "c1",
    createdAt: 1_000,
    width: 1280,
    height: 720,
    ...over,
  };
}

function presentRow(m: ArtifactMeta, over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: m.callId,
    name: "present",
    args: JSON.stringify({ path: "charts/latency-p99.png" }),
    status: "ok",
    resultText: "Presented to the user.",
    detail: { kind: "artifact", artifact: m },
    ...over,
  };
}

const opts = (width: number, inPod = false) =>
  ({ expandAll: false, width, ...(inPod ? { spillInPod: true } : {}) }) as const;

/** The card is the LAST row of the block (the header is the first). */
const cardRow = (tool: ToolItem, width: number, inPod = false): string => {
  const lines = itemLines(tool, opts(width, inPod)).map(strip);
  return lines.at(-1) ?? "";
};

describe("S6a: a `present` row shows the card, not a generic tool body", () => {
  test("two lines total: the header, then `▣ <title>  <meta> · ^X^O open`", () => {
    const lines = itemLines(presentRow(meta()), opts(120)).map(strip);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Present");
    expect(lines[1]).toContain("▣");
    expect(lines[1]).toContain("latency-p99.png");
    expect(lines[1]).toContain("PNG · 1280×720 · 240 KB");
    expect(lines[1]).toContain("^X^O open");
    // The tool's own text is NOT repeated under the card.
    expect(lines.join("\n")).not.toContain("Presented to the user.");
  });

  test("the card fits the width at 80 and 120 (no row overflows)", () => {
    for (const width of [80, 120]) {
      const rows = itemLines(presentRow(meta()), opts(width)).map(strip);
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
      // …and it really is a card at both widths (non-vacuity of the scan).
      expect(cardRow(presentRow(meta()), width)).toContain("▣");
    }
  });

  test("a long title loses the tail, never the name", () => {
    const long = meta({ title: "a-very-long-artifact-title-that-would-eat-the-whole-row.png" });
    const row = cardRow(presentRow(long), 80);
    expect(row).toContain("▣");
    expect(row).toContain("a-very-long-artifact-title");
    expect(row).not.toContain("^X^O open");
  });

  test("a version past the first says `v2`", () => {
    expect(cardRow(presentRow(meta({ version: 2 })), 120)).toContain("v2");
  });

  test("kind `other` offers save, never open (nothing executes)", () => {
    const zip = meta({
      artifactId: "build",
      title: "build-artifacts.zip",
      kind: "other",
      mimeType: "application/zip",
      size: 3_400_000,
    });
    const row = cardRow(presentRow(zip), 120);
    expect(row).toContain("ZIP · 3.4 MB");
    expect(row).toContain("save to ~/Downloads");
    expect(row).not.toContain("open");
  });

  test("an artifact whose kind cannot be opened offers no open hint", () => {
    // `unavailable` (evicted/unreadable) is reached by the OPEN path — a read
    // refused with `evicted` establishes it (S6b) — so a card drawn from a LIST
    // never invents it. What THIS slice owns is the tail: `other` offers save,
    // and no action offers nothing at all.
    const zip = meta({ kind: "other", mimeType: "application/zip", size: 3_400_000 });
    expect(cardRow(presentRow(zip), 120)).not.toContain("^X^O open");
    expect(cardRow(presentRow(zip), 120)).toContain("save to ~/Downloads");
  });

  test("a pod origin is marked, so nobody mistakes it for a local file", () => {
    // The origin is the RUNTIME's fact (`RenderOptions.spillInPod` is the one
    // 'this daemon runs in a pod' the renderer already receives), never a
    // per-item field: a pod-supplied meta cannot claim to be a local file.
    expect(cardRow(presentRow(meta()), 120, true)).toContain("from the pod");
    expect(cardRow(presentRow(meta()), 120)).not.toContain("from the pod");
  });

  test("a `present` row with no artifact detail falls back to its text", () => {
    const bare = presentRow(meta(), { detail: undefined, resultText: "Presented to the user." });
    expect(itemLines(bare, opts(120)).map(strip).join("\n")).toContain("Presented to the user.");
  });
});

describe("S6a: a resumed transcript joins its cards from the daemon's list", () => {
  const HISTORY: readonly ChatMessage[] = [
    { role: "user", content: "show me" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "present", arguments: '{"path":"charts/x.png"}' }],
    },
    { role: "tool", content: "Presented.", toolCallId: "c1" },
  ] as unknown as readonly ChatMessage[];

  const toolOf = (items: readonly { kind: string }[]): ToolItem =>
    items.find((i) => i.kind === "tool") as ToolItem;

  test("the meta whose `callId` matches lands on that tool row as its detail", () => {
    const m = meta();
    const items = messagesToItems(HISTORY, new Map([["c1", m]]));
    expect(toolOf(items).detail).toEqual({ kind: "artifact", artifact: m });
  });

  test("a call the list does not name keeps its plain row (never a guessed card)", () => {
    const items = messagesToItems(HISTORY, new Map([["c9", meta({ callId: "c9" })]]));
    expect(toolOf(items).detail).toBeUndefined();
  });

  test("no list at all is exactly today's transcript", () => {
    const withNone = messagesToItems(HISTORY);
    expect(withNone).toEqual(messagesToItems(HISTORY, new Map()));
    expect(toolOf(withNone).detail).toBeUndefined();
  });

  test("`artifactsByCall` keeps the NEWEST version of a re-presented call", () => {
    const v1 = meta({ version: 1, sha256: "a".repeat(64) });
    const v2 = meta({ version: 2, sha256: "b".repeat(64) });
    const byCall = artifactsByCall([v1, v2]);
    expect(byCall.get("c1")?.version).toBe(2);
    // Order on the wire does not matter (the daemon sends oldest first, and a
    // hostile order must not resurrect an old version as the card).
    expect(artifactsByCall([v2, v1]).get("c1")?.version).toBe(2);
    expect(toolOf(messagesToItems(HISTORY, byCall)).detail).toMatchObject({
      artifact: { version: 2 },
    });
  });

  test("a row that already carries a detail is left alone (the live answer wins)", () => {
    const live = presentRow(meta({ version: 9 }));
    const items = withArtifactDetails([live], new Map([["c1", meta({ version: 1 })]]));
    expect(items[0]).toBe(live);
    // Nothing joined → the SAME array, so a no-op cannot re-render the transcript.
    const plain: ToolItem = { ...presentRow(meta()), detail: undefined };
    expect(withArtifactDetails([plain], new Map([["zzz", meta()]]))).toEqual([plain]);
  });
});
