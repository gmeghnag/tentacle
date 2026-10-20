/**
 * The daemon's session registry: owns every hosted session, independent of any
 * connection (a connection only attaches). Decoupled from how an `Agent` is
 * constructed: the caller supplies an `AgentFactory` (the CLI wires it to the
 * real model/tools/confined execution; tests pass a scripted agent). Workspace
 * confinement is a server-side concern, so a client-requested `cwd` is NOT
 * honoured in v1 — every session runs against the daemon's own `defaultCwd`.
 */
import { type Agent, Session } from "@tentacle/agent";
import type { JobController, PermissionBroker } from "@tentacle/core";
import type { OpenParams } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { type Attachment, HostedSession, type TurnErrorPolicy } from "./hosted-session.ts";

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

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
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
    return true;
  }

  /** A hosted session with a fresh agent, confined to `defaultCwd`. */
  private build(id: string, messages: OpenParams["messages"]): HostedSession {
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
    );
  }
}
