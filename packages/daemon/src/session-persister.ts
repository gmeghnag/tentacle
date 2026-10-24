/**
 * The `serve` daemon's writer of session records (docs/feat/daemon-side-persistence.md),
 * plus the lock that keeps one daemon per store directory.
 *
 * `schedule` is the only write a turn ever makes, and it is SYNCHRONOUS and
 * returns nothing: the record is captured at the call site (so it equals the
 * history there, not at the later I/O) and handed to the store, whose own
 * serialized latest-wins queue does the writing. A turn never waits on the
 * disk — that is what keeps the turn-end write out of the steering window
 * (agent.ts, the late-steer INVARIANT). Only three things wait, via `flush`,
 * all outside that window: a permission request before it is shown, an
 * approved tool about to run (both inside the gate, mid-round), and an
 * `enqueue` ack.
 *
 * A failed write is reported to `onError` and never thrown: the session keeps
 * serving from memory and the next `schedule` writes fresher data.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type LoadResult, type SessionRecord, isValidSessionId } from "@tentacle/agent";
import {
  type DaemonSessionRecord,
  type DaemonSessionState,
  parseDaemonRecord,
  toDaemonRecord,
} from "./persisted-session.ts";
import type { TombstoneStore } from "./session-tombstones.ts";

/** The slice of `JsonSessionStore` the persister uses (tests pass a spy). */
export interface RecordStore {
  save(record: SessionRecord): Promise<void>;
  remove(id: string): Promise<void>;
  drain(): Promise<void>;
  /** One record by id (an archived session's, on its reopen). */
  load(id: string): Promise<LoadResult>;
}

export interface PersisterOptions {
  readonly store: RecordStore;
  /** Every record's project and model (the daemon's own). */
  readonly cwd: string;
  readonly model: string;
  readonly onError: (error: Error) => void;
  /**
   * Whether a record's cwd is this daemon's project (`serve` compares project
   * keys: a symlinked cwd is the same project). Default: the same string as `cwd`.
   */
  readonly sameProject?: (cwd: string) => boolean;
  /**
   * Where a deleted id is recorded for good (`serve`: `TombstoneFile`), before
   * its file is removed. Absent → the host's tombstone is in memory only.
   */
  readonly tombstones?: TombstoneStore;
}

/** A record read back by `load`: the parsed record, or why it cannot be used. */
export type LoadedRecord =
  | { readonly ok: true; readonly record: DaemonSessionRecord }
  | { readonly ok: false; readonly reason: string };

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export class SessionPersister {
  private readonly opts: PersisterOptions;
  /** Settles when the latest write scheduled for the id has (never rejects). */
  private readonly latest = new Map<string, Promise<void>>();
  /** Ids whose file could not be loaded: never written, never removed. */
  private readonly blocked = new Set<string>();
  private readonly removals = new Set<Promise<void>>();
  /** Ids already reported as "not persisted" (one line per session, not per write). */
  private readonly reported = new Set<string>();
  private stopped = false;

  constructor(opts: PersisterOptions) {
    this.opts = opts;
  }

  /**
   * Never write or delete `id`'s file: it exists but could not be loaded
   * (corrupt, another project's, a newer daemon's), and it stays as it is.
   */
  block(id: string): void {
    this.blocked.add(id);
  }

  /** Write `build()` for `id`, captured NOW. Synchronous; never awaited, never throws. */
  schedule(id: string, build: () => DaemonSessionState): void {
    if (this.stopped || !this.persistable(id)) {
      return;
    }
    let record: DaemonSessionRecord;
    try {
      record = this.toRecord(build());
    } catch (error) {
      this.report(error);
      return;
    }
    void this.writeRecord(record);
  }

  /**
   * Write `state` as an ARCHIVED record (stamped `archivedAt`), captured now,
   * through the same per-id queue as `schedule`. Returns the record (`null`:
   * `id` cannot be persisted — a blocked file, an unsafe name — nothing is
   * kept) and whether the write landed (a failure is reported, never thrown).
   */
  archive(
    state: DaemonSessionState,
    archivedAt: number,
  ): { readonly record: DaemonSessionRecord | null; readonly written: Promise<boolean> } {
    if (!this.persistable(state.id)) {
      return { record: null, written: Promise.resolve(false) };
    }
    let record: DaemonSessionRecord;
    try {
      record = this.toRecord({ ...state, archivedAt });
    } catch (error) {
      this.report(error);
      return { record: null, written: Promise.resolve(false) };
    }
    return { record, written: this.writeRecord(record) };
  }

  /**
   * Write an already-built record (an archived one whose write failed, again);
   * resolves whether it landed. `report: false` → a failure is not reported
   * (the caller already said it once). After `stop`: not written, `false`.
   */
  writeRecord(record: DaemonSessionRecord, report = true): Promise<boolean> {
    if (this.stopped) {
      return Promise.resolve(false);
    }
    let saving: Promise<void>;
    try {
      saving = this.opts.store.save(record);
    } catch (error) {
      if (report) {
        this.report(error);
      }
      return Promise.resolve(false);
    }
    const landed = saving.then(
      () => true,
      (error) => {
        if (report) {
          this.report(error);
        }
        return false;
      },
    );
    this.latest.set(
      record.id,
      landed.then(() => {}),
    );
    return landed;
  }

  /**
   * Read `id`'s record back (an archived session's reopen): after its latest
   * pending write has landed, parsed and checked like at start (version,
   * project). Never throws.
   */
  async load(id: string): Promise<LoadedRecord> {
    await this.flush(id);
    let result: LoadResult;
    try {
      result = await this.opts.store.load(id);
    } catch (error) {
      return { ok: false, reason: asError(error).message };
    }
    if (result.status === "absent") {
      return { ok: false, reason: "its file is gone" };
    }
    if (result.status === "unreadable") {
      return { ok: false, reason: result.reason };
    }
    return parseDaemonRecord(
      result.record,
      this.opts.sameProject ?? ((cwd) => cwd === this.opts.cwd),
    );
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

  private toRecord(state: DaemonSessionState): DaemonSessionRecord {
    // `updatedAt` = the last conversation change, never the write time: a
    // detach or a restart writes too, and must not reorder `session/list`.
    return toDaemonRecord(
      state,
      { cwd: this.opts.cwd, model: this.opts.model },
      state.lastChangeAt,
    );
  }

  /** Resolves once the latest write scheduled for `id` has settled (failures are reported, not thrown). */
  flush(id: string): Promise<void> {
    return this.latest.get(id) ?? Promise.resolve();
  }

  /**
   * Delete `id`'s file (`session/delete`): its tombstone is recorded FIRST, so
   * no crash can leave the id with neither (a file left beside its tombstone
   * is removed at the next start). `tombstone: false` → only finish a removal
   * (the tombstone is already on disk). A failure of either step is reported,
   * and the file is removed anyway (the user asked for it). Fire-and-forget;
   * `stop` waits for it.
   */
  remove(id: string, tombstone = true): void {
    this.latest.delete(id);
    this.reported.delete(id);
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
