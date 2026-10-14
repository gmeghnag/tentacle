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
});
