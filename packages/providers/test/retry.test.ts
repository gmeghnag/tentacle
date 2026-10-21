import { describe, expect, test } from "bun:test";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  ModelConnectionError,
  ModelRequestError,
  type RetryInfo,
  RetryingModelProvider,
  abortableSleep,
  backoffDelay,
} from "../src/index.ts";

/** Bun's real connection error shape (see the task doc's Repro): no stack, string code. */
function connectionError(code = "ECONNRESET"): TypeError {
  return Object.assign(new TypeError(`${code}: The socket connection was closed unexpectedly`), {
    code,
  });
}

type Step = StreamEvent | { readonly throw: unknown };

/** An inner provider whose Nth `stream` call plays `script[N]` (the last one repeats). */
function scripted(script: readonly (readonly Step[])[]): ModelProvider & { calls: number } {
  const provider = {
    id: "fake:m",
    calls: 0,
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      const steps = script[Math.min(provider.calls, script.length - 1)] ?? [];
      provider.calls += 1;
      for (const step of steps) {
        if ("throw" in step) {
          throw step.throw;
        }
        yield step;
      }
    },
  };
  return provider;
}

const OK: readonly Step[] = [{ type: "text", delta: "hello" }, { type: "done" }];
const request: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

/** Records the waits instead of sleeping. */
function fakeSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

async function drain(
  provider: ModelProvider,
  req: ChatRequest = request,
): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of provider.stream(req)) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

describe("RetryingModelProvider", () => {
  test("a drop before any output is retried; the consumer sees only the success", async () => {
    const inner = scripted([[{ throw: connectionError() }], [{ throw: connectionError() }], OK]);
    const { waits, sleep } = fakeSleep();
    const retries: RetryInfo[] = [];
    const p = new RetryingModelProvider(inner, {
      sleep,
      random: () => 0,
      onRetry: (info) => retries.push(info),
    });

    const { events, error } = await drain(p);

    expect(error).toBeUndefined();
    expect(events).toEqual([{ type: "text", delta: "hello" }, { type: "done" }]);
    expect(inner.calls).toBe(3);
    expect(waits).toEqual([250, 500]);
    expect(retries).toEqual([
      { attempt: 1, maxAttempts: 3, code: "ECONNRESET", delayMs: 250, providerId: "fake:m" },
      { attempt: 2, maxAttempts: 3, code: "ECONNRESET", delayMs: 500, providerId: "fake:m" },
    ]);
  });

  test("exhausting the attempts surfaces a pre-stream ModelConnectionError with the cause", async () => {
    const original = connectionError("ECONNREFUSED");
    const inner = scripted([[{ throw: original }]]);
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { error } = await drain(p);

    expect(inner.calls).toBe(3);
    expect(error).toBeInstanceOf(ModelConnectionError);
    if (error instanceof ModelConnectionError) {
      expect(error.phase).toBe("pre-stream");
      expect(error.code).toBe("ECONNREFUSED");
      expect(error.attempt).toBe(3);
      expect(error.cause).toBe(original);
      // Refused: no connection ever existed, so it is not "lost".
      expect(error.message).toContain("could not connect to the model endpoint (ECONNREFUSED)");
      expect(error.message).toContain("gave up after 3 attempt(s)");
    }
  });

  test("an exhausted reset says no event was delivered (not 'no output' generated)", async () => {
    const inner = scripted([[{ throw: connectionError("ECONNRESET") }]]);
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { error } = await drain(p);

    expect(error instanceof ModelConnectionError && error.message).toStartWith(
      "model connection lost before any event was delivered (ECONNRESET), gave up after 3 attempt(s): ",
    );
  });

  test("a drop after output started is never retried (no duplicate output)", async () => {
    const inner = scripted([[{ type: "text", delta: "par" }, { throw: connectionError() }], OK]);
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { events, error } = await drain(p);

    expect(inner.calls).toBe(1);
    expect(events).toEqual([{ type: "text", delta: "par" }]);
    expect(error).toBeInstanceOf(ModelConnectionError);
    if (error instanceof ModelConnectionError) {
      expect(error.phase).toBe("mid-stream");
      expect(error.attempt).toBe(1);
      expect(error.message).toContain("not retried, events were already delivered");
    }
  });

  test("a reasoning-only start also counts as output", async () => {
    const inner = scripted([
      [{ type: "reasoning", delta: "hmm" }, { throw: connectionError() }],
      OK,
    ]);
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { error } = await drain(p);

    expect(inner.calls).toBe(1);
    expect(error instanceof ModelConnectionError && error.phase).toBe("mid-stream");
  });

  test("non-transient errors pass through untouched, after one attempt", async () => {
    for (const original of [
      new ModelRequestError(503, "loading model"),
      new TypeError("no code at all"),
      Object.assign(new Error("odd"), { code: "EACCES" }),
    ]) {
      const inner = scripted([[{ throw: original }], OK]);
      const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });
      const { error } = await drain(p);
      expect(error).toBe(original);
      expect(inner.calls).toBe(1);
    }
  });

  test("an AbortError (numeric code) is not mistaken for a connection error", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(abort.code).toBe(20);
    const inner = scripted([[{ throw: abort }], OK]);
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { error } = await drain(p);

    expect(error).toBe(abort);
    expect(inner.calls).toBe(1);
  });

  test("a cancel wins: a transient error with the signal aborted is rethrown as is", async () => {
    const controller = new AbortController();
    const original = connectionError();
    const inner = {
      id: "fake:m",
      calls: 0,
      // biome-ignore lint/correctness/useYield: fails before any event, like the incident
      async *stream(): AsyncIterable<StreamEvent> {
        inner.calls += 1;
        controller.abort();
        throw original;
      },
    };
    const p = new RetryingModelProvider(inner, { sleep: fakeSleep().sleep });

    const { error } = await drain(p, { ...request, signal: controller.signal });

    expect(error).toBe(original);
    expect(inner.calls).toBe(1);
  });

  test("an abort during the backoff ends the wait at once, with no new attempt", async () => {
    const controller = new AbortController();
    const inner = scripted([[{ throw: connectionError() }], OK]);
    // The default (real) sleep, with a wait far longer than the test.
    const p = new RetryingModelProvider(inner, {
      baseDelayMs: 60_000,
      capDelayMs: 60_000,
      onRetry: () => queueMicrotask(() => controller.abort()),
    });

    const started = Date.now();
    const { error } = await drain(p, { ...request, signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(inner.calls).toBe(1);
  });

  test("a throwing onRetry does not stop the retry", async () => {
    const inner = scripted([[{ throw: connectionError() }], OK]);
    const p = new RetryingModelProvider(inner, {
      sleep: fakeSleep().sleep,
      onRetry: () => {
        throw new Error("log sink down");
      },
    });

    const { events, error } = await drain(p);

    expect(error).toBeUndefined();
    expect(events).toEqual([{ type: "text", delta: "hello" }, { type: "done" }]);
  });

  test("keeps the inner provider's id", () => {
    expect(new RetryingModelProvider(scripted([OK])).id).toBe("fake:m");
  });
});

describe("backoffDelay", () => {
  test("equal jitter: half the step guaranteed, never the full step", () => {
    expect([1, 2].map((a) => backoffDelay(a, 500, 4000, () => 0))).toEqual([250, 500]);
    const top = [1, 2].map((a) => backoffDelay(a, 500, 4000, () => 0.999_999));
    expect(top[0]).toBeLessThan(500);
    expect(top[1]).toBeLessThan(1000);
  });

  test("the step is capped", () => {
    expect(backoffDelay(10, 500, 4000, () => 0)).toBe(2000);
  });
});

describe("abortableSleep", () => {
  test("an already-aborted signal rejects at once with its reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow("gone");
  });

  test("resolves after the delay without a signal", async () => {
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });
});
