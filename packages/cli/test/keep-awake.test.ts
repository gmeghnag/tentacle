import { describe, expect, test } from "bun:test";
import { type AwakeChild, createKeepAwake } from "../src/keep-awake.ts";

class FakeChild implements AwakeChild {
  killed = 0;
  unrefs = 0;
  private readonly listeners = new Map<string, (() => void)[]>();
  kill(): void {
    this.killed += 1;
  }
  unref(): void {
    this.unrefs += 1;
  }
  once(event: "error" | "exit", listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: "error" | "exit"): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function rig(over: { platform?: NodeJS.Platform; enabled?: boolean } = {}) {
  const spawned: { command: string; args: readonly string[]; child: FakeChild }[] = [];
  const lines: string[] = [];
  const awake = createKeepAwake({
    platform: over.platform ?? "darwin",
    enabled: over.enabled ?? true,
    pid: 4242,
    spawn: (command, args) => {
      const child = new FakeChild();
      spawned.push({ command, args, child });
      return child;
    },
    log: (line) => lines.push(line),
  });
  return { awake, spawned, lines };
}

describe("createKeepAwake (DR-9, docs/feat/detached-relay-lifecycle.md L24)", () => {
  test("argv is exactly `caffeinate -i -w <pid>`, unref'd", () => {
    // Mutation: `-d` → it keeps the DISPLAY awake too, not asked for.
    const { awake, spawned } = rig();
    awake.set(true);
    expect(spawned.map((s) => [s.command, ...s.args])).toEqual([
      ["caffeinate", "-i", "-w", "4242"],
    ]);
    expect(spawned[0]?.child.unrefs).toBe(1);
  });

  test("`set` is idempotent; false kills it; true again starts another", () => {
    const { awake, spawned } = rig();
    awake.set(false);
    expect(spawned).toHaveLength(0);
    awake.set(true);
    awake.set(true);
    expect(spawned).toHaveLength(1);
    awake.set(false);
    awake.set(false);
    expect(spawned[0]?.child.killed).toBe(1);
    awake.set(true);
    expect(spawned).toHaveLength(2);
  });

  test("off on linux and with the config off", () => {
    for (const over of [{ platform: "linux" as const }, { enabled: false }]) {
      const { awake, spawned } = rig(over);
      awake.set(true);
      expect(spawned).toEqual([]);
    }
  });

  test("a spawn error logs once and turns it off; it never throws", () => {
    const { awake, spawned, lines } = rig();
    awake.set(true);
    spawned[0]?.child.emit("error");
    awake.set(false);
    awake.set(true);
    expect(spawned).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("caffeinate");

    const lines2: string[] = [];
    const broken = createKeepAwake({
      platform: "darwin",
      enabled: true,
      pid: 1,
      spawn: () => {
        throw new Error("ENOENT");
      },
      log: (line) => lines2.push(line),
    });
    broken.set(true);
    broken.set(true);
    expect(lines2).toHaveLength(1);
  });

  test("a child that died on its own is started again on the next turn", () => {
    const { awake, spawned } = rig();
    awake.set(true);
    spawned[0]?.child.emit("exit");
    awake.set(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.child.killed).toBe(0);
  });

  test("`stop` kills it, and no later `set` can start one", () => {
    // Mutation: drop the `stopped` flag → a late event respawns one past the relay's exit.
    const { awake, spawned } = rig();
    awake.set(true);
    awake.stop();
    awake.stop();
    awake.set(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.child.killed).toBe(1);
  });
});
