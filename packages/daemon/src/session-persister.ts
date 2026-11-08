/**
 * The `serve` daemon's writer of sessions (docs/feat/daemon-side-persistence.md;
 * the files: docs/feat/session-log-serve-store.md), plus the lock that keeps
 * one daemon per store directory.
 *
 * On disk a session is its typed log `<uid>.jsonl` (the laptop's format: the
 * daemon writes its OWN entries — it is trusted) plus a small state file
 * `<uid>.state.json` written AFTER the log (`daemon-state-file.ts`). One write
 * is one UNIT — the log entries derived since the last unit, then the state
 * file — in the store's per-session FIFO queue, and it LANDS when its state
 * file does: every wait on durability (`flush`, `write`, `archive`) waits for
 * both files. A reload reads the log only up to the entry the state file names.
 *
 * `schedule` is the only write a turn ever makes, and it is SYNCHRONOUS and
 * returns nothing: the state is captured at the call site (so it equals the
 * history there, not at the later I/O) — the history as today's copy, the log
 * part as references to the entries derived since this persister's cursor
 * (`SessionLog.since`, O(Δ)) — and handed on. Their wire form, the overlay and
 * the state file's text are built on the next microtask, outside the steering
 * window (agent.ts, the late-steer INVARIANT), and the store does the I/O. A
 * turn never waits on the disk. Only three things wait, via `flush`, all
 * outside that window: a permission request before it is shown, an approved
 * tool about to run (both inside the gate, mid-round), and an `enqueue` ack.
 *
 * A failed write is reported to `onError` and never thrown: the session keeps
 * serving from memory and the next unit heals the files (the store's writer
 * follows every unit, written or not).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { encodeTitle, isValidSessionId } from "@tentacle/agent";
import type { LogCursor } from "@tentacle/protocol";
import {
  type DaemonSidecar,
  encodeSidecar,
  parseSidecar,
  rebuild,
  sidecarOf,
} from "./daemon-state-file.ts";
import type {
  DaemonLogCapture,
  DaemonSessionRecord,
  DaemonSessionState,
} from "./persisted-session.ts";
import { type LogFileHeader, parseHeaderLine, parseLogFile } from "./session-log-file.ts";
import type { LogWrite, RawSessionFiles, RawSessionState } from "./session-log-store.ts";
import type { TombstoneStore } from "./session-tombstones.ts";

/** The slice of `LogSessionStore` the persister uses (tests pass a spy holding the files' text). */
export interface DaemonStore {
  /** One unit: the log op, then the state file (`LogWrite.sidecar`), in the session's queue. */
  write(unit: LogWrite): Promise<void>;
  /** The state file only (an archived rename / reclaim). */
  writeState(id: string, data: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Drop the store's in-memory writer state for `id` (an archived session's landed segment). */
  forget(id: string): Promise<void>;
  drain(): Promise<void>;
  /** The log's text and the state file's (an archived session's reopen, a live one at start). */
  readRaw(id: string): Promise<RawSessionFiles>;
  /** The log's header line and the state file's text (the log itself unread). */
  readState(id: string): Promise<RawSessionState>;
}

/** What a session builds at each write; `after` = this persister's log cursor for it. */
export type StateBuild = (after?: LogCursor) => DaemonSessionState;

export interface PersisterOptions {
  readonly store: DaemonStore;
  /** Every session's project and model (the daemon's own). */
  readonly cwd: string;
  readonly model: string;
  readonly onError: (error: Error) => void;
  /**
   * Whether a session's cwd is this daemon's project (`serve` compares project
   * keys: a symlinked cwd is the same project). Default: the same string as `cwd`.
   */
  readonly sameProject?: (cwd: string) => boolean;
  /**
   * Where a deleted id is recorded for good (`serve`: `TombstoneFile`), before
   * its files are removed. Absent → the host's tombstone is in memory only.
   */
  readonly tombstones?: TombstoneStore;
}

/** A session read back by `load`: the rebuilt record, or why it cannot be used. */
export type LoadedRecord =
  | { readonly ok: true; readonly record: DaemonSessionRecord }
  | { readonly ok: false; readonly reason: string; readonly missingState?: true };

/** What an archived session is indexed by (`loadState`): the header and the state file, no history. */
export interface ArchivedMeta {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title: DaemonSessionRecord["title"];
  readonly archivedAt?: number;
}

/** A session's state read back by `loadState`. */
export type LoadedState =
  | {
      readonly ok: true;
      readonly header: LogFileHeader;
      readonly sidecar: DaemonSidecar;
      readonly meta: ArchivedMeta;
    }
  | { readonly ok: false; readonly reason: string; readonly missingState?: true };

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const NO_STATE = "it has no state file (a session cut before its first save landed)";

export class SessionPersister {
  private readonly opts: PersisterOptions;
  /** Settles when the latest write scheduled for the id has (never rejects). */
  private readonly latest = new Map<string, Promise<void>>();
  /** The log entry each session's last unit was captured at: the next unit's entries start after it. */
  private readonly cursors = new Map<string, LogCursor>();
  /** Ids whose files could not be loaded: never written, never removed. */
  private readonly blocked = new Set<string>();
  private readonly removals = new Set<Promise<void>>();
  /** Ids already reported as "not persisted" (one line per session, not per write). */
  private readonly reported = new Set<string>();
  private stopped = false;

  constructor(opts: PersisterOptions) {
    this.opts = opts;
  }

  /**
   * Never write or delete `id`'s files: they exist but could not be loaded
   * (corrupt, another project's, a newer daemon's), and they stay as they are.
   */
  block(id: string): void {
    this.blocked.add(id);
  }

  /** Write `build()` for `id`, captured NOW. Synchronous; never awaited, never throws. */
  schedule(id: string, build: StateBuild): void {
    void this.write(id, build);
  }

  /**
   * `schedule`, and resolves whether THIS write landed — both files (never
   * rejects): `false` when it failed, or when `id` is not written at all
   * (stopped, blocked, an unsafe name). The capture is synchronous, like `schedule`'s.
   */
  write(id: string, build: StateBuild): Promise<boolean> {
    if (this.stopped || !this.persistable(id)) {
      return Promise.resolve(false);
    }
    const captured = this.capture(id, build, undefined);
    return captured
      ? this.unit(captured.record, captured.log, captured.from)
      : Promise.resolve(false);
  }

  /**
   * Write `build()` as an ARCHIVED session (stamped `archivedAt`), captured
   * now, through the same per-id queue as `schedule`. Returns the record
   * (`null`: `id` cannot be persisted — a blocked file, an unsafe name —
   * nothing is kept) and whether the write landed (a failure is reported,
   * never thrown).
   */
  archive(
    id: string,
    build: StateBuild,
    archivedAt: number,
  ): { readonly record: DaemonSessionRecord | null; readonly written: Promise<boolean> } {
    if (!this.persistable(id)) {
      // Still taken: the session must close whatever happens to its files.
      build(this.cursors.get(id));
      return { record: null, written: Promise.resolve(false) };
    }
    const captured = this.capture(id, build, archivedAt);
    if (!captured) {
      return { record: null, written: Promise.resolve(false) };
    }
    return {
      record: captured.record,
      written: this.stopped
        ? Promise.resolve(false)
        : this.unit(captured.record, captured.log, captured.from),
    };
  }

  /**
   * The synchronous part of a write: the state built against this session's
   * cursor, which then moves to the capture's log tip.
   */
  private capture(
    id: string,
    build: StateBuild,
    archivedAt: number | undefined,
  ): { record: DaemonSessionRecord; log: DaemonLogCapture; from: LogCursor | undefined } | null {
    const from = this.cursors.get(id);
    let record: DaemonSessionRecord;
    let log: DaemonLogCapture;
    try {
      const state = build(from);
      if (!state.log) {
        throw new Error(`session ${id}: a capture without its log part`);
      }
      log = state.log;
      record = this.toRecord(archivedAt === undefined ? state : { ...state, archivedAt }, log);
    } catch (error) {
      this.report(error);
      return null;
    }
    this.cursors.set(id, log.head);
    return { record, log, from };
  }

  /**
   * Write an already-built record again (an archived one whose write failed,
   * or one rewritten by a rename / reclaim while still in memory): a unit
   * with no new entries, so the store appends whatever of its log the file
   * lacks (or skips) and then writes its state file. Resolves whether it
   * landed. `report: false` → a failure is not reported (the caller already
   * said it once). After `stop`: not written, `false`.
   */
  writeRecord(record: DaemonSessionRecord, report = true): Promise<boolean> {
    if (this.stopped) {
      return Promise.resolve(false);
    }
    return this.unit(record, undefined, record.logHead, report);
  }

  /**
   * Write `sidecar` as `id`'s state file only (an archived session's rename
   * or reclaim: its log is already on disk and is not touched). Resolves
   * whether it landed. After `stop`: not written, `false`.
   */
  writeState(id: string, sidecar: DaemonSidecar, report = true): Promise<boolean> {
    if (this.stopped || !this.persistable(id)) {
      return Promise.resolve(false);
    }
    let saving: Promise<void>;
    try {
      saving = this.opts.store.writeState(id, encodeSidecar(sidecar));
    } catch (error) {
      if (report) this.report(error);
      return Promise.resolve(false);
    }
    return this.track(id, saving, report);
  }

  /**
   * One unit, handed to the store on the next microtask (outside the
   * caller's synchronous stretch: the entries' wire form, the overlay and the
   * state file's text are built there). Microtasks run in order, so units
   * reach the store in capture order.
   */
  private unit(
    record: DaemonSessionRecord,
    log: DaemonLogCapture | undefined,
    from: LogCursor | undefined,
    report = true,
  ): Promise<boolean> {
    const id = record.id;
    const outcome =
      log === undefined ? "linear" : log.rebased ? "rebased" : from ? "linear" : "cold";
    // Boxed: resolving with the store's promise itself would ADOPT it (and lose it).
    const { promise, resolve } = Promise.withResolvers<{ saving: Promise<void> } | null>();
    queueMicrotask(() => {
      try {
        resolve({
          saving: this.opts.store.write({
            id,
            meta: { cwd: this.opts.cwd, model: this.opts.model, createdAt: record.createdAt },
            entries: log ? log.entries() : [],
            messages: record.logged,
            read: { ...(from ? { from } : {}), head: record.logHead, outcome },
            sidecar: encodeSidecar(sidecarOf(record)),
            keepEmpty: true,
          }),
        });
      } catch (error) {
        // Never handed to the store: its entries are not in the store's
        // writer, so the next capture starts cold (from its `base`: a rewrite).
        if (log && this.cursors.get(id)?.id === record.logHead.id) {
          this.cursors.delete(id);
        }
        if (report) this.report(error);
        resolve(null);
      }
    });
    // `null`: never handed over (already reported above).
    return this.track(
      id,
      promise.then((handed) => handed?.saving ?? Promise.reject(null)),
      report,
    );
  }

  /** `saving` as the id's latest write: resolves whether it landed (a failure reported once). */
  private track(id: string, saving: Promise<void>, report: boolean): Promise<boolean> {
    const landed = saving.then(
      () => true,
      (error) => {
        if (error !== null && report) {
          this.report(error);
        }
        return false;
      },
    );
    this.latest.set(
      id,
      landed.then(() => {}),
    );
    return landed;
  }

  /**
   * Read `id`'s session back (an archived session's reopen, a live one at
   * start): after its latest pending write has landed, both files parsed and
   * checked (versions, project) and the record rebuilt (`rebuild`). Never throws.
   */
  async load(id: string): Promise<LoadedRecord> {
    await this.flush(id);
    let raw: RawSessionFiles;
    try {
      raw = await this.opts.store.readRaw(id);
    } catch (error) {
      return { ok: false, reason: asError(error).message };
    }
    if (raw.status === "absent") {
      return { ok: false, reason: "its file is gone" };
    }
    if (raw.status === "unreadable") {
      return { ok: false, reason: raw.reason };
    }
    // The header first (review M2): a log this build cannot read — a newer
    // version, a corrupt first line — is refused and left as it is, whether or
    // not it has a state file. Only a readable header of THIS version with no
    // state file is a session cut before its first save (FM 5).
    const nl = raw.log.indexOf("\n");
    const header = parseHeaderLine(nl < 0 ? raw.log : raw.log.slice(0, nl), id);
    if (!header.ok) {
      return { ok: false, reason: header.reason };
    }
    if (raw.state === null) {
      return { ok: false, reason: NO_STATE, missingState: true };
    }
    const sidecar = parseSidecar(raw.state, id);
    if (!sidecar.ok) {
      return { ok: false, reason: sidecar.reason };
    }
    const parsed = parseLogFile(raw.log, id);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    const rebuilt = rebuild(parsed, sidecar.value, this.sameProject());
    return rebuilt.ok ? { ok: true, record: rebuilt.value } : { ok: false, reason: rebuilt.reason };
  }

  /**
   * Read `id`'s header and state file only — never its history (an archived
   * session's index entry at start, its rename / reclaim). Checked like
   * `load` (versions, project). Never throws.
   */
  async loadState(id: string): Promise<LoadedState> {
    await this.flush(id);
    let raw: RawSessionState;
    try {
      raw = await this.opts.store.readState(id);
    } catch (error) {
      return { ok: false, reason: asError(error).message };
    }
    if (raw.status === "absent") {
      return { ok: false, reason: "its file is gone" };
    }
    if (raw.status === "unreadable") {
      return { ok: false, reason: raw.reason };
    }
    // The header first (review M2), as in `load`.
    const header = parseHeaderLine(raw.header, id);
    if (!header.ok) {
      return { ok: false, reason: header.reason };
    }
    if (raw.state === null) {
      return { ok: false, reason: NO_STATE, missingState: true };
    }
    const sidecar = parseSidecar(raw.state, id);
    if (!sidecar.ok) {
      return { ok: false, reason: sidecar.reason };
    }
    if (!this.sameProject()(header.header.cwd)) {
      return { ok: false, reason: `belongs to another project (${header.header.cwd})` };
    }
    const h = header.header;
    const s = sidecar.value;
    if (!Number.isSafeInteger(h.createdAt) || h.createdAt < 0) {
      return { ok: false, reason: '"createdAt" is not a non-negative integer' };
    }
    return {
      ok: true,
      header: h,
      sidecar: s,
      meta: {
        id,
        cwd: h.cwd,
        createdAt: h.createdAt,
        updatedAt: s.updatedAt,
        title: s.title,
        ...(s.archivedAt !== undefined ? { archivedAt: s.archivedAt } : {}),
      },
    };
  }

  private sameProject(): (cwd: string) => boolean {
    return this.opts.sameProject ?? ((cwd) => cwd === this.opts.cwd);
  }

  /**
   * Whether `id` is ever written by this persister (not a blocked file, not an
   * unsafe name): nothing is durable for it, whatever happens. Silent, unlike
   * the write path.
   */
  writable(id: string): boolean {
    return !this.blocked.has(id) && isValidSessionId(id);
  }

  /** Whether `id` may be written; reports once (per id) why not. */
  private persistable(id: string): boolean {
    const unpersisted = this.blocked.has(id)
      ? `session ${id} is not persisted: its file could not be loaded and is left as is`
      : !isValidSessionId(id)
        ? `session ${JSON.stringify(id)} is not persisted: not a valid file name`
        : null;
    if (unpersisted) {
      // It lives in memory only; say so once, not at every committed boundary.
      if (!this.reported.has(id)) {
        this.reported.add(id);
        this.report(new Error(unpersisted));
      }
      return false;
    }
    return true;
  }

  private toRecord(state: DaemonSessionState, log: DaemonLogCapture): DaemonSessionRecord {
    // `updatedAt` = the last conversation change, never the write time: a
    // detach or a restart writes too, and must not reorder `session/list`.
    return {
      id: state.id,
      cwd: this.opts.cwd,
      model: this.opts.model,
      createdAt: state.createdAt,
      updatedAt: state.lastChangeAt,
      title: encodeTitle(state.title ?? { source: "auto" }, state.messages),
      messages: state.messages,
      lastActiveAt: state.lastActiveAt,
      turns: state.turns,
      enqueueIds: state.enqueueIds,
      returned: state.returned ?? [],
      ...(state.turn ? { turn: state.turn } : {}),
      ...(state.archivedAt !== undefined ? { archivedAt: state.archivedAt } : {}),
      ...(state.head !== undefined ? { head: state.head } : {}),
      logged: log.logged,
      logHead: log.head,
      paired: true,
    };
  }

  /**
   * `id` is archived and its archive write landed (the host dropped its
   * resident record): nothing writes from its segment again, so the store's
   * writer state and this persister's cursor are released — an archived
   * session costs no history in memory (review M1). Fire-and-forget; a
   * reopen's first write is cold (a fresh writer state).
   */
  forget(id: string): void {
    if (this.stopped || !isValidSessionId(id)) {
      return;
    }
    this.cursors.delete(id);
    this.opts.store.forget(id).catch(() => {});
  }

  /** Resolves once the latest write scheduled for `id` has settled (failures are reported, not thrown). */
  flush(id: string): Promise<void> {
    return this.latest.get(id) ?? Promise.resolve();
  }

  /**
   * Delete `id`'s files (`session/delete`): its tombstone is recorded FIRST,
   * so no crash can leave the id with neither (files left beside their
   * tombstone are removed at the next start). `tombstone: false` → only
   * finish a removal (the tombstone is already on disk). A failure of either
   * step is reported, and the files are removed anyway (the user asked for
   * it). Fire-and-forget; `stop` waits for it.
   */
  remove(id: string, tombstone = true): void {
    this.latest.delete(id);
    this.reported.delete(id);
    this.cursors.delete(id);
    if (!isValidSessionId(id)) {
      return;
    }
    // Tombstoned even when blocked: the id was deleted whatever its file is.
    const recorded = tombstone
      ? this.opts.tombstones?.add(id).catch((error) => this.report(error))
      : undefined;
    // A blocked id's file is left as is (unreadable: not ours to remove).
    const removing = (): Promise<void> =>
      this.blocked.has(id) ? Promise.resolve() : this.opts.store.remove(id);
    const removal = (recorded ? recorded.then(removing) : removing())
      .catch((error) => this.report(error))
      .finally(() => this.removals.delete(removal));
    this.removals.add(removal);
  }

  /** Shutdown: accept no more writes, then wait for every pending write and removal. */
  async stop(): Promise<void> {
    this.stopped = true;
    // A unit is handed to the store on a microtask: let the last ones reach it.
    await Promise.resolve();
    await Promise.all([this.opts.store.drain(), ...this.removals]);
  }

  /** Report through `onError` (never throws): the host's archive problems go to the same log. */
  report(error: unknown): void {
    try {
      this.opts.onError(asError(error));
    } catch {
      // The log sink failed: nowhere left to report it, and a write must not throw.
    }
  }
}

/** A held store lock; `release` is idempotent. */
export interface StoreLock {
  readonly path: string;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * Take `<dir>/.lock` (created exclusively, holding our pid), so two daemons
 * never write one store. Held by a live process (this one included) → throws,
 * naming the pid and the file. Held by a dead one → taken over, once. A pid
 * reused since (after a reboot) reads as live: the message names the file to
 * remove (documented limit).
 */
export function acquireStoreLock(dir: string): StoreLock {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".lock");
  const take = (): void => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  };
  try {
    take();
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number(readFileSync(path, "utf8").trim());
    } catch {
      // Vanished or unreadable: treated as stale below.
    }
    if (Number.isSafeInteger(holder) && holder > 0 && processAlive(holder)) {
      throw new Error(
        `another tentacle serve (pid ${holder}) owns ${dir}; stop it, or remove ${path} if it is not running`,
      );
    }
    rmSync(path, { force: true });
    take();
  }
  let held = true;
  return {
    path,
    release: () => {
      if (!held) {
        return;
      }
      held = false;
      try {
        if (readFileSync(path, "utf8").trim() === String(process.pid)) {
          rmSync(path, { force: true });
        }
      } catch {
        // Already gone: nothing to release.
      }
    },
  };
}
