/**
 * The `present` tool ROW, pure (docs/feat/tui-present-row.md, which replaced
 * docs/feat/model-artifacts.md S6a's `▣ <title> … ^X^O open` card).
 *
 * `● Present <title>` (never the raw JSON args: they carry the whole HTML), and
 * under it ONE grey row `<id> · <type> · <size>[ · vN][ · from the pod]` — the
 * segment after the id is `@tentacle/core`'s `artifactCard().line2`. A row with
 * no card shows no body (the result text is the model's receipt). Pins the
 * width fit and the states that change the row (`vN`, `pod`).
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

/** The result row is the LAST row of the block (the header is the first). */
const cardRow = (tool: ToolItem, width: number, inPod = false): string => {
  const lines = itemLines(tool, opts(width, inPod)).map(strip);
  return lines.at(-1) ?? "";
};

/** A generated-content `present` (the case the owner hit): title + a whole HTML page. */
const HTML_ARGS = JSON.stringify({
  title: "Latency report",
  content: `<!DOCTYPE html><html><body><h1>p99</h1>${"x".repeat(400)}</body></html>`,
});
const HTML = meta({
  artifactId: "a3",
  kind: "html",
  mimeType: "text/html",
  size: 593,
  title: "Latency report",
  width: undefined,
  height: undefined,
});
const RECEIPT =
  'Presented "Latency report" to the user as artifact a3 v1 (html, 593 B). They open it from the card in the transcript.';

describe("tui-present-row: `● Present <title>`, then one short grey row", () => {
  test("the header names the title, never the JSON args or the HTML content", () => {
    const lines = itemLines(presentRow(HTML, { args: HTML_ARGS }), opts(80)).map(strip);
    expect(lines[0]).toBe("● Present Latency report");
    expect(lines.join("\n")).not.toContain("{");
    expect(lines.join("\n")).not.toContain("DOCTYPE");
  });

  test("two lines total: the header, then `<id> · <type> · <size>` (no glyph, no title again)", () => {
    const lines = itemLines(presentRow(HTML, { args: HTML_ARGS, resultText: RECEIPT }), opts(80));
    expect(lines.map(strip)).toEqual(["● Present Latency report", "⎿ a3 · HTML page · 593 B"]);
    // The model's receipt is NOT repeated under it.
    expect(lines.map(strip).join("\n")).not.toContain("Presented");
  });

  test("a path artifact (an image) carries its own type facts", () => {
    const args = JSON.stringify({ title: "p99", path: "charts/latency-p99.png" });
    expect(cardRow(presentRow(meta(), { args }), 120)).toBe(
      "⎿ latency-p99 · PNG · 1280×720 · 240 KB",
    );
  });

  test("a missing title falls back to the id, then the card's id, then the path — never JSON", () => {
    const head = (args: string, m = meta()): string =>
      strip(itemLines(presentRow(m, { args }), opts(120))[0] ?? "");
    expect(head(JSON.stringify({ id: "report", path: "r.pdf" }))).toBe("● Present report");
    expect(head(JSON.stringify({ path: "r.pdf" }))).toBe("● Present latency-p99");
    expect(head(JSON.stringify({ path: "r.pdf" }), meta())).not.toContain("{");
    const noCard = presentRow(meta(), {
      args: JSON.stringify({ path: "r.pdf" }),
      detail: undefined,
    });
    expect(strip(itemLines(noCard, opts(120))[0] ?? "")).toBe("● Present r.pdf");
    // Streaming args (not JSON yet): an empty subtitle, not the raw fragment.
    const partial = presentRow(meta(), { args: '{"title":"Lat', detail: undefined });
    expect(strip(itemLines(partial, opts(120))[0] ?? "")).not.toContain("{");
  });

  test("a long title is cut to the width with `…` (no row overflows)", () => {
    const title = "A very long artifact title that would otherwise eat the whole row and wrap";
    const args = JSON.stringify({ title, content: "<p>x</p>" });
    for (const width of [40, 80]) {
      const rows = itemLines(presentRow(HTML, { args }), opts(width)).map(strip);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
      expect(rows[0]).toStartWith("● Present A very long");
      expect(rows[0]).toEndWith("…");
    }
  });

  test("a version past the first says `v2`", () => {
    expect(cardRow(presentRow(meta({ version: 2 })), 120)).toContain("v2");
  });

  test("kind `other` shows its type and size (a click only says how to save it)", () => {
    const zip = meta({
      artifactId: "build",
      title: "build-artifacts.zip",
      kind: "other",
      mimeType: "application/zip",
      size: 3_400_000,
    });
    expect(cardRow(presentRow(zip), 120)).toBe("⎿ build · ZIP · 3.4 MB");
  });

  test("a pod origin is marked, so nobody mistakes it for a local file", () => {
    // The origin is the RUNTIME's fact (`RenderOptions.spillInPod` is the one
    // 'this daemon runs in a pod' the renderer already receives), never a
    // per-item field: a pod-supplied meta cannot claim to be a local file.
    expect(cardRow(presentRow(meta()), 120, true)).toContain("from the pod");
    expect(cardRow(presentRow(meta()), 120)).not.toContain("from the pod");
  });

  test("a `present` row with no card shows NO body (the receipt is the model's)", () => {
    const bare = presentRow(HTML, { args: HTML_ARGS, detail: undefined, resultText: RECEIPT });
    expect(itemLines(bare, opts(120)).map(strip)).toEqual(["● Present Latency report"]);
  });

  test("a FAILED `present` still shows its error", () => {
    const failed = presentRow(HTML, {
      args: HTML_ARGS,
      detail: undefined,
      status: "error",
      resultText: "give exactly one of `path` or `content`.",
    });
    expect(itemLines(failed, opts(120)).map(strip).join("\n")).toContain("give exactly one");
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
