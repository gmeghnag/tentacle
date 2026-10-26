/**
 * A one-shot exec that RESOLVES ON COMMAND EXIT — the counterpart of
 * `execChannel`, and the Docker twin of `@tentacle/k8s`'s
 * `runExecOverWebSocket` (same result/option shapes): probe the arch, verify
 * an injected binary, stream the binary itself.
 *
 * After the hijack, `input` is pumped in 256 KiB chunks while the connection's
 * queue is below `SEND_HIGH_WATER_BYTES`, resuming on `drain` (event-driven,
 * no polling); then a write-side half-close is the command's stdin EOF — so no
 * `head -c N` is needed (it still works). When the stream ends, the REAL exit
 * code comes from `GET /exec/{id}/json` (k8s only gives Success/Failure).
 */
import type { ByteDuplex } from "./byte-duplex.ts";
import { type ExecConn, createExec, execStartRequest, toError } from "./exec-channel.ts";
import { apiError, hijack, request } from "./http-conn.ts";
import { StdDemux } from "./stdcopy.ts";
import type { DockerExecTarget, ExecInspect, RunExecOptions, RunExecResult } from "./types.ts";

/** stdin is written in chunks of this size. */
const STDIN_CHUNK_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Stop feeding once this many bytes are queued in the connection; resume on drain. */
export const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** The stream can close a beat before the engine marks the exec finished. */
export const EXIT_POLL_ATTEMPTS = 20;
export const EXIT_POLL_INTERVAL_MS = 25;

/** Read the exec's state (`Running`, `ExitCode`). */
export async function inspectExec(
  conn: ExecConn,
  execId: string,
  signal?: AbortSignal,
): Promise<ExecInspect> {
  const v = await conn.apiPath();
  const res = await request(
    conn.dial,
    { method: "GET", path: `${v}/exec/${encodeURIComponent(execId)}/json` },
    signal ? { signal } : {},
  );
  if (res.status !== 200) {
    throw apiError(res);
  }
  return JSON.parse(new TextDecoder().decode(res.body)) as ExecInspect;
}

/**
 * The engine reports a binary it could not start (no shell in the image, a
 * typo, a missing loader) as output text + exit 126/127. Name it plainly.
 */
function startFailure(
  target: DockerExecTarget,
  exitCode: number | null,
  output: string,
): string | undefined {
  if (exitCode !== 126 && exitCode !== 127) {
    return undefined;
  }
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) =>
      /executable file not found|no such file or directory|permission denied|exec format error/i.test(
        l,
      ),
    );
  if (line === undefined) {
    return undefined;
  }
  return `command ${JSON.stringify(target.command[0] ?? "")} could not be started in container "${target.container}" (exit ${exitCode}): ${line}`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function runExec(
  conn: ExecConn,
  target: DockerExecTarget,
  input?: Uint8Array,
  options: RunExecOptions = {},
): Promise<RunExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunExecResult>((resolve, reject) => {
    const life = new AbortController();
    let settled = false;
    let duplex: ByteDuplex | undefined;
    const stdoutDec = new TextDecoder();
    const stderrDec = new TextDecoder();
    const sysDec = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let systemErr = "";
    let malformed: string | undefined;
    let offset = 0;
    let ended = false;

    const finish = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      life.abort();
      duplex?.close();
      reject(error);
    };
    const succeed = (result: RunExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      duplex?.close();
      resolve(result);
    };
    const onAbort = (): void => fail(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(
      () => fail(new Error(`exec timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const demux = new StdDemux({
      onStdout: (b) => {
        stdout += stdoutDec.decode(b, { stream: true });
      },
      onStderr: (b) => {
        stderr += stderrDec.decode(b, { stream: true });
      },
      onSystemErr: (b) => {
        systemErr += sysDec.decode(b, { stream: true });
      },
      onError: (message) => {
        malformed = message;
      },
    });

    const pump = (): void => {
      const d = duplex;
      if (d === undefined || settled || ended) {
        return;
      }
      const data = input ?? new Uint8Array(0);
      while (offset < data.length) {
        if (d.buffered >= SEND_HIGH_WATER_BYTES) {
          return; // `onDrain` resumes
        }
        const end = Math.min(offset + STDIN_CHUNK_BYTES, data.length);
        d.write(data.subarray(offset, end));
        offset = end;
        options.onProgress?.(offset);
      }
      ended = true;
      d.end(); // stdin EOF
    };

    const collect = async (execId: string): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        const state = await inspectExec(conn, execId, life.signal);
        if (!state.Running || attempt >= EXIT_POLL_ATTEMPTS) {
          const exitCode = state.Running ? null : state.ExitCode;
          const status =
            (state.Running ? "exec still running after its stream closed" : undefined) ??
            (systemErr !== "" ? systemErr.trim() : undefined) ??
            startFailure(target, exitCode, `${stdout}\n${stderr}`);
          succeed({ exitCode, stdout, stderr, ...(status !== undefined ? { status } : {}) });
          return;
        }
        await delay(EXIT_POLL_INTERVAL_MS);
      }
    };

    // Resolves when the engine ends the stream (the command exited), or a malformed frame stops it.
    let endStream: (error?: Error) => void = () => {};
    const streamEnded = new Promise<void>((resolveEnd, rejectEnd) => {
      endStream = (error) => (error ? rejectEnd(error) : resolveEnd());
    });
    streamEnded.catch(() => {}); // observed via `run`

    const run = async (): Promise<void> => {
      const execId = await createExec(conn, target, life.signal);
      const v = await conn.apiPath();
      const d = await hijack(conn.dial, execStartRequest(v, execId), {
        signal: life.signal,
        onData: (bytes) => {
          demux.push(bytes);
          if (malformed !== undefined) {
            endStream();
          }
        },
        onEnd: (error) => endStream(error),
      });
      if (settled) {
        d.close();
        return;
      }
      duplex = d;
      d.setOnDrain(pump);
      pump();
      await streamEnded;
      if (settled) {
        return;
      }
      if (malformed !== undefined) {
        throw new Error(`[docker] ${malformed}`);
      }
      const cut = demux.finish().partial;
      if (cut > 0) {
        throw new Error("exec stream ended mid-frame (output truncated)");
      }
      await collect(execId);
    };

    run().catch((error: unknown) => fail(toError(error)));
  });
}
