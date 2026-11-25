/**
 * The local-process transport (docs/feat/subagent-harness-runners.md D2): ONE
 * `HarnessAdapter` for any CLI, built from a `CliCodec` (the pure half) and an
 * injected `Spawner` (the fake in tests). It spawns the CLI detached in its own
 * process group, tracks the group (so tentacle's exit net reaps it), reads
 * stdout as capped lines, keeps a stderr tail, and runs the cancel ladder.
 *
 * Limits (hang guard, token budget) are NOT here: the runner owns them (D2).
 * The process-group functions are injected (`ProcessGroups`): `@tentacle/exec`
 * provides them (`trackGroup` / `untrackGroup` / `killGroup`), wired in by the
 * caller, so this package gains no dependency on `exec`.
 */

import { scrubSensitiveEnv } from "@tentacle/core";
import { versionAtLeast } from "./claude-code.ts";
import type {
  CliCodec,
  HarnessAdapter,
  HarnessCaps,
  HarnessDecision,
  HarnessEvent,
  HarnessProbe,
  HarnessRun,
  HarnessRunSpec,
} from "./types.ts";

/** The slice of a child process the transport needs (a fake in tests). */
export interface HarnessProc {
  readonly pid: number;
  /** Write to stdin; may throw once the pipe is closed. */
  write(data: string): void;
  /** Close stdin (EOF). */
  endInput(): void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code (a signal death is a non-zero code). */
  readonly exited: Promise<number>;
  /** Signal the leader only (the group is signalled through `ProcessGroups`). */
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

/** Spawns `cmd` detached (its own process group, pgid = pid). Throws if it cannot start. */
export type Spawner = (cmd: readonly string[], options: SpawnOptions) => HarnessProc;

/** `@tentacle/exec`'s `trackGroup` / `untrackGroup` / `killGroup`, injected. */
export interface ProcessGroups {
  track(pgid: number): void;
  untrack(pgid: number): void;
  kill(pgid: number, signal: NodeJS.Signals): boolean;
}

export const HARNESS_LINE_CAP = 8 * 1024 * 1024;
export const HARNESS_STDERR_TAIL = 4 * 1024;
export const HARNESS_INTERRUPT_GRACE_MS = 5000;
export const HARNESS_KILL_GRACE_MS = 2000;
/** After the leader exits, how long to wait for stdout EOF (a grandchild may hold the pipe). */
const STDOUT_DRAIN_GRACE_MS = 250;
const PROBE_TIMEOUT_MS = 10_000;
/**
 * The ONLY init permission mode a run may proceed in (D4 version-skew defence):
 * an ALLOWLIST, so a missing, renamed or future mode is refused, never assumed
 * safe. `default` = every decision reaches us through the permission prompt.
 */
const SAFE_MODES: ReadonlySet<string> = new Set(["default"]);
/** What may arrive before a checked init: nothing that runs a tool or the model's output. */
const BEFORE_INIT: ReadonlySet<HarnessEvent["kind"]> = new Set(["end", "quota"]);

/** A run that ended without a result (crash, kill, failed init check). */
export class HarnessFailure extends Error {
  constructor(
    message: string,
    readonly details: {
      readonly exitCode?: number;
      readonly stderrTail: string;
      /** The text seen so far (a partial report). */
      readonly partial: string;
      /** The line cap dropped this many lines. */
      readonly droppedLines: number;
      readonly unparsableLines: number;
    },
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}

export const DEFAULT_SPAWNER: Spawner = (cmd, options) => {
  const proc = Bun.spawn([...cmd], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env as Record<string, string> } : {}),
    // Its own process group (pgid = pid) so the group can be signalled / tracked.
    ...({ detached: true } as object),
  });
  return {
    pid: proc.pid,
    write: (data) => {
      proc.stdin.write(data);
      proc.stdin.flush();
    },
    endInput: () => {
      proc.stdin.end();
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal),
  };
};

export interface ProcessAdapterDeps {
  /** Instance name (`claude-code`). */
  readonly id: string;
  /** The executable (`claude`, or the configured `command`). */
  readonly command: string;
  /** A fresh codec per run (the parser is stateful). */
  readonly codec: () => CliCodec;
  readonly caps: HarnessCaps;
  readonly groups: ProcessGroups;
  readonly spawner?: Spawner;
  /**
   * Explicit vars laid over the scrubbed host env, NOT scrubbed (an opt-in, the
   * shell's `options.env` policy). The host env itself never reaches the child
   * unscrubbed: its keys/tokens would be one `env` away from Claude's context.
   */
  readonly env?: Record<string, string | undefined>;
  /** The host env the child's is built from (default `process.env`; a test seam). */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** What the codec runs with when `spec.tools` is absent (checked against `init.tools`). */
  readonly defaultTools?: readonly string[];
  readonly lineCap?: number;
  readonly interruptGraceMs?: number;
  readonly killGraceMs?: number;
}

/** A single-consumer async queue that can be failed. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: { resolve: () => void } | undefined;
  private closed = false;
  private error: unknown;
  private hasError = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.hasError = true;
    this.closed = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.resolve();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        if (this.hasError) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = { resolve };
      });
    }
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export function createProcessAdapter(deps: ProcessAdapterDeps): HarnessAdapter {
  const spawner = deps.spawner ?? DEFAULT_SPAWNER;
  const lineCap = deps.lineCap ?? HARNESS_LINE_CAP;
  const interruptGraceMs = deps.interruptGraceMs ?? HARNESS_INTERRUPT_GRACE_MS;
  const killGraceMs = deps.killGraceMs ?? HARNESS_KILL_GRACE_MS;
  // Built per spawn (the host env is live): always an explicit env, so `Bun.spawn`
  // never falls back to inheriting tentacle's own (exec/host-execution.ts policy).
  const childEnv = (): Record<string, string> => {
    const env = scrubSensitiveEnv(deps.hostEnv ?? process.env);
    for (const [key, value] of Object.entries(deps.env ?? {})) {
      if (value !== undefined) env[key] = value;
    }
    return env;
  };

  const probe = async (signal: AbortSignal): Promise<HarnessProbe> => {
    const floor = deps.codec().versionFloor;
    let proc: HarnessProc;
    try {
      proc = spawner([deps.command, "--version"], { env: childEnv() });
    } catch (err) {
      return {
        ok: false,
        reason: `${deps.id} not installed (\`${deps.command}\`): ${errMessage(err)}`,
      };
    }
    try {
      proc.endInput();
    } catch {}
    const read = new Response(proc.stdout).text();
    const code = await Promise.race([
      proc.exited,
      delay(PROBE_TIMEOUT_MS).then(() => "timeout" as const),
      new Promise<"aborted">((resolve) => {
        if (signal.aborted) resolve("aborted");
        else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      }),
    ]);
    if (code === "timeout" || code === "aborted") {
      proc.kill("SIGKILL");
      return {
        ok: false,
        reason: `\`${deps.command} --version\` ${code === "timeout" ? "timed out" : "was aborted"}`,
      };
    }
    const out = await read;
    const version = /\d+\.\d+\.\d+/.exec(out)?.[0];
    if (code !== 0 || version === undefined) {
      return { ok: false, reason: `\`${deps.command} --version\` gave no version (exit ${code})` };
    }
    if (!versionAtLeast(version, floor)) {
      return {
        ok: false,
        version,
        reason: `${deps.id} ${version} is older than the supported ${floor}`,
      };
    }
    return { ok: true, version };
  };

  const start = async (spec: HarnessRunSpec, signal: AbortSignal): Promise<HarnessRun> => {
    if (signal.aborted) throw new Error("aborted before start");
    const codec = deps.codec();
    const argv = codec.argv(spec); // throws on a spec the codec refuses: before any spawn
    const proc = spawner([deps.command, ...argv], { cwd: spec.cwd, env: childEnv() });
    const pgid = proc.pid;
    deps.groups.track(pgid);

    const queue = new EventQueue<HarnessEvent>();
    const allowedTools = spec.tools ?? deps.defaultTools;
    let stderrTail = "";
    let dropped = 0;
    let unparsable = 0;
    let partial = "";
    let sawEnd = false;
    let exited = false;
    let cancelRequested = false;
    let initViolation: string | undefined;
    let inputClosed = false;

    let resolveEnd: () => void = () => {};
    const endSeen = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const exitCode = proc.exited.then(
      (code) => {
        exited = true;
        deps.groups.untrack(pgid);
        return code;
      },
      () => {
        exited = true;
        deps.groups.untrack(pgid);
        return -1;
      },
    );

    const closeInput = (): void => {
      if (inputClosed) return;
      inputClosed = true;
      try {
        proc.endInput();
      } catch {}
    };
    const writeLine = (line: string): boolean => {
      if (exited || inputClosed) return false;
      try {
        proc.write(line.endsWith("\n") ? line : `${line}\n`);
        return true;
      } catch {
        return false;
      }
    };
    const killTree = (sig: NodeJS.Signals): void => {
      if (!deps.groups.kill(pgid, sig)) {
        try {
          proc.kill(sig);
        } catch {}
      }
    };

    // Fails CLOSED: nothing but `end`/`quota` before a checked init, and the init
    // must PROVE the run is safe (allowlisted mode, the tool list when we set one).
    let initChecked = false;
    const checkInit = (event: HarnessEvent): string | undefined => {
      if (event.kind !== "started") {
        return initChecked || BEFORE_INIT.has(event.kind)
          ? undefined
          : `"${event.kind}" before a checked init`;
      }
      const { permissionMode, tools, version } = event.detail;
      if (permissionMode === undefined) return "init gave no permissionMode";
      if (!SAFE_MODES.has(permissionMode)) {
        return `init permissionMode "${permissionMode}" is not "default": it could bypass the broker`;
      }
      if (allowedTools) {
        if (!tools) return "init does not list its tools";
        const extra = tools.filter((t) => !allowedTools.includes(t));
        if (extra.length > 0) return `init lists tools we did not allow: ${extra.join(", ")}`;
      }
      if (version !== undefined && !versionAtLeast(version, codec.versionFloor)) {
        return `version ${version} is older than ${codec.versionFloor}`;
      }
      initChecked = true;
      return undefined;
    };

    const handleLine = (line: string): void => {
      if (sawEnd || initViolation !== undefined) return;
      if (line.trim() === "") return;
      const events = codec.parse(line);
      if (events === null) {
        unparsable++;
        return;
      }
      for (const event of events) {
        const bad = checkInit(event);
        if (bad !== undefined) {
          initViolation = bad;
          killTree("SIGKILL"); // before any tool can run
          return;
        }
        if (event.kind === "output" && event.text) partial += event.text;
        queue.push(event);
        if (event.kind === "end") {
          sawEnd = true;
          queue.close(); // exactly one `end`; the process is reaped separately
          resolveEnd();
          return;
        }
      }
    };

    // stdout → capped lines. An over-long line is dropped and counted, never held whole.
    const pumpStdout = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      void exitCode.then(() => {
        setTimeout(() => {
          reader.cancel().catch(() => {});
        }, STDOUT_DRAIN_GRACE_MS).unref?.();
      });
      const decoder = new TextDecoder();
      let buf = "";
      let dropping = false;
      const feed = (text: string): void => {
        let rest = text;
        for (;;) {
          const nl = rest.indexOf("\n");
          if (nl === -1) {
            if (dropping) return;
            buf += rest;
            if (buf.length > lineCap) {
              dropping = true;
              buf = "";
            }
            return;
          }
          const head = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          if (dropping) {
            dropping = false;
            dropped++;
            continue;
          }
          const line = buf + head;
          buf = "";
          if (line.length > lineCap) dropped++;
          else handleLine(line);
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
        feed(decoder.decode());
        if (dropping) dropped++;
        else if (buf.trim() !== "") handleLine(buf);
      } catch {
        // a cancelled reader (drain grace) or a broken pipe: fall through to the exit handling
      }
    };

    const pumpStderr = async (): Promise<void> => {
      const reader = proc.stderr.getReader();
      void exitCode.then(() => {
        setTimeout(() => {
          reader.cancel().catch(() => {});
        }, STDOUT_DRAIN_GRACE_MS).unref?.();
      });
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(
            -HARNESS_STDERR_TAIL,
          );
        }
      } catch {}
    };

    const finish = async (): Promise<void> => {
      const [code] = await Promise.all([exitCode, pumpStdout(), pumpStderr()]);
      if (sawEnd) {
        queue.close();
        return;
      }
      const details = {
        exitCode: code,
        stderrTail,
        partial,
        droppedLines: dropped,
        unparsableLines: unparsable,
      };
      if (initViolation !== undefined) {
        queue.fail(new HarnessFailure(`${deps.id} refused: ${initViolation}`, details));
      } else if (cancelRequested) {
        queue.push({ kind: "end", status: "cancelled", ...(partial ? { text: partial } : {}) });
        queue.close();
      } else {
        const tail = stderrTail.trim();
        queue.fail(
          new HarnessFailure(
            `${deps.id} exited with code ${code} without a result${tail ? `: ${tail}` : ""}`,
            details,
          ),
        );
      }
    };
    const done = finish();

    // After the result: EOF on stdin ends the CLI; reap it if it lingers.
    void endSeen.then(async () => {
      closeInput();
      const winner = await Promise.race([exitCode, delay(killGraceMs).then(() => undefined)]);
      if (winner === undefined) {
        killTree("SIGTERM");
        const second = await Promise.race([exitCode, delay(killGraceMs).then(() => undefined)]);
        if (second === undefined) killTree("SIGKILL");
      }
    });

    // Prompt first (the codec decides the framing).
    if (!writeLine(codec.userMessage(spec.prompt))) {
      killTree("SIGKILL");
    }

    let cancelling: Promise<"confirmed" | "unconfirmed"> | undefined;
    const waitEnd = async (ms: number): Promise<boolean> =>
      (await Promise.race([
        endSeen.then(() => true),
        exitCode.then(() => true),
        delay(ms).then(() => false),
      ])) === true;

    // interrupt → wait for `end` → stdin EOF → SIGTERM group → grace → SIGKILL group.
    const cancel = (): Promise<"confirmed" | "unconfirmed"> => {
      if (cancelling) return cancelling;
      cancelling = (async () => {
        if (exited || sawEnd) return "confirmed" as const;
        cancelRequested = true;
        const interrupt = codec.interrupt();
        if (interrupt !== undefined) {
          writeLine(interrupt);
          if (await waitEnd(interruptGraceMs)) {
            await Promise.race([exitCode, delay(killGraceMs)]);
            return exited ? "confirmed" : "unconfirmed";
          }
        }
        closeInput();
        if (interrupt === undefined && (await waitEnd(interruptGraceMs))) {
          await Promise.race([exitCode, delay(killGraceMs)]);
          return exited ? "confirmed" : "unconfirmed";
        }
        killTree("SIGTERM");
        if ((await Promise.race([exitCode, delay(killGraceMs)])) === undefined || !exited) {
          killTree("SIGKILL");
          await Promise.race([exitCode, delay(killGraceMs)]);
        }
        return exited ? "confirmed" : "unconfirmed";
      })();
      return cancelling;
    };

    const onAbort = (): void => {
      void cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void done.finally(() => signal.removeEventListener("abort", onAbort));

    return {
      events: queue,
      answer: async (askId: string, decision: HarnessDecision): Promise<void> => {
        // A late answer (the run ended, its ask withdrawn) is dropped.
        if (sawEnd || exited) return;
        writeLine(codec.answer(askId, decision));
      },
      send: async (text: string): Promise<void> => {
        if (!deps.caps.steer || sawEnd || exited) return;
        writeLine(codec.userMessage(text));
      },
      cancel,
    };
  };

  return { id: deps.id, kind: "local-process", caps: deps.caps, probe, start };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
