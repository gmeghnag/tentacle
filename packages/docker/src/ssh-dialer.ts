/**
 * The ssh transport seam — the THIRD `Dialer` of the same code path as
 * `socketDialer` (unix + tcp/TLS). It dials a remote Docker/Podman engine by
 * running `ssh <host> docker system dial-stdio` and speaking the SAME
 * hand-written HTTP / exec hijack over the child's stdio: the engine sees only
 * bytes on a connection, and `dial-stdio` is literally "this HTTP connection
 * over ssh's stdio". `DockerClient` only ever sees a `Dialer`, so a remote ssh
 * engine is indistinguishable from a local socket (pinned by `client.test.ts`).
 *
 * Built on the frozen §9 spec of `docs/feat/docker-engine-client.md` (Design
 * §2: "The ssh dialer (A2) implements this same interface"; §9 for the argv /
 * env / stderr / process-group rules):
 *  - argv: `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
 *    -o ServerAliveCountMax=3 [-l user] [-p port] -- <host> docker system dial-stdio`.
 *    No secrets in argv; `--` + the endpoint's host/user validation
 *    (`engine-endpoint.ts:269-307`) stop option injection.
 *  - spawned `detached` (own process group, no controlling TTY — a
 *    host-key/passphrase prompt can never block; `BatchMode=yes` makes it fail
 *    instead), tracked with `@tentacle/exec`'s `trackGroup`/`killGroup` for
 *    close + the exit net (same pattern as `host-execution.ts:158-171,191-194`).
 *  - env = `scrubSensitiveEnv(process.env)` with `SSH_AUTH_SOCK` re-added (the
 *    scrub's `/AUTH/` drops it; `core/src/env.ts:11-12`), so key-based auth via
 *    the user's ssh-agent still works.
 *  - stderr is piped and captured (8 KiB cap), NEVER inherited (`mcp/transport.ts:31-40`),
 *    so a failing `ssh` cannot scribble over the TUI's alt-screen (§7).
 *
 * Backpressure: the child's stdin is a `FileSink` (`bun-types/bun.d.ts:5119-5135`)
 * whose `write` returns a `number` (accepted, no backpressure) or a `Promise`
 * (queued) — there is no `drain` event, so `buffered`/`setOnDrain` are derived
 * from that return (proven by `test/ssh-dialer.test.ts`).
 */
import { scrubSensitiveEnv } from "@tentacle/core";
import { KILL_GRACE_MS, isLingering, killGroup, releaseGroup, trackGroup } from "@tentacle/exec";
import type { Subprocess } from "bun";
import type { ByteDuplex, Dialer } from "./byte-duplex.ts";
import { type EngineEndpoint, endpointLabel } from "./engine-endpoint.ts";

export type SshEndpoint = Extract<EngineEndpoint, { kind: "ssh" }>;

/** The child we only drive through stdio + its process group. */
type SshProcess = Subprocess<"pipe", "pipe", "pipe">;

/** The stdio modes a dial-stdio child always uses (injected so tests can assert "never inherited"). */
export interface SshSpawnOptions {
  readonly stdin: "pipe";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
}

/**
 * Injectable spawner so tests assert the exact argv / env / options without a
 * real `ssh` (mirrors `PodDeleteSpawner`, `k8s/pod-cleanup.ts:155`). The
 * default spawns with `detached:true` — the child leads its own process group
 * (pgid = pid) and has no controlling TTY.
 */
export type SshSpawner = (
  cmd: readonly string[],
  env: Record<string, string>,
  options: SshSpawnOptions,
) => SshProcess;

/** Cap on how much stderr we hold for the exit message (the leading lines are what classify it). */
export const SSH_STDERR_CAP = 8 * 1024;

/** After the child exits, how long to wait for its stdout to reach EOF (a grandchild may hold the pipe open). */
const STDOUT_DRAIN_GRACE_MS = 250;

export const DEFAULT_SSH_SPAWNER: SshSpawner = (cmd, env, options) =>
  Bun.spawn([...cmd], { env, ...options, ...({ detached: true } as object) });

/**
 * The `ssh … dial-stdio` argv (spec §9). `BatchMode=yes` makes auth / host-key
 * failures FAIL instead of prompting (a detached child has no TTY to prompt on);
 * `ServerAlive*` keep the NAT/LB link alive (the ssh analog of TCP keepalive).
 * `user`/`port` are added only when present on the endpoint; `--` stops the
 * host from being parsed as an option.
 */
export function sshCommand(ep: SshEndpoint): string[] {
  const argv = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (ep.user !== undefined) {
    argv.push("-l", ep.user);
  }
  if (ep.port !== undefined) {
    argv.push("-p", String(ep.port));
  }
  argv.push("--", ep.host, "docker", "system", "dial-stdio");
  return argv;
}

/**
 * The child's env: the base env minus secret-looking keys, with `SSH_AUTH_SOCK`
 * re-added from `base` (scrubSensitiveEnv drops it via `/AUTH/`). `override`
 * wins (tests inject a fake-`ssh` PATH + the fake-engine socket path).
 */
export function sshEnv(
  base: Readonly<Record<string, string | undefined>>,
  override: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env = scrubSensitiveEnv(base);
  const sock = base.SSH_AUTH_SOCK;
  if (sock !== undefined && sock !== "") {
    env.SSH_AUTH_SOCK = sock;
  }
  return { ...env, ...override };
}

/**
 * Append `chunk` to a captured-stderr buffer, keeping the HEAD and capping the
 * total at `cap` bytes (a huge `ssh` error must not be held in memory). Pure so
 * the cap is unit-testable.
 */
export function pushStderr(
  state: { chunks: Uint8Array[]; bytes: number },
  chunk: Uint8Array,
  cap: number,
): void {
  if (state.bytes >= cap) {
    return;
  }
  const room = cap - state.bytes;
  const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
  state.chunks.push(piece);
  state.bytes += piece.length;
}

/** Decode a captured-stderr buffer. */
export function decodeStderr(state: { chunks: Uint8Array[]; bytes: number }): string {
  const out = new Uint8Array(state.bytes);
  let at = 0;
  for (const c of state.chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

/**
 * Classify an ssh death that happened BEFORE any engine data flowed (no `200`/
 * `101` ever came back — the session never became live) into an actionable
 * message naming the host (spec §9 "classified on early exit"). Order matters:
 * the specific auth/host-key/docker cases are matched before the generic
 * network fallback.
 */
export function classifySshExit(input: {
  readonly host: string;
  readonly user?: string | undefined;
  readonly port?: number | undefined;
  readonly endpointLabel: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}): string {
  const { host, user, port, endpointLabel, stderr, exitCode } = input;
  // The hint must check the known_hosts entry the dial would use: `[host]:port` and the user.
  const target = `${port !== undefined ? `-p ${port} ` : ""}${user !== undefined ? `${user}@` : ""}${host}`;
  const head = stderr.trim().split("\n").slice(0, 3).join(" ").slice(0, 200);
  const suffix = head ? ` — last stderr: ${head}` : "";
  if (/Host key verification failed/i.test(stderr)) {
    return `ssh: the host key of ${host} is not accepted — verify it once with \`ssh ${target}\`, then retry (${endpointLabel})`;
  }
  if (/Permission denied/i.test(stderr)) {
    return `ssh: permission denied for ${host} — load a key in ssh-agent or set an IdentityFile (batch mode: no password prompts) (${endpointLabel})`;
  }
  if (exitCode === 127 || /docker:? (command not found|No such file or directory)/i.test(stderr)) {
    return `ssh contexts need the docker CLI on the server: the remote command failed for ${host} (exit ${exitCode ?? "?"})${suffix}`;
  }
  return `ssh to ${host} failed${exitCode !== null && exitCode !== 0 ? ` (exit ${exitCode})` : ""} — is the host reachable and is the engine listening? (${endpointLabel})${suffix}`;
}

/** Translate a spawn failure (the child never ran) into an actionable message. */
export function sshSpawnError(ep: SshEndpoint, error: unknown): Error {
  const label = endpointLabel(ep);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    return new Error(`ssh not found on PATH — install OpenSSH (\`ssh\`) to use ${label}`);
  }
  return new Error(
    `cannot start ssh for ${label}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** A `ByteDuplex` over one `ssh … dial-stdio` child's stdio + process group. */
class SshDuplex implements ByteDuplex {
  /** Bytes received on stdout; 0 ⇒ the engine never answered ⇒ a death is a dial-level failure. */
  received = 0;
  private readonly proc: SshProcess;
  private readonly ep: SshEndpoint;
  private readonly label: string;
  private readonly stderrState = { chunks: [] as Uint8Array[], bytes: 0 };
  private pendingBytes = 0;
  private endRequested = false;
  private closed = false;
  private ended = false;
  private endError: Error | undefined;
  private held: Uint8Array[] = [];
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onDrain: (() => void) | undefined;
  private onEnd: ((error?: Error) => void) | undefined;

  constructor(proc: SshProcess, ep: SshEndpoint, label: string) {
    this.proc = proc;
    this.ep = ep;
    this.label = label;
    trackGroup(proc.pid);
    const stdoutDone = this.readStdout();
    this.readStderr();
    void proc.exited.then(async (code) => {
      releaseGroup(proc.pid);
      // Let the already-piped bytes land first: `received` decides "answered or not".
      await Promise.race([stdoutDone, Bun.sleep(STDOUT_DRAIN_GRACE_MS)]);
      this.fireEndFromExit(code);
    });
  }

  get buffered(): number {
    return this.pendingBytes;
  }

  write(bytes: Uint8Array): void {
    if (this.closed || this.endRequested || bytes.length === 0) {
      return;
    }
    let r: unknown;
    try {
      // `FileSink.write` is typed `number` but returns a `Promise` under
      // backpressure (probed) — the Promise is the drain signal.
      r = this.proc.stdin.write(bytes);
    } catch {
      return; // the pipe is gone; the child's exit fires onEnd
    }
    if (typeof r === "number") {
      return; // accepted synchronously — no backpressure (the count is not a reliable partial)
    }
    this.pendingBytes += bytes.length;
    Promise.resolve(r).then(
      () => {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes.length);
        if (this.pendingBytes === 0) {
          this.onDrain?.();
        }
      },
      (error: unknown) => {
        // EPIPE & co: the child's stdin is gone. Nothing queued will ever flush —
        // stop counting it and end the channel (once; `fireEnd` is idempotent).
        this.pendingBytes = 0;
        this.endRequested = true;
        this.fireEnd(
          new Error(
            `ssh closed the engine connection: ${error instanceof Error ? error.message : String(error)} (${this.label})`,
          ),
        );
      },
    );
  }

  setOnData(fn: (bytes: Uint8Array) => void): void {
    this.onData = fn;
    const held = this.held;
    this.held = [];
    for (const b of held) {
      fn(b);
    }
  }

  setOnDrain(fn: () => void): void {
    this.onDrain = fn;
  }

  setOnEnd(fn: (error?: Error) => void): void {
    this.onEnd = fn;
    if (this.ended) {
      fn(this.endError);
    }
  }

  /** Write-side half-close (the child's stdin EOF); reading continues. */
  end(): void {
    if (this.closed || this.endRequested) {
      return;
    }
    this.endRequested = true;
    try {
      this.proc.stdin.end(); // flushes the sink's buffer, then sends EOF
    } catch {
      // already gone
    }
  }

  /** Kill the whole group (ssh + anything it started), then close both directions. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pendingBytes = 0;
    if (!this.ended || isLingering(this.proc.pid)) {
      // SIGTERM the whole group (ssh + anything it started), then SIGKILL after
      // the grace — the leader may die on TERM while a grandchild that ignores
      // it lives on (host-execution.ts:191-194).
      killGroup(this.proc.pid, "SIGTERM");
      setTimeout(() => killGroup(this.proc.pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }
    this.fireEnd(); // clean teardown: no error (the child's exit is ours)
  }

  /** Pump stdout into `data()`; resolves at EOF (or when the reader is torn down). */
  private readStdout(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    return (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          this.data(value);
        }
      } catch {
        // reader torn down
      }
    })();
  }

  private readStderr(): void {
    const reader = this.proc.stderr.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          pushStderr(this.stderrState, value, SSH_STDERR_CAP);
        }
      } catch {
        // reader torn down
      }
    })();
  }

  data(bytes: Uint8Array): void {
    this.received += bytes.length;
    if (this.closed) {
      return;
    }
    if (this.onData) {
      this.onData(bytes);
    } else {
      this.held.push(new Uint8Array(bytes)); // Bun reuses the buffer
    }
  }

  /** The child exited: if the engine never answered, classify the death; else a plain close. */
  private fireEndFromExit(code: number): void {
    if (this.ended) {
      return;
    }
    // The contract: exit 0 after the engine answered is a NORMAL close (what
    // `docker system dial-stdio` does when the engine ends the stream — the
    // `SocketDuplex` FIN analog); a non-zero exit, or any exit before the
    // engine answered, is an error.
    if (this.received > 0 && code === 0) {
      this.fireEnd();
      return;
    }
    const error =
      this.received === 0
        ? new Error(
            classifySshExit({
              host: this.ep.host,
              user: this.ep.user,
              port: this.ep.port,
              endpointLabel: this.label,
              stderr: decodeStderr(this.stderrState),
              exitCode: code,
            }),
          )
        : new Error(`ssh closed the engine connection (exit ${code}) (${this.label})`);
    this.fireEnd(error);
  }

  fireEnd(error?: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endError = error;
    this.onEnd?.(error);
  }
}

export interface SshDialerOptions {
  /** Override the spawner (tests inject a fake `ssh`). */
  readonly spawner?: SshSpawner;
  /** The base environment to scrub (else `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overlay the child's env after the scrub (tests inject a fake-`ssh` PATH + socket). */
  readonly envOverride?: Readonly<Record<string, string>>;
}

/**
 * `Dialer` for an ssh endpoint: spawn `ssh … dial-stdio` and hand back a
 * `ByteDuplex` over its stdio once the child is running (the stdio is ready
 * immediately). A spawn failure (e.g. no `ssh` on PATH) rejects with an
 * actionable `Error`; a child death before any engine data flows surfaces as
 * the classified error on the first request's `onEnd` (the dial itself only
 * rejects on spawn failure, since there is no ssh "connected" signal to wait on).
 */
export function sshDialer(ep: SshEndpoint, options: SshDialerOptions = {}): Dialer {
  const spawner = options.spawner ?? DEFAULT_SSH_SPAWNER;
  const baseEnv = options.env ?? process.env;
  const argv = sshCommand(ep);
  const env = sshEnv(baseEnv, options.envOverride);
  const label = endpointLabel(ep);

  return (signal) =>
    new Promise<ByteDuplex>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      let proc: SshProcess;
      try {
        proc = spawner(argv, env, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      } catch (error) {
        reject(sshSpawnError(ep, error));
        return;
      }
      resolve(new SshDuplex(proc, ep, label));
    });
}
