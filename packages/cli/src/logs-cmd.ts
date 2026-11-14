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
  LogSessionStore,
  type ParsedLogFile,
  entriesThrough,
  parseLogFile,
  parseSidecar,
} from "@tentacle/daemon";
import type { KnownLogEntry } from "@tentacle/protocol";
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
} from "./log-events.ts";
import { relayLogPath, runDirFor } from "./run-state.ts";
import { untrustedText } from "./untrusted-text.ts";

export interface LogsOptions {
  /** A full session uid; absent = the newest session of this project. */
  readonly uid?: string;
  readonly tail: number;
  readonly only?: readonly LogCategory[];
  readonly json: boolean;
  readonly summary: boolean;
  readonly follow: boolean;
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

/** `tentacle logs [<uid>] [--tail N] [--only …] [--json] [--summary] [-f]`. */
export async function logsCommand(opts: LogsOptions, deps: LogsDeps): Promise<number> {
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
