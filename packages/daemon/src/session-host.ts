/**
 * The daemon's session registry: owns every hosted session, independent of any
 * connection (a connection only attaches). Decoupled from how an `Agent` is
 * constructed: the caller supplies an `AgentFactory` (the CLI wires it to the
 * real model/tools/confined execution; tests pass a scripted agent). Workspace
 * confinement is a server-side concern, so a client-requested `cwd` is NOT
 * honoured in v1 — every session runs against the daemon's own `defaultCwd`.
 */
import { type Agent, Session } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import type {
  McpServerStatus,
  OpenParams,
  SkillListEntry,
  SkillSummary,
  SkillsListResult,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  type Attachment,
  HostedSession,
  type RestoredSessionState,
  type TurnErrorPolicy,
} from "./hosted-session.ts";
import { toSkillCatalog, toSkillList } from "./mapping.ts";
import {
  type DaemonSessionRecord,
  reconcileOnReload,
  restoredActivity,
} from "./persisted-session.ts";
import type { SessionPersister } from "./session-persister.ts";
import { type Expired, type ReapPolicy, selectExpired } from "./session-reaper.ts";

/** `serve`'s defaults (the exposure boundary sets the limits; unset = none). */
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_MAX_DETACHED_SESSIONS = 16;

export type AgentFactory = (cwd: string) => {
  agent: Agent;
  permissions: PermissionBroker;
  /** Optional: when present, the hosted session streams its job exits live. */
  jobs?: JobController;
};

export interface SessionHostOptions extends TurnErrorPolicy {
  readonly createAgent: AgentFactory;
  /** The confined working directory every hosted session runs against. */
  readonly defaultCwd: string;
  /** Replay budget per session, in bytes (default `DEFAULT_RING_BYTES`). */
  readonly ringBytes?: number;
  /** The clock for liveness stamps and the sweep (default `Date.now`). */
  readonly now?: () => number;
  /** Refuse to CREATE a session past this many live ones on the daemon. Unset = no limit. */
  readonly maxSessions?: number;
  /** Refuse to CREATE a session while this many are detached. Unset = no limit. */
  readonly maxDetachedSessions?: number;
  /** One line per refused create, naming the limit and the count (decision D6). */
  readonly onAudit?: (line: string) => void;
  /**
   * `serve` only: every session writes itself here, `close` deletes its file,
   * and `restore` reloads one. Pod daemons and the worker never pass it.
   */
  readonly persister?: SessionPersister;
  /**
   * The skills a user can activate with `/name` on this daemon (config's
   * `slashSkills`), returned by `initialize` as its catalog. Absent → none.
   */
  readonly skills?: readonly { readonly name: string; readonly description: string }[];
  /**
   * This daemon's MCP servers, probed live (`mcp/status`, the TUI's `/mcp`).
   * Absent → none (`serve` and pod daemons start no MCP servers today).
   */
  readonly mcpStatus?: () => Promise<readonly McpServerStatus[]>;
  /**
   * Every skill this daemon discovered and its discovery problems
   * (`skills/list`, the TUI's `/skills`), as discovery produced them. Absent → none.
   */
  readonly skillList?: {
    readonly skills: readonly SkillListEntry[];
    readonly problems: readonly string[];
  };
}

/** What `open` did: the session, whether it was built now, and the replay verdict. */
export interface OpenOutcome {
  readonly hosted: HostedSession;
  readonly created: boolean;
  readonly resync: boolean;
  readonly epoch: string;
}

export class SessionHost {
  private readonly opts: SessionHostOptions;
  private readonly sessions = new Map<string, HostedSession>();

  /** The `initialize` skill catalog (built once: skills are fixed at daemon start). */
  readonly skillCatalog: readonly SkillSummary[];
  /** The `skills/list` result, wire-safe (built once, like the catalog). */
  readonly skillList: SkillsListResult;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.skillCatalog = toSkillCatalog(opts.skills ?? []);
    this.skillList = toSkillList(opts.skillList ?? { skills: [], problems: [] });
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
   * Look up or create, then attach — SYNCHRONOUS on purpose (no `await`
   * anywhere): two concurrent opens of one absent id run one after the other,
   * so the second finds the first's session instead of building a second agent,
   * and the replay and the live stream join without a gap. A live id is never
   * overwritten. Rules: `session/open` in `@tentacle/protocol`.
   */
  open(params: OpenParams, attachment: Attachment): OpenOutcome {
    const live = params.sessionId !== undefined ? this.sessions.get(params.sessionId) : undefined;
    if (live) {
      const { resync, epoch } = live.attach(attachment, params.since);
      return { hosted: live, created: false, resync, epoch };
    }
    const seeded = params.messages !== undefined && params.messages.length > 0;
    if (params.sessionId !== undefined && params.create !== true && !seeded) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    this.admit();
    const id = params.sessionId ?? crypto.randomUUID();
    const hosted = this.build(id, params.messages);
    // Registered BEFORE attaching: nothing can observe the id half-built.
    this.sessions.set(id, hosted);
    const { epoch } = hosted.attach(attachment);
    return { hosted, created: true, resync: false, epoch };
  }

  /** End and forget a session. Idempotent: true iff a live session was closed. */
  close(id: string): boolean {
    const hosted = this.sessions.get(id);
    if (!hosted) {
      return false;
    }
    this.sessions.delete(id);
    hosted.close();
    // After `close`: the session writes nothing more, so nothing can recreate the file.
    this.opts.persister?.remove(id);
    return true;
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
  restore(record: DaemonSessionRecord): HostedSession {
    if (this.sessions.has(record.id)) {
      throw new Error(`session ${record.id} is already live`);
    }
    const reconciled = reconcileOnReload(record);
    const lastActiveAt = restoredActivity(record, this.now());
    const hosted = this.build(record.id, reconciled.messages, {
      createdAt: record.createdAt,
      lastActiveAt,
      turns: reconciled.turns,
      enqueueIds: reconciled.enqueueIds,
      ...(reconciled.resume ? { resume: reconciled.resume } : {}),
    });
    this.sessions.set(record.id, hosted);
    return hosted;
  }

  /**
   * Admission control for a new session. Limits only ever REFUSE new work —
   * attaching to a live session is never refused and nothing is evicted
   * (owner decisions G, D6). Counts are derived from the registry at check
   * time, never kept as counters that could drift.
   */
  private admit(): void {
    const { maxSessions, maxDetachedSessions } = this.opts;
    if (maxSessions !== undefined && this.sessions.size >= maxSessions) {
      this.opts.onAudit?.(`session-refused sessions ${this.sessions.size}/${maxSessions}`);
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many sessions on this daemon (max ${maxSessions})`,
        { limit: "sessions", max: maxSessions },
      );
    }
    if (maxDetachedSessions === undefined) {
      return;
    }
    let detached = 0;
    for (const hosted of this.sessions.values()) {
      if (hosted.attachedCount === 0) {
        detached++;
      }
    }
    if (detached >= maxDetachedSessions) {
      this.opts.onAudit?.(`session-refused detached ${detached}/${maxDetachedSessions}`);
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many detached sessions on this daemon (max ${maxDetachedSessions}) — close one with session/close, or wait for the idle TTL`,
        { limit: "detached", max: maxDetachedSessions },
      );
    }
  }

  /**
   * Close every session expired under `policy` (rules: `selectExpired`).
   * SYNCHRONOUS, like `open`: a sweep and an attach never interleave, so a
   * session is either attached first (and skipped) or closed first (and the
   * attach gets `UnknownSession`). Reaping IS `close` — one teardown path.
   * A close that throws is reported and the sweep goes on; the session is
   * already out of the registry by then.
   */
  reapExpired(policy: ReapPolicy, onError?: (error: Error) => void): Expired[] {
    const now = this.now();
    const expired = selectExpired(
      [...this.sessions.values()].map((hosted) => hosted.liveness()),
      now,
      policy,
    );
    const reaped: Expired[] = [];
    for (const entry of expired) {
      try {
        this.close(entry.id);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      reaped.push(entry);
    }
    return reaped;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** A hosted session with a fresh agent, confined to `defaultCwd`. */
  private build(
    id: string,
    messages: readonly ChatMessage[] | undefined,
    restored?: RestoredSessionState,
  ): HostedSession {
    const { agent, permissions, jobs } = this.opts.createAgent(this.opts.defaultCwd);
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
    );
  }
}
