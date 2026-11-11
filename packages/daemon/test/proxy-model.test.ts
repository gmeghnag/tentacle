import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type { AgentEvent } from "@tentacle/agent";
import type { ChatRequest } from "@tentacle/core";
import { ModelStreamCutError } from "@tentacle/core";
import { JsonRpcErrorCode, ModelStreamResultSchema } from "@tentacle/protocol";
import type { ModelStreamChunkedResult } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { ProxyModelProvider } from "../src/proxy-model.ts";

const REQ: ChatRequest = { messages: [{ role: "user", content: "x" }] };

type Chunk = { type: string; delta?: string; toolCall?: unknown; usage?: unknown };
const ev = (type: "text" | "reasoning", delta: string): Chunk => ({ type, delta });

function methodNotFound(): Error {
  return Object.assign(new Error("unknown method"), {
    code: JsonRpcErrorCode.MethodNotFound,
  });
}

describe("ProxyModelProvider — display-only message fields never reach the model", () => {
  test("a tool message's durationMs (and spill) is not on the wire request (docs/fix/tool-duration.md)", async () => {
    // Mutation (red, verified): copy `durationMs` in toWireRequest → fails.
    const sent: unknown[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("batch path must not be used")),
      async (req) => {
        sent.push(req);
        return { chunks: 0 };
      },
    );
    const request: ChatRequest = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
        {
          role: "tool",
          content: "ok",
          toolCallId: "c1",
          durationMs: 1234,
          spill: { chars: 9, head: "h", tail: "t", omitted: 7 },
        },
      ],
    };
    for await (const _ of provider.stream(request)) {
      // drain
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
        { role: "tool", content: "ok", toolCallId: "c1" },
      ],
    });
  });
});

describe("ProxyModelProvider — chunked (streaming) cut", () => {
  test("the deciding test: the first event is observed out of stream() BEFORE the sender resolves (red on the old batch path)", async () => {
    let senderResolved = false;
    // A ref object (not a bare `let`): TS control-flow narrowing would otherwise
    // see `gate` as `null` at the call site (it does not track closure assigns).
    const gateRef: { fn: (() => void) | null } = { fn: null };
    const provider = new ProxyModelProvider(
      // The batch path must NOT be used here — if it is, the old code awaits
      // the whole turn before yielding anything, so the first `next()` hangs.
      () => Promise.reject(new Error("batch path must not be used")),
      (_req, { onProgress }) => {
        onProgress([ev("reasoning", "thinking")], 0);
        return new Promise<ModelStreamChunkedResult>((resolve) => {
          gateRef.fn = () => {
            onProgress([ev("text", "hi")], 1);
            senderResolved = true;
            resolve({ chunks: 2 });
          };
        });
      },
    );
    const iter = provider.stream(REQ)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "reasoning", delta: "thinking" });
    // THE decisive property: the event is out before the sender completes.
    expect(senderResolved).toBe(false);
    gateRef.fn?.();
    const second = await iter.next();
    expect(second.done).toBe(false);
    expect(second.value).toEqual({ type: "text", delta: "hi" });
    const third = await iter.next();
    expect(third.done).toBe(true);
  });

  test("yields events in seq order and completes when the result count matches", async () => {
    const seen: unknown[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("reasoning", "a")], 0);
        onProgress([ev("reasoning", "b")], 1);
        onProgress([ev("text", "c")], 2);
        return Promise.resolve({ chunks: 3 });
      },
    );
    for await (const e of provider.stream(REQ)) {
      seen.push(e);
    }
    expect(seen).toEqual([
      { type: "reasoning", delta: "a" },
      { type: "reasoning", delta: "b" },
      { type: "text", delta: "c" },
    ]);
  });

  test("one frame carrying a batch yields every event in order; chunks counts FRAMES", async () => {
    const seen: unknown[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("reasoning", "a"), ev("text", "b")], 0);
        onProgress([ev("text", "c")], 1);
        return Promise.resolve({ chunks: 2 });
      },
    );
    for await (const e of provider.stream(REQ)) {
      seen.push(e);
    }
    expect(seen).toEqual([ev("reasoning", "a"), ev("text", "b"), ev("text", "c")]);
  });

  test("a corrupt stream (seq gap, invalid batch) also CANCELS the laptop request — it must not keep generating", async () => {
    for (const corrupt of [
      (p: (v: unknown, s: number) => void) => p([ev("text", "x")], 1), // gap: 0 missing
      (p: (v: unknown, s: number) => void) => p([], 0), // invalid batch
    ]) {
      let senderSignal: AbortSignal | undefined;
      const provider = new ProxyModelProvider(
        () => Promise.reject(new Error("no batch")),
        (_req, { signal, onProgress }) => {
          senderSignal = signal;
          corrupt(onProgress);
          return new Promise<ModelStreamChunkedResult>(() => {}); // the laptop keeps going
        },
      );
      // No caller signal (compaction shape): the provider must still own one.
      await expect(
        (async () => {
          for await (const _ of provider.stream(REQ)) {
            // drain
          }
        })(),
      ).rejects.toThrow();
      expect(senderSignal?.aborted).toBe(true);
    }
  });

  test("a non-batch (bare event) or empty-batch value fails the stream loudly", async () => {
    for (const bad of [ev("text", "bare"), []]) {
      let error: unknown;
      const provider = new ProxyModelProvider(
        () => Promise.reject(new Error("no batch")),
        (_req, { onProgress }) => {
          onProgress(bad, 0);
          return Promise.resolve({ chunks: 1 });
        },
      );
      try {
        for await (const _ of provider.stream(REQ)) {
          // drain
        }
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("a seq gap fails the stream (after draining what was queued) — never a silent truncation", async () => {
    const seen: unknown[] = [];
    let error: unknown;
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("text", "ok")], 0);
        onProgress([ev("text", "skipped")], 2); // gap: 1 is missing
        return Promise.resolve({ chunks: 2 });
      },
    );
    try {
      for await (const e of provider.stream(REQ)) {
        seen.push(e);
      }
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([{ type: "text", delta: "ok" }]); // the in-order event still drained
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/seq out of order/);
  });

  test("a duplicate seq fails the stream", async () => {
    let error: unknown;
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("text", "a")], 0);
        onProgress([ev("text", "a")], 0); // duplicate
        return Promise.resolve({ chunks: 1 });
      },
    );
    try {
      for await (const _ of provider.stream(REQ)) {
        /* drain */
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/seq out of order/);
  });

  test("a result count that does not match what was received fails the stream", async () => {
    let error: unknown;
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("text", "only-one")], 0);
        // result claims 2 chunks but only 1 was sent
        return Promise.resolve({ chunks: 2 });
      },
    );
    try {
      for await (const _ of provider.stream(REQ)) {
        /* drain */
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/count mismatch/);
  });

  test("an invalid (non-wire) event value fails the stream", async () => {
    let error: unknown;
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([{ type: "bogus" }], 0);
        return Promise.resolve({ chunks: 1 });
      },
    );
    try {
      for await (const _ of provider.stream(REQ)) {
        /* drain */
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid event/);
  });

  test("a sender error yields the queued events first, then throws", async () => {
    const seen: unknown[] = [];
    let error: unknown;
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress([ev("text", "partial")], 0);
        return Promise.reject(new Error("model exploded"));
      },
    );
    try {
      for await (const e of provider.stream(REQ)) {
        seen.push(e);
      }
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([{ type: "text", delta: "partial" }]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("model exploded");
  });

  test("an already-aborted signal ends the stream as a clean cancel (no hang, no error to the agent)", async () => {
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    const seen: unknown[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        // The cancel already happened, so any event the laptop still emits is
        // dropped (it is not yielded into an aborted turn).
        onProgress([ev("text", "x")], 0);
        return new Promise<ModelStreamChunkedResult>(() => {
          /* never resolves — but the cancel must end the consumer anyway */
        });
      },
    );
    try {
      for await (const e of provider.stream({ ...REQ, signal: controller.signal })) {
        seen.push(e);
      }
    } catch (e) {
      error = e;
    }
    // A clean cancel: the consumer ends and the surfaced error is the
    // `cancelled` marker the agent maps to a `cancelled` turn. No events are
    // yielded (the cancel preceded them).
    expect(
      error && typeof error === "object" && (error as { name?: string }).name === "cancelled",
    ).toBe(true);
    expect(seen).toEqual([]);
  });
});

/**
 * The stop reason is the ONLY place "this reply was cut" exists, and it is on
 * `done` (docs/fix/truncated-reply-silent.md). The tunnel re-serialises every
 * `StreamEvent` through a strip schema, so a `done` the schema does not name
 * arrives at the pod with the fact silently gone: the pod-side loop then
 * accepts a cut reply as complete, and RUNS a tool call cut mid-JSON (Review
 * HIGH-1). These pin the fact crossing both transports.
 */
describe("ProxyModelProvider — the stop reason crosses the tunnel", () => {
  test("a `length` done arrives intact (chunked batch)", async () => {
    const seen: unknown[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress(
          [
            { type: "text", delta: "la vera" },
            { type: "done", stopReason: "length" },
          ],
          0,
        );
        return Promise.resolve({ chunks: 1 });
      },
    );
    for await (const e of provider.stream(REQ)) {
      seen.push(e);
    }
    expect(seen).toEqual([
      { type: "text", delta: "la vera" },
      { type: "done", stopReason: "length" },
    ]);
  });

  test("a `length` done arrives intact (batch result, parsed as the peer parses it)", async () => {
    // The real peer validates the response with the method's result schema, so
    // the sender here plays the wire: it hands back what the laptop sent.
    const result = ModelStreamResultSchema.parse({
      events: [
        { type: "text", delta: "cut" },
        { type: "done", stopReason: "length" },
      ],
    });
    const provider = new ProxyModelProvider(() => Promise.resolve(result));
    const seen: unknown[] = [];
    for await (const e of provider.stream(REQ)) {
      seen.push(e);
    }
    expect(seen.at(-1)).toEqual({ type: "done", stopReason: "length" });
  });

  test("the pod's agent loop takes the truncation path: a cut tool call is NEVER run", async () => {
    // The end-to-end property: this is a POD agent, its only model is the
    // proxy, and the laptop says `length`. On the buggy schema the loop saw
    // `stopReason: undefined` and ran the partial call (case 5, 17 rounds).
    let ran = 0;
    const echo = {
      name: "echo",
      description: "echo",
      inputSchema: {
        _def: {},
        parse: (v: unknown) => v,
        safeParse: (v: unknown) => ({ success: true as const, data: v }),
      },
      permission: "none" as const,
      async execute(): Promise<{ content: string }> {
        ran++;
        return { content: "ran" };
      },
    };
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("no batch")),
      (_req, { onProgress }) => {
        onProgress(
          [
            { type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"one' } },
            { type: "done", stopReason: "length" },
          ],
          0,
        );
        return Promise.resolve({ chunks: 1 });
      },
    );
    const agent = new Agent({
      model: provider,
      tools: new ToolRegistry().register(echo as never),
      env: {
        id: "noop",
        exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
        readFile: () => Promise.resolve(""),
        writeFile: () => Promise.resolve(),
      },
    });
    const events: AgentEvent[] = [];
    let error: unknown;
    try {
      for await (const event of agent.runMessages([{ role: "user", content: "hi" }], "s1")) {
        events.push(event);
      }
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ModelStreamCutError);
    expect(ran).toBe(0);
    expect(events.flatMap((e) => (e.type === "truncated_reply" ? [e.reason] : []))).toEqual([
      "length",
    ]);
  });
});

describe("ProxyModelProvider — MethodNotFound probe + latch (old laptop)", () => {
  test("falls back to the batch path once on MethodNotFound, and latches for the rest of the connection", async () => {
    let chunkedCalls = 0;
    let batchCalls = 0;
    const provider = new ProxyModelProvider(
      (_req) => {
        batchCalls += 1;
        return Promise.resolve({ events: [{ type: "text", delta: "batch" }, { type: "done" }] });
      },
      (_req, { onProgress }) => {
        chunkedCalls += 1;
        // Simulate an old laptop: it rejects the unknown method.
        return Promise.reject(methodNotFound());
      },
    );
    // First call: probes chunked (1), gets MethodNotFound, latches, retries
    // batch (1).
    const first: unknown[] = [];
    for await (const e of provider.stream(REQ)) {
      first.push(e);
    }
    expect(chunkedCalls).toBe(1);
    expect(batchCalls).toBe(1);
    expect(first).toEqual([{ type: "text", delta: "batch" }, { type: "done" }]);
    // Second call: latched to batch — chunked is NOT retried.
    const second: unknown[] = [];
    for await (const e of provider.stream(REQ)) {
      second.push(e);
    }
    expect(chunkedCalls).toBe(1); // unchanged
    expect(batchCalls).toBe(2);
    expect(second).toEqual([{ type: "text", delta: "batch" }, { type: "done" }]);
  });

  test("a NON-MethodNotFound sender error propagates (no silent fallback)", async () => {
    let batchCalls = 0;
    let error: unknown;
    const provider = new ProxyModelProvider(
      (_req) => {
        batchCalls += 1;
        return Promise.resolve({ events: [{ type: "text", delta: "batch" }] });
      },
      () => Promise.reject(new Error("laptop is on fire")),
    );
    try {
      for await (const _ of provider.stream(REQ)) {
        /* drain */
      }
    } catch (e) {
      error = e;
    }
    expect(batchCalls).toBe(0); // did NOT fall back on a real error
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("laptop is on fire");
  });

  test("with no chunked sender wired, the provider is byte-identical to the batch path", async () => {
    let batchCalls = 0;
    const provider = new ProxyModelProvider((_req) => {
      batchCalls += 1;
      return Promise.resolve({ events: [{ type: "reasoning", delta: "r" }, { type: "done" }] });
    });
    const seen: unknown[] = [];
    for await (const e of provider.stream(REQ)) {
      seen.push(e);
    }
    expect(batchCalls).toBe(1);
    expect(seen).toEqual([{ type: "reasoning", delta: "r" }, { type: "done" }]);
  });
});
