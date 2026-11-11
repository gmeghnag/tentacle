/**
 * docs/fix/deepseek-dsml-leak.md, symptom B — how streamed `tool_calls` deltas
 * are stitched back into calls. An omitted `index` mid-call (DeepSeek) must not
 * fork a second, nameless call; an explicit index must stay authoritative, so
 * two interleaved parallel calls keep working.
 */
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@tentacle/core";
import { ToolCallAssembler } from "../src/index.ts";

const only = (calls: ToolCall[]): ToolCall => {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) {
    throw new Error("no call assembled");
  }
  return call;
};

describe("ToolCallAssembler", () => {
  test("joins argument deltas that all carry index 0", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_write", arguments: '{"path":' } }]);
    a.add([{ index: 0, function: { arguments: '"a.txt"' } }]);
    a.add([{ index: 0, function: { arguments: "}" } }]);
    expect(only(a.drain())).toEqual({
      id: "c1",
      name: "fs_write",
      arguments: '{"path":"a.txt"}',
    });
  });

  test("an OMITTED index mid-call continues the call (the DeepSeek shape)", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_write", arguments: '{"path":"a' } }]);
    // No index, no id, no name: the tail of the same call, never a new one.
    a.add([{ function: { arguments: '.txt","content":"' } }]);
    a.add([{ function: { arguments: 'x"}' } }]);
    const call = only(a.drain());
    expect(call.name).toBe("fs_write");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt", content: "x" });
  });

  test("a REPEATED same id with no index still continues the call", () => {
    const a = new ToolCallAssembler();
    a.add([{ id: "c1", function: { name: "fs_write", arguments: "{" } }]);
    // The server restates the id on the continuation: the same call.
    a.add([{ id: "c1", function: { arguments: '"a":1' } }]);
    a.add([{ id: "c1", function: { arguments: "}" } }]);
    expect(only(a.drain()).arguments).toBe('{"a":1}');
  });

  test("two calls INTERLEAVED by index keep their own arguments", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_read", arguments: '{"pa' } }]);
    a.add([{ index: 1, id: "c2", function: { name: "shell", arguments: '{"comm' } }]);
    a.add([{ index: 0, function: { arguments: 'th":"a"}' } }]);
    a.add([{ index: 1, function: { arguments: 'and":"ls"}' } }]);
    const calls = a.drain();
    expect(calls.map((c) => c.name)).toEqual(["fs_read", "shell"]);
    expect(JSON.parse(calls[0]?.arguments ?? "")).toEqual({ path: "a" });
    expect(JSON.parse(calls[1]?.arguments ?? "")).toEqual({ command: "ls" });
  });

  test("two calls in sequence stay two, in order", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_read", arguments: "{}" } }]);
    a.add([{ index: 1, id: "c2", function: { name: "shell", arguments: "" } }]);
    a.add([{ index: 1, function: { arguments: '{"command":"ls"}' } }]);
    const calls = a.drain();
    expect(calls.map((c) => c.name)).toEqual(["fs_read", "shell"]);
    expect(calls[1]?.arguments).toBe('{"command":"ls"}');
  });

  test("a stray index-less continuation after drain invents no call", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_write", arguments: '{"a":' } }]);
    a.add([{ index: 0, function: { arguments: "1" } }]);
    expect(a.drain()).toHaveLength(1);
    a.add([{ function: { arguments: "}" } }]);
    expect(a.drain()).toEqual([]);
  });

  test("a name split across deltas is joined", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c1", function: { name: "fs_" } }]);
    a.add([{ index: 0, function: { name: "write", arguments: "{}" } }]);
    expect(only(a.drain()).name).toBe("fs_write");
  });

  test("a restated name is not doubled", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, id: "c2", function: { name: "shell", arguments: "{" } }]);
    a.add([{ index: 0, function: { name: "shell", arguments: "}" } }]);
    expect(only(a.drain()).name).toBe("shell");
  });

  test("a call the server never named is dropped, not dispatched empty", () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 3, function: { arguments: '{"a":1}' } }]);
    expect(a.drain()).toEqual([]);
  });
});
