/**
 * The laptop's session store: one typed event log per session, `<uid>.jsonl`
 * (docs/feat/session-log-laptop-store.md; the format is `session-log-file.ts`).
 *
 * A save APPENDS the entries a `session/log` read returned (validated and
 * re-serialized by the client: F4) when they continue the file's last entry —
 * one `write` + `fsync`, the inode kept. Any other save (a cold, rebased or
 * forked read, a mismatch after a failed or skipped write, a compaction with
 * `keepSuperseded` off) REPLACES the file atomically (temp + fsync + rename)
 * with the writer's current segment. Before a replace drops the file's last
 * segment, that segment must be CONTAINED (its projection a prefix of the new
 * one, or superseded in the same daemon incarnation); otherwise its bytes are
 * set aside first (`<uid>.stale-<ms>-<hex>.aside`, a log file too) and
 * `onAside` says so — never spliced, never silently lost (F1 on disk).
 *
 * Several writers (two TUIs of a detached run, a relay): every write and
 * remove holds the session's lock file `.<uid>.lock` (`wx`, `pid token ms`;
 * a dead holder or a stamp older than `lockStaleMs` is taken over; a live one
 * is waited for up to `lockWaitMs`, then the save fails and is reported). A
 * writer on the same daemon segment appends only what the file lacks, or
 * skips when the file is already ahead: an older copy never regresses a newer
 * one.
 *
 * Only `<uid>.jsonl` is read: a legacy `<uid>.json` in the folder is ignored
 * (owner, 2026-11-07: no conversion, no backward compatibility).
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import {
  type LoadResult,
  type RecordTitle,
  type SessionRecord,
  type TitleState,
  encodeTitle,
  isValidSessionId,
  recordTitleState,
} from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  type LogCursor,
  type SessionTitle,
  canonicalMessage,
} from "@tentacle/protocol";
import {
  type LogSegment,
  type ParsedLogFile,
  closeAtLoad,
  currentSegment,
  entryLines,
  headerLine,
  parseLogFile,
  segmentFromMessages,
} from "./session-log-file.ts";

/** The facts the header holds (immutable for a session). */
export interface LogMeta {
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: number;
}

/** One save from a `session/log` read (`RemoteClient.readBack`'s `ReadBack`, plus the session's facts). */
export interface LogWrite {
  readonly id: string;
  readonly meta: LogMeta;
  /** The read's validated, re-serialized known entries, in order. */
  readonly entries: readonly KnownLogEntry[];
  /** The client's projection after the read (= the fold of the writer's segment). */
  readonly messages: readonly ChatMessage[];
  readonly read: {
    readonly from?: LogCursor;
    readonly head: LogCursor;
    readonly outcome: string;
  };
  /**
   * The `serve` daemon's state file (docs/feat/session-log-serve-store.md):
   * written atomically to `<uid>.state.json` AFTER the log op succeeded, in
   * the same queued op and lock — the unit's commit marker. A failed log op
   * throws before it (the old state file stays). The laptop never passes it.
   */
  readonly sidecar?: string;
  /** Write header + `base` even for an empty history (`serve`: a created session survives a restart). */
  readonly keepEmpty?: boolean;
}

/** A daemon session's files as read back (`readRaw`): the log's text and its state file's (null: none). */
export type RawSessionFiles =
  | { readonly status: "ok"; readonly log: string; readonly state: string | null }
  | { readonly status: "absent" }
  | { readonly status: "unreadable"; readonly file: string; readonly reason: string };

/** A daemon session's header line and state file (`readState`): the log itself is not read. */
export type RawSessionState =
  | { readonly status: "ok"; readonly header: string; readonly state: string | null }
  | { readonly status: "absent" }
  | { readonly status: "unreadable"; readonly file: string; readonly reason: string };

/** What a session list shows, without loading every history (`summarize`). */
export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: number;
  /** The file's modification time (every save writes it). */
  readonly updatedAt: number;
  readonly title: string | RecordTitle;
  /** Non-system messages of the history a load gives. */
  readonly messageCount: number;
}

export interface SkippedLog {
  readonly id: string;
  readonly file: string;
  readonly reason: string;
}

/** A replace set the file's content aside instead of dropping it. */
export interface LogAsideInfo {
  readonly id: string;
  readonly file: string;
  readonly reason: string;
}

/** The writes the store makes; injectable so tests can count or fail one. */
export interface LogStoreIo {
  /** Append `data` to `path` (created if absent) in one write, then fsync. */
  append(path: string, data: string): Promise<void>;
  /** Write `data` to a NEW file at `path` and fsync it. */
  writeDurable(path: string, data: string): Promise<void>;
}

const defaultIo: LogStoreIo = {
  async append(path, data) {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.write(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async writeDurable(path, data) {
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export interface LogSessionStoreOptions {
  /** Keep superseded segments (compaction, `context_reset`) in the file. Default `false`. */
  readonly keepSuperseded?: boolean;
  readonly io?: LogStoreIo;
  /** Told of every aside a replace made (a notice; never a raw terminal write). */
  readonly onAside?: (info: LogAsideInfo) => void;
  /** How long a live holder of a session's lock is waited for. Default 2 s. */
  readonly lockWaitMs?: number;
  /** A lock whose stamp is older than this is stale (taken over). Default 30 s. */
  readonly lockStaleMs?: number;
}

/** What one writer (this store, this uid) remembers between saves. */
interface WriterState {
  /** Its current segment as of its latest read (from that segment's `base`). */
  segment: KnownLogEntry[];
  /** The segment before it, when this writer saw the transition (a compaction/reset). */
  previous?: KnownLogEntry[] | undefined;
  /** The last entry id it wrote (or found) at the file's end. */
  lastDiskHead?: string | undefined;
  /** The client head of the last read it wrote from. */
  lastFromHead?: LogCursor;
  /** The laptop-minted incarnation of its snapshot saves (the in-process path). */
  snapshotInc?: string;
  /** The copy `saveAside` last set aside (a fork's held copy): a replace need not set it aside again. */
  asided?: readonly ChatMessage[] | undefined;
}

type Op =
  | { readonly kind: "write"; readonly update: LogWrite }
  | { readonly kind: "snapshot"; readonly record: SessionRecord }
  | { readonly kind: "state"; readonly data: string }
  | { readonly kind: "aside"; readonly reason: string }
  | { readonly kind: "dropState" }
  | { readonly kind: "remove" };

interface Slot {
  /** Pending operations, in order (writes are never coalesced: each read's entries matter). */
  queue: Array<{ op: Op; resolve: () => void; reject: (error: unknown) => void }>;
  running: Promise<void> | null;
}

const FS_ERRORS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOSPC: "no space left on device",
  EDQUOT: "disk quota exceeded",
  EROFS: "read-only file system",
  EIO: "I/O error",
};

function describeFsError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return `${FS_ERRORS[code] ?? "error"} (${code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** `.<uid>.jsonl.tmp-<pid>-<hex>`: a replace's temp; `.<uid>.state.json.tmp-…`: a state file's. */
const TEMP_NAME = /^\..+\.(?:jsonl|state\.json)\.tmp-(\d+)-[0-9a-f]+$/;
/** `.<uid>.lock`. */
const LOCK_NAME = /^\..+\.lock$/;
/** What follows `<id>.stale-` in an aside's name. */
const ASIDE_TAIL = /^\d+-[0-9a-f]{8}\.aside$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `held` is a prefix of `next` (each message by its canonical form). */
function isPrefix(held: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
  if (held.length > next.length) return false;
  for (let i = 0; i < held.length; i++) {
    const a = held[i];
    const b = next[i];
    if (a === undefined || b === undefined || canonicalMessage(a) !== canonicalMessage(b)) {
      return false;
    }
  }
  return true;
}

function titleOf(title: SessionTitle | undefined, messages: readonly ChatMessage[]) {
  const state: TitleState =
    title === undefined || title.source === "auto"
      ? { source: "auto" }
      : { source: title.source, text: title.text };
  return encodeTitle(state, messages);
}

/** The id at which `entries` holds `id`, searching from the end (the usual case is near it). */
function indexOfId(entries: readonly KnownLogEntry[], id: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.id === id) return i;
  }
  return -1;
}

/** A directory of `<uid>.jsonl` session logs (the laptop's store). */
export class LogSessionStore {
  private readonly slots = new Map<string, Slot>();
  private readonly writers = new Map<string, WriterState>();
  private readonly io: LogStoreIo;
  private readonly keepSuperseded: boolean;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;
  /** Tells two store instances of ONE process apart in a lock body. */
  private readonly token = randomUUID().slice(0, 8);
  private swept = false;

  constructor(
    private readonly dir: string,
    private readonly options: LogSessionStoreOptions = {},
  ) {
    this.io = options.io ?? defaultIo;
    this.keepSuperseded = options.keepSuperseded === true;
    this.lockWaitMs = options.lockWaitMs ?? 2000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  /** The session file's path. */
  file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  /** The `serve` daemon's state file of the session (`LogWrite.sidecar`). */
  stateFile(id: string): string {
    return join(this.dir, `${id}.state.json`);
  }

  private lockFile(id: string): string {
    return join(this.dir, `.${id}.lock`);
  }

  /**
   * Save one `session/log` read (APPEND or REPLACE, see the module comment).
   * Resolves once it is durable (or skipped: the file already holds it);
   * REJECTS when the write failed — the caller reports it, and the next save
   * heals the file (its check then fails, and it replaces from the segment).
   */
  write(update: LogWrite): Promise<void> {
    return this.enqueue(update.id, { kind: "write", update });
  }

  /**
   * Save a whole history with no daemon log (the in-process path): a REPLACE
   * with a laptop-minted segment (`base{create}` + its messages + a chosen
   * title), under the lock; `keepSuperseded` does not apply (it cannot tell a
   * compaction from a rewrite). The containment rule still holds: another
   * writer's content this copy does not contain goes aside first.
   */
  saveSnapshot(record: SessionRecord): Promise<void> {
    return this.enqueue(record.id, { kind: "snapshot", record });
  }

  /**
   * Replace the session's state file only (`serve`: an archived rename or
   * reclaim — the log is not touched), under its lock, in its queue.
   */
  writeState(id: string, data: string): Promise<void> {
    return this.enqueue(id, { kind: "state", data });
  }

  /**
   * Move the session's log aside (`<uid>.stale-<ms>-<hex>.aside`, `onAside`
   * says where), under its lock, in its queue: `serve`'s log with no state
   * file (a new session cut before its first save landed, FM 5).
   */
  setAside(id: string, reason: string): Promise<void> {
    return this.enqueue(id, { kind: "aside", reason });
  }

  /** Delete only the session's state file (`serve`: one left with no log, a remove cut short). */
  removeState(id: string): Promise<void> {
    return this.enqueue(id, { kind: "dropState" });
  }

  /** Delete the session's state file, its log and its asides (in that order), under its lock, in its queue. */
  remove(id: string): Promise<void> {
    if (!isValidSessionId(id)) {
      return Promise.reject(new Error(`invalid session id ${JSON.stringify(id)}`));
    }
    return this.enqueue(id, { kind: "remove" });
  }

  /**
   * Keep a copy the daemon's history FORKED from (docs/feat/session-log.md F1)
   * in a new aside file — a log file too (header + a laptop-minted segment) —
   * and resolve with its path. Never touches `<uid>.jsonl`. Rejects when the
   * write fails (the caller keeps the copy and retries).
   */
  async saveAside(
    id: string,
    meta: LogMeta,
    messages: readonly ChatMessage[],
    title: TitleState,
  ): Promise<string> {
    if (!isValidSessionId(id)) {
      throw new Error(`invalid session id ${JSON.stringify(id)}`);
    }
    const chosen: SessionTitle | undefined =
      title.source === "auto" ? undefined : { text: title.text, source: title.source };
    const text =
      headerLine({ id, ...meta }) +
      entryLines(segmentFromMessages(messages, chosen, `laptop-${randomUUID()}`, Date.now()));
    await mkdir(this.dir, { recursive: true });
    const file = await this.writeAside(id, text);
    const state = this.writers.get(id) ?? { segment: [] };
    state.asided = messages;
    this.writers.set(id, state);
    return file;
  }

  /** Resolve once every in-flight and queued operation has settled. */
  async drain(): Promise<void> {
    for (;;) {
      const running = [...this.slots.values()].flatMap((s) => (s.running ? [s.running] : []));
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  private enqueue(id: string, op: Op): Promise<void> {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { queue: [], running: null };
      this.slots.set(id, slot);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    slot.queue.push({ op, resolve, reject });
    if (!slot.running) {
      slot.running = this.pump(id, slot);
    }
    return promise;
  }

  private async pump(id: string, slot: Slot): Promise<void> {
    for (;;) {
      const next = slot.queue.shift();
      if (!next) break;
      try {
        await this.run(id, next.op);
        next.resolve();
      } catch (error) {
        next.reject(error);
      }
    }
    slot.running = null;
    this.slots.delete(id);
  }

  private async run(id: string, op: Op): Promise<void> {
    if (!isValidSessionId(id)) {
      throw new Error(`invalid session id ${JSON.stringify(id)}`);
    }
    // The writer's segment follows EVERY read, written or not (a failed write
    // must not leave it behind: the next save replaces from it).
    if (op.kind === "write") {
      this.advance(id, op.update);
    }
    const target = this.file(id);
    try {
      await mkdir(this.dir, { recursive: true });
      if (!this.swept) {
        this.swept = true;
        await this.sweep();
      }
      const release = await this.lock(id);
      try {
        if (op.kind === "write") {
          await this.writeLocked(id, op.update);
          if (op.update.sidecar !== undefined) {
            await this.writeStateLocked(id, op.update.sidecar);
          }
        } else if (op.kind === "snapshot") await this.snapshotLocked(op.record);
        else if (op.kind === "state") await this.writeStateLocked(id, op.data);
        else if (op.kind === "aside") await this.asideLocked(id, op.reason);
        else if (op.kind === "dropState") await rm(this.stateFile(id), { force: true });
        else await this.removeLocked(id);
      } finally {
        await release();
      }
    } catch (error) {
      if (error instanceof LockBusyError || error instanceof StateWriteError) throw error;
      const verb = op.kind === "remove" ? "remove" : "write";
      throw new Error(`couldn't ${verb} ${target}: ${describeFsError(error)}`, { cause: error });
    }
  }

  /** The state file, atomically (temp + fsync + rename): the old one or the new one. */
  private async writeStateLocked(id: string, data: string): Promise<void> {
    const path = this.stateFile(id);
    try {
      await this.writeWhole(path, data);
    } catch (error) {
      throw new StateWriteError(`couldn't write ${path}: ${describeFsError(error)}`, {
        cause: error,
      });
    }
  }

  /** The log moved aside whole (its bytes kept), the id free again. */
  private async asideLocked(id: string, reason: string): Promise<void> {
    const path = this.file(id);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return;
      throw error;
    }
    await this.asideRaw(id, text, reason);
    await rm(path, { force: true });
    this.writers.delete(id);
  }

  /** Fold a read into the writer's segment (a batch with a `base` restarts it there). */
  private advance(id: string, update: LogWrite): void {
    const state = this.writers.get(id) ?? { segment: [] };
    const entries = update.entries;
    const lastBase = lastBaseIndex(entries);
    if (lastBase < 0) {
      if (update.read.outcome === "linear") {
        state.segment = [...state.segment, ...entries];
      }
      // A non-linear read always starts at a base (the reader's rule); one
      // without entries changes nothing.
    } else {
      const before = entries.slice(0, lastBase);
      const after = entries.slice(lastBase);
      if (update.read.outcome === "linear") {
        // The segment the last base superseded, whole: the held one + its tail
        // in this batch, or (two bases in one batch) the one between them.
        const inBatch = lastBaseIndex(before);
        state.previous = inBatch < 0 ? [...state.segment, ...before] : before.slice(inBatch);
      } else {
        state.previous = undefined;
      }
      state.segment = after;
    }
    this.writers.set(id, state);
  }

  private async writeLocked(id: string, update: LogWrite): Promise<void> {
    const state = this.writers.get(id);
    if (!state || state.segment.length === 0 || state.segment[0]?.type !== "base") {
      // No complete segment to write from (a linear read with nothing held).
      throw new Error("no complete log segment to save yet");
    }
    const segment = state.segment;
    const path = this.file(id);
    const tail = await readTail(path);
    if (tail.kind === "absent" && update.messages.length === 0 && update.keepEmpty !== true) {
      return; // nothing to keep yet (no prompt committed): no empty session file
    }
    const hasBase = update.entries.some((e) => e.type === "base");
    const linear = update.read.outcome === "linear";
    if (tail.kind === "line" && linear) {
      const from = update.read.from;
      const continues =
        from !== undefined &&
        (tail.lastId === from.id ||
          (tail.lastId === state.lastDiskHead &&
            state.lastFromHead !== undefined &&
            state.lastFromHead.id === from.id &&
            state.lastFromHead.seq === from.seq));
      if (continues) {
        if (update.entries.length === 0) {
          this.remember(state, tail.lastId, update.read.head);
          return;
        }
        if (hasBase && !this.keepSuperseded) {
          // A compaction / reset with keepSuperseded off: the new segment replaces
          // the superseded one (today's behaviour). Through `replace`, which reads
          // the file: segments kept earlier are carried over, and unknown lines of
          // the superseded segment are set aside, never dropped.
          await this.replace(
            id,
            update.meta,
            update.messages,
            segment,
            state,
            update.read.head,
            tail,
          );
          return;
        }
        await this.appendLines(path, tail, update.entries);
        this.remember(state, update.entries.at(-1)?.id, update.read.head);
        return;
      }
    }
    if (tail.kind === "line" && tail.lastId !== undefined) {
      // Another writer of the same segment: append what the file lacks.
      const at = indexOfId(segment, tail.lastId);
      if (at >= 0) {
        const missing = segment.slice(at + 1);
        if (missing.length > 0) {
          await this.appendLines(path, tail, missing);
        }
        this.remember(state, segment.at(-1)?.id, update.read.head);
        return;
      }
    }
    await this.replace(id, update.meta, update.messages, segment, state, update.read.head, tail);
  }

  private remember(state: WriterState, lastDiskHead: string | undefined, from: LogCursor): void {
    if (lastDiskHead !== undefined) state.lastDiskHead = lastDiskHead;
    state.lastFromHead = from;
  }

  /** Truncate a torn tail (a crash mid-append), then append `entries` in one write + fsync. */
  private async appendLines(
    path: string,
    tail: Extract<Tail, { kind: "line" }>,
    entries: readonly KnownLogEntry[],
  ): Promise<void> {
    if (tail.contentEnd < tail.size) {
      await truncate(path, tail.contentEnd);
    }
    await this.io.append(path, entryLines(entries));
  }

  /**
   * REPLACE the file with this writer's segment (after the containment rule),
   * or skip when the file already holds more of the same segment.
   */
  private async replace(
    id: string,
    meta: LogMeta,
    messages: readonly ChatMessage[],
    segment: readonly KnownLogEntry[],
    state: WriterState,
    head: LogCursor,
    tail: Tail,
  ): Promise<void> {
    const path = this.file(id);
    let text: string | null = null;
    if (tail.kind !== "absent") {
      text = await readFile(path, "utf8").catch(() => null);
    }
    const mine = segment[0] as Extract<KnownLogEntry, { type: "base" }>;
    let kept = "";
    let headerMeta = meta;
    if (text !== null && text !== "") {
      const parsed = parseLogFile(text, id);
      if (!parsed.ok) {
        // Unreadable (corrupt, a newer version, an unknown critical entry):
        // its bytes go aside first, never overwritten silently (FM 14).
        await this.asideRaw(id, text, parsed.reason);
      } else {
        headerMeta = {
          cwd: parsed.header.cwd,
          model: parsed.header.model,
          createdAt: parsed.header.createdAt,
        };
        const last = currentSegment(parsed);
        // Same daemon, the file's last segment NEWER than this writer's (a
        // compaction/reset another writer already saved): the file is ahead.
        const ahead =
          last.base.inc === mine.inc && last.base.id !== mine.id && last.base.seq > mine.seq;
        // Same segment, file AHEAD (another writer appended more): skip.
        if (ahead || (last.base.id === mine.id && fileHolds(last, segment))) {
          // The file's end is NOT this writer's head: forget the pair, so a
          // later read is matched by id (or by its segment), never re-appended.
          state.lastDiskHead = undefined;
          state.lastFromHead = head;
          return;
        }
        // Unknown lines after the last known one but the known part continues
        // this writer's segment: append (the newer build's lines are kept).
        const known = last.entries.at(-1)?.id;
        if (last.base.id === mine.id && known !== undefined) {
          const at = indexOfId(segment, known);
          if (at >= 0) {
            const missing = segment.slice(at + 1);
            if (missing.length > 0) {
              // BYTE offsets (the file is truncated by bytes; `text` is decoded).
              await this.appendLines(
                path,
                {
                  kind: "line",
                  size: Buffer.byteLength(text),
                  contentEnd: Buffer.byteLength(text.slice(0, parsed.contentEnd)),
                },
                missing,
              );
            }
            this.remember(state, segment.at(-1)?.id, head);
            return;
          }
        }
        // Segments kept earlier survive whatever the option says now: switching
        // it off stops keeping NEW superseded history, it never erases the old.
        const carried = parsed.segments.slice(0, -1).map((s) => text.slice(s.start, s.end));
        kept =
          carried.join("") + (await this.settleLast(id, text, parsed, last, mine, messages, state));
      }
    }
    await this.writeWhole(path, headerLine({ id, ...headerMeta }) + kept + entryLines(segment));
    this.remember(state, segment.at(-1)?.id, head);
  }

  /**
   * What happens to the file's last segment `last` before the new segment
   * replaces it: its text when it is kept, `""` when it is dropped (contained,
   * or superseded and not kept), after setting it aside when it is neither.
   */
  private async settleLast(
    id: string,
    text: string,
    parsed: ParsedLogFile,
    last: LogSegment,
    mine: Extract<KnownLogEntry, { type: "base" }>,
    messages: readonly ChatMessage[],
    state: WriterState,
  ): Promise<string> {
    const sameInc = last.base.inc === mine.inc && last.base.id !== mine.id;
    const superseding = mine.reason === "compact" || mine.reason === "context_reset";
    if (sameInc && superseding) {
      // Superseded in the same incarnation (one writer): kept or dropped by config.
      if (this.keepSuperseded) {
        const previous = state.previous;
        if (
          previous !== undefined &&
          previous[0]?.id === last.base.id &&
          fileHolds(last, previous)
        ) {
          return text.slice(last.start, last.end) + entryLines(previous.slice(last.entries.length));
        }
        return text.slice(last.start, last.end);
      }
      if (last.unknown === 0) return "";
      // Dropped by config, but it holds lines this build does not know (a newer
      // build's): set aside, never dropped silently (falls through).
    } else if (
      last.unknown === 0 &&
      (sameInc ||
        // A base that explicitly continues the file's last entry restates that
        // segment (`serve`'s reload, docs/feat/session-log-serve-store.md Q11).
        (mine.prev !== undefined && last.entries.at(-1)?.id === mine.prev) ||
        isPrefix(last.messages, messages))
    ) {
      return ""; // contained: a restatement (seed/reload/create) or the same lineage
    }
    if (last.unknown === 0 && state.asided && isPrefix(last.messages, state.asided)) {
      state.asided = undefined;
      return ""; // contained in the copy a fork just set aside (durable before this write)
    }
    await this.asideRaw(
      id,
      headerLine(parsed.header) + text.slice(last.start, last.end),
      last.unknown > 0
        ? "the file held entries this build does not know"
        : "the file held a history this copy does not contain",
    );
    return "";
  }

  private async snapshotLocked(record: SessionRecord): Promise<void> {
    const id = record.id;
    const state = this.writers.get(id) ?? { segment: [] };
    state.snapshotInc ??= `laptop-${randomUUID()}`;
    const titleState = recordTitleState(record);
    const chosen: SessionTitle | undefined =
      titleState.source === "auto"
        ? undefined
        : { text: titleState.text, source: titleState.source };
    const segment = segmentFromMessages(record.messages, chosen, state.snapshotInc, Date.now());
    state.segment = segment;
    this.writers.set(id, state);
    const path = this.file(id);
    const meta: LogMeta = { cwd: record.cwd, model: record.model, createdAt: record.createdAt };
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch {
      text = null;
    }
    let headerMeta = meta;
    let carried = "";
    if (text !== null && text !== "") {
      const parsed = parseLogFile(text, id);
      if (!parsed.ok) {
        await this.asideRaw(id, text, parsed.reason);
      } else {
        headerMeta = {
          cwd: parsed.header.cwd,
          model: parsed.header.model,
          createdAt: parsed.header.createdAt,
        };
        // Segments kept earlier (keepSuperseded) survive this save.
        carried = parsed.segments
          .slice(0, -1)
          .map((s) => text.slice(s.start, s.end))
          .join("");
        const last = currentSegment(parsed);
        const mine = last.base.inc === state.snapshotInc; // this writer's own earlier save
        if (last.unknown > 0 || (!mine && !isPrefix(last.messages, record.messages))) {
          await this.asideRaw(
            id,
            headerLine(parsed.header) + text.slice(last.start, last.end),
            "the file held a history this copy does not contain",
          );
        }
      }
    }
    await this.writeWhole(path, headerLine({ id, ...headerMeta }) + carried + entryLines(segment));
  }

  private async removeLocked(id: string): Promise<void> {
    // The state file first: a remove cut short leaves a log with no state
    // (set aside at the next start) or nothing, never a state with no log.
    await rm(this.stateFile(id), { force: true });
    await rm(this.file(id), { force: true });
    this.writers.delete(id);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const prefix = `${id}.stale-`;
    for (const name of names) {
      if (name.startsWith(prefix) && ASIDE_TAIL.test(name.slice(prefix.length))) {
        await rm(join(this.dir, name), { force: true }).catch(() => {});
      }
    }
  }

  /** temp + fsync + rename: the old file or the new one, never half of one. */
  private async writeWhole(path: string, data: string): Promise<void> {
    const temp = join(
      this.dir,
      `.${path.slice(this.dir.length + 1)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await this.io.writeDurable(temp, data);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async writeAside(id: string, data: string): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const destination = join(this.dir, `${id}.stale-${Date.now()}-${suffix}.aside`);
    const temp = join(this.dir, `.${id}.jsonl.tmp-${process.pid}-${suffix}`);
    try {
      await this.io.writeDurable(temp, data);
      await rename(temp, destination);
      return destination;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw new Error(`couldn't write ${destination}: ${describeFsError(error)}`, { cause: error });
    }
  }

  /** Set `data` aside (durable BEFORE the main file changes) and say so. */
  private async asideRaw(id: string, data: string, reason: string): Promise<void> {
    const file = await this.writeAside(id, data);
    try {
      this.options.onAside?.({ id, file, reason });
    } catch {
      // A broken listener must not undo a write that landed.
    }
  }

  /**
   * Take `.<uid>.lock`. A live holder is waited for (backoff) up to
   * `lockWaitMs`; a dead one, or a stamp older than `lockStaleMs`, is taken
   * over. Resolves with the release (which removes the file only if it is
   * still ours).
   */
  private async lock(id: string): Promise<() => Promise<void>> {
    const path = this.lockFile(id);
    const body = `${process.pid} ${this.token} ${Date.now()}`;
    const deadline = Date.now() + this.lockWaitMs;
    let delay = 5;
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(body);
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            if ((await readFile(path, "utf8")) === body) {
              await rm(path, { force: true });
            }
          } catch {
            // Already gone (taken over as stale): nothing to release.
          }
        };
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      }
      let holder: { pid: number; stamp: number } | null = null;
      let mtime = 0;
      try {
        const [pid, , stamp] = (await readFile(path, "utf8")).trim().split(" ");
        holder = { pid: Number(pid), stamp: Number(stamp) };
        mtime = (await stat(path)).mtimeMs;
      } catch {
        continue; // vanished between the two calls: try again at once
      }
      // A body that is empty or unparsable is a holder between `open(wx)` and its
      // write (or a foreign file): LIVE until the lock's mtime is older than the
      // stale age, never taken at once.
      const readable =
        Number.isSafeInteger(holder.pid) && holder.pid > 0 && Number.isFinite(holder.stamp);
      const stale = readable
        ? !processAlive(holder.pid) || Date.now() - holder.stamp > this.lockStaleMs
        : Date.now() - mtime > this.lockStaleMs;
      if (stale) {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockBusyError(
          `the session file is being written by another tentacle${readable ? ` (pid ${holder.pid})` : ""}; not saved this time`,
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 100);
    }
  }

  /** Remove crash leftovers: temps and locks of dead writers (or very old temps). Best-effort. */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const temp = TEMP_NAME.exec(name);
        if (temp) {
          const pid = Number(temp[1]);
          if (
            pid !== process.pid &&
            (!processAlive(pid) || Date.now() - (await stat(path)).mtimeMs > STALE_TEMP_MS)
          ) {
            await rm(path, { force: true });
          }
          continue;
        }
        if (LOCK_NAME.test(name)) {
          const pid = Number((await readFile(path, "utf8")).trim().split(" ")[0]);
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)) {
            await rm(path, { force: true });
          }
        }
      } catch {
        // Vanished or unreadable: not worth failing over.
      }
    }
  }

  /** One session's history, as a LOAD gives it (an open turn closed). */
  async load(id: string): Promise<LoadResult> {
    const file = this.file(id);
    if (!isValidSessionId(id)) {
      return { status: "unreadable", file, reason: `invalid session id ${JSON.stringify(id)}` };
    }
    let text: string;
    let mtime: number;
    try {
      const st = await stat(file);
      mtime = st.mtimeMs;
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", file, reason: describeFsError(error) };
    }
    const parsed = parseLogFile(text, id);
    if (!parsed.ok) {
      return { status: "unreadable", file, reason: parsed.reason };
    }
    const segment = currentSegment(parsed);
    const messages = closeAtLoad(segment);
    return {
      status: "ok",
      record: {
        id,
        cwd: parsed.header.cwd,
        model: parsed.header.model,
        createdAt: parsed.header.createdAt,
        updatedAt: Math.round(mtime),
        title: titleOf(segment.title, messages),
        messages,
      },
    };
  }

  /**
   * `serve`: the session's log text and state file text, as they are (the
   * daemon's loader parses them, `daemon-state-file.ts`; no turn is closed
   * here). A log with no state file → `state: null`; no log → `absent`.
   */
  async readRaw(id: string): Promise<RawSessionFiles> {
    const file = this.file(id);
    if (!isValidSessionId(id)) {
      return { status: "unreadable", file, reason: `invalid session id ${JSON.stringify(id)}` };
    }
    let log: string;
    try {
      log = await readFile(file, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", file, reason: describeFsError(error) };
    }
    const state = await this.readStateText(id);
    return state.ok ? { status: "ok", log, state: state.text } : state.unreadable;
  }

  /**
   * `serve`: the session's header line and state file text — the log beyond
   * its first line is NOT read (an archived session is indexed from these).
   */
  async readState(id: string): Promise<RawSessionState> {
    const file = this.file(id);
    if (!isValidSessionId(id)) {
      return { status: "unreadable", file, reason: `invalid session id ${JSON.stringify(id)}` };
    }
    let header: string;
    try {
      header = await readFirstLine(file);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", file, reason: describeFsError(error) };
    }
    const state = await this.readStateText(id);
    return state.ok ? { status: "ok", header, state: state.text } : state.unreadable;
  }

  private async readStateText(id: string): Promise<
    | { readonly ok: true; readonly text: string | null }
    | {
        readonly ok: false;
        readonly unreadable: { status: "unreadable"; file: string; reason: string };
      }
  > {
    const file = this.stateFile(id);
    try {
      return { ok: true, text: await readFile(file, "utf8") };
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return { ok: true, text: null };
      return {
        ok: false,
        unreadable: { status: "unreadable", file, reason: describeFsError(error) },
      };
    }
  }

  /**
   * `serve`'s start-up listing: the ids with a log (`<uid>.jsonl`), and the
   * ids with a state file but no log (a remove cut short). A legacy
   * `<uid>.json` is not listed.
   */
  async daemonFiles(): Promise<{ readonly logs: string[]; readonly orphanStates: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { logs: [], orphanStates: [] };
    }
    const logs = await this.ids();
    const withLog = new Set(logs);
    const orphanStates = names
      .filter((name) => name.endsWith(".state.json") && !name.startsWith("."))
      .map((name) => name.slice(0, -".state.json".length))
      .filter((id) => isValidSessionId(id) && !withLog.has(id));
    return { logs, orphanStates };
  }

  /** One session's list entry: the same walk as `load`, without the per-entry schema parse. */
  async summarize(
    id: string,
  ): Promise<
    | { readonly status: "ok"; readonly summary: SessionSummary }
    | { readonly status: "absent" }
    | { readonly status: "unreadable"; readonly file: string; readonly reason: string }
  > {
    const file = this.file(id);
    let text: string;
    let mtime: number;
    try {
      const st = await stat(file);
      mtime = st.mtimeMs;
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", file, reason: describeFsError(error) };
    }
    const parsed = parseLogFile(text, id, { lax: true });
    if (!parsed.ok) {
      return { status: "unreadable", file, reason: parsed.reason };
    }
    const segment = currentSegment(parsed);
    const messages = closeAtLoad(segment);
    return {
      status: "ok",
      summary: {
        id,
        cwd: parsed.header.cwd,
        model: parsed.header.model,
        createdAt: parsed.header.createdAt,
        updatedAt: Math.round(mtime),
        title: titleOf(segment.title, messages),
        messageCount: messages.filter((m) => m.role !== "system").length,
      },
    };
  }

  /** Every `<uid>.jsonl` of the folder, summarized one at a time (a legacy `.json` is ignored). */
  async *scan(): AsyncIterable<{
    readonly id: string;
    readonly result: Awaited<ReturnType<LogSessionStore["summarize"]>>;
  }> {
    for (const id of await this.ids()) {
      yield { id, result: await this.summarize(id) };
    }
  }

  /** The ids of the folder's `<uid>.jsonl` files (a missing folder: none). */
  private async ids(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter((id) => isValidSessionId(id));
  }

  /**
   * Every session FULLY loaded (strict, as `load`), newest-updated first, plus
   * the files that could not be used. O(all files): for tests and audits; a
   * picker uses `list`.
   */
  async loadAll(): Promise<{ readonly records: SessionRecord[]; readonly skipped: SkippedLog[] }> {
    const records: SessionRecord[] = [];
    const skipped: SkippedLog[] = [];
    for (const id of await this.ids()) {
      const result = await this.load(id);
      if (result.status === "ok") records.push(result.record);
      else if (result.status === "unreadable") {
        skipped.push({ id, file: result.file, reason: result.reason });
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { records, skipped };
  }

  /** Every session's summary, newest-updated first, plus the files that could not be used. */
  async list(): Promise<{ readonly records: SessionSummary[]; readonly skipped: SkippedLog[] }> {
    const records: SessionSummary[] = [];
    const skipped: SkippedLog[] = [];
    for await (const { id, result } of this.scan()) {
      if (result.status === "ok") records.push(result.summary);
      else if (result.status === "unreadable") {
        skipped.push({ id, file: result.file, reason: result.reason });
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { records, skipped };
  }
}

/** A live holder kept the session's lock past the wait: this save failed (retried at the next). */
export class LockBusyError extends Error {}

/** The log op landed but the state file did not (`serve`: the unit failed; the next one heals). */
export class StateWriteError extends Error {}

/** A file's first line (without its `\n`), read in chunks: the header of a log file. */
async function readFirstLine(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const CHUNK = 16 * 1024;
    const parts: Uint8Array[] = [];
    let position = 0;
    for (;;) {
      const chunk = new Uint8Array(CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const nl = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl));
        break;
      }
      parts.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Index of the last `base` in `entries` (-1 when none). */
function lastBaseIndex(entries: readonly KnownLogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "base") return i;
  }
  return -1;
}

/** `last` (a file segment) holds every entry of `segment` (same ids, in order, as a prefix of it). */
function fileHolds(last: LogSegment, segment: readonly KnownLogEntry[]): boolean {
  if (last.entries.length < segment.length) return false;
  for (let i = 0; i < segment.length; i++) {
    if (last.entries[i]?.id !== segment[i]?.id) return false;
  }
  return true;
}

type Tail =
  | { readonly kind: "absent" }
  /** Unreadable tail (no line, or not JSON): the caller replaces. */
  | { readonly kind: "unknown" }
  | {
      readonly kind: "line";
      readonly size: number;
      /** After the last `\n`: a torn tail beyond it is truncated before an append. */
      readonly contentEnd: number;
      readonly lastId?: string;
    };

/**
 * The file's last complete line, read backwards in chunks until a `\n` before
 * it is found (one 8 MB line still works). A last line that is a header (a
 * file with no entry) or of an unknown type reports no `lastId`.
 */
async function readTail(path: string): Promise<Tail> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const CHUNK = 64 * 1024;
    let start = size;
    let buf = new Uint8Array(0);
    /** Offset (in `buf`) of the `\n` ending the last complete line; -1 until found. */
    let nl = -1;
    while (start > 0) {
      const from = Math.max(0, start - CHUNK);
      const chunk = new Uint8Array(start - from);
      await handle.read(chunk, 0, chunk.length, from);
      nl = nl < 0 ? -1 : nl + chunk.length; // the old offset moves with the prepend
      const joined = new Uint8Array(chunk.length + buf.length);
      joined.set(chunk, 0);
      joined.set(buf, chunk.length);
      buf = joined;
      start = from;
      if (nl < 0) {
        nl = buf.lastIndexOf(0x0a);
        if (nl < 0) continue;
      }
      // That line starts after the previous `\n`, or at the file's start.
      const prev = nl === 0 ? -1 : buf.lastIndexOf(0x0a, nl - 1);
      if (prev < 0 && start > 0) continue; // its start is in an earlier chunk
      const line = new TextDecoder().decode(buf.subarray(prev + 1, nl));
      const contentEnd = start + nl + 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return { kind: "unknown" };
      }
      const v = (typeof value === "object" && value !== null ? value : {}) as Record<
        string,
        unknown
      >;
      return typeof v.type === "string" && typeof v.id === "string"
        ? { kind: "line", size, contentEnd, lastId: v.id }
        : { kind: "unknown" };
    }
    return { kind: "unknown" };
  } finally {
    await handle.close();
  }
}
