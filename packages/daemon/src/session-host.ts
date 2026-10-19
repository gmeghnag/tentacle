/**
 * Builds hosted sessions. Decoupled from how an `Agent` is constructed: the
 * caller supplies an `AgentFactory` (the CLI wires it to the real model/tools/
 * confined execution; tests pass a scripted agent). Workspace confinement is a
 * server-side concern, so a client-requested `cwd` is NOT honoured in v1 — every
 * session runs against the daemon's own confined `defaultCwd`.
 */
import { type Agent, Session } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import { HostedSession, type RemotePermission, type TurnErrorPolicy } from "./hosted-session.ts";

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

export class SessionHost {
  private readonly opts: SessionHostOptions;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
  }

  /** Create a hosted session with a fresh agent, confined to `defaultCwd`. */
  create(
    id: string,
    _cwd: string | undefined,
    requestPermission: RemotePermission,
    messages?: readonly ChatMessage[],
  ): HostedSession {
    const { agent, permissions, jobs } = this.opts.createAgent(this.opts.defaultCwd);
    const session = new Session(agent, id, messages && messages.length > 0 ? { messages } : {});
    const { exposeTurnErrors, onTurnError } = this.opts;
    return new HostedSession(
      id,
      session,
      permissions,
      requestPermission,
      jobs,
      {
        ...(exposeTurnErrors ? { exposeTurnErrors } : {}),
        ...(onTurnError ? { onTurnError } : {}),
      },
      this.opts.ringBytes,
    );
  }
}
