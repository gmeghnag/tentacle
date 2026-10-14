import { describe, expect, test } from "bun:test";
import { parseSSE } from "../src/index.ts";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSSE(stream)) {
    out.push(data);
  }
  return out;
}

describe("parseSSE", () => {
  test("extracts data payloads", async () => {
    const out = await collect(streamOf(["data: a\n\n", "data: b\n\n"]));
    expect(out).toEqual(["a", "b"]);
  });

  test("reassembles events split across reads", async () => {
    const out = await collect(streamOf(["data: hel", "lo\n\ndata: wor", "ld\n\n"]));
    expect(out).toEqual(["hello", "world"]);
  });

  test("ignores blank lines and non-data fields", async () => {
    const out = await collect(streamOf([": comment\n\n", "event: ping\n", "data: x\n\n"]));
    expect(out).toEqual(["x"]);
  });

  test("handles CRLF line endings", async () => {
    const out = await collect(streamOf(["data: a\r\n\r\n"]));
    expect(out).toEqual(["a"]);
  });

  test("flushes a trailing line without a final newline", async () => {
    const out = await collect(streamOf(["data: [DONE]"]));
    expect(out).toEqual(["[DONE]"]);
  });
});
