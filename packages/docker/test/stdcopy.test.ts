import { describe, expect, test } from "bun:test";
import { StdDemux } from "../src/stdcopy.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(stream: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const out = new Uint8Array(8 + body.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out;
}

function recorder() {
  const out = {
    stdout: [] as number[],
    stderr: [] as number[],
    sys: [] as number[],
    errors: [] as string[],
    chunks: 0,
  };
  const demux = new StdDemux({
    onStdout: (b) => {
      out.chunks++;
      out.stdout.push(...b);
    },
    onStderr: (b) => out.stderr.push(...b),
    onSystemErr: (b) => out.sys.push(...b),
    onError: (m) => out.errors.push(m),
  });
  return {
    demux,
    out,
    text: (k: "stdout" | "stderr" | "sys") => dec.decode(new Uint8Array(out[k])),
  };
}

describe("StdDemux", () => {
  test("a header split at every offset 0..8 still routes the frame", () => {
    const bytes = new Uint8Array([...frame(1, "hello"), ...frame(2, "oops")]);
    for (let cut = 0; cut <= 8; cut++) {
      const { demux, text, out } = recorder();
      demux.push(bytes.subarray(0, cut));
      demux.push(bytes.subarray(cut));
      expect(text("stdout")).toBe("hello");
      expect(text("stderr")).toBe("oops");
      expect(out.errors).toEqual([]);
    }
  });

  test("payload is emitted as it arrives (no whole-frame buffering)", () => {
    const { demux, out, text } = recorder();
    const f = frame(1, "abcdef");
    demux.push(f.subarray(0, 10)); // header + "ab"
    expect(text("stdout")).toBe("ab");
    demux.push(f.subarray(10));
    expect(text("stdout")).toBe("abcdef");
    expect(out.chunks).toBe(2);
  });

  test("streams 0/1 → stdout, 2 → stderr, 3 → systemErr", () => {
    const { demux, text } = recorder();
    demux.push(
      new Uint8Array([
        ...frame(0, "in"),
        ...frame(1, "out"),
        ...frame(2, "err"),
        ...frame(3, "sys"),
      ]),
    );
    expect(text("stdout")).toBe("inout");
    expect(text("stderr")).toBe("err");
    expect(text("sys")).toBe("sys");
  });

  test("a zero-length frame is skipped cleanly", () => {
    const { demux, text, out } = recorder();
    demux.push(new Uint8Array([...frame(1, ""), ...frame(1, "x")]));
    expect(text("stdout")).toBe("x");
    expect(out.chunks).toBe(1);
    expect(demux.finish()).toEqual({ partial: 0, failed: false });
  });

  test("a size up to 2^32-1 is read unsigned (not negative)", () => {
    const { demux, out } = recorder();
    demux.push(new Uint8Array([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x41]));
    expect(out.stdout).toEqual([0x41]);
    expect(demux.finish().partial).toBe(0xffffffff - 1);
  });

  test("bytes 1-3 not zero → error, and nothing more is emitted", () => {
    const { demux, out } = recorder();
    demux.push(new Uint8Array([1, 0, 1, 0, 0, 0, 0, 1, 0x41, ...frame(1, "after")]));
    expect(out.errors).toEqual(["malformed docker stream header [01 00 01 00 00 00 00 01]"]);
    expect(out.stdout).toEqual([]);
    expect(demux.finish().failed).toBe(true);
  });

  test("stream 4 → error (raw TTY output or garbage, not a multiplexed stream)", () => {
    const { demux, out } = recorder();
    demux.push(enc.encode('{"jsonrpc":')); // what a Tty:true exec would send
    expect(out.errors[0]).toMatch(/^malformed docker stream header/);
  });

  test("finish() reports a frame cut mid-way (header or payload)", () => {
    const a = recorder();
    a.demux.push(frame(1, "abcdef").subarray(0, 10));
    expect(a.demux.finish()).toEqual({ partial: 4, failed: false });
    const b = recorder();
    b.demux.push(frame(1, "x").subarray(0, 3));
    expect(b.demux.finish()).toEqual({ partial: 3, failed: false });
  });

  test("a UTF-8 char split across two frames decodes once through a streaming decoder", () => {
    const euro = enc.encode("€"); // 3 bytes
    const decoder = new TextDecoder();
    let text = "";
    const demux = new StdDemux({
      onStdout: (b) => {
        text += decoder.decode(b, { stream: true });
      },
      onStderr: () => {},
      onError: () => {},
    });
    demux.push(new Uint8Array([...frame(1, euro.subarray(0, 1)), ...frame(1, euro.subarray(1))]));
    expect(text).toBe("€");
  });
});
