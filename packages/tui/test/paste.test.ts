import { describe, expect, test } from "bun:test";
import { stepPaste, stripPasteMarkers } from "../src/paste.ts";

describe("bracketed paste", () => {
  test("captures a whole paste in one chunk (ESC + markers stripped)", () => {
    const step = stepPaste(null, "\u001b[200~hello world\u001b[201~");
    expect(step.consumed).toBe(true);
    expect(step.text).toBe("hello world");
    expect(step.buffer).toBeNull();
  });

  test("accumulates a paste split across chunks", () => {
    const a = stepPaste(null, "\u001b[200~hel");
    expect(a.consumed).toBe(true);
    expect(a.text).toBeUndefined();
    expect(a.buffer).toBe("hel");
    const b = stepPaste(a.buffer, "lo\u001b[201~");
    expect(b.consumed).toBe(true);
    expect(b.text).toBe("hello");
    expect(b.buffer).toBeNull();
  });

  test("handles markers delivered as separate events", () => {
    const a = stepPaste(null, "[200~");
    expect(a).toMatchObject({ consumed: true, buffer: "" });
    const b = stepPaste(a.buffer, "pasted");
    expect(b).toMatchObject({ consumed: true, buffer: "pasted" });
    const c = stepPaste(b.buffer, "[201~");
    expect(c.text).toBe("pasted");
  });

  test("ignores ordinary input and mouse reports", () => {
    expect(stepPaste(null, "abc").consumed).toBe(false);
    expect(stepPaste(null, "\u001b[<64;10;5M").consumed).toBe(false);
    expect(stepPaste(null, "\r").consumed).toBe(false);
  });

  test("stripPasteMarkers removes stray markers", () => {
    expect(stripPasteMarkers("[200~hi[201~")).toBe("hi");
    expect(stripPasteMarkers("plain")).toBe("plain");
  });

  test("abandons a paste whose closing marker never arrives (size cap)", () => {
    // Start a paste, then keep feeding chunks without ever sending `[201~`.
    const maxBuffer = 16;
    let step = stepPaste(null, "[200~", maxBuffer);
    expect(step).toMatchObject({ consumed: true, buffer: "" });
    // Under the cap: still buffering, no flush yet.
    step = stepPaste(step.buffer, "0123456789", maxBuffer);
    expect(step.consumed).toBe(true);
    expect(step.text).toBeUndefined();
    expect(step.buffer).toBe("0123456789");
    // Crossing the cap: flush what we captured and reset, so input unfreezes.
    step = stepPaste(step.buffer, "abcdefgh", maxBuffer);
    expect(step.buffer).toBeNull();
    expect(step.text).toBe("0123456789abcdefgh");
    // And the machine is back to idle: ordinary input is no longer consumed.
    expect(stepPaste(step.buffer, "x", maxBuffer).consumed).toBe(false);
  });
});
