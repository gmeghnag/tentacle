/**
 * An in-memory `DaemonStore` for the `serve` persister's tests
 * (docs/feat/session-log-serve-store.md): it holds the TEXT of each session's
 * two files — `<uid>.jsonl` and `<uid>.state.json` — applies each unit the way
 * `LogSessionStore` does (the log first: lines appended when the unit
 * continues the file's last entry, else the writer's segment rewritten; then
 * the state file replaced), and decodes with the REAL pure decoders
 * (`parseLogFile`, `parseSidecar`, `rebuild`). So `durable.get(id)` is what a
 * restarted daemon would load, round-tripped through the bytes.
 *
 * Controls: `hold` parks units until `release()`; `fail` rejects units (the
 * writer still follows them, like the real store); `snapshots` records the
 * files at each unit's crash points — after the log op (`log`), mid-append (a
 * torn last line, `mid`) and after the state file (`state`) — for crash tests.
 */
import type { ChatMessage } from "@tentacle/core";
import type { KnownLogEntry } from "@tentacle/protocol";
import {
  type DaemonSidecar,
  encodeSidecar,
  parseSidecar,
  rebuild,
} from "../../src/daemon-state-file.ts";
import type { DaemonSessionRecord } from "../../src/persisted-session.ts";
import { entryLines, headerLine, parseLogFile } from "../../src/session-log-file.ts";
import type { LogWrite, RawSessionFiles, RawSessionState } from "../../src/session-log-store.ts";
import type { DaemonStore } from "../../src/session-persister.ts";

export interface SessionFiles {
  log?: string;
  state?: string;
}

export type CrashPoint = "mid" | "log" | "state";

export interface Snapshot {
  readonly id: string;
  /** Which unit of `id` (0-based, in landing order). */
  readonly unit: number;
  readonly at: CrashPoint;
  readonly files: SessionFiles;
}

/** Decode a session's files as `SessionPersister.load` does (any project). Throws why not. */
export function decodeFiles(id: string, files: SessionFiles): DaemonSessionRecord {
  if (files.log === undefined) throw new Error(`${id}: no log`);
  if (files.state === undefined) throw new Error(`${id}: no state file`);
  const sidecar = parseSidecar(files.state, id);
  if (!sidecar.ok) throw new Error(`${id}: ${sidecar.reason}`);
  const parsed = parseLogFile(files.log, id);
  if (!parsed.ok) throw new Error(`${id}: ${parsed.reason}`);
  const record = rebuild(parsed, sidecar.value, () => true);
  if (!record.ok) throw new Error(`${id}: ${record.reason}`);
  return record.value;
}

const lastId = (text: string): string | undefined => {
  const lines = text.split("\n").filter((l) => l !== "");
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const value = JSON.parse(last) as { id?: unknown; type?: unknown };
  return typeof value.type === "string" && typeof value.id === "string" ? value.id : undefined;
};

/**
 * A session as a test writes it by hand: a record without its log fields
 * (`logged` / `logHead` / `paired` come from the files). The keys of the old
 * JSON record (`kind`, `schemaVersion`) are tolerated and ignored, so the
 * existing fixtures read as they are.
 */
export type Fixture = Omit<DaemonSessionRecord, "logged" | "logHead" | "paired"> & {
  readonly logged?: unknown;
  readonly logHead?: unknown;
  readonly paired?: unknown;
  readonly kind?: string;
  readonly schemaVersion?: number;
};

/** The files of a record seeded as a fixture: one cold segment of its messages, then its state file. */
export function filesOf(record: Fixture): SessionFiles {
  const inc = `fixture-${record.id}`;
  const entries: KnownLogEntry[] = [];
  let seq = 0;
  let prev: string | undefined;
  const push = (body: Record<string, unknown>): void => {
    seq++;
    const id = `${inc}/${seq}`;
    entries.push({ ...body, seq, id, ...(prev ? { prev } : {}), ts: 1 } as KnownLogEntry);
    prev = id;
  };
  push({ type: "base", critical: true, inc, reason: "create", count: record.messages.length });
  for (const message of record.messages) push({ type: "message", critical: true, message });
  const head = { seq, id: `${inc}/${seq}` };
  const sidecar: DaemonSidecar = {
    format: "tentacle-daemon-state",
    schemaVersion: 1,
    id: record.id,
    logHead: head,
    k: record.messages.length,
    tail: [],
    lastActiveAt: record.lastActiveAt,
    updatedAt: record.updatedAt,
    title: record.title,
    turns: record.turns,
    enqueueIds: record.enqueueIds,
    returned: record.returned,
    ...(record.turn ? { turn: record.turn } : {}),
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
    ...(record.head !== undefined ? { head: record.head } : {}),
  };
  return {
    log:
      headerLine({
        id: record.id,
        cwd: record.cwd,
        model: record.model,
        createdAt: record.createdAt,
      }) + entryLines(entries),
    state: encodeSidecar(sidecar),
  };
}

/** `durable`: what landed, decoded — a Map-like view (tests read it like the old record map). */
class DurableView {
  constructor(private readonly store: SpyDaemonStore) {}
  get(id: string): DaemonSessionRecord | undefined {
    const files = this.store.files.get(id);
    if (files?.state === undefined) return undefined;
    return decodeFiles(id, files);
  }
  has(id: string): boolean {
    return this.store.files.get(id)?.state !== undefined;
  }
  keys(): string[] {
    return [...this.store.files.entries()].flatMap(([id, f]) =>
      f.state !== undefined ? [id] : [],
    );
  }
  values(): DaemonSessionRecord[] {
    return this.keys().flatMap((id) => {
      const record = this.get(id);
      return record ? [record] : [];
    });
  }
  /** Seed a fixture: the record as a cold segment + its state file. */
  set(id: string, record: Fixture): void {
    this.store.files.set(id, filesOf({ ...record, id }));
  }
  delete(id: string): boolean {
    return this.store.files.delete(id);
  }
}

export class SpyDaemonStore implements DaemonStore {
  /** Each session's file texts, as they are "on disk". */
  readonly files = new Map<string, SessionFiles>();
  readonly durable = new DurableView(this);
  /** Every unit handed over, decoded as it would land (in hand-over order). */
  readonly saves: DaemonSessionRecord[] = [];
  /** Every unit handed over, raw. */
  readonly units: LogWrite[] = [];
  /** Every state-only write handed over (`writeState`). */
  readonly stateWrites: Array<{ id: string; data: string }> = [];
  readonly removed: string[] = [];
  readonly snapshots: Snapshot[] = [];
  /** Record `snapshots` (off by default: they copy the files at every unit). */
  snapshotting = false;
  hold = false;
  fail: Error | null = null;
  /** Fail just the units it picks (checked when each lands), like a disk refusing one write. */
  failIf: (unit: LogWrite) => boolean = () => false;
  keepSuperseded = false;
  private held: Array<() => void> = [];
  private readonly segments = new Map<string, KnownLogEntry[]>();
  private readonly landed = new Map<string, number>();

  write(unit: LogWrite): Promise<void> {
    // A copy at hand-over, like bytes on a disk.
    const copy = JSON.parse(JSON.stringify(unit)) as LogWrite;
    this.units.push(copy);
    this.saves.push(this.decodeUnit(copy));
    return this.park(() => {
      this.advance(copy);
      if (this.fail) throw this.fail;
      if (this.failIf(copy)) throw new Error("disk full");
      this.apply(copy);
    });
  }

  writeState(id: string, data: string): Promise<void> {
    this.stateWrites.push({ id, data });
    return this.park(() => {
      if (this.fail) throw this.fail;
      const files = this.files.get(id) ?? {};
      this.files.set(id, { ...files, state: data });
    });
  }

  release(): void {
    for (const land of this.held.splice(0)) land();
  }

  async remove(id: string): Promise<void> {
    this.removed.push(id);
    this.files.delete(id);
    this.segments.delete(id);
  }

  async drain(): Promise<void> {}

  /** Ids read back (`readRaw` / `readState`); `holdLoads` parks a read until `releaseLoads()`; `loadAs` overrides it. */
  readonly loads: string[] = [];
  readonly stateLoads: string[] = [];
  holdLoads = false;
  loadAs: RawSessionFiles | null = null;
  private heldLoads: Array<() => void> = [];

  async readRaw(id: string): Promise<RawSessionFiles> {
    this.loads.push(id);
    if (this.holdLoads) await new Promise<void>((r) => this.heldLoads.push(r));
    if (this.loadAs) return this.loadAs;
    const files = this.files.get(id);
    if (files?.log === undefined) return { status: "absent" };
    return { status: "ok", log: files.log, state: files.state ?? null };
  }

  async readState(id: string): Promise<RawSessionState> {
    this.stateLoads.push(id);
    if (this.holdLoads) await new Promise<void>((r) => this.heldLoads.push(r));
    if (this.loadAs) {
      return this.loadAs.status === "ok"
        ? {
            status: "ok",
            header: this.loadAs.log.slice(0, this.loadAs.log.indexOf("\n")),
            state: this.loadAs.state,
          }
        : this.loadAs;
    }
    const files = this.files.get(id);
    if (files?.log === undefined) return { status: "absent" };
    const nl = files.log.indexOf("\n");
    return {
      status: "ok",
      header: nl < 0 ? files.log : files.log.slice(0, nl),
      state: files.state ?? null,
    };
  }

  releaseLoads(): void {
    for (const r of this.heldLoads.splice(0)) r();
  }

  private park(land: () => void): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const run = (): void => {
      try {
        land();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    if (this.hold) this.held.push(run);
    else queueMicrotask(run);
    return promise;
  }

  /** The writer's segment follows every unit, landed or not (`LogSessionStore.advance`). */
  private advance(unit: LogWrite): void {
    const at = unit.entries.findLastIndex((e) => e.type === "base");
    if (at >= 0) {
      this.segments.set(unit.id, unit.entries.slice(at));
    } else if (unit.read.outcome === "linear") {
      this.segments.set(unit.id, [...(this.segments.get(unit.id) ?? []), ...unit.entries]);
    }
  }

  private apply(unit: LogWrite): void {
    const id = unit.id;
    const segment = this.segments.get(id) ?? [];
    const files = this.files.get(id) ?? {};
    const header = headerLine({ id, ...unit.meta });
    const existing = files.log;
    let log: string;
    let appended = "";
    const hasBase = unit.entries.some((e) => e.type === "base");
    const last = existing !== undefined ? lastId(existing) : undefined;
    if (existing === undefined || last === undefined) {
      log = header + entryLines(segment);
    } else if (unit.read.outcome === "linear" && unit.read.from?.id === last) {
      if (hasBase && !this.keepSuperseded) {
        log = header + entryLines(segment);
      } else {
        appended = entryLines(unit.entries);
        log = existing + appended;
      }
    } else {
      const at = segment.findIndex((e) => e.id === last);
      if (at >= 0) {
        appended = entryLines(segment.slice(at + 1));
        log = existing + appended;
      } else {
        log = header + entryLines(segment);
      }
    }
    const n = this.landed.get(id) ?? 0;
    if (this.snapshotting) {
      // A crash mid-append leaves a torn last line (no `\n`); a rewrite is atomic.
      const mid =
        appended !== "" && existing !== undefined
          ? existing + appended.slice(0, Math.max(1, Math.floor(appended.indexOf("\n") / 2)))
          : existing;
      this.snapshots.push({ id, unit: n, at: "mid", files: { ...files, log: mid } });
      this.snapshots.push({ id, unit: n, at: "log", files: { ...files, log } });
    }
    const state = unit.sidecar;
    const next: SessionFiles = {
      log,
      ...(state !== undefined ? { state } : files.state ? { state: files.state } : {}),
    };
    this.files.set(id, next);
    if (this.snapshotting) {
      this.snapshots.push({ id, unit: n, at: "state", files: { ...next } });
    }
    this.landed.set(id, n + 1);
  }

  /** What a unit lands as: the overlay over its own `messages` (the log's projection), its state file. */
  private decodeUnit(unit: LogWrite): DaemonSessionRecord {
    const sidecar = parseSidecar(unit.sidecar ?? "", unit.id);
    if (!sidecar.ok) throw new Error(`${unit.id}: ${sidecar.reason}`);
    const s = sidecar.value;
    const logged = unit.messages as ChatMessage[];
    return {
      id: unit.id,
      cwd: unit.meta.cwd,
      model: unit.meta.model,
      createdAt: unit.meta.createdAt,
      updatedAt: s.updatedAt,
      title: s.title,
      messages: [...logged.slice(0, s.k), ...s.tail],
      lastActiveAt: s.lastActiveAt,
      turns: s.turns,
      enqueueIds: s.enqueueIds,
      returned: s.returned,
      ...(s.turn ? { turn: s.turn } : {}),
      ...(s.archivedAt !== undefined ? { archivedAt: s.archivedAt } : {}),
      ...(s.head !== undefined ? { head: s.head } : {}),
      logged,
      logHead: s.logHead,
      paired: true,
    };
  }
}
