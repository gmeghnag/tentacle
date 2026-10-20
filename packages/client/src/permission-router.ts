/**
 * Which permission request the user is asked about, and what goes back to the
 * daemon — pure, React-free (docs/feat/permission-events.md). The daemon streams
 * `permission_request` / `permission_resolved` to every attached client; this
 * reducer turns those events and the user's answers into actions for
 * `RemoteClient` to execute: show a prompt, withdraw one, send an answer.
 *
 * - One prompt at a time (the TUI has one dialog); the rest wait FIFO.
 * - A request already on screen, queued, or resolved is ignored: a replay
 *   after a re-attach never prompts twice.
 * - `permission_resolved` is DISPLAY-ONLY: it closes a dialog and nothing
 *   else. It never sends, never records an approval, never changes how a later
 *   request is handled — a pod daemon is not trusted (AGENTS §7), and there is
 *   no grant cache here at all ("allow always" is remembered daemon-side).
 * - A dismissed prompt (withdrawn, or the TUI went away) sends nothing: no
 *   human decided, so the request stays pending for another client.
 */
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import { responseToOutcome } from "./permission-map.ts";

export type RouterAction =
  | {
      readonly kind: "prompt";
      readonly sessionId: string;
      readonly requestId: string;
      readonly request: PermissionRequest;
    }
  | { readonly kind: "abort"; readonly sessionId: string; readonly requestId: string }
  | {
      readonly kind: "send";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string;
    }
  /** The user's answer maps to an option the request did not offer: not sent (report it). */
  | {
      readonly kind: "unoffered";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string;
    };

interface Entry {
  readonly sessionId: string;
  readonly update: PermissionRequestUpdate;
}

const is = (entry: Entry | null, sessionId: string, requestId: string): boolean =>
  entry !== null && entry.sessionId === sessionId && entry.update.requestId === requestId;

/** The local request the daemon's gate built, rebuilt from the event. */
export function toPermissionRequest(update: PermissionRequestUpdate): PermissionRequest {
  return {
    tool: update.tool,
    level: "ask",
    title: update.title,
    ...(update.explanation ? { detail: update.explanation } : {}),
    input: {},
    ...(update.suggestion ? { suggestion: { prefix: update.suggestion.prefix } } : {}),
  };
}

export class PermissionRouter {
  private current: Entry | null = null;
  private queue: Entry[] = [];
  /** Per session: every request the daemon said is settled (replay dedupe). */
  private readonly resolvedIds = new Map<string, Set<string>>();

  /** A `permission_request` arrived (live or replayed). */
  request(sessionId: string, update: PermissionRequestUpdate): RouterAction[] {
    const id = update.requestId;
    if (
      is(this.current, sessionId, id) ||
      this.queue.some((e) => is(e, sessionId, id)) ||
      this.resolvedIds.get(sessionId)?.has(id)
    ) {
      return [];
    }
    this.queue.push({ sessionId, update });
    return this.next();
  }

  /** A `permission_resolved` arrived: close its dialog (display-only). */
  resolved(sessionId: string, requestId: string): RouterAction[] {
    let ids = this.resolvedIds.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.resolvedIds.set(sessionId, ids);
    }
    ids.add(requestId);
    if (is(this.current, sessionId, requestId)) {
      this.current = null;
      return [{ kind: "abort", sessionId, requestId }, ...this.next()];
    }
    this.queue = this.queue.filter((e) => !is(e, sessionId, requestId));
    return [];
  }

  /** The local prompt for this request returned. */
  answered(sessionId: string, requestId: string, response: PermissionResponse): RouterAction[] {
    const entry = this.current;
    if (!entry || !is(entry, sessionId, requestId)) {
      return []; // withdrawn meanwhile: its answer must not be sent
    }
    this.current = null;
    if (response.dismissed) {
      return this.next();
    }
    const outcome = responseToOutcome(response);
    if (outcome.outcome !== "selected") {
      return this.next();
    }
    if (!entry.update.options.some((o) => o.optionId === outcome.optionId)) {
      return [
        { kind: "unoffered", sessionId, requestId, optionId: outcome.optionId },
        ...this.next(),
      ];
    }
    return [{ kind: "send", sessionId, requestId, optionId: outcome.optionId }, ...this.next()];
  }

  /** The session ended (`session_closed`): its prompts can no longer be answered. */
  sessionClosed(sessionId: string): RouterAction[] {
    this.resolvedIds.delete(sessionId);
    this.queue = this.queue.filter((e) => e.sessionId !== sessionId);
    const entry = this.current;
    if (entry?.sessionId === sessionId) {
      this.current = null;
      return [{ kind: "abort", sessionId, requestId: entry.update.requestId }, ...this.next()];
    }
    return [];
  }

  /** The connection closed: nothing can be answered on it (a re-attach replays). */
  connectionClosed(): RouterAction[] {
    this.queue = [];
    const entry = this.current;
    this.current = null;
    return entry
      ? [{ kind: "abort", sessionId: entry.sessionId, requestId: entry.update.requestId }]
      : [];
  }

  private next(): RouterAction[] {
    if (this.current !== null) {
      return [];
    }
    const entry = this.queue.shift();
    if (!entry) {
      return [];
    }
    this.current = entry;
    return [
      {
        kind: "prompt",
        sessionId: entry.sessionId,
        requestId: entry.update.requestId,
        request: toPermissionRequest(entry.update),
      },
    ];
  }
}
