/**
 * HEIC/HEIF → JPEG, the ONE effectful edge (docs/feat/image-heic.md D3): the OS's
 * own decoder (macOS `sips`, ImageIO), in a child process, under `sandbox-exec`.
 * No codec ships with tentacle, and where there is no confined decoder there is
 * no converter at all — never an unconfined run.
 *
 * The bytes are untrusted: `sips` is handed only OUR copy of them, has no
 * network, reads nothing under `/Users` or `/Volumes`, writes only in the user
 * temp dir, can neither fork nor run another program, and is bounded in time,
 * output and number. What it writes is believed only after core's strict checks
 * (`convertHeicWith`). Not a deny-default sandbox: Mach/XPC services are not
 * denied (docs/feat/image-heic.md Notes).
 */
import { existsSync } from "node:fs";
import { constants, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HEIC_CONVERT_TIMEOUT_MS,
  HEIC_JPEG_QUALITY,
  type HeicConverter,
  type HeicRefusal,
  type HeicSize,
  MAX_IMAGE_BYTES,
  convertHeicWith,
  imageOverCapReason,
} from "@tentacle/core";

const SIPS = "/usr/bin/sips";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** What is kept of each of the child's pipes. */
const PIPE_BYTES = 64 * 1024;
/** How much of its first error line a refusal quotes. */
const REASON_CHARS = 120;
/** Conversions alive at once in this process. */
const MAX_CONVERSIONS = 2;

export interface HeicSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Never `inherit`: Ink may own the terminal. */
  readonly stdin: "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
}

export interface HeicChild {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: "SIGKILL"): void;
}

export type HeicSpawn = (argv: string[], options: HeicSpawnOptions) => HeicChild;

export interface SipsDeps {
  readonly platform?: string;
  readonly exists?: (path: string) => boolean;
  readonly spawn?: HeicSpawn;
  /** Where the work happens, and the ONE place the child may write. */
  readonly tmpRoot?: string;
  readonly timeoutMs?: number;
}

/** `sips -g pixelWidth -g pixelHeight`'s answer; `<nil>` or a missing side is none. */
export function parseSipsSize(stdout: string): HeicSize | undefined {
  const side = (key: string): number | undefined => {
    const found = new RegExp(`^\\s+${key}: (\\d+)\\s*$`, "m").exec(stdout)?.[1];
    return found === undefined ? undefined : Number(found);
  };
  const w = side("pixelWidth");
  const h = side("pixelHeight");
  return w === undefined || h === undefined ? undefined : { w, h };
}

/**
 * The sandbox profile: all allowed but the network, reads of the user's files,
 * writes elsewhere, forking, and running any program but `sips` itself.
 */
export function sipsSandboxProfile(writable: string): string {
  const quoted = writable.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `(version 1)(allow default)(deny network*)(deny file-read* (subpath "/Users") (subpath "/Volumes"))(deny file-write* (require-not (subpath "${quoted}")))(deny process-fork)(deny process-exec* (require-not (literal "${SIPS}")))`;
}

/** The one method `drain` needs: the two `ReadableStream` typings disagree on the rest. */
interface PipeReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
}

/** Drain a pipe to its end, keeping its first `PIPE_BYTES`. */
async function drain(reader: PipeReader): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      return text;
    }
    const part = value.subarray(0, PIPE_BYTES - kept);
    kept += part.length;
    text += decoder.decode(part, { stream: true });
  }
}

/**
 * The per-user temp dir. `sips` writes its own scratch there whatever `TMPDIR`
 * says (our environment's or the empty one we give it), so it — never
 * `os.tmpdir()`, which follows `TMPDIR` — is what the sandbox leaves writable.
 */
async function userTempDir(): Promise<string> {
  const child = Bun.spawn(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const dir = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0 || !dir.startsWith("/")) {
    throw new Error("no user temp directory");
  }
  return dir;
}

/** A child's error as a few printable characters: it may end up on a terminal. */
function errorLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.replace(/\p{Cc}/gu, "").slice(0, REASON_CHARS);
}

const undecodable = (why: string): HeicRefusal => ({
  refused: `the HEIC could not be decoded (${why})`,
});

/** One confined `sips` run in `dir`: its stdout, or why there is none. */
async function runSips(
  spawn: HeicSpawn,
  profile: string,
  dir: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly stdout: string } | HeicRefusal> {
  const child = spawn([SANDBOX_EXEC, "-p", profile, SIPS, ...args], {
    cwd: dir,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.getReader();
  const err = child.stderr.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    // A pipe something else still holds must not keep us waiting.
    void out.cancel().catch(() => {});
    void err.cancel().catch(() => {});
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([drain(out), drain(err), child.exited]);
    if (timedOut) {
      return { refused: `the HEIC took over ${timeoutMs / 1000} s to decode` };
    }
    if (code !== 0) {
      return undecodable(errorLine(stderr) || errorLine(stdout) || `exit ${code}`);
    }
    return { stdout };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The child's output, read as untrusted: never through a symlink it may have
 * left (we are not confined, it is), only a regular file, only within the bound.
 */
async function readOutput(path: string): Promise<Uint8Array | HeicRefusal> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undecodable("no output");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return undecodable("no output");
    }
    if (info.size > MAX_IMAGE_BYTES) {
      return { refused: imageOverCapReason(info.size, MAX_IMAGE_BYTES) };
    }
    const buffer = new Uint8Array(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

let converting = 0;
const waiting: (() => void)[] = [];

/** FIFO, `MAX_CONVERSIONS` at a time: a batch of HEICs cannot fill the host's memory. */
async function gated<T>(work: () => Promise<T>): Promise<T> {
  if (converting < MAX_CONVERSIONS) {
    converting += 1;
  } else {
    // The one who finishes hands its slot over.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next === undefined) {
      converting -= 1;
    } else {
      next();
    }
  }
}

/**
 * The converter, or `undefined` where there is no confined decoder: not macOS,
 * or `sips` / `sandbox-exec` is missing (fail closed).
 */
export function createSipsHeicConverter(deps: SipsDeps = {}): HeicConverter | undefined {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  if (platform !== "darwin" || !exists(SIPS) || !exists(SANDBOX_EXEC)) {
    return undefined;
  }
  const spawn: HeicSpawn = deps.spawn ?? ((argv, options) => Bun.spawn(argv, options));
  const timeoutMs = deps.timeoutMs ?? HEIC_CONVERT_TIMEOUT_MS;
  return (bytes, limits) =>
    gated(async () => {
      let dir: string | undefined;
      try {
        // Resolved, as the sandbox sees it.
        const root = await realpath(deps.tmpRoot ?? (await userTempDir()));
        const work = await mkdtemp(join(root, "tentacle-heic-"));
        dir = work;
        const input = join(work, "in.heic");
        await writeFile(input, bytes);
        const profile = sipsSandboxProfile(root);
        const sips = (args: readonly string[]) => runSips(spawn, profile, work, args, timeoutMs);
        let outputs = 0;
        return await convertHeicWith(limits, {
          size: async () => {
            const ran = await sips(["-g", "pixelWidth", "-g", "pixelHeight", input]);
            return "refused" in ran ? ran : parseSipsSize(ran.stdout);
          },
          toJpeg: async (edge) => {
            const output = join(work, `out-${outputs}.jpg`);
            outputs += 1;
            const ran = await sips([
              "-s",
              "format",
              "jpeg",
              "-s",
              "formatOptions",
              String(HEIC_JPEG_QUALITY),
              ...(edge === undefined ? [] : ["-Z", String(edge)]),
              input,
              "--out",
              output,
            ]);
            return "refused" in ran ? ran : readOutput(output);
          },
        });
      } catch (error) {
        const why = errorLine(error instanceof Error ? error.message : String(error));
        return { refused: `the HEIC could not be converted (${why})` };
      } finally {
        if (dir !== undefined) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    });
}

let memo: { readonly converter: HeicConverter | undefined } | undefined;

/** This host's converter, made once per process. */
export function defaultHeicConverter(): HeicConverter | undefined {
  memo ??= { converter: createSipsHeicConverter() };
  return memo.converter;
}
