/**
 * The client runtime: an `RpcPeer` over the control channel that performs the
 * handshake, opens sessions, forwards the agent's permission requests to the
 * local `PermissionBroker` (the TUI's prompt), and routes streamed
 * `session/update`s to the right `RemoteSession`.
 */
import type { ChatMessage, PermissionBroker, PermissionRequest } from "@agent-harness/core";
import {
  type CompactResult,
  type InitializeResult,
  JsonRpcErrorCode,
  Method,
  type NewSessionResult,
  Notification,
  PROTOCOL_VERSION,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUpdateParams,
  type SnapshotResult,
  type StopReason,
  text,
} from "@agent-harness/protocol";
import { type DuplexChannel, RpcError, RpcPeer } from "@agent-harness/transport";
import { responseToOutcome } from "./permission-map.ts";
import { RemoteSession } from "./remote-session.ts";

/** A background-job exit surfaced by the daemon, outside any turn. */
export interface BackgroundExitNotice {
  readonly jobId: string;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
}

export class RemoteClient {
  private readonly peer: RpcPeer;
  private readonly permissions: PermissionBroker;
  private readonly handlers = new Map<string, (update: SessionUpdate) => void>();
  /** Session-independent listeners for background-job exits (idle or mid-turn). */
  private readonly exitListeners = new Set<(notice: BackgroundExitNotice) => void>();

  constructor(channel: DuplexChannel, permissions: PermissionBroker) {
    this.permissions = permissions;
    this.peer = new RpcPeer(channel, {
      onNotification: (method, params) => {
        if (method === Notification.SessionUpdate) {
          const p = params as SessionUpdateParams;
          // A background exit is not turn-scoped: route it to the dedicated
          // listeners (which fire even when no turn is streaming), never to the
          // per-turn update handler.
          if (p.update.type === "background_exit") {
            const { jobId, command, status, exitCode } = p.update;
            for (const listener of this.exitListeners) {
              listener({ jobId, command, status, exitCode });
            }
            return;
          }
          this.handlers.get(p.sessionId)?.(p.update);
        }
      },
      onRequest: async (method, params) => {
        if (method === Method.RequestPermission) {
          return this.onPermission(params as RequestPermissionParams);
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unexpected request: ${method}`);
      },
    });
  }

  /** Handshake; rejects on an incompatible daemon version. */
  async initialize(): Promise<InitializeResult> {
    return (await this.peer.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as InitializeResult;
  }

  /** A controller the Ink App drives exactly like a local `Session`. */
  newSession(seedMessages?: readonly ChatMessage[], sessionId?: string): RemoteSession {
    return new RemoteSession(this, seedMessages, sessionId);
  }

  /** Create the remote session and return its id (used lazily by `RemoteSession`). */
  async openSession(
    cwd?: string,
    messages?: readonly ChatMessage[],
    sessionId?: string,
  ): Promise<string> {
    const result = (await this.peer.request(Method.NewSession, {
      ...(cwd ? { cwd } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
      ...(sessionId ? { sessionId } : {}),
    })) as NewSessionResult;
    return result.sessionId;
  }

  /** Read the session's current history back (for the main thread to persist). */
  async snapshot(sessionId: string): Promise<readonly ChatMessage[]> {
    const result = (await this.peer.request(Method.Snapshot, { sessionId })) as SnapshotResult;
    return result.messages as readonly ChatMessage[];
  }

  prompt(sessionId: string, prompt: string): Promise<StopReason> {
    return this.peer
      .request(Method.Prompt, { sessionId, content: [text(prompt)] })
      .then((result) => (result as PromptResult).stopReason);
  }

  compact(sessionId: string): Promise<{ before: number; after: number }> {
    return this.peer
      .request(Method.Compact, { sessionId })
      .then((result) => result as CompactResult);
  }

  cancel(sessionId: string): void {
    this.peer.notify(Notification.Cancel, { sessionId });
  }

  setUpdateHandler(sessionId: string, handler: ((update: SessionUpdate) => void) | null): void {
    if (handler) {
      this.handlers.set(sessionId, handler);
    } else {
      this.handlers.delete(sessionId);
    }
  }

  /** Subscribe to background-job exits across all sessions; returns an unsubscribe. */
  onBackgroundExit(listener: (notice: BackgroundExitNotice) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    this.peer.close();
  }

  private async onPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const req: PermissionRequest = {
      tool: "",
      level: "ask",
      title: params.title,
      ...(params.explanation ? { detail: params.explanation } : {}),
      input: {},
    };
    const response = await this.permissions.request(req);
    return { outcome: responseToOutcome(response) };
  }
}
