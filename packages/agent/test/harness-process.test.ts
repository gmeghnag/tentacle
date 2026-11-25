import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPAWNER,
  HarnessFailure,
  type HarnessProc,
  type ProcessGroups,
  type Spawner,
  createProcessAdapter,
} from "../src/harness/process.ts";
import type {
  CliCodec,
  HarnessCaps,
  HarnessEvent,
  HarnessRun,
  HarnessRunSpec,
} from "../src/harness/types.ts";

const CAPS: HarnessCaps = {
  permissionAsks: true,
  inputRequired: false,
  steer: true,
  usage: true,
  cost: true,
  quota: false,
  structuredResult: false,
  workspace: "local",
};
const SPEC: HarnessRunSpec = { prompt: "hi", mode: "write", runId: "r1" };
const enc = new TextEncoder();

/** One JSON object per line: {t:"started",mode?,tools?} | {t:"out",text} | {t:"end"}. */
function fakeCodec(parseSpy?: string[]): CliCodec {
  return {
    id: "fake",
    versionFloor: "1.2.0",
    argv: (spec) => {
      if (spec.mode !== "write") throw new Error("refused");
      return ["--run"];
    },
    parse: (line) => {
      parseSpy?.push(line);
      let o: { t?: string; text?: string; mode?: string; tools?: string[] };
      try {
        o = JSON.parse(line);
      } catch {
        return null;
      }
      if (o.t === "started")
        return [
          {
            kind: "started",
            handle: { adapter: "fake", id: "s1" },
            detail: { permissionMode: o.mode, tools: o.tools },
          },
        ];
      if (o.t === "out") return [{ kind: "output", text: o.text }];
      if (o.t === "end") return [{ kind: "end", status: "completed", text: "done" }];
      return [];
    },
    answer: (id, d) => `A:${id}:${d.allow ? "allow" : "deny"}`,
    interrupt: () => "INT",
    userMessage: (text) => `U:${text}`,
  };
}

interface Fake {
  proc: HarnessProc;
  /** Ordered log of everything the transport did to the process. */
  log: string[];
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): void;
  closeStdout(): void;
}

function fakeProc(opts: { pid?: number; onWrite?: (line: string, f: Fake) => void } = {}): Fake {
  const log: string[] = [];
  let outCtl: ReadableStreamDefaultController<Uint8Array> | undefined;
  let errCtl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start: (c) => {
      outCtl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (c) => {
      errCtl = c;
    },
  });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const fake: Fake = {
    log,
    stdout: (t) => outCtl?.enqueue(enc.encode(t)),
    stderr: (t) => errCtl?.enqueue(enc.encode(t)),
    closeStdout: () => {
      try {
        outCtl?.close();
      } catch {}
    },
    exit: (code) => {
      log.push(`exit:${code}`);
      resolveExit(code);
      try {
        outCtl?.close();
        errCtl?.close();
      } catch {}
    },
    proc: {
      pid: opts.pid ?? 4242,
      write: (data) => {
        const line = data.trimEnd();
        log.push(`write:${line}`);
        opts.onWrite?.(line, fake);
      },
      endInput: () => {
        log.push("stdin:end");
      },
      stdout,
      stderr,
      exited,
      kill: (sig) => {
        log.push(`leader:${sig}`);
      },
    },
  };
  return fake;
}

/** A group registry that records into the process log and lets a test pick which signals kill. */
function fakeGroups(fake: Fake, dies: readonly NodeJS.Signals[]) {
  const ops: string[] = [];
  const groups: ProcessGroups = {
    track: (p) => void ops.push(`track:${p}`),
    untrack: (p) => void ops.push(`untrack:${p}`),
    kill: (_p, sig) => {
      fake.log.push(`group:${sig}`);
      if (dies.includes(sig)) fake.exit(sig === "SIGKILL" ? 137 : 143);
      return true;
    },
  };
  return { groups, ops };
}

const spawnerOf =
  (fake: Fake, seen?: string[][]): Spawner =>
  (cmd) => {
    seen?.push([...cmd]);
    return fake.proc;
  };

async function collect(run: HarnessRun): Promise<{ events: HarnessEvent[]; error?: unknown }> {
  const events: HarnessEvent[] = [];
  try {
    for await (const e of run.events) events.push(e);
  } catch (error) {
    return { events, error };
  }
  return { events };
}

const FAST = { interruptGraceMs: 30, killGraceMs: 30 };

function adapterFor(
  fake: Fake,
  dies: readonly NodeJS.Signals[],
  extra: Partial<Parameters<typeof createProcessAdapter>[0]> = {},
) {
  const g = fakeGroups(fake, dies);
  const spawned: string[][] = [];
  const adapter = createProcessAdapter({
    id: "fake",
    command: "fakecli",
    codec: () => fakeCodec(),
    caps: CAPS,
    groups: g.groups,
    spawner: spawnerOf(fake, spawned),
    ...FAST,
    ...extra,
  });
  return { adapter, ops: g.ops, spawned };
}

describe("process transport: happy path and group lifecycle", () => {
  test("prompt on stdin, events in order, group tracked then released, stdin closed after end", async () => {
    const fake = fakeProc();
    const { adapter, ops, spawned } = adapterFor(fake, []);
    const run = await adapter.start(SPEC, new AbortController().signal);
    expect(spawned[0]).toEqual(["fakecli", "--run"]);
    expect(fake.log[0]).toBe("write:U:hi");
    expect(ops).toEqual(["track:4242"]);
    fake.stdout('{"t":"started"}\n{"t":"out","text":"a"}\n');
    fake.stdout('{"t":"end"}\n');
    const done = collect(run);
    const { events } = await done;
    expect(events.map((e) => e.kind)).toEqual(["started", "output", "end"]);
    // stdin EOF follows the result; the process then exits and the group is released.
    await Bun.sleep(5);
    expect(fake.log).toContain("stdin:end");
    fake.exit(0);
    await Bun.sleep(5);
    expect(ops).toEqual(["track:4242", "untrack:4242"]);
  });

  test("a spec the codec refuses is thrown before any spawn", async () => {
    const fake = fakeProc();
    const { adapter, spawned, ops } = adapterFor(fake, []);
    await expect(
      adapter.start({ ...SPEC, mode: "remote" }, new AbortController().signal),
    ).rejects.toThrow("refused");
    expect(spawned).toEqual([]);
    expect(ops).toEqual([]);
  });

  test("answer and send write codec lines; a late answer (after end) is dropped", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, []);
    const run = await adapter.start(SPEC, new AbortController().signal);
    await run.answer("k1", { allow: false, message: "no" });
    await run.send("more");
    expect(fake.log).toContain("write:A:k1:deny");
    expect(fake.log).toContain("write:U:more");
    fake.stdout('{"t":"end"}\n');
    await collect(run);
    const before = fake.log.length;
    await run.answer("k2", { allow: true, input: {} });
    expect(fake.log.slice(before).filter((l) => l.startsWith("write:"))).toEqual([]);
  });
});

describe("process transport: cancel ladder", () => {
  test("interrupt first; TERM only when no `end` in grace; then KILL — in that order", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, ["SIGKILL"]); // ignores INT and TERM
    const run = await adapter.start(SPEC, new AbortController().signal);
    const result = collect(run);
    const verdict = await run.cancel();
    const { events } = await result;
    expect(fake.log.filter((l) => l !== "write:U:hi")).toEqual([
      "write:INT",
      "stdin:end",
      "group:SIGTERM",
      "group:SIGKILL",
      "exit:137",
    ]);
    expect(verdict).toBe("confirmed");
    expect(events[events.length - 1]).toMatchObject({ kind: "end", status: "cancelled" });
  });

  test("an interrupt that yields `end` in grace sends no signal", async () => {
    const fake = fakeProc({
      onWrite: (line, f) => {
        if (line === "INT") {
          f.stdout('{"t":"end"}\n');
          setTimeout(() => f.exit(0), 5);
        }
      },
    });
    const { adapter } = adapterFor(fake, []);
    const run = await adapter.start(SPEC, new AbortController().signal);
    const result = collect(run);
    expect(await run.cancel()).toBe("confirmed");
    await result;
    expect(fake.log.some((l) => l.startsWith("group:") || l.startsWith("leader:"))).toBe(false);
  });

  test("a TERM that stops the process spares the KILL; an AbortSignal runs the same ladder", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, ["SIGTERM"]);
    const ac = new AbortController();
    const run = await adapter.start(SPEC, ac.signal);
    const result = collect(run);
    ac.abort();
    const { events } = await result;
    expect(fake.log.filter((l) => l.startsWith("group:"))).toEqual(["group:SIGTERM"]);
    expect(fake.log.indexOf("write:INT")).toBeLessThan(fake.log.indexOf("group:SIGTERM"));
    expect(events[events.length - 1]).toMatchObject({ kind: "end", status: "cancelled" });
  });

  test("cancel after the run ended is confirmed without touching the process", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, []);
    const run = await adapter.start(SPEC, new AbortController().signal);
    fake.stdout('{"t":"end"}\n');
    await collect(run);
    const before = fake.log.length;
    expect(await run.cancel()).toBe("confirmed");
    expect(fake.log.length).toBe(before);
  });
});

describe("process transport: failures", () => {
  test("an over-long line is dropped and counted, never parsed; later lines still flow", async () => {
    const fake = fakeProc();
    const seen: string[] = [];
    const { adapter } = adapterFor(fake, [], { lineCap: 100, codec: () => fakeCodec(seen) });
    const run = await adapter.start(SPEC, new AbortController().signal);
    const result = collect(run);
    fake.stdout('{"t":"out","text":"first"}\n');
    // a 50 KiB line arriving in chunks, then a normal line
    for (let i = 0; i < 50; i++) fake.stdout("x".repeat(1024));
    fake.stdout('\n{"t":"out","text":"after"}\n');
    fake.exit(1); // no `end`
    const { events, error } = await result;
    expect(
      events.filter((e) => e.kind === "output").map((e) => (e as { text?: string }).text),
    ).toEqual(["first", "after"]);
    expect(seen.every((l) => l.length <= 100)).toBe(true);
    expect(error).toBeInstanceOf(HarnessFailure);
    expect((error as HarnessFailure).details.droppedLines).toBe(1);
  });

  test("exit without `end` → HarnessFailure with exit code, stderr tail and the text seen", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, []);
    const run = await adapter.start(SPEC, new AbortController().signal);
    const result = collect(run);
    fake.stdout('{"t":"out","text":"partial "}\nnot json\n');
    fake.stderr(`${"noise\n".repeat(2000)}boom: it broke`);
    fake.exit(3);
    const { error } = await result;
    expect(error).toBeInstanceOf(HarnessFailure);
    const f = error as HarnessFailure;
    expect(f.message).toContain("code 3");
    expect(f.message).toContain("boom: it broke");
    expect(f.details.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(f.details.partial).toBe("partial ");
    expect(f.details.unparsableLines).toBe(1);
    expect(f.details.exitCode).toBe(3);
  });

  test("a bypass permissionMode at init kills the group before any event is delivered", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, ["SIGKILL"]);
    const run = await adapter.start(SPEC, new AbortController().signal);
    const result = collect(run);
    fake.stdout('{"t":"started","mode":"bypassPermissions"}\n{"t":"out","text":"x"}\n');
    const { events, error } = await result;
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(HarnessFailure);
    expect((error as Error).message).toContain("bypass");
    expect(fake.log).toContain("group:SIGKILL");
  });

  test("an init tool list wider than what we allowed kills the run", async () => {
    const fake = fakeProc();
    const { adapter } = adapterFor(fake, ["SIGKILL"]);
    const run = await adapter.start({ ...SPEC, tools: ["Read"] }, new AbortController().signal);
    const result = collect(run);
    fake.stdout('{"t":"started","mode":"default","tools":["Read","Bash"]}\n');
    const { events, error } = await result;
    expect(events).toEqual([]);
    expect((error as Error).message).toContain("Bash");
  });
});

describe("process transport: probe", () => {
  const probeWith = async (fake: () => Fake | Error) => {
    const g = fakeGroups(fakeProc(), []);
    const adapter = createProcessAdapter({
      id: "fake",
      command: "fakecli",
      codec: () => fakeCodec(),
      caps: CAPS,
      groups: g.groups,
      spawner: () => {
        const f = fake();
        if (f instanceof Error) throw f;
        return f.proc;
      },
    });
    return adapter.probe(new AbortController().signal);
  };
  const versioned = (text: string, code = 0): Fake => {
    const f = fakeProc();
    f.stdout(text);
    f.exit(code);
    return f;
  };

  test("not installed, too old, unreadable, ok", async () => {
    const missing = await probeWith(() => new Error("ENOENT"));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("not installed");
    const old = await probeWith(() => versioned("1.1.9 (Fake)\n"));
    expect(old).toMatchObject({ ok: false, version: "1.1.9" });
    expect(old.reason).toContain("older");
    expect((await probeWith(() => versioned("garbage"))).ok).toBe(false);
    expect(await probeWith(() => versioned("1.2.0 (Fake)\n"))).toEqual({
      ok: true,
      version: "1.2.0",
    });
  });
});

describe("default spawner (a real `sleep`, no CLI)", () => {
  test("the child leads its own process group", async () => {
    const proc = DEFAULT_SPAWNER(["sleep", "5"], {});
    try {
      const out = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(proc.pid)]).stdout.toString();
      expect(Number(out.trim())).toBe(proc.pid);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});
