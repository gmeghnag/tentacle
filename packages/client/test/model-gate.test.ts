import { describe, expect, test } from "bun:test";
import { CallGateError, createCallGate } from "../src/model-gate.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Enter, and record the moment it settles. */
function entering(gate: ReturnType<typeof createCallGate>, signal?: AbortSignal) {
  const state: { release?: () => void; error?: unknown } = {};
  const done = gate.enter(signal).then(
    (release) => {
      state.release = release;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return { state, done };
}

const reasonOf = (error: unknown): string | undefined =>
  error instanceof CallGateError ? error.reason : undefined;

describe("createCallGate", () => {
  test("at most `limit` inside; the next waits until a release", async () => {
    const gate = createCallGate(2, 8);
    const [a, b, c] = [entering(gate), entering(gate), entering(gate)];
    await tick();
    expect(a.state.release).toBeDefined();
    expect(b.state.release).toBeDefined();
    expect(c.state.release).toBeUndefined();
    a.state.release?.();
    await tick();
    expect(c.state.release).toBeDefined();
  });

  test("first in, first out", async () => {
    const gate = createCallGate(1, 8);
    const first = entering(gate);
    await tick();
    const order: string[] = [];
    void gate.enter().then(() => order.push("second"));
    void gate.enter().then(() => order.push("third"));
    await tick();
    expect(order).toEqual([]);
    first.state.release?.();
    await tick();
    expect(order).toEqual(["second"]);
  });

  test("past `maxWaiting` a call is refused at once, and only that one", async () => {
    const gate = createCallGate(1, 2);
    entering(gate);
    const [w1, w2, over] = [entering(gate), entering(gate), entering(gate)];
    await tick();
    expect(reasonOf(over.state.error)).toBe("full");
    expect(w1.state.error).toBeUndefined();
    expect(w2.state.error).toBeUndefined();
  });

  test("an abort while waiting removes the waiter and frees its queue place", async () => {
    const gate = createCallGate(1, 1);
    const inside = entering(gate);
    await tick();
    const controller = new AbortController();
    const waiting = entering(gate, controller.signal);
    await tick();
    controller.abort();
    await tick();
    expect(reasonOf(waiting.state.error)).toBe("aborted");
    const next = entering(gate);
    await tick();
    expect(next.state.error).toBeUndefined();
    inside.state.release?.();
    await tick();
    expect(next.state.release).toBeDefined();
  });

  test("a signal already aborted never enters", async () => {
    const gate = createCallGate(4, 4);
    const controller = new AbortController();
    controller.abort();
    const call = entering(gate, controller.signal);
    await tick();
    expect(reasonOf(call.state.error)).toBe("aborted");
  });

  test("dropWaiting rejects the queue, keeps the running ones counted, and the gate stays usable", async () => {
    const gate = createCallGate(1, 4);
    const inside = entering(gate);
    await tick();
    const queued = entering(gate);
    await tick();
    gate.dropWaiting();
    await tick();
    expect(reasonOf(queued.state.error)).toBe("dropped");
    // The running call still holds its slot.
    const after = entering(gate);
    await tick();
    expect(after.state.release).toBeUndefined();
    inside.state.release?.();
    await tick();
    expect(after.state.release).toBeDefined();
  });

  test("a second release is a no-op: it cannot let two calls in for one slot", async () => {
    const gate = createCallGate(1, 4);
    const inside = entering(gate);
    await tick();
    const [b, c] = [entering(gate), entering(gate)];
    await tick();
    inside.state.release?.();
    inside.state.release?.();
    await tick();
    expect(b.state.release).toBeDefined();
    expect(c.state.release).toBeUndefined();
  });
});
