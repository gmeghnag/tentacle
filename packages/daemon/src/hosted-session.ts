/**
 * A single hosted conversation on the daemon: wraps the agent `Session`, drives
 * one turn at a time, streams `session/update` params through a sink, routes the
 * agent's permission requests to the connected client, and keeps a bounded
 * replay buffer of the current turn (seq-numbered) for reconnect.
 */
import type { Session } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import type {
  PermissionOutcome,
  RequestPermissionParams,
  SessionUpdate,
  SessionUpdateParams,
  StopReason,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { contentToText, eventToUpdate, stopReasonToProtocol } from "./mapping.ts";
import { outcomeToResponse, toRequestPermissionParams } from "./permission-map.ts";

/** Receives each streamed `session/update` (one per emitted update). */
export type UpdateSink = (params: SessionUpdateParams) => void;
/** Asks the connected client to resolve a permission request. */
export type RemotePermission = (params: RequestPermissionParams) => Promise<PermissionOutcome>;

/** Max updates retained for turn-scoped replay on reconnect. */
const MAX_REPLAY = 1024;

export class HostedSession {
  readonly id: string;
  private readonly session: Session;
  private controller: AbortController | null = null;
  private currentToolCallId = "";
  private seq = 0;
  private turnBuffer: SessionUpdateParams[] = [];
  private sink: UpdateSink | null = null;

  constructor(
    id: string,
    session: Session,
    permissions: PermissionBroker,
    requestPermission: RemotePermission,
    jobs?: JobController,
  ) {
    this.id = id;
    this.session = session;
    // The agent's permission gate routes here; we forward to the client and map
    // its choice back to a local allow/deny + scope.
    permissions.setRequester(async (req) => {
      const params = toRequestPermissionParams(this.id, this.currentToolCallId || "pending", req);
      const outcome = await requestPermission(params);
      return outcomeToResponse(outcome);
    });
    // A background job can exit while the session is idle (between turns), so we
    // stream the exit the moment it happens — not only at the next turn, where
    // the agent injects a note for the model. The client renders it like a local
    // job-exit notice; the TUI dedupes by job id against that next-turn event.
    jobs?.onExit((job) => {
      this.emit({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
    });
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Attach (or detach with `null`) the sink that receives streamed updates. */
  setSink(sink: UpdateSink | null): void {
    this.sink = sink;
  }

  /** Buffered updates of the current turn with `seq` strictly greater than `afterSeq`. */
  replayFrom(afterSeq: number): SessionUpdateParams[] {
    return this.turnBuffer.filter((p) => (p.seq ?? 0) > afterSeq);
  }

  private emit(update: SessionUpdate): void {
    const params: SessionUpdateParams = { sessionId: this.id, seq: ++this.seq, update };
    this.turnBuffer.push(params);
    if (this.turnBuffer.length > MAX_REPLAY) {
      this.turnBuffer.shift();
    }
    this.sink?.(params);
  }

  /** Drive one turn to completion, streaming updates; resolves with the stop reason. */
  async prompt(content: Parameters<typeof contentToText>[0]): Promise<StopReason> {
    if (this.controller) {
      throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    }
    this.turnBuffer = [];
    const controller = new AbortController();
    this.controller = controller;
    try {
      for await (const event of this.session.send(contentToText(content), controller.signal)) {
        if (event.type === "tool_start") {
          this.currentToolCallId = event.id;
        }
        const update = eventToUpdate(event);
        if (update) {
          this.emit(update);
        }
        if (event.type === "turn_end") {
          return stopReasonToProtocol(event.reason);
        }
      }
      return "end_turn";
    } finally {
      this.controller = null;
    }
  }

  /** Queue a user message for injection at the next model-round boundary. */
  enqueue(text: string): void {
    this.session.enqueue(text);
  }

  /** Compact the conversation; returns message counts before/after. */
  async compact(): Promise<{ before: number; after: number }> {
    const { before, after } = await this.session.compact();
    return { before, after };
  }

  /** The current conversation history (the main thread persists it). */
  snapshot(): { messages: readonly ChatMessage[] } {
    return { messages: this.session.snapshot().messages };
  }

  /** Abort the active turn (if any). */
  cancel(): void {
    this.controller?.abort();
  }
}
