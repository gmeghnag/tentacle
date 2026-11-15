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

/**
 * `workload_shell`'s "always" is keyed on the WORKLOAD, never on the command
 * alone (docs/feat/workload-shell.md D6; the owner's decision). An "always
 * `rm -rf build`" in a dev container must never cover a prod pod — that is the
 * bleed this suite pins, and the reason the tool never falls through to the
 * session-wide `grantedTools`.
 */
const workloadShell: Tool = {
  name: "workload_shell",
  description: "workload_shell",
  inputSchema: z.object({
    action: z.string(),
    target: z.object({
      engine: z.string(),
      name: z.string(),
      container: z.string().optional(),
      namespace: z.string().optional(),
    }),
    command: z.string().optional(),
  }),
  permission: "ask",
  async execute() {
    return { content: "" };
  },
};

const devA = { engine: "kubernetes", namespace: "dev", name: "api-0" } as const;
const devAOtherContainer = { ...devA, container: "sidecar" } as const;
const prodA = { engine: "kubernetes", namespace: "prod", name: "api-0" } as const;
const devB = { engine: "kubernetes", namespace: "dev", name: "web-0" } as const;
const dockerBox = { engine: "docker", name: "box" } as const;

function workloadRun(target: object, command: string) {
  return { action: "run", target, command };
}

/** An "always" for `command` on `target`, as the gate would build it. */
function alwaysOn(target: object, command: string, prefix = command.split(" ")[0] as string) {
  return {
    tool: "workload_shell",
    level: "ask" as const,
    input: workloadRun(target, command),
    title: "Run a command in a workload",
    detail: `${command}`,
    suggestion: { prefix },
  };
}

describe("workload_shell approvals are scoped to the workload", () => {
  test("always `ls` on one workload covers `ls -la` there — and nothing else", () => {
    const grants = new SessionGrants();
    grants.remember(workloadShell, alwaysOn(devA, "ls"));

    expect(grants.covers(workloadShell, workloadRun(devA, "ls -la"))).toBe(true);
    // Another NAME, another NAMESPACE, another CONTAINER: all refused.
    expect(grants.covers(workloadShell, workloadRun(devB, "ls"))).toBe(false);
    expect(grants.covers(workloadShell, workloadRun(prodA, "ls"))).toBe(false);
    expect(grants.covers(workloadShell, workloadRun(devAOtherContainer, "ls"))).toBe(false);
    expect(grants.covers(workloadShell, workloadRun(dockerBox, "ls"))).toBe(false);
    // And a different command on the SAME workload is still asked.
    expect(grants.covers(workloadShell, workloadRun(devA, "rm -rf /"))).toBe(false);
  });

  test("an always for another workload's identical command does not carry over", () => {
    const grants = new SessionGrants();
    grants.remember(workloadShell, alwaysOn(prodA, "kubectl delete"));
    expect(grants.covers(workloadShell, workloadRun(prodA, "kubectl delete pod x"))).toBe(true);
    expect(grants.covers(workloadShell, workloadRun(devA, "kubectl delete pod x"))).toBe(false);
  });

  test("an always with NO suggestion grants nothing (it never falls through to grantedTools)", () => {
    const grants = new SessionGrants();
    const request = { ...alwaysOn(devA, "make deploy"), suggestion: undefined };
    grants.remember(workloadShell, request as never);

    // Not even the same command on the same workload: without a derivable
    // prefix there is no rule to store, and inventing "all commands on this
    // workload" is the broader thing the owner ruled out.
    expect(grants.covers(workloadShell, workloadRun(devA, "make deploy"))).toBe(false);
    expect(grants.covers(workloadShell, workloadRun(devA, "anything"))).toBe(false);

    // And crucially: no OTHER tool's road is opened either. A fall-through would
    // have put "workload_shell" in the session-wide set, which is the bleed.
    const unrelated = new SessionGrants();
    unrelated.remember(workloadShell, request as never);
    // A close is covered (it never asks); a run on ANY target must still ask,
    // including one with no `command` at all (a malformed call).
    expect(unrelated.covers(workloadShell, { action: "run", target: devA })).toBe(false);
    expect(unrelated.covers(workloadShell, workloadRun(prodA, "make deploy"))).toBe(false);
    expect(unrelated.covers(workloadShell, workloadRun(devA, "make deploy"))).toBe(false);
  });

  test("no remember() path can ever put workload_shell in the session-wide set", () => {
    // The bleed needs BOTH halves, so pin the pair: an "always" that stores a
    // rule AND one that stores nothing, then prove the tool is still not
    // session-wide anywhere. (Mutating either half alone is invisible — which is
    // exactly why the test drives the real sequence: ask, remember, ask again.)
    const grants = new SessionGrants();
    grants.remember(workloadShell, alwaysOn(devA, "ls"));
    grants.remember(workloadShell, {
      ...alwaysOn(devA, "make deploy"),
      suggestion: undefined,
    } as never);

    // A workload the first rule was NOT granted for still asks, for every shape
    // of input — a command, no command, a malformed target, a close-less action.
    for (const input of [
      workloadRun(prodA, "ls"),
      workloadRun(devB, "make deploy"),
      { action: "run", target: prodA },
      { action: "run", target: {} },
      { action: "run" },
      {},
    ]) {
      expect(grants.covers(workloadShell, input), JSON.stringify(input)).toBe(false);
    }
  });

  test("it never widens the SHELL tool, and shell rules never cover it", () => {
    const grants = new SessionGrants();
    grants.remember(workloadShell, alwaysOn(devA, "ls"));
    // A workload "always ls" must not make a host `shell` call free.
    expect(grants.covers(shell, { command: "ls" })).toBe(false);

    const other = new SessionGrants();
    other.remember(shell, {
      tool: "shell",
      level: "ask",
      input: { command: "ls" },
      title: "Run a shell command",
      suggestion: { prefix: "ls" },
    });
    expect(other.covers(workloadShell, workloadRun(devA, "ls"))).toBe(false);
  });

  test("close never needs an approval; run still asks", () => {
    const grants = new SessionGrants();
    expect(grants.covers(workloadShell, { action: "close", target: devA })).toBe(true);
    expect(grants.covers(workloadShell, workloadRun(devA, "ls"))).toBe(false);
  });

  test("clear() resets the workload rules too", () => {
    const grants = new SessionGrants();
    grants.remember(workloadShell, alwaysOn(devA, "ls"));
    expect(grants.covers(workloadShell, workloadRun(devA, "ls"))).toBe(true);
    grants.clear();
    expect(grants.covers(workloadShell, workloadRun(devA, "ls"))).toBe(false);
  });
});

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

describe("SessionGrants.clear (docs/feat/clear-keeps-jobs.md, T3)", () => {
  test("empties tools and shell prefixes; a waiter in the ask lane is still admitted", async () => {
    // Mutation: reset the lane too → the waiter is dropped / never admitted.
    const grants = new SessionGrants();
    grants.remember(edit, { suggestion: undefined } as never);
    grants.remember(shell, { suggestion: { prefix: "bun test" } } as never);
    expect(grants.covers(edit, { path: "x" })).toBe(true);
    expect(grants.covers(shell, { command: "bun test a" })).toBe(true);

    const holder = deferred<void>();
    const order: string[] = [];
    const first = grants.serial(new AbortController().signal, async () => {
      order.push("first");
      await holder.promise;
    });
    const second = grants.serial(new AbortController().signal, async () => {
      order.push("second");
    });
    grants.clear();
    expect(grants.covers(edit, { path: "x" })).toBe(false);
    expect(grants.covers(shell, { command: "bun test a" })).toBe(false);
    expect(order).toEqual(["first"]);
    holder.resolve();
    await first;
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});
