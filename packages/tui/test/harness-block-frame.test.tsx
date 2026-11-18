/**
 * S2's end-to-end half (feat/harness-notices.md): what a person SEES. Frames of
 * the real `App` via ink-testing-library (the `app.test.tsx` pattern), or the
 * real `transcriptLines` for the row structure.
 *
 * RED before the fix: three harness lines drew `●` in two different colours with
 * a blank row between each.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import { transcriptLines } from "../src/render-lines.ts";
import { type DisplayState, appendNotice, pushNoticeItem } from "../src/state.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const sessionOf = (events: readonly AgentEvent[]) => () => ({
  ...inertSession(),
  async *send(): AsyncGenerator<AgentEvent> {
    for (const event of events) {
      yield event;
    }
  },
});

describe("a reply plus three harness lines render as ONE block", () => {
  test("no blank rows between them, one glyph, no `●` on a harness line", async () => {
    const app = render(
      <App
        createSession={sessionOf([
          { type: "text", delta: "the answer" },
          // Three harness facts in a row: two info, then a warn.
          { type: "dsml_leak", text: "re-asked the model" },
          { type: "history_repaired", invalidArguments: 1, unansweredCalls: 0, orphanResults: 0 },
          { type: "empty_turn" },
          { type: "turn_end", reason: "end_turn" },
        ])}
        model="qwen3"
        cwd="/tmp/work"
        // 200 columns keeps the ready line short; the harness lines still wrap only if
        // they are long, so "no blank row" is what this reads, not the wrap.
        // not the wrap (a wrapped continuation row starts at column 0).
        columns={200}
      />,
    );
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(200);
      const rows = strip(app.lastFrame() ?? "")
        .split("\n")
        .map((r) => r.trimEnd());
      const reply = rows.findIndex((r) => r.includes("the answer"));
      expect(reply).toBeGreaterThanOrEqual(0);
      const tail = rows.slice(reply + 1);
      const glyphAt = (glyph: string): number => tail.findIndex((r) => r.startsWith(`${glyph} `));
      const info = glyphAt("◇");
      const warnAt = glyphAt("▲");
      // ONE blank row between the reply and the block, and none inside it.
      expect(tail[0]).toBe("");
      expect(info).toBe(1);
      expect(warnAt).toBeGreaterThan(info);
      // GROUPED: every row from the info glyph to the warn glyph belongs to the
      // block — no blank row inside it (mutation: keep transcriptLines'
      // unconditional blank row → `tail` has "" between the two notices).
      const between = tail.slice(info, warnAt);
      expect(between).not.toContain("");
      expect(between[0]?.startsWith("◇ re-asked the model")).toBe(true);
      // The second fact hangs two spaces under the first (no second glyph), and
      // the glyph re-appears only at the LEVEL CHANGE.
      expect(tail[info + 1]?.startsWith("  ")).toBe(true);
      expect(tail.filter((r) => r.startsWith("◇ "))).toHaveLength(1);
      expect(tail.filter((r) => r.startsWith("▲ "))).toHaveLength(1);
      // The model's `●` never appears on a harness row.
      expect(tail.slice(info).join("\n")).not.toContain("●");
    } finally {
      app.unmount();
    }
  });
});

describe("the transcript's own rows (no App)", () => {
  test("the doubled reply-cut notice is gone: a re-ask that cuts again is ONE line", () => {
    // The repro's two lines, now one (docs/feat/harness-notices.md S2.6).
    let s = {
      items: [{ kind: "assistant", text: "Ho aggiornato il test." }],
    } as unknown as DisplayState;
    s = appendNotice(
      s,
      "the reply was cut — asked it to continue, cut again; this answer is incomplete",
    );
    s = pushNoticeItem(s, "_Compacting the conversation…_");
    const rows = transcriptLines(s.items, { expandAll: false, width: 100 }).map(strip);
    // reply, blank, the merged notice, then the harness line joined under it.
    expect(rows[1]).toBe("");
    expect(rows.filter((r) => r === "")).toHaveLength(1);
    expect(rows[2]?.startsWith("◇ ")).toBe(true);
    expect(rows[3]?.startsWith("  Compacting")).toBe(true);
  });
});
