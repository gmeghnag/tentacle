/**
 * The upload window, in isolation (docs/feat/attachments-upload.md T4).
 *
 * The property: at most `UPLOAD_WINDOW` chunks are out at once, a lower `have`
 * rewinds the cursor, and a daemon that lies (past the end, early `complete`,
 * `have: 0` forever) trips a violation instead of making the laptop send more.
 */
import { describe, expect, test } from "bun:test";
import {
  UPLOAD_MAX_SENT_FACTOR,
  UPLOAD_WINDOW,
  UploadProtocolError,
  UploadWindow,
} from "../src/upload-window.ts";

const CHUNK = 8;

/** Drive the window to exhaustion against a daemon that acks honestly. */
function drive(
  w: UploadWindow,
  answer: (offset: number, length: number) => { have: number; complete: boolean },
): void {
  for (let i = 0; i < 200; i++) {
    const step = w.next();
    if (step.kind === "done") return;
    if (step.kind === "wait") throw new Error("a wait with nothing in flight");
    w.ack(step.offset, answer(step.offset, step.length));
  }
  // A BOUNDED loop: a window with no send cap would otherwise spin forever,
  // and a hang is not a red test.
  throw new Error(`never finished: sent ${w.sent} bytes`);
}

describe("in-order acks", () => {
  test("offsets 0, 8, 16, … then `done`; each chunk is `chunk` long", () => {
    const w = new UploadWindow(20, { chunk: CHUNK, window: 1 });
    const sent: number[] = [];
    for (;;) {
      const step = w.next();
      if (step.kind === "done") break;
      if (step.kind === "wait") throw new Error("window 1 must never wait");
      sent.push(step.offset);
      expect(step.length).toBe(Math.min(CHUNK, 20 - step.offset));
      w.ack(step.offset, {
        have: step.offset + step.length,
        complete: step.offset + step.length === 20,
      });
    }
    expect(sent).toEqual([0, 8, 16]);
    expect(w.have).toBe(20);
  });

  test("the default window is 2 and never more than 2 are outstanding", () => {
    expect(UPLOAD_WINDOW).toBe(2);
    const size = 10 * CHUNK;
    const w = new UploadWindow(size, { chunk: CHUNK });
    // What this test has sent and not yet acked, in order.
    const out: { offset: number; length: number }[] = [];
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      peak = Math.max(peak, w.outstanding);
      const step = w.next();
      if (step.kind === "done") break;
      if (step.kind === "wait") {
        // Either the window is full, or every chunk is out and only acks remain.
        expect(w.outstanding).toBeGreaterThan(0);
        // Ack the oldest in flight, honestly.
        const next = out.shift();
        if (next === undefined) throw new Error("a wait with nothing in flight");
        w.ack(next.offset, {
          have: next.offset + next.length,
          complete: next.offset + next.length === size,
        });
        continue;
      }
      out.push({ offset: step.offset, length: step.length });
    }
    expect(w.have).toBe(size);
    expect(peak).toBe(UPLOAD_WINDOW);
  });
});

describe("a lower `have` rewinds", () => {
  test("a gap ack moves the cursor back to `have`", () => {
    const w = new UploadWindow(4 * CHUNK, { chunk: CHUNK, window: 2 });
    const a = w.next();
    const b = w.next();
    if (a.kind !== "send" || b.kind !== "send") throw new Error("expected two sends");
    expect([a.offset, b.offset]).toEqual([0, CHUNK]);
    // The daemon holds nothing (it restarted): chunk 1's ack rewinds to 0, even
    // though chunk 2 is still in flight.
    w.ack(0, { have: 0, complete: false });
    const c = w.next();
    if (c.kind !== "send") throw new Error("expected a send");
    expect(c.offset).toBe(0);
    // Chunk 2's own ack is a gap too (the daemon holds 0): still 0.
    w.ack(CHUNK, { have: 0, complete: false });
    const d = w.next();
    if (d.kind !== "send") throw new Error("expected a send");
    expect(d.offset).toBe(0);
  });

  test("`rewind` after a probe adopts the daemon's `have`", () => {
    const w = new UploadWindow(4 * CHUNK, { chunk: CHUNK, window: 2 });
    w.rewind(2 * CHUNK);
    expect(w.have).toBe(2 * CHUNK);
    const step = w.next();
    if (step.kind !== "send") throw new Error("expected a send");
    expect(step.offset).toBe(2 * CHUNK);
  });
});

describe("violations (a hostile or broken daemon)", () => {
  const bad = (have: number, complete = false): unknown => {
    const w = new UploadWindow(2 * CHUNK, { chunk: CHUNK, window: 1 });
    const step = w.next();
    if (step.kind !== "send") throw new Error("expected a send");
    return w.ack(step.offset, { have, complete });
  };

  test("`have` past the blob throws", () => {
    expect(() => bad(2 * CHUNK + 1)).toThrow(UploadProtocolError);
  });

  test("a negative or fractional `have` throws", () => {
    expect(() => bad(-1)).toThrow(UploadProtocolError);
    expect(() => bad(1.5)).toThrow(UploadProtocolError);
  });

  test("`complete` before the whole blob throws", () => {
    expect(() => bad(CHUNK, true)).toThrow(UploadProtocolError);
  });

  test("`have === size` without `complete` on the last chunk throws", () => {
    const w = new UploadWindow(CHUNK, { chunk: CHUNK, window: 1 });
    const step = w.next();
    if (step.kind !== "send") throw new Error("expected a send");
    expect(() => w.ack(step.offset, { have: CHUNK, complete: false })).toThrow(UploadProtocolError);
  });

  test("`have: 0` forever is bounded: it throws instead of sending forever", () => {
    const w = new UploadWindow(4 * CHUNK, { chunk: CHUNK, window: 1 });
    let sends = 0;
    expect(() => {
      // A bounded loop: the BOUND is what must stop this, not a test timeout.
      for (let i = 0; i < 200; i++) {
        const step = w.next();
        if (step.kind === "wait") continue;
        if (step.kind === "done") break;
        sends += 1;
        w.ack(step.offset, { have: 0, complete: false });
      }
      throw new Error(`never bounded: sent ${sends} chunks`);
    }).toThrow(UploadProtocolError);
    // Never more than the bound, whatever the daemon says.
    expect(sends).toBeLessThanOrEqual(UPLOAD_MAX_SENT_FACTOR * 4 + 1);
  });

  test("the send bound holds in bytes", () => {
    const size = 4 * CHUNK;
    const w = new UploadWindow(size, { chunk: CHUNK, window: 1 });
    expect(() => drive(w, () => ({ have: 0, complete: false }))).toThrow(UploadProtocolError);
    expect(w.sent).toBeLessThanOrEqual(UPLOAD_MAX_SENT_FACTOR * size + CHUNK);
  });
});

describe("the node is done as soon as the blob is", () => {
  test("a `complete` on an early chunk stops issuing", () => {
    const w = new UploadWindow(2 * CHUNK, { chunk: CHUNK, window: 2 });
    const step = w.next();
    if (step.kind !== "send") throw new Error("expected a send");
    w.ack(step.offset, { have: 2 * CHUNK, complete: true });
    expect(w.next()).toEqual({ kind: "done" });
  });

  test("`finish` (the probe said complete) leaves nothing to send", () => {
    const w = new UploadWindow(2 * CHUNK, { chunk: CHUNK, window: 2 });
    w.finish();
    expect(w.next()).toEqual({ kind: "done" });
    expect(w.have).toBe(2 * CHUNK);
  });
});
