import { describe, expect, test } from "bun:test";
import type { ToolResultSpill } from "@tentacle/core";
import { spillView } from "../src/spill-view.ts";

// docs/feat/tui-spill-note.md: the short note a spilled result shows instead
// of the model's banner. UI strings are the owner's, verbatim (TODO.md).
const PATH = ".tentacle/tool-output/fs_read-c1.txt";
const spill: ToolResultSpill = {
  chars: 40_800,
  path: PATH,
  head: "first\nsecond",
  tail: "last\n",
  omitted: 39_600,
};
const local = { expanded: false, inPod: false };

describe("spillView", () => {
  test("the note, with a path", () => {
    expect(spillView(spill, local).note).toBe(
      "40.8k chars · too large, the model reads it in parts",
    );
  });

  test("the note without a path says it could not be saved — never a path, never a where line", () => {
    const { path: _p, ...noPath } = spill;
    for (const o of [local, { expanded: true, inPod: false }, { expanded: true, inPod: true }]) {
      const view = spillView(noPath, o);
      expect(view.note).toBe(
        "40.8k chars · too large, could not be saved — the model sees only this preview",
      );
      expect(view.where).toBeUndefined();
    }
  });

  test("the path is shown only in ctrl+o: saved to <path> locally, saved in the pod to <path> in a pod", () => {
    // Mutation (red, verified): emit `where` regardless of `expanded` → fails.
    expect(spillView(spill, local).where).toBeUndefined();
    expect(spillView(spill, { expanded: false, inPod: true }).where).toBeUndefined();
    expect(spillView(spill, { expanded: true, inPod: false }).where).toBe(`saved to ${PATH}`);
    expect(spillView(spill, { expanded: true, inPod: true }).where).toBe(
      `saved in the pod to ${PATH}`,
    );
  });

  test("a pod-supplied path is one display line: control and bidi characters never reach the row", () => {
    // Built, not literal: a raw bidi override in source is itself a hazard.
    const path = `a\nb${String.fromCharCode(0x202e)}c\u0007d`;
    const view = spillView({ ...spill, path }, { expanded: true, inPod: true });
    // `oneLine`: a control character becomes a space, a bidi override is dropped.
    expect(view.where).toBe("saved in the pod to a bc d");
  });

  test("the omitted line; none when nothing was omitted", () => {
    expect(spillView(spill, local).omitted).toBe("… 39.6k chars omitted …");
    const whole = spillView({ chars: 150, path: PATH, head: "all", tail: "", omitted: 0 }, local);
    expect(whole.omitted).toBeUndefined();
    expect(whole.tail).toBe("");
    expect(whole.head).toBe("all");
  });

  test("head and tail are the data, cleaned like a read (CRLF, CR, NUL) and without trailing newlines", () => {
    const view = spillView({ ...spill, head: "a\r\nb\rc\0", tail: "x\r\ny\n\n" }, local);
    expect(view.head).toBe("a\nbc");
    expect(view.tail).toBe("x\ny");
  });
});
