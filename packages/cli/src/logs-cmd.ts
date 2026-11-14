/**
 * `tentacle logs` — read (and follow) a session without a TUI or a shell
 * redirect (docs/feat/logs-cmd.md, sub-task 1 `logs-tail`). The DECIDING lives
 * in `log-events.ts` (pure); this module finds the file (the laptop store, then
 * this project's `serve` store, then the other projects), reads it strictly
 * with `parseLogFile`, and prints.
 *
 * Read-only, by construction: it never takes the session's lock, never writes,
 * never sets anything aside (AGENTS §7). A writer either appends whole lines or
 * replaces the file atomically (`session-log-store.ts`), and `parseLogFile`
 * ignores a torn last line — so an unlocked read is safe, and a real corruption
 * is REFUSED loudly (exit 1, the parser's reason, the path), never half-shown.
 *
 * Owner Q4: `-f` with no daemon follows the FILE — committed events only (no
 * asks, no streaming deltas, said on stderr), at a 1 s poll, resuming by entry
 * id. Sub-task 2 adds `-f` over `connect` (the daemon's watcher); this file
 * keeps the fallback it is for a session no daemon is serving.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isValidSessionId, projectKey } from "@tentacle/agent";
import {
  type ConnectOptions,
  type TlsOptions,
  UNKNOWN_WATCH_HINT,
  closeWatch,
  openWatch,
  pollWatch,
  webSocketChannelFactory,
} from "@tentacle/client";
import {
  LogSessionStore,
  type ParsedLogFile,
  entriesThrough,
  parseLogFile,
  parseSidecar,
} from "@tentacle/daemon";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  PROTOCOL_VERSION,
  type WatchCategory,
} from "@tentacle/protocol";
import { type DuplexChannel, RpcPeer } from "@tentacle/transport";
import { readKept } from "./kept-index.ts";
import {
  LOG_FOLLOW_INTERVAL_MS,
  type LogCategory,
  type LogEvent,
  type LogSummary,
  eventsOf,
  filterEvents,
  formatEvent,
  formatSummary,
  jsonLine,
  summarize,
  takeLast,
  updateEvents,
} from "./log-events.ts";
import { relayLogPath, runDirFor } from "./run-state.ts";
import { untrustedText } from "./untrusted-text.ts";
import { CLIENT_INFO } from "./version.ts";

export interface LogsOptions {
  /** A full session uid; absent = the newest session of this project. */
  readonly uid?: string;
  readonly tail: number;
  readonly only?: readonly LogCategory[];
  readonly json: boolean;
  readonly summary: boolean;
  readonly follow: boolean;
  /**
   * `--connect <url>`: follow a `serve` daemon's session LIVE (`session/watch`)
   * instead of the file. Needs `follow`: a one-shot read of a remote session is
   * `logs --tail` on that host's store, not a dial.
   */
  readonly connect?: string;
  readonly token?: string;
  readonly tls?: TlsOptions;
}

export interface LogsDeps {
  /** `<configDir>`. */
  readonly configDir: string;
  /** The launch directory (its `projectKey` names both stores). */
  readonly cwd: string;
  /** STDOUT: data only (events, the summary). */
  readonly out: (text: string) => void;
  /** STDERR: prose (which file, what the fallback cannot show, refusals). */
  readonly err: (text: string) => void;
  /** `-f`'s poll interval sleep (a test drives it without waiting). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `-f` stops when aborted (Ctrl+C). */
  readonly signal?: AbortSignal;
  /**
   * Test seam: the daemon dial for `--connect` (`webSocketChannelFactory` in a
   * real run). A test hands it a channel pair and never opens a socket.
   */
  readonly dial?: (url: string, options: ConnectOptions) => () => Promise<DuplexChannel>;
}

/** One readable log: where it is and what it holds. */
interface LogRead {
  readonly dir: string;
  readonly file: string;
  readonly parsed: ParsedLogFile;
  /** The entries this read shows: the current segment's, cut at the sidecar's head. */
  readonly entries: readonly KnownLogEntry[];
  /** Segments dropped from the projection (an older compaction/reset). */
  readonly olderSegments: number;
}

/** A candidate file's outcome, before the strict entry parse. */
type Candidate =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly file: string; readonly reason: string }
  | {
      readonly kind: "read";
      readonly dir: string;
      readonly file: string;
      readonly log: string;
      readonly state: string | null;
    };

/** The index of the segment holding `head`'s entry (-1: none holds it). */
function segmentIndexOf(
  parsed: ParsedLogFile,
  head: { readonly seq: number; readonly id: string },
): number {
  for (let s = parsed.segments.length - 1; s >= 0; s--) {
    const segment = parsed.segments[s];
    if (segment === undefined) continue;
    if (segment.entries.some((entry) => entry.id === head.id && entry.seq === head.seq)) {
      return s;
    }
  }
  return -1;
}

/** One candidate file read without a lock (`readRaw` writes nothing). */
async function candidate(dir: string, uid: string): Promise<Candidate> {
  const raw = await new LogSessionStore(dir).readRaw(uid);
  switch (raw.status) {
    case "absent":
      return { kind: "absent" };
    case "unreadable":
      return { kind: "unreadable", file: raw.file, reason: raw.reason };
    case "ok":
      return {
        kind: "read",
        dir,
        file: new LogSessionStore(dir).file(uid),
        log: raw.log,
        state: raw.state,
      };
  }
}

/**
 * The entries to show of a parsed file: a `serve` copy names the entry its
 * state file was captured at (`logHead`), and everything after it is what a
 * crash left uncommitted — never shown. No sidecar (a laptop copy), or one this
 * build cannot read, falls back to the log's current segment.
 */
function readableEntries(
  parsed: ParsedLogFile,
  state: string | null,
  uid: string,
  file: string,
  err: (text: string) => void,
): { entries: readonly KnownLogEntry[]; olderSegments: number } {
  const current = parsed.segments[parsed.segments.length - 1];
  const whole = { entries: current?.entries ?? [], olderSegments: parsed.segments.length - 1 };
  if (state === null) {
    return whole;
  }
  const sidecar = parseSidecar(state, uid);
  if (!sidecar.ok) {
    // Loud, and still read-only: the state file is another version's or torn,
    // so the log is shown as it is rather than refused (it parsed strictly).
    err(`[logs] ${file}: ${untrustedText(sidecar.reason)}; showing the log's current segment\n`);
    return whole;
  }
  const through = entriesThrough(parsed, sidecar.value.logHead);
  const at = segmentIndexOf(parsed, sidecar.value.logHead);
  if (through === null || at < 0) {
    // A crash mid-rewrite leaves no such entry: the last segment is the lineage.
    return whole;
  }
  return { entries: through, olderSegments: at };
}

/** Parse a candidate strictly, or say why it cannot be shown. */
function parseCandidate(
  read: Extract<Candidate, { kind: "read" }>,
  uid: string,
  err: (text: string) => void,
): LogRead | { readonly reason: string } {
  const parsed = parseLogFile(read.log, uid);
  if (!parsed.ok) {
    return { reason: parsed.reason };
  }
  const { entries, olderSegments } = readableEntries(parsed, read.state, uid, read.file, err);
  return { dir: read.dir, file: read.file, parsed, entries, olderSegments };
}

/** Every project directory under `root` (`<root>/<projectKey>/`), sorted. */
async function projectDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Where a session's log may be, in the order the design fixed: this project's
 * laptop store, this project's `serve` store, then every other project's
 * (laptop and `serve`), newest-first by name. Laptop only — a pod stores
 * nothing (AGENTS §7).
 */
async function candidateDirs(configDir: string, cwd: string): Promise<string[]> {
  const key = projectKey(cwd);
  const sessions = join(configDir, "sessions");
  const daemon = join(configDir, "daemon");
  const others = async (root: string): Promise<string[]> =>
    (await projectDirs(root)).filter((dir) => dir !== join(root, key));
  return [
    join(sessions, key),
    join(daemon, key),
    ...(await others(sessions)),
    ...(await others(daemon)),
  ];
}

/** The newest session id in a directory tree of stores, or none. */
async function newestSession(dirs: readonly string[]): Promise<string | undefined> {
  let best: { readonly id: string; readonly updatedAt: number } | undefined;
  for (const dir of dirs) {
    const { records } = await new LogSessionStore(dir).list();
    for (const record of records) {
      if (!best || record.updatedAt > best.updatedAt) {
        best = { id: record.id, updatedAt: record.updatedAt };
      }
    }
  }
  return best?.id;
}

type Resolution =
  | { readonly ok: true; readonly read: LogRead; readonly uid: string }
  | { readonly ok: false; readonly message: string };

/** Find and parse the session's log (the explicit uid, or the newest of this project). */
async function resolve(deps: LogsDeps, uid: string | undefined): Promise<Resolution> {
  if (uid !== undefined && !isValidSessionId(uid)) {
    return { ok: false, message: `[error] ${JSON.stringify(uid)} is not a valid session id\n` };
  }
  const dirs = await candidateDirs(deps.configDir, deps.cwd);
  let unreadable: { readonly file: string; readonly reason: string } | undefined;
  const chosen = uid ?? (await newestSession(dirs.slice(0, 2)));
  if (chosen === undefined) {
    return {
      ok: false,
      message: `[logs] no session in ${deps.cwd} yet (nothing under ${join(deps.configDir, "sessions")})\n`,
    };
  }
  // An explicit uid searches everywhere; a chosen one is in those two stores.
  const search = uid !== undefined ? dirs : dirs.slice(0, 2);
  for (const dir of search) {
    const found = await candidate(dir, chosen);
    if (found.kind === "unreadable") {
      unreadable ??= { file: found.file, reason: found.reason };
      continue;
    }
    if (found.kind === "absent") {
      continue;
    }
    const parsed = parseCandidate(found, chosen, deps.err);
    if ("reason" in parsed) {
      unreadable ??= { file: found.file, reason: parsed.reason };
      continue;
    }
    return { ok: true, read: parsed, uid: chosen };
  }
  if (unreadable !== undefined) {
    // Loud and exact: the reason and the file, never a half-shown log.
    return {
      ok: false,
      message: `[error] session ${chosen} is unreadable: ${untrustedText(unreadable.reason)} (${unreadable.file})\n`,
    };
  }
  return {
    ok: false,
    message:
      uid !== undefined
        ? `[error] no session ${uid} in ${deps.cwd} or another project (looked in ${join(deps.configDir, "sessions")} and ${join(deps.configDir, "daemon")})\n`
        : `[logs] no session in ${deps.cwd} yet\n`,
  };
}

/** The events of one read, after `--only` and `--tail` (`tail` < 0 keeps everything). */
export function eventsOfRead(
  read: Pick<LogRead, "entries">,
  uid: string,
  only: readonly LogCategory[] | undefined,
  tail: number,
): LogEvent[] {
  const events = filterEvents(eventsOf(read.entries, uid), only);
  return tail < 0 ? events : takeLast(events, tail);
}

/**
 * The detached run whose record names this session, and where its free-text
 * logs are (owner Q6: `--summary` prints their PATHS, never merges them). The
 * record is the laptop's kept index — WHERE to look comes from it, never from a
 * workload (AGENTS §7).
 */
function runFor(
  configDir: string,
  uid: string,
): { readonly name: string; readonly logs: readonly string[] } | undefined {
  const index = readKept(join(configDir, "kept"));
  for (const { entry } of index.entries) {
    if (entry.sessionId !== uid) {
      continue;
    }
    const dir = runDirFor(configDir, entry);
    return { name: entry.name, logs: [join(dir, "daemon.log"), relayLogPath(dir)] };
  }
  return undefined;
}

/** `--summary` for a read: the entries' facts, plus a run's log paths when one names it. */
async function summaryOf(deps: LogsDeps, read: LogRead, uid: string): Promise<LogSummary> {
  const run = runFor(deps.configDir, uid);
  return summarize(read.entries, eventsOf(read.entries, uid), {
    session: uid,
    file: read.file,
    project: read.parsed.header.cwd,
    model: read.parsed.header.model,
    olderSegments: read.olderSegments,
    ...(run !== undefined ? { run } : {}),
  });
}

/** Print one batch of events in the chosen format. */
function printEvents(deps: LogsDeps, events: readonly LogEvent[], json: boolean): void {
  for (const event of events) {
    deps.out(json ? `${jsonLine(event)}\n` : `${formatEvent(event)}\n`);
  }
}

/** The last entry id of the entries shown: where the next poll resumes. */
function lastEntryId(read: LogRead): string | undefined {
  return read.entries.at(-1)?.id;
}

/**
 * `-f`'s file fallback (owner Q4): print the first batch, then re-read the file
 * every {@link LOG_FOLLOW_INTERVAL_MS} and print what is new, resuming by entry
 * id. Committed events only — a live ask or a streaming delta is not in a file
 * — which is said once, on stderr.
 */
async function follow(
  deps: LogsDeps,
  first: LogRead,
  uid: string,
  opts: LogsOptions,
): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  // Read through a function: `aborted` changes while we await, so it must never
  // be narrowed from an earlier check (a loop that only checked once would run
  // forever after the first sleep).
  const stopped = (): boolean => deps.signal?.aborted === true;
  printEvents(deps, eventsOfRead(first, uid, opts.only, opts.tail), opts.json);
  deps.err(
    "[logs] following the file: committed events only (no asks or streaming text — those need a daemon)\n",
  );
  let last = lastEntryId(first);
  for (;;) {
    if (stopped()) {
      return 0;
    }
    await sleep(LOG_FOLLOW_INTERVAL_MS);
    if (stopped()) {
      return 0;
    }
    const again = await resolve(deps, uid);
    if (!again.ok) {
      deps.err(`${again.message}`);
      continue; // a rewrite in progress is not the end of the stream
    }
    const entries = again.read.entries;
    const at = last === undefined ? -1 : entries.findIndex((entry) => entry.id === last);
    if (at < 0 && last !== undefined) {
      // The id is gone: the file was rewritten (a compaction's new segment).
      // Say so, then show the new segment's events (its ids are new: no repeat).
      deps.err(`[logs] ${again.read.file}: the log was rewritten; showing the new segment\n`);
    }
    // Resume by entry id: `at < 0` means the id is gone (rewritten), so the
    // whole current segment is new to us; `last === undefined` had nothing yet.
    const fresh = at >= 0 ? entries.slice(at + 1) : entries;
    const events = filterEvents(eventsOf(fresh, uid), opts.only);
    if (events.length > 0) {
      printEvents(deps, events, opts.json);
    }
    last = lastEntryId(again.read) ?? last;
  }
}

/**
 * `-f` over a daemon (docs/feat/logs-cmd.md sub-task 2): a READ-ONLY watch
 * (`session/watch`), polled one batch at a time, printed in the same vocabulary
 * as the file half. What it can show the file half cannot: streaming text, the
 * asks (and their answers), and a turn that ends with an error.
 *
 * Whatever happens, it leaves the daemon as it found it: `unwatch` on the way
 * out (Ctrl+C, a close, an error), no session open, no turn touched. An exit
 * code says what a script must know: 0 the session ended or the user stopped,
 * 1 the watch is gone / the daemon is too old / the transport failed, 2 the
 * queue overflowed so badly the daemon ended the watch.
 */
async function followDaemon(
  deps: LogsDeps,
  uid: string,
  opts: LogsOptions,
  url: string,
): Promise<number> {
  const dial = deps.dial ?? webSocketChannelFactory;
  let channel: DuplexChannel;
  try {
    channel = await dial(url, {
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    })();
  } catch (error) {
    deps.err(`[logs] cannot reach ${url}: ${untrustedText(errorText(error))}\n`);
    return 1;
  }
  const peer = new RpcPeer(channel, {
    onNotification: () => {},
    onRequest: async (method) => {
      // A daemon asks a CLIENT for the model and for hook trust; a follower
      // serves neither (it never attaches, so nothing should reach here).
      throw new Error(`logs does not serve ${method}`);
    },
  });
  let watching: string | undefined;
  const stop = (): void => {
    peer.close();
  };
  try {
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
      clientInfo: CLIENT_INFO,
    });
    const opened = await openWatch(peer, uid, opts.only as readonly WatchCategory[] | undefined);
    watching = opened.watchId;
    deps.err(`[logs] watching ${uid} on ${url} (live: asks, streaming text, turn ends)\n`);
    // The state the watch began at: a running turn, and every ask already
    // pending — printed BEFORE anything else, so an ask raised just before the
    // follower arrived is never missed (owner Q3's whole point).
    const now = (): number => Date.now();
    for (const ask of opened.state.pending) {
      printEvents(deps, updateEvents(ask, uid, now()), opts.json);
    }
    if (opened.state.running) {
      deps.err(
        `[logs] a turn is running${opened.state.turnId !== undefined ? ` (${untrustedText(opened.state.turnId)})` : ""}\n`,
      );
    }
    return await pollLoop(deps, peer, opened.watchId, uid, opts);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) {
      deps.err(`[logs] ${refusal}\n`);
      return 1;
    }
    deps.err(`[logs] ${untrustedText(errorText(error))}\n`);
    return 1;
  } finally {
    if (watching !== undefined) {
      // Release the watcher whatever ended the loop (a Ctrl+C included): the
      // daemon's queue and its timer go away now, not at some reaper.
      await closeWatch(peer, watching).catch(() => undefined);
    }
    stop();
  }
}

/** The poll loop: one `watch_next` at a time until the watch ends or the user stops it. */
async function pollLoop(
  deps: LogsDeps,
  peer: RpcPeer,
  watchId: string,
  uid: string,
  opts: LogsOptions,
): Promise<number> {
  const stopped = (): boolean => deps.signal?.aborted === true;
  for (;;) {
    if (stopped()) {
      return 0; // Ctrl+C is a normal way to stop following
    }
    let poll: Awaited<ReturnType<typeof pollWatch>>;
    try {
      poll = await pollWatch(peer, watchId, {
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
    } catch (error) {
      // Ctrl+C while a batch was held: the peer aborts the request (a
      // `$/cancelRequest` to the daemon, a local cancel here). A normal stop.
      if (stopped()) {
        return 0;
      }
      throw error;
    }
    if (poll.lost > 0) {
      // Never silent (owner Q3): the queue dropped this many before it could be
      // read, so the follower says so and goes on.
      printEvents(
        deps,
        [{ v: 1, ts: Date.now(), session: uid, type: "lost", count: poll.lost }],
        opts.json,
      );
    }
    const events = poll.updates.flatMap((update) => updateEvents(update, uid, Date.now()));
    printEvents(deps, filterEvents(events, opts.only), opts.json);
    for (const kind of poll.unknown) {
      deps.err(
        `[logs] ${kind.mandatory ? "unsupported (mandatory)" : "unsupported"} update ${untrustedText(kind.type)}\n`,
      );
      if (kind.mandatory) {
        // A mandatory kind this build cannot act on means the daemon is newer:
        // say so and stop, rather than show a stream with a hole in it.
        deps.err("[logs] this daemon is newer than this tentacle; update the laptop\n");
        return 1;
      }
    }
    if (poll.ended !== undefined) {
      return endOfWatch(deps, poll.ended, uid, opts);
    }
  }
}

/** The last word of a watch: why it stopped, and the exit code a script reads. */
function endOfWatch(
  deps: LogsDeps,
  ended: "closed" | "overflow" | "evicted",
  uid: string,
  opts: LogsOptions,
): number {
  if (ended === "closed") {
    // The session ended: `closed` already rode the batch (its own line), so this
    // is the prose a person needs and a normal stop (exit 0).
    deps.err(`[logs] session ${uid} closed\n`);
    return 0;
  }
  if (ended === "overflow") {
    deps.err(
      "[logs] the watch overflowed (even asks and turn ends could not be queued): the stream is incomplete\n",
    );
    return 2;
  }
  deps.err(`[logs] the watch was evicted (${MAX_WATCHERS_TEXT})\n`);
  return 1;
}

/** Why a watcher stops when too many are open on one session (the daemon's cap). */
const MAX_WATCHERS_TEXT = "too many watchers on this session";

/** A daemon refusal the CLI can word exactly, or `undefined` (a transport error). */
function refusalOf(error: unknown): string | undefined {
  const code = (error as { code?: number }).code;
  const message = errorText(error);
  if (code === -32601) {
    return "this daemon is too old for `logs -f` (no session/watch): use `logs --tail`";
  }
  if (code === -32003) {
    return `${message} — nothing live to follow; \`logs --tail\` reads a serve host's stored log`;
  }
  if (code === -32018) {
    return `${message} — ${UNKNOWN_WATCH_HINT}`;
  }
  return undefined;
}

/** An error's message, never a stack (a daemon's prose is untrusted text too). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `--tail` over `--connect`: read the daemon's committed log through
 * `session/log`, which a WATCHING connection may call without an `open` (so
 * `--tail` never attaches). Starts the same read-only watch, pages the log,
 * prints the same events as the file half, and releases the watch.
 */
async function readDaemon(
  deps: LogsDeps,
  uid: string,
  opts: LogsOptions,
  url: string,
): Promise<number> {
  const dial = deps.dial ?? webSocketChannelFactory;
  let channel: DuplexChannel;
  try {
    channel = await dial(url, {
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    })();
  } catch (error) {
    deps.err(`[logs] cannot reach ${url}: ${untrustedText(errorText(error))}\n`);
    return 1;
  }
  const peer = new RpcPeer(channel, {
    onNotification: () => {},
    onRequest: async (method) => {
      throw new Error(`logs does not serve ${method}`);
    },
  });
  let watching: string | undefined;
  try {
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
      clientInfo: CLIENT_INFO,
    });
    // A watch is how this connection earns the right to `session/log` (the
    // daemon's rule): it attaches nothing, so `--tail` stays read-only.
    const opened = await openWatch(peer, uid, opts.only as readonly WatchCategory[] | undefined);
    watching = opened.watchId;
    const entries = await readLog(peer, uid);
    deps.err(`[logs] ${uid} on ${url} (the daemon's committed log)\n`);
    printEvents(deps, eventsOfRead({ entries }, uid, opts.only, opts.tail), opts.json);
    return 0;
  } catch (error) {
    const refusal = refusalOf(error);
    deps.err(`[logs] ${refusal ?? untrustedText(errorText(error))}\n`);
    return 1;
  } finally {
    if (watching !== undefined) {
      await closeWatch(peer, watching).catch(() => undefined);
    }
    peer.close();
  }
}

/** How many pages of `session/log` a `--tail` read follows before it stops (a bound, not a limit). */
const LOG_PAGES_MAX = 200;

/** Every entry of a session's committed log, page by page (the current segment). */
async function readLog(peer: RpcPeer, uid: string): Promise<readonly KnownLogEntry[]> {
  const entries: KnownLogEntry[] = [];
  let after: { seq: number; id: string } | undefined;
  for (let page = 0; page < LOG_PAGES_MAX; page++) {
    const result = (await peer.request("session/log", {
      sessionId: uid,
      ...(after !== undefined ? { after } : {}),
    })) as {
      entries: { seq: number; id: string; type: string }[];
      more: boolean;
      rebased?: boolean;
    };
    if (result.rebased === true) {
      // The daemon restarted its log (`after` is gone): this page starts at its
      // `base`, so what it returned replaces what we hold.
      entries.length = 0;
    }
    for (const raw of result.entries) {
      const parsed = KnownLogEntrySchema.safeParse(raw);
      if (parsed.success) {
        entries.push(parsed.data);
      }
      // A kind this build does not know is dropped, never half-applied (the
      // same rule the client's log reader follows).
    }
    const last = result.entries.at(-1);
    if (!result.more || last === undefined) {
      break;
    }
    after = { seq: last.seq, id: last.id };
  }
  return entries;
}

/** `tentacle logs [<uid>] [--tail N] [--only …] [--json] [--summary] [-f]`. */
export async function logsCommand(opts: LogsOptions, deps: LogsDeps): Promise<number> {
  // `--connect`: the daemon side (sub-task 2). It needs a uid — a remote
  // `newest` would be another project's newest, a guess — and never touches this
  // laptop's stores.
  if (opts.connect !== undefined) {
    if (opts.uid === undefined) {
      deps.err(
        `[logs] --connect needs a session id: \`logs -f <uid> --connect ${opts.connect}\` (\`ps\` on that host lists them)\n`,
      );
      return 1;
    }
    if (!isValidSessionId(opts.uid)) {
      deps.err(`[error] ${JSON.stringify(opts.uid)} is not a valid session id\n`);
      return 1;
    }
    if (opts.summary) {
      // A summary is a FILE's facts (its path, its project, its kept segments):
      // a remote read has none of them, so say what to run instead.
      deps.err(
        "[logs] --summary reads a session's log file on THIS laptop; for a serve session, run it on that host\n",
      );
      return 1;
    }
    return opts.follow
      ? followDaemon(deps, opts.uid, opts, opts.connect)
      : readDaemon(deps, opts.uid, opts, opts.connect);
  }
  const found = await resolve(deps, opts.uid);
  if (!found.ok) {
    deps.err(found.message);
    return 1;
  }
  // Which file was read is a `logs` fact the person must never have to guess.
  deps.err(`[logs] ${found.read.file}\n`);
  if (found.read.olderSegments > 0) {
    deps.err(
      `[logs] ${found.read.olderSegments} older kept segment(s) not shown (a compaction or a context reset)\n`,
    );
  }
  if (opts.summary) {
    const summary = await summaryOf(deps, found.read, found.uid);
    deps.out(opts.json ? `${jsonLine(summary)}\n` : formatSummary(summary));
    return 0;
  }
  if (opts.follow) {
    return follow(deps, found.read, found.uid, opts);
  }
  printEvents(deps, eventsOfRead(found.read, found.uid, opts.only, opts.tail), opts.json);
  return 0;
}
