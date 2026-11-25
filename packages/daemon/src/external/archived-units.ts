/**
 * An external caller's units of work in its ARCHIVED contexts (docs/feat/a2a.md,
 * Unification §4 "Archived contexts (F4)"; slice S7; protocol-neutral). READ-ONLY:
 * an archived session is read through `SessionHost.readArchivedUnits` (the
 * record its reopen would restore — resident, or both files parsed by the
 * daemon's loader, nothing written) and NEVER reopened. Nothing here is
 * persisted: the index and the LRU are in-memory caches of the session log.
 *
 * - The index, per archived session: its version (`updatedAt` + `archivedAt`
 *   from the host's archived index — header and state file only), its context,
 *   and its addressable units WITHOUT their results (small: ≤ 256 units).
 *   A session of the caller that is new or changed is read once, on the next
 *   lookup; one no longer archived (reopened, deleted) leaves it.
 * - The LRU holds the full units (results included) of the last
 *   `ARCHIVED_LRU_CAPACITY` sessions read: a `GetTask` or an artifact list.
 * - An unreadable session (gone, damaged, a newer version) has no task; it is
 *   reported once per version, and its files are never touched.
 *
 * Owner scoping is by session id, as the live side (`external/session-ids.ts`).
 */
import type { WorkUnit } from "@tentacle/core";
import type { ArchivedUnitsRead } from "../persisted-session.ts";
import { contextIdOf } from "./session-ids.ts";
import { type CallerUnit, addressableUnits } from "./work-units.ts";

export type { ArchivedUnitsRead };

/** One archived session, as the host indexes it (no history read). */
export interface ArchivedSessionRef {
  readonly id: string;
  readonly updatedAt: number;
  readonly archivedAt?: number;
}

/** What the archived side reads of the host (`SessionHost` implements it). */
export interface ArchivedUnitSource {
  archivedSessions(): Iterable<ArchivedSessionRef>;
  readArchivedUnits(id: string): Promise<ArchivedUnitsRead>;
}

export interface ArchivedUnitIndexOptions {
  /** Sessions whose full units are kept (default `ARCHIVED_LRU_CAPACITY`). */
  readonly capacity?: number;
  /** An archived session could not be read (the audit line); once per version. */
  readonly onUnreadable?: (id: string, reason: string) => void;
}

export const ARCHIVED_LRU_CAPACITY = 8;

interface Indexed {
  readonly version: string;
  readonly contextId: string;
  /** Addressable units by task id, results dropped. */
  readonly units: ReadonlyMap<string, WorkUnit>;
}

interface Cached {
  readonly version: string;
  readonly units: ReadonlyMap<string, WorkUnit>;
}

const versionOf = (ref: ArchivedSessionRef): string => `${ref.updatedAt}:${ref.archivedAt ?? ""}`;

function withoutResult(unit: WorkUnit): WorkUnit {
  const { result: _result, ...rest } = unit;
  return rest;
}

export class ArchivedUnitIndex {
  private readonly source: ArchivedUnitSource;
  private readonly capacity: number;
  private readonly onUnreadable: ((id: string, reason: string) => void) | undefined;
  private readonly index = new Map<string, Indexed>();
  /** Insertion order = recency (a hit is re-inserted). */
  private readonly lru = new Map<string, Cached>();
  private readonly reported = new Set<string>();

  constructor(source: ArchivedUnitSource, opts: ArchivedUnitIndexOptions = {}) {
    this.source = source;
    this.capacity = Math.max(1, opts.capacity ?? ARCHIVED_LRU_CAPACITY);
    this.onUnreadable = opts.onUnreadable;
  }

  /** Sessions held by the index and by the LRU (tests: a gone session leaves both). */
  cachedCount(): { readonly indexed: number; readonly full: number } {
    return { indexed: this.index.size, full: this.lru.size };
  }

  /** The caller's archived unit addressed by `taskId`, if any of its archived contexts holds it. */
  async find(protocol: string, caller: string, taskId: string): Promise<CallerUnit | undefined> {
    for (const [sessionId, ix] of await this.sync(protocol, caller)) {
      if (!ix.units.has(taskId)) {
        continue;
      }
      const unit = (await this.full(sessionId, ix.version))?.get(taskId);
      return unit === undefined ? undefined : { taskId, contextId: ix.contextId, sessionId, unit };
    }
    return undefined;
  }

  /** Every addressable unit of the caller's archived contexts; `results` only when asked (through the LRU). */
  async units(
    protocol: string,
    caller: string,
    opts: { readonly contextId?: string; readonly results: boolean },
  ): Promise<CallerUnit[]> {
    const out: CallerUnit[] = [];
    for (const [sessionId, ix] of await this.sync(protocol, caller)) {
      if (opts.contextId !== undefined && ix.contextId !== opts.contextId) {
        continue;
      }
      const units = opts.results ? await this.full(sessionId, ix.version) : ix.units;
      for (const [taskId, unit] of units ?? []) {
        out.push({ taskId, contextId: ix.contextId, sessionId, unit });
      }
    }
    return out;
  }

  /**
   * The caller's archived sessions, each indexed at its current version: a new
   * or changed one is read now, one no longer archived leaves the index and the LRU.
   */
  private async sync(protocol: string, caller: string): Promise<Array<[string, Indexed]>> {
    const refs = [...this.source.archivedSessions()];
    const archived = new Set(refs.map((r) => r.id));
    for (const id of [...this.index.keys()]) {
      if (!archived.has(id)) this.index.delete(id);
    }
    for (const id of [...this.lru.keys()]) {
      if (!archived.has(id)) this.lru.delete(id);
    }
    const mine: Array<[string, Indexed]> = [];
    for (const ref of refs) {
      const contextId = contextIdOf(protocol, caller, ref.id);
      if (contextId === null) {
        continue;
      }
      const version = versionOf(ref);
      let ix = this.index.get(ref.id);
      if (ix === undefined || ix.version !== version) {
        const units = await this.read(ref.id, version);
        const light = new Map<string, WorkUnit>();
        for (const [taskId, unit] of units ?? []) light.set(taskId, withoutResult(unit));
        ix = { version, contextId, units: light };
        this.index.set(ref.id, ix);
      }
      mine.push([ref.id, ix]);
    }
    return mine;
  }

  /** The session's full units at `version`: from the LRU, else read. */
  private async full(
    id: string,
    version: string,
  ): Promise<ReadonlyMap<string, WorkUnit> | undefined> {
    const hit = this.lru.get(id);
    if (hit !== undefined && hit.version === version) {
      this.lru.delete(id);
      this.lru.set(id, hit);
      return hit.units;
    }
    return this.read(id, version);
  }

  /** One read of the host (never a reopen); a success enters the LRU, a failure is reported once. */
  private async read(
    id: string,
    version: string,
  ): Promise<ReadonlyMap<string, WorkUnit> | undefined> {
    const read = await this.source.readArchivedUnits(id);
    if (read.status !== "ok") {
      const key = `${id}@${version}`;
      if (read.status === "unreadable" && !this.reported.has(key)) {
        this.reported.add(key);
        this.onUnreadable?.(id, read.reason);
      }
      return undefined;
    }
    const units = addressableUnits(read.units);
    this.lru.delete(id);
    this.lru.set(id, { version, units });
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value;
      if (oldest === undefined) break;
      this.lru.delete(oldest);
    }
    return units;
  }
}
