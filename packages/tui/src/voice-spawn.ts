/**
 * The voice helper's process edge — the ONE place in the TUI where a child
 * process exists for dictation (docs/feat/voice-dictation.md §5, F10/F13).
 *
 * Everything here is deliberately dumb: resolve the helper's path, spawn it with
 * every stream PIPED, split its stdout into lines, and end it reliably. The
 * decisions are the reducer's (`voice-session.ts`); this module only turns its
 * commands into effects, so the whole hook stays testable with a fake spawner and
 * no child process at all.
 *
 * **AGENTS §7, "never write raw to the terminal while Ink owns it":** stdin and
 * stdout are pipes (the protocol), and stderr goes to a FILE. `"inherit"` is not
 * merely unused — `spawnVoiceHelper` never produces it, and a test pins that.
 */
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { type HelperCommand, encodeHelperLine } from "./voice-protocol.ts";
import type { VoiceConfig } from "./voice-session.ts";

/** One stream's disposition, as Bun's `spawn` takes it. */
export type StreamDisposition = "pipe" | "ignore" | "inherit" | number;

/** Exactly what the spawner is asked to run: the seam a test replaces. */
export interface VoiceSpawnSpec {
  readonly cmd: readonly string[];
  readonly stdio: {
    readonly stdin: StreamDisposition;
    readonly stdout: StreamDisposition;
    readonly stderr: StreamDisposition;
  };
  /** Where the child's stderr is written (a file, never the terminal). */
  readonly logPath: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The child, as this module needs it (Bun's shape, narrowed). */
export interface VoiceChild {
  readonly stdin: { write(chunk: string | Uint8Array): unknown; end(): unknown } | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** The injectable spawner: `Bun.spawn` in production, a fake in a test. */
export type VoiceSpawner = (spec: VoiceSpawnSpec) => VoiceChild;

/**
 * Where the helper binary is looked for, in order (F3): the explicit setting,
 * a sibling of the running `tentacle`, then the config dir's own bin.
 */
export function helperPathCandidates(input: {
  readonly execPath: string;
  readonly configDir: string;
  readonly config: Pick<VoiceConfig, "helperPath">;
}): readonly string[] {
  const out: string[] = [];
  if (input.config.helperPath !== undefined && input.config.helperPath !== "") {
    out.push(input.config.helperPath);
  }
  const dir = resolve(input.execPath, "..");
  const sibling = resolve(dir, "tentacle-voice");
  if (!out.includes(sibling)) out.push(sibling);
  const inConfig = resolve(input.configDir, "voice", "bin", "tentacle-voice");
  if (!out.includes(inConfig)) out.push(inConfig);
  return out;
}

/**
 * Build the spawn spec. Every stream is a pipe except stderr, which is the log
 * FILE the caller opens: the helper must never be able to write into the
 * alternate screen (AGENTS §7, F10).
 *
 * `logPath` is `""` when the caller could not name a config dir (a host-less
 * mount): then no log file exists, and the helper's stderr is DRAINED to nothing
 * rather than dropped — a full pipe would block the child.
 */
export function voiceSpawnSpec(input: {
  readonly helperPath: string;
  readonly args?: readonly string[];
  readonly logPath: string;
  readonly env?: Readonly<Record<string, string>>;
}): VoiceSpawnSpec {
  return {
    cmd: [input.helperPath, ...(input.args ?? [])],
    // The helper's OWN streams: stdin/stdout speak the protocol, stderr is the
    // log file. `"inherit"` appears in NO position — a test pins that.
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    logPath: input.logPath,
    env: { ...(input.env ?? {}) },
  };
}

/** Spawn through the injected seam and hand back the child. */
export function spawnVoiceHelper(input: {
  readonly spawner: VoiceSpawner;
  readonly helperPath: string;
  readonly args?: readonly string[];
  readonly logPath: string;
  readonly env?: Readonly<Record<string, string>>;
}): VoiceChild {
  return input.spawner(
    voiceSpawnSpec({
      helperPath: input.helperPath,
      ...(input.args === undefined ? {} : { args: input.args }),
      logPath: input.logPath,
      ...(input.env === undefined ? {} : { env: input.env }),
    }),
  );
}

/**
 * The `Bun.spawn` options the REAL spawner uses, derived from the spec.
 *
 * Extracted (Review round 1, MEDIUM 5) because the spawner used to hardcode
 * `stderr: "pipe"`/`stdin: "pipe"` beside the spec: T8 pinned the spec, which
 * nothing on the production path read, so its mutation stayed green. Now the
 * production spawner consumes THIS, and a test pins it directly.
 * `stderr` is the log FILE (an fd), so the helper can never paint the
 * alt-screen (AGENTS §7); when the caller named no config dir there is no file
 * and the stream is still a pipe, drained by the caller.
 */
export function bunSpawnOptions(
  spec: VoiceSpawnSpec,
  logFd: number | null,
): {
  stdin: StreamDisposition;
  stdout: StreamDisposition;
  stderr: StreamDisposition;
  env: Record<string, string | undefined>;
} {
  return {
    stdin: spec.stdio.stdin,
    stdout: spec.stdio.stdout,
    stderr: logFd ?? spec.stdio.stderr,
    env: { ...process.env, ...spec.env },
  };
}

/** The log is rotated (kept as `.1`) once it passes this size (plan §3). */
export const LOG_ROTATE_BYTES = 1024 * 1024;

/**
 * Open the helper's log for append, creating `<configDir>/voice/` first.
 *
 * Review round 2, NEW-2: the directory was assumed to exist, so on a machine
 * where nothing had created it `openSync` threw ENOENT, the spawn was reported
 * as "helper not found", and the reducer was never told — the strip stayed
 * `● starting` with no mic. The log is also rotated at 1 MiB (plan §3), which
 * was documented but absent.
 *
 * `""` means "the caller could not name a config dir": no file, no fd, and the
 * child's stderr is drained to nothing instead.
 */
export function openVoiceLog(logPath: string, fs: LogFs = realLogFs): number | null {
  if (logPath === "") return null;
  const slash = logPath.lastIndexOf("/");
  if (slash > 0) fs.mkdir(logPath.slice(0, slash));
  const size = fs.size(logPath);
  if (size !== null && size >= LOG_ROTATE_BYTES) fs.rotate(logPath);
  return fs.open(logPath);
}

/** The three file operations `openVoiceLog` needs, injectable so a test can
 * assert the ORDER (mkdir before open) and the rotation without a big file. */
export interface LogFs {
  mkdir(dir: string): void;
  size(path: string): number | null;
  rotate(path: string): void;
  open(path: string): number;
}

const realLogFs: LogFs = {
  mkdir: (dir) => {
    // Best effort: a read-only mount must not turn a dictation into a crash —
    // the `open` below then fails and the caller reports it honestly.
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // left to `open`
    }
  },
  size: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  rotate: (path) => {
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // a lost rotation is not worth a failed dictation
    }
  },
  open: (path) => openSync(path, "a"),
};

/** What this module needs from a spawned process (Bun's shape, narrowed). */
export interface SpawnedProc {
  readonly stdin: { write(chunk: string | Uint8Array): unknown; end(): unknown } | null;
  readonly stdout: ReadableStream<Uint8Array>;
  /** A pipe when the spec asked for one; an fd when the log took it. */
  readonly stderr: ReadableStream<Uint8Array> | number | undefined;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** The `Bun.spawn` call, as the seam a test replaces (Review round 2, MEDIUM 5). */
export type BunSpawnFn = (
  cmd: readonly string[],
  options: ReturnType<typeof bunSpawnOptions>,
) => SpawnedProc;

/**
 * Build the REAL spawner, with its two irreducibles injected: the `Bun.spawn`
 * call and the log file's file-system operations.
 *
 * Extracted here (Review round 2, MEDIUM 5) because the spawn was the ONE place
 * the spec was not read: the old `bunSpawnProc` hardcoded `stdin`/`stdout`/
 * `stderr`, so mutating the spec (`stderr: "inherit"`) — and the hardcoded call
 * itself — stayed green in every test. The caller supplies `Bun.spawn`; a test
 * supplies a recorder and asserts the options this function builds, so neither
 * can drift again.
 */
export function makeDefaultSpawner(
  spawn: BunSpawnFn,
  fs: LogFs | undefined = undefined,
): VoiceSpawner {
  return (spec) => {
    // The log FILE, first: the helper's stderr goes there, never to the frame
    // (AGENTS §7, F10), and `append` keeps an earlier dictation's lines. The
    // directory is created first, and the file rotated at 1 MiB (NEW-2, plan §3).
    let log: number | null = null;
    try {
      log = fs === undefined ? openVoiceLog(spec.logPath) : openVoiceLog(spec.logPath, fs);
    } catch {
      // An unwritable log must not be reported as a missing binary (NEW-2): it
      // is re-thrown, and `useVoice` turns it into a `spawnFailed` event with
      // its own message.
      throw new Error(`cannot open the voice log ${spec.logPath}`);
    }
    const options = bunSpawnOptions(spec, log);
    let proc: SpawnedProc;
    try {
      proc = spawn(spec.cmd, options);
    } catch (error) {
      if (log !== null) {
        try {
          closeSync(log);
        } catch {
          // already closed
        }
      }
      throw error;
    }
    // Piped and DRAINED: a full stderr pipe would block the helper.
    if (proc.stderr !== undefined && typeof proc.stderr !== "number") drainTo(proc.stderr, log);
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      // The caller never gets a raw stream to leak: stderr went to the log fd.
      stderr: null,
      exited: proc.exited.finally(() => {
        if (log === null) return;
        try {
          closeSync(log);
        } catch {
          // already closed
        }
      }),
      kill: (signal) => {
        try {
          proc.kill(signal as NodeJS.Signals | undefined);
        } catch {
          // already gone
        }
      },
    };
  };
}

/** Copy a child's stderr into the log file (or drain it), until it closes. */
function drainTo(stream: ReadableStream<Uint8Array>, fd: number | null): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // No fd to write to (a host-less mount): the child must still not block.
        if (fd === null) continue;
        try {
          writeSync(fd, decoder.decode(value, { stream: true }));
        } catch {
          return;
        }
      }
    } catch {
      // The child died mid-line: the exit event is the one that reports it.
    } finally {
      reader.releaseLock?.();
    }
  })();
}

/** Split a stdout chunk into complete lines, keeping the unfinished tail. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  // A CRLF stream leaves a trailing \r on each line; the parser trims anyway,
  // but dropping it here keeps the line cap honest about what was sent.
  return { lines: parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), rest };
}

/** Write one protocol line. A closed stdin (a dead child) is a no-op, not a throw. */
export function sendCommand(child: VoiceChild, command: HelperCommand): void {
  const stdin = child.stdin;
  if (stdin === null) return;
  try {
    stdin.write(encodeHelperLine(command));
  } catch {
    // The child exited between the decision and the write: the exit event is the
    // one that reports this, so a failed write must not crash the render.
  }
}

/**
 * End the child, reliably (F13): close stdin (the helper exits on EOF — its own
 * LIFETIME rule), then SIGTERM after `graceMs` if it is still there. Returns
 * when the child is gone (or the timer fired).
 */
export async function endChild(child: VoiceChild, graceMs = 500): Promise<void> {
  try {
    void child.stdin?.end();
  } catch {
    // already closed
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolveTimeout();
    }, graceMs);
  });
  try {
    await Promise.race([child.exited.then(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
