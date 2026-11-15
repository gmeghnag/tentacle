/**
 * `workload_shell` — the registry and the tool (docs/feat/workload-shell.md D3,
 * D4). Driven by a fake backend whose `RawExec` is a tiny in-memory `sh`: it
 * understands the bootstrap line and a framed command, tracks `cd`, and can be
 * told to drop the stream, to hang, or to exit.
 *
 * What is pinned here is the tool's CONTRACT, not its I/O: lazy open, one shell
 * per target key, state carried between calls, the cap, the close/dispose
 * sequences and every notice.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@tentacle/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import { READY_PREFIX, bootstrapLine, killTreeScript } from "../src/workload-shell-frame.ts";
import {
  MAX_OPEN_SHELLS,
  WORKLOAD_SHELL_DESCRIPTION,
  WORKLOAD_SHELL_TOOL_NAME,
  type WorkloadShellBackend,
  WorkloadShells,
  type WorkloadTarget,
  createWorkloadShellTool,
  targetKey,
  workloadShellSchema,
} from "../src/workload-shell.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What a fake shell does with one framed command line. */
interface FakeShellBehaviour {
  /** Output the command prints (plus the shell's own exit code and cwd). */
  output?: (line: string) => { out?: string; code?: number; hang?: boolean; exitShell?: boolean };
}

/** A tiny in-memory `sh`: it answers the bootstrap line and each framed command. */
class FakeExec {
  readonly written: string[] = [];
  /** Every raw line the tool wrote, verbatim (the §4 pin compares these). */
  readonly raw: string[] = [];
  closed = false;
  ended = false;
  private onStdout: ((b: Uint8Array) => void) | undefined;
  private onEnd: ((e: { exitCode: number | null; error?: Error }) => void) | undefined;
  cwd = "/home/app";
  /** Set by a test to control what a command does. */
  behaviour: (line: string) => {
    out?: string;
    code?: number;
    hang?: boolean;
    exitShell?: boolean;
  } = (line) => ({ out: line });
  /** Commands the fake was asked to run, in order. */
  readonly commands: string[] = [];
  readonly bootstraps: string[] = [];
  /** When true, a probe line is consumed but never answered (a shell stuck in a builtin loop). */
  hangProbe = false;
  /** When set, the stream dies as soon as a command line arrives (a link drop). */
  dropOnCommand: ((make: (e: unknown) => Error) => Error) | undefined;
  /** When set, the ready marker is withheld until it resolves (an open still priming). */
  readyGate: Promise<void> | undefined;
  /** When true, the bootstrap line is never answered (a slow or garbled shell). */
  muteBootstrap = false;
  /**
   * When true, `close()` does NOT end the stream — a real backend's close is not
   * always synchronous with its `end` callback, and the window it opens is the
   * one a session end can land in.
   */
  closeWithoutEnd = false;
  private buffer = "";
  lastCode = 0;

  constructor(readonly target: WorkloadTarget) {}

  /** Deliver bytes as if the pod wrote them. */
  stdout(text: string): void {
    this.onStdout?.(enc.encode(text));
  }

  end(error?: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.onEnd?.({ exitCode: error === undefined ? 0 : null, ...(error ? { error } : {}) });
  }

  write(bytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    this.buffer += dec.decode(bytes);
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.raw.push(line);
      this.handle(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private handle(line: string): void {
    this.written.push(line);
    if (line.startsWith("printf '__TNT_")) {
      this.bootstraps.push(line);
      if (this.muteBootstrap) {
        return; // never ready: the ready timeout's job
      }
      const ready = `${READY_PREFIX}4242_${this.cwd}__TNT__E\n`;
      if (this.readyGate !== undefined) {
        void this.readyGate.then(() => this.stdout(ready));
        return;
      }
      this.stdout(ready);
      return;
    }
    // Every framed command line ends with a `printf` that reports $? and $PWD.
    // Interpolate it exactly as `sh` would (the marker's %s/%d/%s form). The
    // nonce is an ARGUMENT to that printf, not part of the marker text.
    const nonce = line.match(/'([0-9a-f]{32})'/)?.[1];
    if (nonce === undefined) {
      return; // a stray line
    }
    const command = line.includes("command eval '")
      ? line.slice(
          line.indexOf("command eval '") + "command eval '".length,
          line.indexOf("' </dev/null"),
        )
      : undefined;
    if (command !== undefined) {
      this.commands.push(command);
      const plan = this.behaviour(command);
      if (this.dropOnCommand !== undefined) {
        this.end(new Error("link lost"));
        return;
      }
      if (plan.hang === true) {
        return; // never answers: the timeout ladder's job
      }
      if (plan.out !== undefined) {
        this.stdout(`${plan.out}\n`);
      }
      if (plan.exitShell === true) {
        // `exit`/`exec`: the shell dies with no sentinel.
        this.end();
        return;
      }
      if (command.startsWith("cd ")) {
        this.cwd = command.slice(3).trim();
      }
      this.lastCode = plan.code ?? 0;
    }
    if (this.hangProbe) {
      return; // a shell stuck in `while :` cannot run anything we write
    }
    // The trailing printf: `\n__TNT_<nonce>_B_<code>_<cwd>__TNT_<nonce>_E`.
    this.stdout(`\n__TNT_${nonce}_B_${this.lastCode}_${this.cwd}__TNT_${nonce}_E\n`);
  }

  setOnStdout(fn: (b: Uint8Array) => void): void {
    this.onStdout = fn;
  }
  setOnStderr(_fn: (b: Uint8Array) => void): void {}
  setOnEnd(fn: (e: { exitCode: number | null; error?: Error }) => void): void {
    this.onEnd = fn;
    if (this.ended) {
      fn({ exitCode: 0 });
    }
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.closeWithoutEnd) {
      this.end();
    }
  }
}

/** A backend over `FakeExec`s, recording one-shots (`kill`/`exit`) it was asked to run. */
class FakeBackend implements WorkloadShellBackend {
  readonly execs: FakeExec[] = [];
  readonly oneShots: Array<{ target: WorkloadTarget; script: string }> = [];
  /** Set to make `open` fail, as a missing pod / a distroless image would. */
  openError: Error | undefined;
  /** Tweak the fake as it is opened (set behaviour before the command arrives). */
  openImpl: ((exec: FakeExec) => void) | undefined;
  /** Set to answer a one-shot differently (default: succeeds, empty). */
  oneShotImpl:
    | ((
        t: WorkloadTarget,
        script: string,
      ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>)
    | undefined;

  /** When set, `prime` awaits it — the window a session end can land in. */
  primeGate: Promise<void> | undefined;

  async prime(): Promise<undefined> {
    if (this.primeGate !== undefined) {
      await this.primeGate;
    }
    return undefined;
  }

  open(target: WorkloadTarget): FakeExec {
    if (this.openError !== undefined) {
      throw this.openError;
    }
    const exec = new FakeExec(target);
    this.execs.push(exec);
    this.openImpl?.(exec);
    return exec;
  }

  async oneShot(target: WorkloadTarget, script: string) {
    this.oneShots.push({ target, script });
    if (this.oneShotImpl !== undefined) {
      return this.oneShotImpl(target, script);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async explain(error: unknown): Promise<Error> {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    signal: new AbortController().signal,
    env: undefined as unknown as ToolContext["env"],
    ...overrides,
  };
}

const target: WorkloadTarget = { engine: "kubernetes", name: "api-0", namespace: "dev" };

/** Let the tool's own promise chains run (`setTimeout(0)` is the cheapest). */
async function tick(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(options: { idleCloseMs?: number; readyTimeoutMs?: number } = {}) {
  const backend = new FakeBackend();
  const shells = new WorkloadShells(backend, {
    // The default idle close is 15 min; a test that wants it sooner sets it here.
    idleCloseMs: options.idleCloseMs ?? 15 * 60_000,
    readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
    killGraceMs: 60,
  });
  const tool = createWorkloadShellTool(shells);
  return { backend, shells, tool };
}

/** Run `action: "run"` and let the fake answer. */
async function run(
  tool: ReturnType<typeof createWorkloadShellTool>,
  input: Record<string, unknown>,
  ctx = context(),
) {
  const promise = tool.execute({ action: "run", ...input } as never, ctx);
  await tick();
  return promise;
}

describe("targetKey", () => {
  test("is engine|namespace|name|container, so two workloads can never alias", () => {
    expect(targetKey({ engine: "kubernetes", namespace: "dev", name: "a" })).toBe(
      "kubernetes|dev|a|",
    );
    expect(targetKey({ engine: "docker", name: "a" })).toBe("docker||a|");
    expect(targetKey({ engine: "kubernetes", namespace: "dev", name: "a", container: "c" })).toBe(
      "kubernetes|dev|a|c",
    );
    // Different namespace / name / container ⇒ different keys (the owner's rule:
    // an "always" must never travel between workloads).
    expect(targetKey({ engine: "kubernetes", namespace: "prod", name: "a" })).not.toBe(
      targetKey({ engine: "kubernetes", namespace: "dev", name: "a" }),
    );
  });
});

describe("the tool surface", () => {
  test("is named workload_shell, asks for permission, and keys one write per target", () => {
    const { tool } = setup();
    expect(tool.name).toBe(WORKLOAD_SHELL_TOOL_NAME);
    expect(tool.permission).toBe("ask");
    const concurrency = tool.concurrency;
    expect(typeof concurrency).toBe("function");
    const keys =
      typeof concurrency === "function"
        ? concurrency({ action: "run", target, command: "ls" })
        : undefined;
    expect(keys).toEqual([{ mode: "write", resource: `workload:${targetKey(target)}` }]);
  });

  test("an invalid input is refused with a readable error, not a throw", async () => {
    const { tool, backend } = setup();
    const result = await tool.execute(
      { action: "run", target, command: "x".repeat(70_000) } as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command");
    expect(backend.execs).toHaveLength(0); // nothing was opened
  });
});

describe("run", () => {
  test("opens the shell lazily and returns exit, cwd and output", async () => {
    const { tool, backend } = setup();
    const promise = run(tool, { target, command: "echo hi" });
    await tick();
    const result = await promise;

    expect(backend.execs).toHaveLength(1);
    expect(result.content.startsWith("exit=0")).toBe(true);
    expect(result.content).toContain("cwd=/home/app");
    expect(result.content).toContain("echo hi");
    expect(result.isError).toBe(false);
  });

  test("sends the bootstrap line once, and it is the pure module's constant", async () => {
    const { tool, backend } = setup();
    const promise = run(tool, { target, command: "true" });
    await tick();
    await promise;
    const exec = backend.execs[0] as FakeExec;
    expect(exec.bootstraps).toHaveLength(1);
    expect(exec.bootstraps[0]).toContain("$$");
    expect(exec.bootstraps[0]).not.toContain("TENTACLE_");
  });

  test("cd/export persist across two runs (the whole point), and the cwd is reported", async () => {
    const { tool, backend } = setup();
    const first = run(tool, { target, command: "cd /etc" });
    await tick();
    await first;

    const second = run(tool, { target, command: "pwd" });
    await tick();
    const result = await second;

    expect(backend.execs).toHaveLength(1); // ONE shell, reused
    expect(result.content).toContain("cwd=/etc");
  });

  test("a non-zero exit is an error result, and its output is kept", async () => {
    const { tool, backend } = setup();
    // Set the behaviour BEFORE the command reaches the fake (it answers inline).
    backend.openImpl = (exec) => {
      exec.behaviour = () => ({ out: "boom", code: 3 });
    };
    const promise = run(tool, { target, command: "false" });
    await tick();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content.startsWith("exit=3")).toBe(true);
  });
});

describe("close", () => {
  test("closes the stream and kills the tree (the leftovers rule), and does not prompt", async () => {
    const { tool, backend } = setup();
    const first = run(tool, { target, command: "true" });
    await tick();
    await first;

    const result = await tool.execute({ action: "close", target } as never, context());
    await tick();
    expect(result.isError).toBe(false);
    const exec = backend.execs[0] as FakeExec;
    expect(exec.closed).toBe(true);
    // The one-shot kill names the shell's pid and includes itself (`-KILL`).
    expect(backend.oneShots).toHaveLength(1);
    expect(backend.oneShots[0]?.script).toBe(killTreeScript(4242, "KILL", { includeSelf: true }));
    expect(backend.oneShots[0]?.target).toEqual(target); // same container as the shell
  });

  test("closing a target with no open shell is a harmless no-op", async () => {
    const { tool, backend } = setup();
    const result = await tool.execute({ action: "close", target } as never, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("no shell");
    expect(backend.oneShots).toHaveLength(0);
  });
});

describe("the cap", () => {
  test(`refuses the ${MAX_OPEN_SHELLS + 1}th CONCURRENT open, not just the ${MAX_OPEN_SHELLS + 1}th open shell`, async () => {
    const { tool, shells, backend } = setup();
    // Distinct targets → distinct concurrency lanes: they all start at once, and
    // all pass a size check taken before the first await.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.primeGate = gate;
    const promises = Array.from({ length: MAX_OPEN_SHELLS + 1 }, (_, i) =>
      tool.execute(
        { action: "run", target: { engine: "docker", name: `box${i}` }, command: "true" } as never,
        context(),
      ),
    );
    await tick();
    release();
    const results = await Promise.all(promises);
    await tick();

    const refused = results.filter((r) => r.isError && r.content.includes("already holds"));
    expect(refused).toHaveLength(1);
    // The cap held: exactly MAX_OPEN_SHELLS execs were opened, not one more.
    expect(backend.execs).toHaveLength(MAX_OPEN_SHELLS);
    expect(shells.size).toBe(MAX_OPEN_SHELLS);
  });

  test(`refuses the ${MAX_OPEN_SHELLS + 1}th workload with the open list, never evicting`, async () => {
    const { tool } = setup();
    for (let i = 0; i < MAX_OPEN_SHELLS; i++) {
      const promise = run(tool, {
        target: { engine: "docker", name: `box${i}` },
        command: "true",
      });
      await tick();
      await promise;
    }
    const result = await run(tool, {
      target: { engine: "docker", name: "one-too-many" },
      command: "true",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("one-too-many".length > 0 ? "4" : "4");
    expect(result.content).toContain("box0"); // the list names what is open
    expect(result.content).toContain('action: "close"');
  });
});

describe("failure modes", () => {
  test("a shell that never becomes ready closes its exec and kills what it can (D4)", async () => {
    const { tool, shells, backend } = setup({ readyTimeoutMs: 20 });
    backend.openImpl = (exec) => {
      exec.muteBootstrap = true; // a slow or garbled bootstrap: no ready marker
    };
    const result = await run(tool, { target, command: "true" });
    await tick();

    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not become ready");
    const exec = backend.execs[0] as FakeExec;
    // The exec is closed even though the shell never got a pid: no live stream
    // is left outside the registry, where nothing could ever reach it.
    expect(exec.closed).toBe(true);
    expect(exec.written).toContain("exit");
    expect(shells.size).toBe(0);
    // No pid was ever parsed, so there is nothing to kill (and no bogus pid 0).
    expect(backend.oneShots).toHaveLength(0);
  });

  test("a shell that dies before the ready marker reports explain()'s text and registers nothing", async () => {
    const { tool, backend } = setup();
    backend.openError = new Error('pod "api-0" not found in namespace "dev"');
    const promise = run(tool, { target, command: "true" });
    await tick();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pod "api-0" not found');
    expect(backend.execs).toHaveLength(0);
  });

  test("the shell exiting (exit/exec) is reported honestly, and the next run opens a new one", async () => {
    const { tool, backend } = setup();
    backend.openImpl = (exec) => {
      exec.behaviour = () => ({ exitShell: true });
    };
    const result = await run(tool, { target, command: "exit" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("shell exited");

    backend.openImpl = undefined;
    const second = run(tool, { target, command: "true" });
    await tick();
    await second;
    expect(backend.execs).toHaveLength(2); // a fresh shell
  });

  test("a drop mid-command says the outcome is unknown and the next run opens a new shell", async () => {
    const { tool, backend } = setup();
    // Hangs, so the run is still waiting when the link drops.
    backend.openImpl = (exec) => {
      exec.behaviour = () => ({ hang: true });
      exec.dropOnCommand = () => new Error("link lost");
    };
    const first = run(tool, { target, command: "sleep 100" });
    await tick(12);
    const result = await first;

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outcome unknown");

    backend.openImpl = undefined;
    const next = run(tool, { target, command: "true" });
    await tick();
    const reopened = await next;
    expect(backend.execs).toHaveLength(2);
    expect(reopened.content).toContain("new shell");
  });
});

describe("a reopen restores the working directory (owner decision 4)", () => {
  test("the `cd` persists in the SHELL, and the result says so", async () => {
    const { tool, backend } = setup();
    const first = run(tool, { target, command: "cd /etc" });
    await tick();
    await first;

    // Kill the shell's stream: the next run reopens it.
    const exec = backend.execs[0] as FakeExec;
    exec.dropOnCommand = () => new Error("link lost");
    const dying = run(tool, { target, command: "sleep 100" });
    await tick(12);
    await dying;
    expect(backend.execs).toHaveLength(1);

    // `FakeExec` starts every new shell in its own cwd: a restore is observable.
    const reopened = run(tool, { target, command: "pwd" });
    await tick(12);
    const result = await reopened;

    expect(backend.execs).toHaveLength(2);
    // Mutation: drop `restoreCwd` from the reopen → no notice, and the new shell
    // answers `/home/app` instead of `/etc`.
    expect(result.content).toContain("returned to /etc");
    expect(result.content).toContain("environment variables were not replayed");
    expect(result.content).toContain("cwd=/etc");
  });

  test("env vars are NOT replayed, and the notice says so (they may hold secrets)", async () => {
    const { tool, backend } = setup();
    const first = run(tool, { target, command: "export TOKEN=hunter2" });
    await tick();
    await first;

    // Kill the shell, so the next run genuinely reopens it.
    const exec = backend.execs[0] as FakeExec;
    exec.end();
    const reopened = run(tool, { target, command: "true" });
    await tick(12);
    const result = await reopened;

    expect(backend.execs).toHaveLength(2);
    // The sentence is the contract: a model must not assume `export`s survived,
    // and the tool must not have replayed them (it only ever re-sends a `cd`).
    expect(result.content).toContain("environment variables were not replayed");
    // Nothing but a `cd` is ever written back into a fresh shell.
    const reopenedExec = backend.execs[1] as FakeExec;
    expect(reopenedExec.commands.filter((c) => c.includes("export"))).toEqual([]);
  });
});

describe("dispose", () => {
  test("an open still priming when the session ends leaves NO live shell (D4)", async () => {
    const { tool, shells, backend } = setup();
    // The session ends while the backend is still resolving the engine.
    let release: () => void = () => {};
    backend.primeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promise = tool.execute({ action: "run", target, command: "echo hi" } as never, context());
    await tick();
    await shells.dispose();
    release();
    const result = await promise;

    expect(result.isError).toBe(true);
    // Nothing was even opened, so there is nothing to leave behind.
    expect(backend.execs).toHaveLength(0);
    expect(shells.size).toBe(0);
  });

  test("an open whose ready is cut by the session end leaves nothing live behind (D4)", async () => {
    const { tool, shells, backend } = setup();
    // The exec is opened, but its ready marker arrives only after the session end.
    let release: () => void = () => {};
    backend.openImpl = (exec) => {
      exec.readyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const promise = tool.execute({ action: "run", target, command: "echo hi" } as never, context());
    await tick();
    expect(backend.execs).toHaveLength(1); // the exec exists already
    await shells.dispose(); // …and the session ends before it is ready
    release();
    const result = await promise;
    await tick();

    expect(result.isError).toBe(true);
    const exec = backend.execs[0] as FakeExec;
    expect(exec.closed).toBe(true); // the stream it opened was closed
    expect(shells.size).toBe(0); // …and nothing stayed in the registry
    // No pid was ever parsed, so nothing pretends to kill a tree either: an
    // unready shell must never produce a `kill` naming the target pid 0 (in
    // `sh`, `kill -KILL 0` signals the caller's WHOLE process group instead).
    expect(backend.oneShots.every((s) => !s.script.includes("__tnt_target=0"))).toBe(true);
  });

  test("an open that turns ready AFTER the session end is closed, not run", async () => {
    const { tool, shells, backend } = setup();
    // The stream survives dispose's close (a backend's close is not always
    // synchronous with its `end`), so the open reaches its own ready await…
    let release: () => void = () => {};
    backend.openImpl = (exec) => {
      exec.closeWithoutEnd = true;
      exec.readyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const promise = tool.execute({ action: "run", target, command: "echo hi" } as never, context());
    await tick();
    await shells.dispose(); // …the session ends in it…
    release(); // …and the ready marker arrives afterwards.
    const result = await promise;

    // …and the open refuses instead of running a command on a dead session.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("already disposed");
    expect(shells.size).toBe(0);
  });

  test("closes every stream and issues the kill one-shot for each", async () => {
    const { tool, shells, backend } = setup();
    for (const name of ["a", "b"]) {
      const promise = run(tool, { target: { engine: "docker", name }, command: "true" });
      await tick();
      await promise;
    }
    expect(backend.oneShots).toHaveLength(0);

    await shells.dispose();
    await tick();
    expect(backend.execs.every((e) => e.closed)).toBe(true);
    expect(backend.oneShots).toHaveLength(2);
    expect(backend.oneShots.every((s) => s.script.includes("kill -KILL"))).toBe(true);
  });

  test("never throws, even when every one-shot fails", async () => {
    const { tool, shells, backend } = setup();
    const promise = run(tool, { target, command: "true" });
    await tick();
    await promise;
    backend.oneShotImpl = () => Promise.reject(new Error("RBAC says no"));
    await shells.dispose(); // must not reject
  });
});

describe("the timeout ladder and idle close", () => {
  test("a hung command is stopped by the TERM tree, and the shell SURVIVES (state kept)", async () => {
    const { tool, backend } = setup();
    backend.openImpl = (exec) => {
      // The first command hangs; the probe afterwards answers, so it survived.
      let first = true;
      exec.behaviour = (line) => {
        if (first) {
          first = false;
          return { hang: true };
        }
        return {};
      };
    };
    const result = await run(tool, { target, command: "sleep 1000", timeout: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("the shell (cwd/env) survived");
    expect(backend.oneShots[0]?.script).toContain("kill -TERM");
    expect(backend.execs).toHaveLength(1); // NOT restarted
  });

  test("a builtin loop that ignores the kill ladder restarts the shell, and says the state is gone", async () => {
    const { tool, backend } = setup();
    backend.openImpl = (exec) => {
      // A builtin loop: the shell is BUSY, so it cannot run the probe either.
      exec.hangProbe = true;
      exec.behaviour = () => ({ hang: true });
    };
    const result = await run(tool, { target, command: "while :; do :; done", timeout: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("shell restarted");
    // TERM tree, KILL tree, then the close sequence with includeSelf.
    const scripts = backend.oneShots.map((s) => s.script);
    expect(scripts.some((s) => s.includes("kill -TERM"))).toBe(true);
    expect(scripts.some((s) => s.includes("kill -KILL"))).toBe(true);
  });

  test("an aborted turn follows the same ladder and reports the abort", async () => {
    const { tool, backend } = setup();
    backend.openImpl = (exec) => {
      exec.behaviour = () => ({ hang: true });
    };
    const controller = new AbortController();
    const promise = tool.execute(
      { action: "run", target, command: "sleep 1000", timeout: 600 } as never,
      context({ signal: controller.signal }),
    );
    await tick(4);
    controller.abort();
    const result = await promise;
    expect(result.content).toContain("aborted");
    expect(backend.oneShots.length).toBeGreaterThan(0);
  });

  test("a shell idle past the close period is closed; the next run reopens with the reset notice", async () => {
    const { tool, backend } = setup({ idleCloseMs: 20 });
    const first = run(tool, { target, command: "true" });
    await tick();
    await first;
    expect(backend.execs).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 60)); // let the idle timer fire
    await tick();
    expect(backend.execs[0]?.closed).toBe(true);

    const second = await run(tool, { target, command: "true" });
    expect(backend.execs).toHaveLength(2);
    expect(second.content).toContain("new shell");
    expect(second.isError).toBe(true); // the state is gone: never silently "fine"
  });
});

describe("what the plan's §4 pin requires", () => {
  test("the bootstrap the tool sends is the pure module's line, verbatim", async () => {
    const { tool, backend } = setup();
    const promise = run(tool, { target, command: "true" });
    await tick();
    await promise;
    const exec = backend.execs[0] as FakeExec;
    // The line the tool sends IS the pure module's, character for character: no
    // interpolation of anything the daemon knows can slip in (§4 pin).
    expect(exec.raw[0]).toBe(bootstrapLine("").replace(/\n$/, ""));
    expect(exec.raw[0]).not.toContain("TENTACLE_");
  });
});

// docs/fix/workload-shell-live.md, owner decision 3: the owner saw a FRESH
// shell's FIRST command come back as `guard-3a6ec321…-end` instead of
// `etcd-guard-3a6ec321…-end`. What is PROVEN here is the mechanism these rows
// cover — the ready handshake dropped the bytes that rode the same read as the
// marker, and its tail cut disagreed with the ready parser about where the
// marker ended. What is NOT proven is that this was the owner's live cause:
// with a real `sh` the command line goes out after `await readyDone`, so a
// real shell cannot print `hostname` before it receives `hostname`.
describe("the first command on a fresh shell keeps its head (owner decision 3)", () => {
  test("a banner that rides the ready read is the first command's output, not lost", async () => {
    const backend = new FakeBackend();
    backend.openImpl = (exec) => {
      const original = exec.stdout.bind(exec);
      exec.stdout = (text: string): void => {
        if (text.startsWith(READY_PREFIX)) {
          // The ready marker, then the pod's own first line in the same write.
          original(`${text}banner line\n`);
          return;
        }
        original(text);
      };
    };
    const shells = new WorkloadShells(backend, { readyTimeoutMs: 2_000, killGraceMs: 60 });
    const tool = createWorkloadShellTool(shells);

    const promise = run(tool, { target, command: "hostname" });
    await tick();
    const result = await promise;

    // Mutation: drop the bytes after the ready marker → the banner is gone.
    expect(result.content).toContain("banner line");
    expect(result.content).toContain("hostname");
    await shells.dispose();
  });

  test("a HEAD split across the ready read is rejoined (the `guard-…-end` shape)", async () => {
    const HOST = "etcd-guard-3a6ec32139722234d98bed4f29e301189cef109a-end";
    const backend = new FakeBackend();
    backend.openImpl = (exec) => {
      const original = exec.stdout.bind(exec);
      let answered = false;
      exec.stdout = (text: string): void => {
        if (!answered && text.startsWith(READY_PREFIX)) {
          answered = true;
          // The ready marker's TAIL and the head of what follows, in one write:
          // the very split that produced `guard-…-end`.
          original(`${READY_PREFIX}4242_/home/app__TNT__E\n${HOST.slice(0, 5)}`);
          return;
        }
        original(text);
      };
      exec.behaviour = () => ({ out: HOST.slice(5) });
    };
    const shells = new WorkloadShells(backend, { readyTimeoutMs: 2_000, killGraceMs: 60 });
    const tool = createWorkloadShellTool(shells);

    const promise = run(tool, { target, command: "hostname" });
    await tick();
    const result = await promise;

    // The whole hostname, unbroken: neither the head lost nor the delimiter
    // leaked into it (owner decision 3's own assertion).
    expect(result.content).toContain(HOST);
    expect(result.content).not.toContain("__TNT_");
    await shells.dispose();
  });

  test("a pod line that contains the READY end sequence does not put the delimiter in the body", async () => {
    // Found in fix round 2: `parseReady` scans from the ready PREFIX, but the
    // tail cut used to scan from byte 0. A pod that prints `__TNT__E` BEFORE
    // the marker (an odd startup banner, a logging wrapper — and a pod is not
    // trusted, AGENTS §7) made the two disagree, so the cut landed on the banner's
    // sequence and handed the READY MARKER itself — delimiter and all — to the
    // first command's parser as its output. This is the only reachable way the
    // delimiter gets into a body, and it respects the write order (the banner
    // is written before the marker, the command line after `execute` arms).
    const backend = new FakeBackend();
    backend.openImpl = (exec) => {
      const original = exec.stdout.bind(exec);
      exec.stdout = (text: string): void => {
        if (text.startsWith(READY_PREFIX)) {
          original(`container says __TNT__E hello\n${text}`);
          return;
        }
        original(text);
      };
      exec.behaviour = () => ({ out: "hostname-output" });
    };
    const shells = new WorkloadShells(backend, { readyTimeoutMs: 2_000, killGraceMs: 60 });
    const tool = createWorkloadShellTool(shells);

    const promise = run(tool, { target, command: "hostname" });
    await tick();
    const result = await promise;

    // The banner is data, so it may be echoed — but never our framing, and
    // never the ready marker we generated ourselves.
    expect(result.content).toContain("hostname-output");
    expect(result.content).not.toContain("__TNT_");
    expect(result.content).not.toContain("__TNT__R_");
    await shells.dispose();
  });

  test("a command's output never carries the framing delimiter", async () => {
    const backend = new FakeBackend();
    backend.openImpl = (exec) => {
      exec.behaviour = () => ({ out: "plain output" });
    };
    const shells = new WorkloadShells(backend, { readyTimeoutMs: 2_000, killGraceMs: 60 });
    const tool = createWorkloadShellTool(shells);

    const promise = run(tool, { target, command: "echo plain" });
    await tick();
    const result = await promise;

    expect(result.content).toContain("plain output");
    expect(result.content).not.toContain("__TNT_");
    await shells.dispose();
  });
});

// docs/fix/workload-shell-live.md D4: the model was never TOLD about
// `container` — its doc was a JSDoc comment, which never reaches the JSON
// Schema (`definitions()` converts the Zod schema), so a model that hit the
// multi-container refusal had no field to reach for.
describe("what the model is offered (D4)", () => {
  const json = zodToJsonSchema(workloadShellSchema, { target: "openApi3" }) as {
    properties: {
      target: {
        properties: Record<string, { description?: string; type?: string }>;
        allOf?: unknown;
      };
    };
  };

  test("target.container carries a description naming the default-container annotation", () => {
    const container = json.properties.target.properties.container;
    expect(container?.description).toBeDefined();
    expect(container?.description).toContain("default-container");
    expect(container?.description).toContain("Kubernetes only");
    expect(json.properties.target.properties.namespace?.description).toContain("Kubernetes only");
  });

  test("the refine does not wrap the target in an allOf/effects schema (registry.ts converts it)", () => {
    // `registry.definitions()` hands this straight to the model: a wrapper would
    // hide `properties` entirely.
    expect(json.properties.target.allOf).toBeUndefined();
    expect(json.properties.target.properties.name?.type).toBe("string");
  });

  test("the tool description mentions target.container", () => {
    expect(WORKLOAD_SHELL_DESCRIPTION).toContain("target.container");
  });

  test("docker/podman with a container (or a namespace) is refused at parse, as move_session does", async () => {
    const { tool, backend } = setup();
    for (const rejected of [
      { engine: "docker", name: "box", container: "x" },
      { engine: "podman", name: "box", container: "x" },
      { engine: "docker", name: "box", namespace: "ns" },
    ]) {
      const result = await run(tool, { target: rejected, command: "true" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("only a kubernetes workload");
    }
    expect(backend.execs).toHaveLength(0); // nothing was opened
  });
});
