/**
 * One grant store and one ask at a time for a session's agent tree
 * (docs/feat/parallel-agents.md, Design 3; PE-Q4). T-G.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionResponse, Tool } from "@tentacle/core";
import { z } from "zod";
import { PermissionGate } from "../src/permission-gate.ts";
import { ABORTED, SessionGrants } from "../src/session-grants.ts";

const shell: Tool = {
  name: "shell",
  description: "shell",
  inputSchema: z.object({ command: z.string() }),
  permission: "ask",
  async execute() {
    return { content: "" };
  },
};
const edit: Tool = { ...shell, name: "fs_edit", inputSchema: z.object({ path: z.string() }) };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(pred()).toBe(true);
}

/** A requester whose asks stay open until the test answers each, in order. */
function heldRequester() {
  const asks: { input: unknown; answer: Deferred<PermissionResponse> }[] = [];
  return {
    asks,
    requester: async (req: { input: unknown }): Promise<PermissionResponse> => {
      const answer = deferred<PermissionResponse>();
      asks.push({ input: req.input, answer });
      return answer.promise;
    },
  };
}

const callOf = (id: string, signal: AbortSignal = new AbortController().signal) => ({
  sessionId: "s",
  toolCallId: id,
  signal,
});

describe("SessionGrants — one store for the tree", () => {
  test("an always given in one gate covers another gate of the tree", async () => {
    const grants = new SessionGrants();
    let asked = 0;
    const child = new PermissionGate(
      async () => {
        asked++;
        return { allowed: true, scope: "session" };
      },
      undefined,
      grants,
    );
    const parent = new PermissionGate(
      async () => {
        asked++;
        return { allowed: true, scope: "once" };
      },
      undefined,
      grants,
    );
    await child.authorize(shell, { command: "bun test a" }, callOf("c"));
    const outcome = await parent.authorize(shell, { command: "bun test b" }, callOf("p"));
    expect(outcome.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("gates built without a store stay private (as today)", async () => {
    let asked = 0;
    const requester = async (): Promise<PermissionResponse> => {
      asked++;
      return { allowed: true, scope: "session" };
    };
    await new PermissionGate(requester).authorize(shell, { command: "ls" }, callOf("a"));
    await new PermissionGate(requester).authorize(shell, { command: "ls" }, callOf("b"));
    expect(asked).toBe(2);
  });

  test("two concurrent asks of one command: ONE requester call (the race)", async () => {
    // Mutation: no re-check inside the lane → 2 asks.
    const grants = new SessionGrants();
    const { asks, requester } = heldRequester();
    const a = new PermissionGate(requester, undefined, grants);
    const b = new PermissionGate(requester, undefined, grants);
    const first = a.authorize(shell, { command: "bun test" }, callOf("a"));
    const second = b.authorize(shell, { command: "bun test" }, callOf("b"));
    await until(() => asks.length === 1);
    asks[0]?.answer.resolve({ allowed: true, scope: "session" });
    expect((await first).allowed).toBe(true);
    expect((await second).allowed).toBe(true);
    expect(asks.length).toBe(1);
  });

  test("two uncovered asks: two calls, one at a time, FIFO", async () => {
    const grants = new SessionGrants();
    const { asks, requester } = heldRequester();
    const gates = [1, 2, 3].map(() => new PermissionGate(requester, undefined, grants));
    const runs = gates.map((gate, i) =>
      gate.authorize(shell, { command: `cmd${i} x` }, callOf(`c${i}`)),
    );
    await until(() => asks.length === 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(asks.length).toBe(1); // never two on screen
    expect(asks[0]?.input).toEqual({ command: "cmd0 x" });
    asks[0]?.answer.resolve({ allowed: true, scope: "once" });
    await until(() => asks.length === 2);
    expect(asks[1]?.input).toEqual({ command: "cmd1 x" });
    asks[1]?.answer.resolve({ allowed: false });
    await until(() => asks.length === 3);
    expect(asks[2]?.input).toEqual({ command: "cmd2 x" });
    asks[2]?.answer.resolve({ allowed: true, scope: "once" });
    expect((await Promise.all(runs)).map((o) => o.allowed)).toEqual([true, false, true]);
  });

  test("an always for another tool does not cover: still asked next", async () => {
    const grants = new SessionGrants();
    const { asks, requester } = heldRequester();
    const a = new PermissionGate(requester, undefined, grants);
    const b = new PermissionGate(requester, undefined, grants);
    const first = a.authorize(shell, { command: "git status" }, callOf("a"));
    const second = b.authorize(edit, { path: "x" }, callOf("b"));
    await until(() => asks.length === 1);
    asks[0]?.answer.resolve({ allowed: true, scope: "session" });
    await first;
    await until(() => asks.length === 2);
    asks[1]?.answer.resolve({ allowed: true, scope: "once" });
    expect((await second).allowed).toBe(true);
  });

  test('a hook\'s force "ask" still asks, even when a rule covers it', async () => {
    const grants = new SessionGrants();
    grants.remember(edit, { tool: "fs_edit", title: "t", level: "ask", input: {} });
    const hooks = {
      hasAny: () => true,
      toolCall: async (call: { input: unknown }) => ({
        kind: "pass" as const,
        input: call.input,
        modified: false,
        force: "ask" as const,
      }),
    };
    let asked = 0;
    const gate = new PermissionGate(
      async () => {
        asked++;
        return { allowed: true, scope: "once" };
      },
      hooks as never,
      grants,
    );
    expect((await gate.authorize(edit, { path: "x" }, callOf("a"))).allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("an abort releases the waiters with no requester call; the ask in the lane ends by itself", async () => {
    const grants = new SessionGrants();
    const { asks, requester } = heldRequester();
    const controller = new AbortController();
    const a = new PermissionGate(requester, undefined, grants);
    const b = new PermissionGate(requester, undefined, grants);
    const holder = a.authorize(shell, { command: "one x" }, callOf("a", controller.signal));
    const waiter = b.authorize(shell, { command: "two x" }, callOf("b", controller.signal));
    await until(() => asks.length === 1);
    controller.abort();
    const outcome = await waiter;
    expect(outcome).toEqual({ allowed: false, input: { command: "two x" }, by: "user" });
    expect(asks.length).toBe(1);
    asks[0]?.answer.resolve({ allowed: false });
    await holder;
    // The lane is free for the next turn.
    const next = new PermissionGate(requester, undefined, grants);
    const later = next.authorize(shell, { command: "three x" }, callOf("c"));
    await until(() => asks.length === 2);
    asks[1]?.answer.resolve({ allowed: true, scope: "once" });
    expect((await later).allowed).toBe(true);
  });

  test("a throwing requester releases the lane; that call fails alone", async () => {
    const grants = new SessionGrants();
    const { asks, requester } = heldRequester();
    const a = new PermissionGate(requester, undefined, grants);
    const b = new PermissionGate(requester, undefined, grants);
    const first = a.authorize(shell, { command: "one x" }, callOf("a"));
    const second = b.authorize(shell, { command: "two x" }, callOf("b"));
    await until(() => asks.length === 1);
    asks[0]?.answer.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await until(() => asks.length === 2);
    asks[1]?.answer.resolve({ allowed: true, scope: "once" });
    expect((await second).allowed).toBe(true);
  });

  test("serial: an already-aborted signal never runs fn", async () => {
    const grants = new SessionGrants();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const result = await grants.serial(controller.signal, async () => {
      ran = true;
    });
    expect(result).toBe(ABORTED);
    expect(ran).toBe(false);
  });
});
