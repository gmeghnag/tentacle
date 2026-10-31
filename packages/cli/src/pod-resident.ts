/**
 * The RESIDENT pod daemon (docs/feat/detached-runs.md S1): the pod daemon
 * outlives the exec that started it, so a dropped link (a Mac asleep, Wi-Fi)
 * or a laptop process handing the run to another one keeps the session in the
 * pod. Two modes of `tentacle serve`, both inside the pod:
 *
 * - `--resident`: ONE `SessionHost` (`podSessionHost`, the same as `--stdio`)
 *   served on a unix socket in a private state dir; each accepted socket is a
 *   `Connection`, exactly like the `serve` WebSocket. No new session logic.
 * - `--bridge`: what every exec runs — a dumb byte pipe stdin ⇄ socket ⇄
 *   stdout (no frame parsing). With no resident listening it spawns one,
 *   detached and with its stdio on a log file (never the exec's), and retries.
 *
 * The resident is memory-only (a pod daemon never persists, AGENTS §7): it
 * exits after `idleExitMs` with no connection and no attached or running
 * session — a laptop killed without `session/close` included — and a detached
 * idle session expires on that same bound. `--resident-status` /
 * `--resident-stop` let a laptop about to replace the binary see whether a run
 * is still using it (`residentGuard`).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TentacleConfig } from "@tentacle/config";
import { Connection, type SessionHost, startReaper, sweepIntervalFor } from "@tentacle/daemon";
import {
  type InitializeResult,
  PROTOCOL_VERSION,
  type SessionListResult,
} from "@tentacle/protocol";
import {
  type NodeReadableLike,
  type NodeWritableLike,
  RpcPeer,
  streamChannel,
} from "@tentacle/transport";
import { type ParsedFlags, parseContextWindowFlag } from "./flags.ts";
import { type PodDaemonOptions, podSessionHost } from "./serve.ts";
import { untrustedText } from "./untrusted-text.ts";

/** No session and no connection for this long → the resident exits. */
export const RESIDENT_IDLE_EXIT_MS = 30 * 60 * 1000;
/** How long a bridge waits for a resident (spawned or starting) to listen. */
export const BRIDGE_CONNECT_TIMEOUT_MS = 10_000;
/** The resident's log is cut to one rotation past this size. */
const RESIDENT_LOG_CAP_BYTES = 1024 * 1024;

/**
 * The resident's private state dir: `${TMPDIR:-/tmp}/tentacle-<uid>`. `/tmp`
 * is writable even on a read-only rootfs (where `--bin-dir /tmp` is used).
 */
export function residentStateDir(
  base: string = tmpdir(),
  uid: number | undefined = process.getuid?.(),
): string {
  return join(base, `tentacle-${uid ?? "user"}`);
}

/** Where the resident listens: `<stateDir>/resident.sock` unless `--socket` says otherwise. */
export function residentSocketPath(stateDir: string): string {
  return join(stateDir, "resident.sock");
}

/**
 * The command that runs THIS tentacle again: the compiled binary itself, or
 * `bun <script>` from source (the pattern of the exit-net children).
 */
export function selfCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
): string[] {
  const base = execPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const isBun = base === "bun" || base === "bun.exe";
  return isBun && script !== undefined ? [execPath, script] : [execPath];
}

/**
 * The resident a bridge starts: its own flags, so the resident's agents take
 * the model flags of the laptop that started it (`podDaemonCommand`).
 */
export function residentCommand(
  self: readonly string[],
  options: PodDaemonOptions & { readonly socket?: string },
): string[] {
  return [
    ...self,
    "serve",
    "--resident",
    ...(options.modelProxy ? ["--model-proxy"] : []),
    ...(options.contextWindow !== undefined
      ? ["--context-window", String(options.contextWindow)]
      : []),
    ...(options.autoTitle ? ["--auto-title"] : []),
    ...(options.socket !== undefined ? ["--socket", options.socket] : []),
  ];
}

/** A running resident: `done` settles once it stopped (idle, `stop`, a signal). */
export interface ResidentHandle {
  readonly socketPath: string;
  /** Connections open right now. */
  connections(): number;
  stop(): Promise<void>;
  readonly done: Promise<void>;
}

export interface ResidentOptions {
  readonly stateDir: string;
  readonly socketPath: string;
  /** The connections serve the model (`--model-proxy`). */
  readonly servesModel: boolean;
  readonly log: (line: string) => void;
  readonly idleExitMs?: number;
  /** The idle check's (and the reaper's) period; tests shorten it. */
  readonly sweepIntervalMs?: number;
  /** Reads a process's state and start time (`procStat`); tests inject it. */
  readonly procOf?: ProcOf;
}

/** Fields of `/proc/<pid>/stat`, `undefined` where absent. */
export interface ProcStat {
  /** Field 3: `Z` is a zombie, gone but never reaped. */
  readonly state: string | undefined;
  /** Field 22, clock ticks since the host's boot: a reused pid reads differently. */
  readonly start: string | undefined;
}
export type ProcOf = (pid: number) => ProcStat | undefined;

/** `pid`'s `/proc` entry; `undefined` where there is no `/proc` (macOS) or the pid is gone. */
export function procStat(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/** Parse a `/proc/<pid>/stat` line; the `(comm)` field may hold spaces and parens. */
export function parseProcStat(stat: string): ProcStat {
  // After the LAST `)`: state is field 3 (index 0), so field 22 is index 19.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] || undefined, start: fields[19] || undefined };
}

/** The lock file's content; `undefined` when there is none. */
function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The lock's holder: `<pid> <start time>` (the start time absent where unknown). */
function parseLockHolder(
  content: string | undefined,
): { pid: number; start: string | undefined } | null {
  const [pid, start] = (content ?? "").trim().split(" ");
  const n = Number(pid);
  return Number.isSafeInteger(n) && n > 0 ? { pid: n, start } : null;
}

/**
 * Is `holder` still the process that took the lock? Alive AND, where both
 * start times are known, the same start time: a `docker start` of a kept
 * container keeps `/tmp` (and its lock) but not the process, and a low pid is
 * soon reused by another one.
 */
export function holderAlive(
  holder: { readonly pid: number; readonly start: string | undefined },
  procOf: ProcOf,
): boolean {
  if (!alive(holder.pid, procOf)) {
    return false;
  }
  const now = procOf(holder.pid)?.start;
  return holder.start === undefined || now === undefined || now === holder.start;
}

/** The lock of generation `n`. */
function lockPath(stateDir: string, n: number): string {
  return join(stateDir, `.lock.${n}`);
}

/** `name`'s generation, `undefined` if it is not a `.lock.<n>`. */
function lockGeneration(name: string): number | undefined {
  const match = /^\.lock\.(\d+)$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** The highest generation in `stateDir`, the holder's; 0 when there is none. */
function currentGeneration(stateDir: string): number {
  try {
    return Math.max(0, ...readdirSync(stateDir).map((name) => lockGeneration(name) ?? 0));
  } catch {
    return 0;
  }
}

/** Where `acquireResidentLock` lets a test run a rival. */
export type LockStep = "judged" | "link";

/**
 * Take `<stateDir>/.lock.<n>`: `<pid> <start time>`, hard-linked from a private
 * temp file, so it never exists half-written. The highest generation is the
 * holder: a live one → throws; a dead one, a reused pid (another start time) or
 * a tombstone → the next generation is linked. Exactly one taker wins that link,
 * and there is no claim to wedge on: a taker that dies at any step leaves at
 * worst a dead holder of a higher generation, which is just stale. Never removed
 * on release (a lower generation would reopen the slot to a slow taker): emptied,
 * the highest stays as a tombstone. The winner sweeps everything below it (old
 * generations, a crashed taker's temp, a pre-generation `.lock`/`.lock.takeover`),
 * so one file stays; a slow taker that links a swept slot sees the higher
 * generation right after and backs off.
 */
export function acquireResidentLock(
  stateDir: string,
  procOf: ProcOf,
  beforeStep: (step: LockStep) => void = () => {},
): { release(): void } {
  const seen = currentGeneration(stateDir);
  const holder = parseLockHolder(readLock(lockPath(stateDir, seen)));
  if (holder && holderAlive(holder, procOf)) {
    throw new Error(
      `another tentacle resident (pid ${holder.pid}) owns ${stateDir}; stop it, or remove ${lockPath(stateDir, seen)} if it is not running`,
    );
  }
  const generation = seen + 1;
  const path = lockPath(stateDir, generation);
  const lost = (): Error => new Error(`another tentacle resident took ${stateDir} first; retry`);
  beforeStep("judged");
  const temp = join(stateDir, `.lock.${randomUUID()}`);
  const start = procOf(process.pid)?.start;
  writeFileSync(temp, start !== undefined ? `${process.pid} ${start}` : String(process.pid), {
    mode: 0o600,
  });
  try {
    beforeStep("link");
    linkSync(temp, path);
  } catch (error) {
    // ENOENT: the winner swept our temp.
    const code = (error as { code?: unknown }).code;
    throw code === "EEXIST" || code === "ENOENT" ? lost() : error;
  } finally {
    rmSync(temp, { force: true });
  }
  if (currentGeneration(stateDir) > generation) {
    rmSync(path, { force: true });
    throw lost();
  }
  for (const name of readdirSync(stateDir)) {
    if (name.startsWith(".lock") && (lockGeneration(name) ?? 0) < generation) {
      rmSync(join(stateDir, name), { force: true });
    }
  }
  let held = true;
  return {
    release: () => {
      if (!held) {
        return;
      }
      held = false;
      try {
        truncateSync(path);
      } catch {
        // Already swept by a later generation: nothing to release.
      }
    },
  };
}

/**
 * Serve `host` on a unix socket until idle. Single instance: the state dir's
 * lock (`acquireResidentLock`: a live holder → throws; a dead one or a reused
 * pid → taken over), then a stale socket file is unlinked and the socket bound
 * (0600, in a 0700 dir). A connection that goes away is DETACHED from its sessions — the
 * session lives on for the next exec (the last model-serving one cancels the
 * running turn, `Connection.release`).
 */
export async function serveResident(
  host: SessionHost,
  options: ResidentOptions,
): Promise<ResidentHandle> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const lock = acquireResidentLock(options.stateDir, options.procOf ?? procStat);
  const open = new Set<{ readonly connection: Connection; readonly socket: Socket }>();
  let server: Server;
  try {
    rmSync(options.socketPath, { force: true });
    server = createServer((socket) => {
      const connection = new Connection(
        streamChannel(socket as unknown as NodeReadableLike, socket as unknown as NodeWritableLike),
        host,
        (error) => options.log(`error: ${error.message}`),
        { servesModel: options.servesModel },
      );
      const entry = { connection, socket };
      open.add(entry);
      // `close` follows an `error`: one place detaches.
      socket.on("error", () => {});
      socket.on("close", () => {
        if (open.delete(entry)) {
          connection.close();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(options.socketPath, 0o600);
  } catch (error) {
    lock.release();
    throw error;
  }
  options.log(`resident listening on ${options.socketPath} (pid ${process.pid})`);

  const idleExitMs = options.idleExitMs ?? RESIDENT_IDLE_EXIT_MS;
  const period = options.sweepIntervalMs ?? sweepIntervalFor(idleExitMs) ?? 60_000;
  // A detached idle session expires on the resident's own bound, not `serve`'s
  // 24 h (its laptop history is the truth; a re-attach re-seeds it).
  const stopReaper = startReaper(
    host,
    { idleTtlMs: idleExitMs },
    {
      sweepIntervalMs: period,
      onAudit: options.log,
      onError: (error) => options.log(`error: ${error.message}`),
    },
  );
  // In use: a connection, an attached session, or a turn/compaction running.
  // A detached idle session (a laptop that died without `session/close`) is not.
  const inUse = (): boolean => {
    if (open.size > 0) {
      return true;
    }
    for (const hosted of host.values()) {
      const { attached, busy } = hosted.liveness();
      if (attached > 0 || busy) {
        return true;
      }
    }
    return false;
  };
  let idleSince: number | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(idleTimer);
      stopReaper();
      for (const entry of open) {
        entry.connection.close();
        entry.socket.destroy();
      }
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(options.socketPath, { force: true });
      lock.release();
      options.log("resident stopped");
      resolveDone();
    })();
    return stopping;
  };
  const idleTimer = setInterval(
    () => {
      if (inUse()) {
        idleSince = undefined;
        return;
      }
      const now = Date.now();
      idleSince ??= now;
      if (now - idleSince >= idleExitMs) {
        options.log(`idle for ${idleExitMs}ms (no connection, no running turn): exiting`);
        void stop();
      }
    },
    Math.min(period, idleExitMs),
  );
  return { socketPath: options.socketPath, connections: () => open.size, stop, done };
}

/** The slice of `process.stdin` / `process.stdout` a bridge uses. */
export interface BridgeIO {
  readonly stdin: {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
    on(event: "end" | "close", listener: () => void): unknown;
  };
  readonly stdout: { write(chunk: Uint8Array | string): unknown };
  /** Start a resident (once, on ENOENT / ECONNREFUSED). */
  readonly spawnResident: () => void;
  readonly log: (line: string) => void;
  readonly dial?: (path: string) => Promise<Socket>;
  readonly retryMs?: number;
  readonly timeoutMs?: number;
}

function dialSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

const nobodyListening = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
};

/**
 * Pipe stdin ⇄ the resident's socket ⇄ stdout until either side ends.
 * Resolves the process exit code: 0 when the pipe ran and closed, 1 when no
 * resident could be reached. Bytes read before the connect are kept and sent
 * first (the laptop's `initialize` does not wait for us).
 */
export async function runBridge(socketPath: string, io: BridgeIO): Promise<number> {
  const dial = io.dial ?? dialSocket;
  const pending: (Uint8Array | string)[] = [];
  let socket: Socket | undefined;
  let stdinEnded = false;
  io.stdin.on("data", (chunk) => {
    if (socket) {
      socket.write(chunk);
    } else {
      pending.push(chunk);
    }
  });
  const endInput = (): void => {
    stdinEnded = true;
    socket?.end();
  };
  io.stdin.on("end", endInput);
  io.stdin.on("close", endInput);

  const deadline = Date.now() + (io.timeoutMs ?? BRIDGE_CONNECT_TIMEOUT_MS);
  let spawned = false;
  for (;;) {
    try {
      socket = await dial(socketPath);
      break;
    } catch (error) {
      if (!nobodyListening(error)) {
        io.log(`bridge: cannot reach ${socketPath}: ${(error as Error).message}`);
        return 1;
      }
      if (!spawned) {
        spawned = true;
        io.log(`bridge: no resident on ${socketPath}; starting one`);
        io.spawnResident();
      }
      if (Date.now() >= deadline) {
        io.log(
          `bridge: no resident listening on ${socketPath} after ${io.timeoutMs ?? BRIDGE_CONNECT_TIMEOUT_MS}ms`,
        );
        return 1;
      }
      await new Promise((r) => setTimeout(r, io.retryMs ?? 100));
    }
  }
  const connected = socket;
  for (const chunk of pending.splice(0)) {
    connected.write(chunk);
  }
  if (stdinEnded) {
    connected.end();
  }
  return new Promise<number>((resolve) => {
    connected.on("data", (chunk: Uint8Array) => io.stdout.write(chunk));
    connected.on("error", (error) => io.log(`bridge: ${error.message}`));
    connected.on("close", () => resolve(0));
  });
}

/**
 * Spawn the resident detached from this exec: its own session (`setsid`), its
 * stdio on `<stateDir>/resident.log` (capped: one rotation), unref'd — so the
 * exec ending (or being killed) never takes it along. P0 (Execution) verified
 * this survives on docker and Kubernetes.
 */
export function spawnResidentProcess(argv: readonly string[], stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = join(stateDir, "resident.log");
  try {
    if (statSync(logPath).size > RESIDENT_LOG_CAP_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // No log yet.
  }
  const fd = openSync(logPath, "a", 0o600);
  try {
    const [command, ...args] = argv;
    if (command === undefined) {
      throw new Error("no resident command");
    }
    spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] }).unref();
  } finally {
    closeSync(fd);
  }
}

/** What `serve --resident-status` prints (one JSON line). */
export interface ResidentStatus {
  readonly resident: boolean;
  readonly version?: string;
  readonly sessions?: number;
  readonly running?: number;
  readonly attached?: number;
}

/**
 * Ask the resident on `socketPath` (over the session protocol: `initialize`,
 * then `session/list` — it attaches to nothing) how busy it is. Nobody
 * listening → `{resident: false}`.
 */
export async function residentStatus(socketPath: string): Promise<ResidentStatus> {
  let socket: Socket;
  try {
    socket = await dialSocket(socketPath);
  } catch (error) {
    if (nobodyListening(error)) {
      return { resident: false };
    }
    throw error;
  }
  // A drop (EPIPE, ECONNRESET) closes the channel, which rejects the pending
  // request; unhandled, it would crash the probe with no JSON answer.
  socket.on("error", () => {});
  const peer = new RpcPeer(
    streamChannel(socket as unknown as NodeReadableLike, socket as unknown as NodeWritableLike),
    {},
  );
  try {
    const { agentInfo } = (await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as InitializeResult;
    const { sessions } = (await peer.request("session/list", {})) as SessionListResult;
    return {
      resident: true,
      // The resident's own build; absent from one too old to say.
      ...(agentInfo ? { version: agentInfo.version } : {}),
      sessions: sessions.length,
      running: sessions.filter((s) => s.running).length,
      attached: sessions.reduce((sum, s) => sum + s.attached, 0),
    };
  } finally {
    peer.close();
    socket.destroy();
  }
}

/**
 * `serve --resident-status`'s one JSON line and exit code. A probe that fails
 * still answers in JSON (`{resident: null, error}`, exit 1), so `residentGuard`
 * tells "the probe failed" (refuse) from "no resident mode" (no JSON).
 */
export async function residentStatusReport(
  socketPath: string,
): Promise<{ readonly line: string; readonly exitCode: number }> {
  try {
    return { line: JSON.stringify(await residentStatus(socketPath)), exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { line: JSON.stringify({ resident: null, error: message }), exitCode: 1 };
  }
}

/**
 * Does `pid` still run? Not a zombie: `kill(pid, 0)` succeeds on one and nothing
 * reaps it (PID 1 is `sleep infinity`), so a crashed resident stays one forever.
 */
function alive(pid: number, procOf: ProcOf): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EPERM") {
      return false;
    }
  }
  return procOf(pid)?.state !== "Z";
}

/** The process that holds `stateDir`'s lock now; `null` when none does (absent, stale, released). */
export function lockHolder(stateDir: string, procOf: ProcOf): { readonly pid: number } | null {
  const holder = parseLockHolder(readLock(lockPath(stateDir, currentGeneration(stateDir))));
  return holder && holderAlive(holder, procOf) ? holder : null;
}

/**
 * Stop the resident that holds `stateDir`'s lock: SIGTERM (it detaches every
 * connection, unlinks its socket, releases the lock), SIGKILL past `graceMs`.
 * Its sessions are memory-only: they go with it (the laptop history stays).
 * Resolves whether a resident was running. A lock whose pid now belongs to
 * another process (another start time: a restarted container) is never signalled.
 */
export async function residentStop(
  stateDir: string,
  graceMs = 5000,
  procOf: ProcOf = procStat,
): Promise<boolean> {
  const holder = lockHolder(stateDir, procOf);
  if (!holder || holder.pid === process.pid) {
    return false;
  }
  const { pid } = holder;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (alive(pid, procOf) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (alive(pid, procOf)) {
    process.kill(pid, "SIGKILL");
  }
  return true;
}

/** `attach`'s decision before replacing the pod's binary (`residentGuard`). */
export type ResidentVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "stop" }
  | { readonly kind: "refuse"; readonly message: string };

/**
 * Replace the pod's tentacle only when no run uses its resident: the OLD
 * binary's `serve --resident-status` (`probe`) → busy (a turn running, or a
 * client attached) refuses with what to do; idle → stop it, then replace (its
 * idle in-pod sessions go; the laptop history stays); `resident:false`, or an
 * exit below 128 with no JSON (no binary, or one older than the resident mode:
 * `unknown option`) → nothing to stop. FAIL CLOSED: a probe that failed (the
 * exec threw or timed out, the status process was killed, the status mode
 * reported an error, an unreadable answer) refuses — a busy resident must never
 * lose its binary on a guess. Pod-supplied text (version, error) is sanitised.
 * The guess left: ANY exit 1–127 with no JSON lands on `none`, a failed probe
 * included: k8s maps every `Failure` to 1 (`exec-run.ts`), and on any engine a
 * `[config error]` of the status process exits 1 before reaching the mode (`main.ts`).
 */
export function residentGuard(
  probe: { readonly exitCode: number | null; readonly stdout: string } | null,
  name: string,
): ResidentVerdict {
  const unknown = (why: string): ResidentVerdict => ({
    kind: "refuse",
    message: `could not ask ${name} whether a detached run is using its tentacle (${untrustedText(why)}) — retry, or \`tentacle rm ${name}\``,
  });
  if (!probe) {
    return unknown("the status probe failed");
  }
  if (probe.exitCode === null) {
    return unknown("the status probe did not finish");
  }
  let status: unknown;
  try {
    status = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    if (probe.exitCode === 0) {
      return unknown("unreadable status");
    }
    return probe.exitCode >= 128 ? unknown(`killed, exit ${probe.exitCode}`) : { kind: "none" };
  }
  if (typeof status !== "object" || status === null) {
    return unknown("unreadable status");
  }
  const fields = status as { readonly resident?: unknown; readonly error?: unknown };
  if (fields.resident === false) {
    return { kind: "none" };
  }
  if (fields.resident !== true) {
    return unknown(typeof fields.error === "string" ? fields.error : "unreadable status");
  }
  return busyVerdict(status as ResidentStatus, name);
}

/**
 * What `--resident-stop` left (`stop`: `null` if the exec threw): a stop that
 * did not report success may leave a resident running → refuse the replace.
 */
export function residentStopVerdict(
  stop: { readonly exitCode: number | null } | null,
  name: string,
): ResidentVerdict {
  return stop?.exitCode === 0
    ? { kind: "stop" }
    : {
        kind: "refuse",
        message: `could not stop the idle tentacle resident in ${name} before replacing its binary — retry, or \`tentacle rm ${name}\``,
      };
}

/**
 * What `--resident-status` (`probe`, by the binary this attach will run) says
 * about the resident it is about to join: one up that is not `expected`
 * (another build, or too old to say) is told, never stopped. `expected`
 * undefined (from source): any resident is told. Same build, no resident, a
 * failed probe → nothing: this never blocks an attach.
 */
export function residentSkewWarning(
  probe: { readonly stdout: string } | null,
  name: string,
  binPath: string,
  expected: string | undefined,
): string | undefined {
  let status: { readonly resident?: unknown; readonly version?: unknown } | null;
  try {
    status = JSON.parse(probe?.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
  if (status?.resident !== true || (expected !== undefined && status.version === expected)) {
    return undefined;
  }
  const version =
    typeof status.version === "string" ? untrustedText(status.version) : "of an unknown version";
  const laptop = expected !== undefined ? `, this laptop ${expected}` : "";
  return `⚠ ${name} already runs a tentacle resident ${version}${laptop}: this attach joins it (a protocol mismatch is still refused). If it runs from a binary outside ${binPath} (another --bin-dir at \`run\`?), attach with that --bin-dir`;
}

function busyVerdict(status: ResidentStatus, name: string): ResidentVerdict {
  const running = typeof status.running === "number" ? status.running : 0;
  const attached = typeof status.attached === "number" ? status.attached : 0;
  if (running > 0 || attached > 0) {
    const version = untrustedText(String(status.version ?? "of an unknown version"));
    return {
      kind: "refuse",
      message: `a detached run is using tentacle ${version} in ${name} — wait for it, \`tentacle rm ${name}\`, or attach with tentacle ${version}`,
    };
  }
  return { kind: "stop" };
}

/** `serve`'s pod-daemon modes: none of them scaffolds config (a read-only pod). */
export const POD_DAEMON_MODES = [
  "stdio",
  "bridge",
  "resident",
  "resident-status",
  "resident-stop",
] as const;

/**
 * `serve --bridge | --resident | --resident-status | --resident-stop`, in the
 * pod. Returns the exit code. The bridge's stdout IS the RPC channel and the
 * resident's stdio is its log file: every diagnostic goes to stderr.
 */
export async function runResidentMode(
  config: TentacleConfig,
  parsed: Pick<ParsedFlags, "flags" | "bools">,
): Promise<number> {
  const { flags, bools } = parsed;
  const log = (line: string): void => {
    process.stderr.write(`[daemon] ${line}\n`);
  };
  try {
    const stateDir = residentStateDir();
    const socket = flags.get("socket");
    const socketPath = socket ?? residentSocketPath(stateDir);
    if (bools.has("resident-status")) {
      const report = await residentStatusReport(socketPath);
      process.stdout.write(`${report.line}\n`);
      return report.exitCode;
    }
    if (bools.has("resident-stop")) {
      process.stdout.write(`${JSON.stringify({ stopped: await residentStop(stateDir) })}\n`);
      return 0;
    }
    const contextWindow = parseContextWindowFlag(parsed);
    const options: PodDaemonOptions = {
      modelProxy: bools.has("model-proxy"),
      autoTitle: bools.has("auto-title"),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    if (bools.has("bridge")) {
      const argv = residentCommand(selfCommand(), {
        ...options,
        ...(socket !== undefined ? { socket } : {}),
      });
      return await runBridge(socketPath, {
        stdin: process.stdin,
        stdout: process.stdout,
        spawnResident: () => spawnResidentProcess(argv, stateDir),
        log,
      });
    }
    const handle = await serveResident(podSessionHost(config, log, options), {
      stateDir,
      socketPath,
      servesModel: options.modelProxy === true,
      log,
    });
    // `--resident-stop` (a replace) and a pod shutdown: detach all, unlink, unlock.
    process.once("SIGTERM", () => void handle.stop());
    process.once("SIGINT", () => void handle.stop());
    await handle.done;
    return 0;
  } catch (error) {
    log(`resident error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** The one-shot commands `attach` runs with the pod's OLD binary. */
export function residentStatusCommand(bin: string): string[] {
  return [bin, "serve", "--resident-status"];
}
export function residentStopCommand(bin: string): string[] {
  return [bin, "serve", "--resident-stop"];
}
