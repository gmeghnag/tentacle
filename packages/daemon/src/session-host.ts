/**
 * The daemon's session registry: owns every hosted session, independent of any
 * connection (a connection only attaches). Decoupled from how an `Agent` is
 * constructed: the caller supplies an `AgentFactory` (the CLI wires it to the
 * real model/tools/confined execution; tests pass a scripted agent). Workspace
 * confinement is a server-side concern, so a client-requested `cwd` is NOT
 * honoured in v1 — every session runs against the daemon's own `defaultCwd`.
 */
import {
  type Agent,
  EMPTY_SKILL_LISTING,
  type RecordTitle,
  Session,
  type SkillListing,
  recordTitleText,
} from "@tentacle/agent";
import type { ChatMessage, JobController, ModelProvider, PermissionBroker } from "@tentacle/core";
import {
  JsonRpcErrorCode,
  type McpServerStatus,
  type OpenParams,
  type SessionListParams,
  type SessionListResult,
  type SessionSkillsResult,
  type SessionTitle,
  type SessionTtlParams,
  type SessionTtlResult,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  type Attachment,
  HostedSession,
  type RestoredSessionState,
  type TurnErrorPolicy,
} from "./hosted-session.ts";
import { toSessionSkills } from "./mapping.ts";
import {
  type DaemonSessionRecord,
  reconcileOnReload,
  restoredActivity,
} from "./persisted-session.ts";
import { type SessionSummary, toSessionList } from "./session-list.ts";
import type { SessionPersister } from "./session-persister.ts";
import { type Expired, type ReapPolicy, selectEvictable, selectExpired } from "./session-reaper.ts";
import { type TitleState, renameText, seedState } from "./session-title.ts";
import type { DaemonIdentity } from "./version-mismatch.ts";

/** `serve`'s defaults (the exposure boundary sets the limits; unset = none). */
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_MAX_DETACHED_SESSIONS = 16;

export type AgentFactory = (cwd: string) => {
  agent: Agent;
  permissions: PermissionBroker;
  /** Optional: when present, the hosted session streams its job exits live. */
  jobs?: JobController;
  /**
   * Optional: the provider that names the session after its first exchange
   * (docs/feat/session-titles.md). On a pod daemon it is the model proxy, so
   * the request runs on the laptop. Absent → titles are never generated.
   */
  titleModel?: ModelProvider;
};

/**
 * Read / change the idle TTL the reaper runs with (`daemon/session_ttl`). The
 * reaper's owner (`serve`) implements it; `set` takes effect at once.
 * `null` = never.
 */
export interface SessionTtlControl {
  get(): number | null;
  set(idleTtlMs: number | null): void;
}

export interface SessionHostOptions extends TurnErrorPolicy {
  readonly createAgent: AgentFactory;
  /** The confined working directory every hosted session runs against. */
  readonly defaultCwd: string;
  /** Replay budget per session, in bytes (default `DEFAULT_RING_BYTES`). */
  readonly ringBytes?: number;
  /** The clock for liveness stamps and the sweep (default `Date.now`). */
  readonly now?: () => number;
  /** Refuse to CREATE (or reopen) a session past this many live ones on the daemon. Unset = no limit. */
  readonly maxSessions?: number;
  /** Refuse to CREATE a session while this many are detached. Unset = no limit. */
  readonly maxDetachedSessions?: number;
  /** One line per refused create, naming the limit and the count (decision D6). */
  readonly onAudit?: (line: string) => void;
  /**
   * `serve` only: every session writes itself here, `close` (and the reaper,
   * the detached cap) keeps it ARCHIVED, `delete` removes its file, `restore`
   * reloads one. Pod daemons and the worker never pass it: there, a close
   * forgets the session.
   */
  readonly persister?: SessionPersister;
  /**
   * `serve` only: the handle on its idle reaper's TTL. Absent (a pod daemon,
   * the worker: no reaper) → `daemon/session_ttl` answers `MethodNotFound`.
   */
  readonly sessionTtl?: SessionTtlControl;
  /**
   * The skills a session created NOW would have, read again from disk
   * (`session/skills` with no session id: a client opens its session lazily,
   * at the first prompt; docs/feat/skills-hot-reload.md). The cli backs it
   * with the same scan its `createAgent` builds a new session's activator
   * from, so the list shown before the first prompt is what that prompt's
   * `/name` is checked against. May throw. Absent → an empty listing.
   */
  readonly newSessionSkills?: () => Promise<SkillListing>;
  /**
   * This daemon's MCP servers, probed live (`mcp/status`, the TUI's `/mcp`).
   * Absent → none (`serve` and pod daemons start no MCP servers today).
   */
  readonly mcpStatus?: () => Promise<readonly McpServerStatus[]>;
  /**
   * This daemon's tentacle version and kind, injected by the cli (the daemon
   * cannot import `APP_VERSION`): it words a `VersionMismatch`. Absent → the
   * refusal names only the protocol on the daemon side.
   */
  readonly identity?: DaemonIdentity;
  /** The bound on one title request (default `TITLE_TIMEOUT_MS`; tests shorten it). */
  readonly titleTimeoutMs?: number;
}

/** What `open` did: the session, whether it was built now, and the replay verdict. */
export interface OpenOutcome {
  readonly hosted: HostedSession;
  readonly created: boolean;
  readonly resync: boolean;
  readonly epoch: string;
}

/**
 * An ARCHIVED session (ended and kept on a `serve` daemon): metadata only, so
 * memory stays bounded however many there are — plus its full `record` while
 * that record's write is not confirmed (then a reopen and a listing work from
 * memory, and the reaper's sweeps retry the write).
 */
interface ArchivedEntry {
  readonly id: string;
  /** What `session/list` shows (the record's title, or a rename's). */
  title: string;
  /**
   * A `session/rename` of the archived session: the record is rewritten with
   * it (a write, no reopen), and a reopen — even one racing that write —
   * restores with it.
   */
  renamed: RecordTitle | undefined;
  /**
   * A `session/reclaim` of the archived session (owner F2): these returned
   * rows are back with their writer. Dropped from the record by the same
   * rewrite (no reopen), and from a reopen even one racing that write.
   */
  readonly reclaimed: Set<string>;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  record: DaemonSessionRecord | undefined;
  /** The last write of `record` failed: a sweep retries it. */
  unwritten: boolean;
  retrying: boolean;
}

function archivedEntry(
  record: DaemonSessionRecord,
  resident: DaemonSessionRecord | undefined,
): ArchivedEntry {
  return {
    id: record.id,
    title: recordTitleText(record),
    renamed: undefined,
    reclaimed: new Set(),
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    record: resident,
    unwritten: false,
    retrying: false,
  };
}

/** `record` without the `reclaimed` returned rows (itself when none of them is there). */
function withoutReclaimed(
  record: DaemonSessionRecord,
  reclaimed: ReadonlySet<string>,
): DaemonSessionRecord {
  const returned = record.returned.filter((r) => !reclaimed.has(r.id));
  return returned.length === record.returned.length ? record : { ...record, returned };
}

export class SessionHost {
  private readonly opts: SessionHostOptions;
  private readonly sessions = new Map<string, HostedSession>();
  /** ARCHIVED sessions (a persisting host only). An id is in ONE of the two maps, never both. */
  private readonly archived = new Map<string, ArchivedEntry>();
  /** In-flight reopen loads, by id: concurrent reopens share one read. */
  private readonly loads = new Map<string, Promise<DaemonSessionRecord | undefined>>();
  /** Tombstones: ids removed by `delete` (with a persister, also on disk). Never live, never archived. */
  private readonly deleted = new Set<string>();

  /** Who this daemon is (`SessionHostOptions.identity`). */
  readonly identity: DaemonIdentity | undefined;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.identity = opts.identity;
  }

  /**
   * `session/skills` with no session: the skills a session created now would
   * have, wire-safe (`SessionHostOptions.newSessionSkills`). Rejects when the
   * scan does.
   */
  async newSessionSkills(): Promise<SessionSkillsResult> {
    return toSessionSkills((await this.opts.newSessionSkills?.()) ?? EMPTY_SKILL_LISTING);
  }

  /**
   * `daemon/session_ttl`: set the idle TTL when `params` carries one, then
   * report the value in force. Synchronous (two concurrent sets are ordered,
   * the later wins). A change is not persisted.
   */
  sessionTtl(params: SessionTtlParams): SessionTtlResult {
    const control = this.opts.sessionTtl;
    if (!control) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "session TTL is not configurable on this daemon",
      );
    }
    // The wire says "never"; inside the daemon it is `null` (`ReapPolicy`).
    if (params.idleTtlMs !== undefined) {
      control.set(params.idleTtlMs === "never" ? null : params.idleTtlMs);
    }
    return { idleTtlMs: control.get() ?? "never", persisted: false };
  }

  /** This daemon's MCP servers and their live state; empty when it runs none. */
  mcpStatus(): Promise<readonly McpServerStatus[]> {
    return this.opts.mcpStatus?.() ?? Promise.resolve([]);
  }

  /** The live session `id`, if any. */
  get(id: string): HostedSession | undefined {
    return this.sessions.get(id);
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Every live session. */
  values(): IterableIterator<HostedSession> {
    return this.sessions.values();
  }

  /**
   * One `session/list` page (rules in `session-list.ts`). SYNCHRONOUS, like
   * `open`: a consistent read of the registry with no lock — each session is
   * either fully registered or gone. A read only: it attaches nothing and
   * moves no stamp, so a list never keeps a session alive.
   */
  list(params: SessionListParams): SessionListResult {
    const summaries: SessionSummary[] = [];
    for (const hosted of this.sessions.values()) {
      summaries.push(hosted.summary(this.opts.defaultCwd));
    }
    // From memory only: a listing never reads the disk, however many there are.
    for (const entry of this.archived.values()) {
      summaries.push({
        id: entry.id,
        createdAt: entry.createdAt,
        lastChangeAt: entry.updatedAt,
        running: false,
        attached: 0,
        title: entry.title,
        cwd: entry.cwd,
        archived: true,
      });
    }
    return toSessionList(summaries, params);
  }

  /** Number of ARCHIVED sessions (not in `size`). */
  get archivedCount(): number {
    return this.archived.size;
  }

  /**
   * The only ASYNCHRONOUS step of an open, run BEFORE the synchronous `open`:
   * an explicit reopen (`reopen: true`) of an archived id whose record is not
   * in memory reads it from disk (concurrent reopens share one read). Returns
   * the record, PINNED for that `open` (a write confirmation that drops the
   * resident copy meanwhile cannot lose it); `undefined` when there is
   * nothing to prepare. A record that cannot be read back (gone, damaged,
   * another project) → the entry is dropped (hidden, like at start), its id
   * blocked (the file is never touched) and the failure reported; the open
   * then answers `UnknownSession`.
   */
  prepareOpen(params: OpenParams): Promise<DaemonSessionRecord | undefined> {
    const id = params.sessionId;
    const persister = this.opts.persister;
    const entry = id !== undefined ? this.archived.get(id) : undefined;
    if (id === undefined || !entry || !persister || params.reopen !== true) {
      return Promise.resolve(undefined);
    }
    if (entry.record) {
      return Promise.resolve(entry.record);
    }
    const pending = this.loads.get(id);
    if (pending) {
      return pending;
    }
    const loading = persister.load(id).then((loaded) => {
      this.loads.delete(id);
      if (loaded.ok) {
        return loaded.record;
      }
      if (this.archived.get(id) === entry) {
        this.archived.delete(id);
        persister.block(id);
        persister.report(
          new Error(`archived session ${id} could not be reopened: ${loaded.reason} (left as is)`),
        );
      }
      return undefined;
    });
    this.loads.set(id, loading);
    return loading;
  }

  /**
   * Look up or create, then attach — SYNCHRONOUS on purpose (no `await`
   * anywhere): two concurrent opens of one absent id run one after the other,
   * so the second finds the first's session instead of building a second agent,
   * and the replay and the live stream join without a gap. A live id is never
   * overwritten. An ARCHIVED id is reloaded only on an explicit `reopen`
   * (from `prepared`, `prepareOpen`'s record, or the resident one), else it
   * is `SessionArchived`: never revived by a reconnect, never shadowed by a
   * new session. A DELETED id is `SessionDeleted`, whatever the params say: it
   * is never reused. Rules: `session/open` in `@tentacle/protocol`.
   */
  open(params: OpenParams, attachment: Attachment, prepared?: DaemonSessionRecord): OpenOutcome {
    if (params.sessionId !== undefined && this.deleted.has(params.sessionId)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${params.sessionId} was deleted`);
    }
    const live = params.sessionId !== undefined ? this.sessions.get(params.sessionId) : undefined;
    if (live) {
      const { resync, epoch } = live.attach(attachment, params.since);
      return { hosted: live, created: false, resync, epoch };
    }
    const entry = params.sessionId !== undefined ? this.archived.get(params.sessionId) : undefined;
    if (entry) {
      if (params.reopen !== true) {
        throw new RpcError(
          DomainErrorCode.SessionArchived,
          `session ${entry.id} was ended and is archived: reopen it to resume it`,
        );
      }
      const record = (prepared?.id === entry.id ? prepared : undefined) ?? entry.record;
      if (!record) {
        // Only a caller that skipped `prepareOpen`.
        throw new RpcError(
          DomainErrorCode.UnknownSession,
          `archived session not loaded: ${entry.id}`,
        );
      }
      // A reopen BUILDS a live session: the live cap applies (refused → still
      // archived, untouched). It is attached at once, so the detached cap does not.
      this.admitLive();
      // One step: out of the archive, live, attached (the restart path, mid-life).
      this.archived.delete(entry.id);
      // A rename (or a reclaim) of the archived session wins over the record it was read from.
      const hosted = this.restore(withoutReclaimed(record, entry.reclaimed), entry.renamed);
      const { resync, epoch } = hosted.attach(attachment, params.since);
      return { hosted, created: false, resync, epoch };
    }
    const seeded = params.messages !== undefined && params.messages.length > 0;
    if (params.sessionId !== undefined && params.create !== true && !seeded) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    this.admit();
    const id = params.sessionId ?? crypto.randomUUID();
    // `title` seeds only a session this open creates (a live or archived id never got here).
    const hosted = this.build(id, params.messages, undefined, seedState(params.title));
    // Registered BEFORE attaching: nothing can observe the id half-built.
    this.sessions.set(id, hosted);
    const { epoch } = hosted.attach(attachment);
    return { hosted, created: true, resync: false, epoch };
  }

  /**
   * End a session for every client. With a persister it is kept ARCHIVED;
   * without one it is forgotten. Idempotent: true iff a live session was closed.
   */
  close(id: string): boolean {
    return this.archive(id).closed;
  }

  /**
   * Remove a session for good: a live one is ended (`session_closed{deleted}`)
   * and its file removed; an archived one loses its file. Either way its id
   * is TOMBSTONED (a later open is `SessionDeleted`; with a persister the
   * tombstone is written before the file goes). Synchronous: true iff there
   * was one. The removal is queued after any pending write of the id (the
   * store's per-id queue), so the file is gone at the end.
   */
  delete(id: string): boolean {
    const hosted = this.sessions.get(id);
    if (hosted) {
      this.sessions.delete(id);
      this.deleted.add(id);
      hosted.close("deleted");
      // After `close`: the session writes nothing more, so nothing can recreate the file.
      this.opts.persister?.remove(id);
      return true;
    }
    if (this.archived.delete(id)) {
      this.deleted.add(id);
      this.opts.persister?.remove(id);
      return true;
    }
    return false;
  }

  /**
   * `session/rename` (rules: `@tentacle/protocol`). Synchronous: a live
   * session renames itself and streams `session_title`; an ARCHIVED one is
   * renamed in place — listed with it at once, its record rewritten in the
   * background (read back first if not resident; a reopen meanwhile carries
   * the new title, `entry.renamed`), never reopened. A deleted id →
   * `SessionDeleted`; else `UnknownSession`.
   */
  rename(id: string, raw: string): SessionTitle {
    if (this.deleted.has(id)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${id} was deleted`);
    }
    const live = this.sessions.get(id);
    if (live) {
      return live.rename(raw);
    }
    const entry = this.archived.get(id);
    if (!entry) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${id}`);
    }
    const text = renameText(raw);
    if (text === null) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        "a title needs at least one visible character",
      );
    }
    entry.title = text;
    entry.renamed = { text, source: "user" };
    void this.rewriteArchived(entry, "renamed");
    return { text, source: "user" };
  }

  /**
   * `session/reclaim` of a session that is no longer live (owner F2): a
   * closed / archived one only marks the rows reclaimed in its record — no
   * reopen, no revival, like an archived rename. Resolves once that write
   * settled (a reclaimed row never comes back after a restart). A deleted id
   * → `SessionDeleted`; one not archived → `UnknownSession`.
   */
  reclaimArchived(id: string, ids: readonly string[]): Promise<void> {
    if (this.deleted.has(id)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${id} was deleted`);
    }
    const entry = this.archived.get(id);
    if (!entry) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${id}`);
    }
    for (const key of ids) entry.reclaimed.add(key);
    return this.rewriteArchived(entry, "reclaimed");
  }

  /**
   * Write an archived entry's record with its `renamed` title (the latest one
   * when renames overlap) and without its `reclaimed` rows. Read back first
   * when the record is not resident; a read that fails leaves the change in
   * memory only (listed, kept by a reopen), reported. Skipped once the entry
   * is no longer archived (reopened: the live session carries it; deleted),
   * or when it changes nothing. The rewritten record stays resident until its
   * write lands; a failed write is retried by the sweeps. Resolves once the
   * write settled.
   */
  private async rewriteArchived(entry: ArchivedEntry, what: string): Promise<void> {
    const persister = this.opts.persister;
    if (!persister) {
      return;
    }
    let base = entry.record;
    if (!base) {
      const loaded = await persister.load(entry.id);
      if (!loaded.ok) {
        if (this.archived.get(entry.id) === entry) {
          persister.report(
            new Error(
              `archived session ${entry.id} was ${what} in memory only: its record could not be read back (${loaded.reason})`,
            ),
          );
        }
        return;
      }
      base = loaded.record;
    }
    if (this.archived.get(entry.id) !== entry) {
      return;
    }
    const current = entry.record ?? base;
    const renamed = entry.renamed;
    const kept = withoutReclaimed(current, entry.reclaimed);
    if (!renamed && kept === current) {
      return;
    }
    const record: DaemonSessionRecord = { ...kept, ...(renamed ? { title: renamed } : {}) };
    entry.record = record;
    entry.unwritten = false;
    const ok = await persister.writeRecord(record);
    this.settleWrite(entry, ok, record);
  }

  /**
   * A tombstone read at start (`serve`): the id stays deleted. A record still
   * on disk for it (a delete cut short) must not be restored: `isDeleted`.
   */
  addDeleted(id: string): void {
    if (this.sessions.has(id) || this.archived.has(id)) {
      throw new Error(`session ${id} is already known`);
    }
    this.deleted.add(id);
  }

  /** Whether `id` was removed by `delete` (its tombstone). */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Live, archived or deleted: an id in exactly one of the three, never two. */
  private known(id: string): boolean {
    return this.sessions.has(id) || this.archived.has(id) || this.deleted.has(id);
  }

  /**
   * Index an archived record found at start: metadata only (the record is
   * read again on its reopen). Never live, never counted by the limits.
   */
  addArchived(record: DaemonSessionRecord): void {
    if (this.known(record.id)) {
      throw new Error(`session ${record.id} is already known`);
    }
    this.archived.set(record.id, archivedEntry(record, undefined));
  }

  /**
   * End live session `id` (synchronously) and, with a persister, keep it
   * archived: its state is captured around the close (`HostedSession.archive`),
   * written stamped, and indexed with the record RESIDENT until the write is
   * confirmed. `archived: false` with `closed: true` → it could not be kept
   * (no persister, or a file the daemon may not write): it is gone.
   */
  private archive(id: string): { closed: boolean; archived: boolean } {
    const hosted = this.sessions.get(id);
    if (!hosted) {
      return { closed: false, archived: false };
    }
    this.sessions.delete(id);
    const persister = this.opts.persister;
    if (!persister) {
      hosted.close();
      return { closed: true, archived: false };
    }
    const { record, written } = persister.archive(hosted.archive(), this.now());
    if (!record) {
      return { closed: true, archived: false };
    }
    const entry = archivedEntry(record, record);
    this.archived.set(id, entry);
    void written.then((ok) => this.settleWrite(entry, ok, record));
    return { closed: true, archived: true };
  }

  /**
   * A write of `record` for `entry` settled: landed → memory drops the record;
   * failed → a sweep retries. Only for the entry's CURRENT record: an older
   * write settling after a rename rewrote it changes nothing.
   */
  private settleWrite(entry: ArchivedEntry, ok: boolean, record: DaemonSessionRecord): void {
    if (entry.record !== record) {
      return;
    }
    entry.retrying = false;
    // Reopened, deleted or replaced meanwhile: not this entry's business any more.
    if (this.archived.get(entry.id) !== entry) {
      return;
    }
    if (ok) {
      entry.record = undefined;
      entry.unwritten = false;
    } else {
      entry.unwritten = true;
    }
  }

  /**
   * Reload a persisted session as a live, DETACHED one (a `serve` restart):
   * its history reconciled (`reconcileOnReload`), its idempotency keys and TTL
   * clock restored. A turn suspended on its own call's permission is RUNNING
   * again — asked anew, streamed into the ring for whoever attaches
   * (docs/feat/suspended-turn-resume.md); any other turn cut short is closed
   * honestly and the session is idle (nothing re-runs). Never refused by the
   * limits (they only refuse NEW sessions, decision G); the new incarnation's
   * epoch makes any returning client resync. Synchronous, like `open`.
   */
  restore(record: DaemonSessionRecord, renamed?: RecordTitle): HostedSession {
    if (this.known(record.id)) {
      throw new Error(`session ${record.id} is already known`);
    }
    const reconciled = reconcileOnReload(record);
    const now = this.now();
    const lastActiveAt = restoredActivity(record, now);
    const kept = renamed ?? (typeof record.title === "string" ? undefined : record.title);
    const hosted = this.build(record.id, reconciled.messages, {
      title: seedState(kept),
      createdAt: record.createdAt,
      lastActiveAt,
      // A turn cut short is reconciled now (notes appended, or re-asked): a
      // change at the restart. Otherwise the record's last change, kept.
      lastChangeAt: record.turn ? now : record.updatedAt,
      turns: reconciled.turns,
      enqueueIds: reconciled.enqueueIds,
      returned: reconciled.returned,
      cutShort: record.turn !== undefined,
      ...(reconciled.resume ? { resume: reconciled.resume } : {}),
    });
    this.sessions.set(record.id, hosted);
    return hosted;
  }

  /**
   * Admission control for a new session. Attaching to a live session is never
   * refused (owner decision G). `maxSessions` only refuses. At the detached
   * cap a persisting host ARCHIVES the idle detached session idle the longest
   * to make room (owner decision Q1: `selectEvictable`, never a busy one) and
   * refuses only when every detached session is busy; without a persister an
   * archive would be a deletion, so it refuses (D6). Counts are derived from
   * the registry at check time, never kept as counters that could drift.
   */
  private admit(): void {
    this.admitLive();
    const { maxDetachedSessions } = this.opts;
    if (maxDetachedSessions === undefined) {
      return;
    }
    let detached = 0;
    for (const hosted of this.sessions.values()) {
      if (hosted.attachedCount === 0) {
        detached++;
      }
    }
    if (detached < maxDetachedSessions) {
      return;
    }
    if (this.opts.persister) {
      const victim = selectEvictable([...this.sessions.values()].map((h) => h.liveness()));
      if (victim !== null) {
        const { archived } = this.archive(victim);
        this.opts.onAudit?.(`session-${archived ? "archived" : "reaped"} ${victim} evicted`);
        return;
      }
    }
    this.opts.onAudit?.(`session-refused detached ${detached}/${maxDetachedSessions}`);
    throw new RpcError(
      DomainErrorCode.TooManySessions,
      this.opts.persister
        ? `too many detached sessions on this daemon (max ${maxDetachedSessions}) — every detached session is running a turn`
        : `too many detached sessions on this daemon (max ${maxDetachedSessions}) — close one with session/close, or wait for the idle TTL`,
      { limit: "detached", max: maxDetachedSessions },
    );
  }

  /** `maxSessions`: refuse one more LIVE session (a new one, or a reopen). Never evicts. */
  private admitLive(): void {
    const { maxSessions } = this.opts;
    if (maxSessions !== undefined && this.sessions.size >= maxSessions) {
      this.opts.onAudit?.(`session-refused sessions ${this.sessions.size}/${maxSessions}`);
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many sessions on this daemon (max ${maxSessions})`,
        { limit: "sessions", max: maxSessions },
      );
    }
  }

  /**
   * Close every session expired under `policy` (rules: `selectExpired`).
   * SYNCHRONOUS, like `open`: a sweep and an attach never interleave, so a
   * session is either attached first (and skipped) or closed first (and the
   * attach finds it archived — or, without a persister, `UnknownSession`).
   * Reaping IS `close` — one teardown path (archived where it can be kept).
   * A close that throws is reported and the sweep goes on; the session is
   * already out of the registry by then. Each sweep also retries, once, the
   * write of every archived record whose last write failed (reported once,
   * at the archive; the retries are quiet).
   */
  reapExpired(policy: ReapPolicy, onError?: (error: Error) => void): Expired[] {
    this.retryUnwritten();
    const now = this.now();
    const expired = selectExpired(
      [...this.sessions.values()].map((hosted) => hosted.liveness()),
      now,
      policy,
    );
    const reaped: Expired[] = [];
    for (const entry of expired) {
      let archived = false;
      try {
        archived = this.archive(entry.id).archived;
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      reaped.push(archived ? { ...entry, archived } : entry);
    }
    return reaped;
  }

  private retryUnwritten(): void {
    const persister = this.opts.persister;
    if (!persister) {
      return;
    }
    for (const entry of this.archived.values()) {
      const record = entry.record;
      if (entry.unwritten && record && !entry.retrying) {
        entry.retrying = true;
        void persister.writeRecord(record, false).then((ok) => this.settleWrite(entry, ok, record));
      }
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** A hosted session with a fresh agent, confined to `defaultCwd`. */
  private build(
    id: string,
    messages: readonly ChatMessage[] | undefined,
    restored?: RestoredSessionState,
    seed?: TitleState,
  ): HostedSession {
    const { agent, permissions, jobs, titleModel } = this.opts.createAgent(this.opts.defaultCwd);
    // core `ChatMessage` is structurally the wire schema.
    const session = new Session(agent, id, messages && messages.length > 0 ? { messages } : {});
    const { exposeTurnErrors, onTurnError } = this.opts;
    return new HostedSession(
      id,
      session,
      permissions,
      jobs,
      {
        ...(exposeTurnErrors ? { exposeTurnErrors } : {}),
        ...(onTurnError ? { onTurnError } : {}),
      },
      this.opts.ringBytes,
      () => this.now(),
      this.opts.persister
        ? { persister: this.opts.persister, ...(restored ? { restored } : {}) }
        : undefined,
      {
        ...(titleModel ? { model: titleModel } : {}),
        // A reload's title too: it does not depend on persisting from here on.
        ...((seed ?? restored?.title) ? { seed: seed ?? restored?.title } : {}),
        ...(this.opts.titleTimeoutMs !== undefined ? { timeoutMs: this.opts.titleTimeoutMs } : {}),
      },
    );
  }
}
