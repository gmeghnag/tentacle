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
 */
export function voiceSpawnSpec(input: {
  readonly helperPath: string;
  readonly args?: readonly string[];
  readonly logPath: string;
  readonly env?: Readonly<Record<string, string>>;
}): VoiceSpawnSpec {
  return {
    cmd: [input.helperPath, ...(input.args ?? [])],
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
