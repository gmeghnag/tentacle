import { describe, expect, test } from "bun:test";
import { CHANNEL_STDIN, ExecDemux, encodeStdin } from "../src/exec-frame.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a raw exec message: one channel byte + payload. */
function msg(channel: number, text: string): Uint8Array {
  const body = enc.encode(text);
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

describe("encodeStdin", () => {
  test("prefixes the stdin channel byte and appends a newline", () => {
    const bytes = encodeStdin('{"x":1}');
    expect(bytes[0]).toBe(CHANNEL_STDIN);
    expect(dec.decode(bytes.subarray(1))).toBe('{"x":1}\n');
  });
});

describe("ExecDemux", () => {
  test("reassembles stdout frames split across messages", () => {
    const frames: string[] = [];
    const demux = new ExecDemux({ onFrame: (f) => frames.push(f) });

    demux.push(msg(1, '{"a":'));
    expect(frames).toEqual([]); // nothing complete yet
    demux.push(msg(1, '1}\n{"b":2}\n'));
    expect(frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("routes stderr (2) and error (3), ignores unknown + empty", () => {
    const frames: string[] = [];
    const stderrs: string[] = [];
    const errors: string[] = [];
    const demux = new ExecDemux({
      onFrame: (f) => frames.push(f),
      onStderr: (s) => stderrs.push(s),
      onError: (s) => errors.push(s),
    });

    demux.push(msg(2, "a warning"));
    demux.push(msg(3, '{"status":"Success"}'));
    demux.push(msg(4, "resize-ignored"));
    demux.push(new Uint8Array(0)); // empty message ignored

    expect(stderrs).toEqual(["a warning"]);
    expect(errors).toEqual(['{"status":"Success"}']);
    expect(frames).toEqual([]);
  });

  test("an stdout line over the cap is a violation; the demux then ignores stdout", () => {
    const frames: string[] = [];
    const violations: string[] = [];
    const demux = new ExecDemux(
      { onFrame: (f) => frames.push(f), onViolation: (m) => violations.push(m) },
      16,
    );
    demux.push(msg(1, "x".repeat(10)));
    demux.push(msg(1, "x".repeat(7))); // 17 bytes held: over the cap
    demux.push(msg(1, '\n{"a":1}\n'));
    expect(frames).toEqual([]);
    expect(violations).toEqual([
      "pod stdout line exceeds 16 bytes with no newline (frame cap); channel closed",
    ]);
  });

  test("stderr is not counted against the stdout cap", () => {
    const frames: string[] = [];
    const stderrs: string[] = [];
    const violations: string[] = [];
    const demux = new ExecDemux(
      {
        onFrame: (f) => frames.push(f),
        onStderr: (s) => stderrs.push(s),
        onViolation: (m) => violations.push(m),
      },
      16,
    );
    demux.push(msg(2, "e".repeat(100)));
    demux.push(msg(1, '{"a":1}\n'));
    expect(stderrs).toEqual(["e".repeat(100)]);
    expect(frames).toEqual(['{"a":1}']);
    expect(violations).toEqual([]);
  });
});
