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
import {
  A2A_ADD_AGENT_TOOL,
  APP_PUBLISH_TOOL,
  BROWSER_ACTION_TOOL,
  CONTAINER_PREVIEW_TOOL,
  type PermissionRequest,
  type PermissionResponse,
  WORKFLOW_APPROVE_TOOL,
} from "@tentacle/core";
import {
  type PermissionRequestUpdate,
  QUESTION_ANSWER_OPTION,
  QUESTION_SKIP_OPTION,
  type QuestionRequestUpdate,
} from "@tentacle/protocol";
import { progressText } from "./mapping.ts";
import {
  normalizePermissionReply,
  normalizeQuestionAnswer,
  responseToOutcome,
} from "./permission-map.ts";

/**
 * An ask the router holds: a permission request, or a remote agent's question
 * (docs/feat/a2a-client.md C6) — one queue, one prompt at a time.
 */
export type AskUpdate = PermissionRequestUpdate | QuestionRequestUpdate;

export type RouterAction =
  | {
      readonly kind: "prompt";
      readonly sessionId: string;
      readonly requestId: string;
      readonly request: PermissionRequest;
      /** The turn it was raised in (`request`'s `turnId`); absent when none. */
      readonly turnId?: string;
      /**
       * The sub-agent that asked (the update's `agent`); absent: the call
       * itself. Display only, from a daemon that may be a pod: nothing here
       * decides on it.
       */
      readonly agent?: {
        readonly type: string;
        readonly description: string;
        /** A BACKGROUND child's `sa-N`. */
        readonly id?: string;
      };
      /**
       * The other devices this ask was raised to, by their declared labels
       * (`ClientInfo.host`, docs/feat/session-auto-accept.md D7). Display only,
       * bounded and sanitized here (a pod could forge one), and still each
       * surface's OWN label: `otherDevicesAsked` drops it.
       */
      readonly askedOn?: readonly string[];
      /**
       * The workflow step / run / schedule approval it belongs to (the update's
       * `workflow`). Display only, bounded and sanitized here (a pod could forge
       * it); `askOrigin` turns it into the label.
       */
      readonly workflow?: {
        readonly name: string;
        readonly runId?: string;
        readonly stepId?: string;
        readonly index?: number;
        readonly count?: number;
      };
    }
  | { readonly kind: "abort"; readonly sessionId: string; readonly requestId: string }
  | {
      readonly kind: "send";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string;
      /**
       * The person's reply with a refusal, normalized (only if the request
       * offered `reply`) — or, with `question`, the ANSWER (absent = skip).
       */
      readonly message?: string;
      /** A remote question's answer: sent as `session/answer_question` (C6). */
      readonly question?: true;
    }
  /** The user's answer maps to an option the request did not offer: not sent (report it). */
  | {
      readonly kind: "unoffered";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string;
    }
  /**
   * A refusal with a reply for a request that did not offer one (an older
   * daemon would strip it silently): not sent — never a bare No in its place.
   * Report it and hand the words back.
   */
  | { readonly kind: "unreplyable"; readonly sessionId: string; readonly requestId: string };

interface Entry {
  readonly sessionId: string;
  readonly update: AskUpdate;
  readonly turnId: string | null;
}

/** A `send` action (narrowed out for the callers that only send). */
export type PermissionSendAction = Extract<RouterAction, { kind: "send" }>;

/**
 * What a keyed `session/resolve_permission` came to (docs/feat/mobile-notifications.md
 * Design 5): `sent` (the daemon took it), `not-pending` (answered elsewhere, or
 * gone — first-wins, no effect), `session-lost` (the session was recreated
 * mid-send: it MAY have arrived), `failed` (not delivered).
 */
export type PermissionAnswerOutcome = "sent" | "not-pending" | "session-lost" | "failed";

/**
 * What a notification's answer came to: the outcome of the send, or the reason
 * nothing was sent — `unoffered` (the option is not one this request offers),
 * `unreplyable` (a reply for a request that takes none), `not-pending` (no such
 * ask is held: unknown, resolved, or already answered).
 */
export type NotificationAnswerOutcome = PermissionAnswerOutcome | "unoffered" | "unreplyable";

const is = (entry: Entry | null, sessionId: string, requestId: string): boolean =>
  entry !== null && entry.sessionId === sessionId && entry.update.requestId === requestId;

/** The local request the daemon's gate built, rebuilt from the event. */
export function toPermissionRequest(update: AskUpdate): PermissionRequest {
  if (update.type === "question_request") {
    // A remote agent's question (docs/feat/a2a-client.md C6): a kind auto-accept
    // never answers; the answer is the reply text, bounded by `maxChars`.
    return {
      kind: "question",
      tool: update.agent?.type ?? "question",
      level: "ask",
      title: update.title,
      ...(update.question !== "" ? { detail: update.question } : {}),
      input: {},
      reply: { maxChars: update.maxChars },
    };
  }
  return {
    // A workflow's hash approval / approve step (docs/feat/agent-workflows.md
    // D3): the one kind read off the wire, because it only ever asks MORE — a
    // daemon naming an ordinary ask so makes auto-accept skip it, never answer.
    ...(update.tool === WORKFLOW_APPROVE_TOOL ? { kind: "workflow_approve" as const } : {}),
    // A browser action (docs/feat/browser-inspect.md B5, Q3): same rule, the
    // session's auto-accept never answers acting AS the user on the web.
    ...(update.tool === BROWSER_ACTION_TOOL ? { kind: "browser_action" as const } : {}),
    // A remote agent the model proposed (docs/feat/a2a-client.md C11): same rule.
    ...(update.tool === A2A_ADD_AGENT_TOOL ? { kind: "agent_add" as const } : {}),
    // Publishing a public web page (session apps D3): same rule.
    ...(update.tool === APP_PUBLISH_TOOL ? { kind: "app_publish" as const } : {}),
    // Showing a container to the paired devices (container-apps-devices OD2): same rule.
    ...(update.tool === CONTAINER_PREVIEW_TOOL ? { kind: "container_preview" as const } : {}),
    tool: update.tool,
    level: "ask",
    title: update.title,
    ...(update.explanation ? { detail: update.explanation } : {}),
    input: {},
    ...(update.suggestion ? { suggestion: { prefix: update.suggestion.prefix } } : {}),
    ...(update.reply ? { reply: { maxChars: update.reply.maxChars } } : {}),
  };
}

export class PermissionRouter {
  private current: Entry | null = null;
  private queue: Entry[] = [];
  /** Per session: every request the daemon said is settled (replay dedupe). */
  private readonly resolvedIds = new Map<string, Set<string>>();
  /**
   * Per session: requests answered here whose `permission_resolved` has not
   * arrived yet (the answer may still be in flight, or held while the link is
   * down). A replay that re-offers one is not a second dialog.
   */
  private readonly answeredIds = new Map<string, Set<string>>();

  /**
   * A `permission_request` arrived (live or replayed). `turnId`: the turn the
   * stream raised it in; a background child's ask names its own `turnId`, which
   * wins. Kept until it is asked.
   */
  request(sessionId: string, update: AskUpdate, turnId: string | null = null): RouterAction[] {
    const id = update.requestId;
    if (
      is(this.current, sessionId, id) ||
      this.queue.some((e) => is(e, sessionId, id)) ||
      this.resolvedIds.get(sessionId)?.has(id) ||
      this.answeredIds.get(sessionId)?.has(id)
    ) {
      return [];
    }
    // A background child's ask names its SPAWNING turn: it may arrive outside
    // any turn, or inside an unrelated one (the stream's would be wrong).
    this.queue.push({ sessionId, update, turnId: update.turnId ?? turnId });
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
    this.answeredIds.get(sessionId)?.delete(requestId);
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
    return [...this.decide(entry, response), ...this.next()];
  }

  /**
   * The asks this router is HOLDING for a session: the one on screen and the
   * queued ones, oldest first. Read-only and display-only — a caller may look
   * (to name an ask it means to settle, or to show what is waiting), never
   * decide from it: `answerById` re-validates everything (N1).
   */
  heldIds(sessionId: string): readonly string[] {
    const ids: string[] = [];
    const current = this.current;
    if (current?.sessionId === sessionId) {
      ids.push(current.update.requestId);
    }
    for (const entry of this.queue) {
      if (entry.sessionId === sessionId) {
        ids.push(entry.update.requestId);
      }
    }
    return ids;
  }

  /**
   * An answer given OUTSIDE the prompt (docs/feat/mobile-notifications.md
   * Design 5, owner decision 8: Approve / Deny / Reply from a notification).
   * The ask is settled whether or not it is the one on screen, and no broker
   * requester is involved: the phone's notification path never shows a prompt,
   * so `answered` (which accepts only `current`) cannot serve it.
   *
   * - `current`: the same validation as `answered`, plus an `abort` for the
   *   open prompt — its late `DISMISSED` then finds nothing to settle (the
   *   "withdrawn meanwhile" branch of `answered`), so no second answer is sent.
   * - queued: dropped from the queue and settled the same way.
   * - unknown / already resolved / already answered here: `[]` (nothing is
   *   sent: a stale notification must never decide anything).
   */
  answerById(sessionId: string, requestId: string, response: PermissionResponse): RouterAction[] {
    const entry = this.current;
    const isCurrent = is(entry, sessionId, requestId);
    const queued = isCurrent ? undefined : this.queue.find((e) => is(e, sessionId, requestId));
    const held = isCurrent ? entry : queued;
    if (!held) {
      return [];
    }
    const decided = this.decide(held, response);
    if (!decided.some((a) => a.kind === "send")) {
      // Nothing was sent (an unoffered option, a reply the daemon takes
      // nowhere, a withdrawn/no decision): the ask stays HELD — still pending
      // daemon-side, so the sheet (or a later tap) must still be able to answer
      // it. A stale notification settles nothing.
      return decided;
    }
    if (isCurrent) {
      this.current = null;
      // The prompt on screen (if any) is withdrawn: its late `DISMISSED` then
      // finds nothing to settle (`answered`'s withdrawn branch), so no second
      // answer is sent.
      return [{ kind: "abort", sessionId, requestId }, ...decided, ...this.next()];
    }
    this.queue = this.queue.filter((e) => e !== queued);
    return decided;
  }

  /**
   * What one answer means for one held request: nothing (a withdrawn prompt, or
   * an outcome that is no decision), the refusal to send it (`unoffered`,
   * `unreplyable`), or the `send` — the person's reply only where the daemon
   * takes one. Shared by `answered` (the prompt) and `answerById` (a
   * notification), so both validate a decision the same way.
   */
  private decide(entry: Entry, response: PermissionResponse): RouterAction[] {
    const { sessionId } = entry;
    const requestId = entry.update.requestId;
    if (response.dismissed) {
      return [];
    }
    let optionId: string;
    let message: string | null;
    const update = entry.update;
    if (update.type === "question_request") {
      // A remote question (docs/feat/a2a-client.md C6): `allowed` with a text is
      // the answer; anything else (a refusal, or no text left once normalized)
      // is a skip — never an empty answer sent to the remote.
      message =
        response.allowed && response.message !== undefined
          ? normalizeQuestionAnswer(response.message, update.maxChars)
          : null;
      optionId = message !== null ? QUESTION_ANSWER_OPTION : QUESTION_SKIP_OPTION;
    } else {
      const outcome = responseToOutcome(response);
      if (outcome.outcome !== "selected") {
        return [];
      }
      optionId = outcome.optionId;
      if (!update.options.some((o) => o.optionId === optionId)) {
        return [{ kind: "unoffered", sessionId, requestId, optionId }];
      }
      // A reply goes only with a refusal (an approval's is ignored), and only
      // where the daemon said it takes one.
      const reply = update.reply;
      // Blank once normalized: a plain No (owner Q2).
      message =
        !response.allowed && response.message !== undefined
          ? normalizePermissionReply(response.message, reply?.maxChars ?? Number.POSITIVE_INFINITY)
          : null;
      if (message !== null && !reply) {
        return [{ kind: "unreplyable", sessionId, requestId }];
      }
    }
    const answeredIds = this.answeredIds.get(sessionId);
    if (answeredIds?.has(requestId)) {
      return []; // already answered here: a duplicate tap decides nothing
    }
    let answered = answeredIds;
    if (!answered) {
      answered = new Set();
      this.answeredIds.set(sessionId, answered);
    }
    answered.add(requestId);
    return [
      {
        kind: "send",
        sessionId,
        requestId,
        optionId,
        ...(message !== null ? { message } : {}),
        ...(update.type === "question_request" ? { question: true as const } : {}),
      },
    ];
  }

  /**
   * An answer could not be delivered (not "answered elsewhere": a real
   * failure): the request may still be pending daemon-side, so a later replay
   * must offer it again.
   */
  answerFailed(sessionId: string, requestId: string): void {
    this.answeredIds.get(sessionId)?.delete(requestId);
  }

  /** The session ended (`session_closed`): its prompts can no longer be answered. */
  sessionClosed(sessionId: string): RouterAction[] {
    this.resolvedIds.delete(sessionId);
    this.answeredIds.delete(sessionId);
    this.queue = this.queue.filter((e) => e.sessionId !== sessionId);
    const entry = this.current;
    if (entry?.sessionId === sessionId) {
      this.current = null;
      return [{ kind: "abort", sessionId, requestId: entry.update.requestId }, ...this.next()];
    }
    return [];
  }

  /**
   * The session was resynced: keep only the requests the replay re-offers
   * (`ids`), withdraw the rest — answered or cancelled while this client was
   * away, or minted by a previous incarnation of the session (a `serve`
   * restart re-asks under a fresh id). The kept ones are deduped when the
   * replay re-offers them, so their dialog is not shown twice.
   */
  retainOnly(sessionId: string, ids: readonly string[]): RouterAction[] {
    const keep = (e: Entry): boolean =>
      e.sessionId !== sessionId || ids.includes(e.update.requestId);
    this.queue = this.queue.filter(keep);
    const answered = this.answeredIds.get(sessionId);
    for (const id of answered ?? []) {
      if (!ids.includes(id)) answered?.delete(id); // gone: nothing left to dedupe
    }
    const entry = this.current;
    if (entry && !keep(entry)) {
      this.current = null;
      return [{ kind: "abort", sessionId, requestId: entry.update.requestId }, ...this.next()];
    }
    return [];
  }

  /** The connection closed: nothing can be answered on it (a re-attach replays). */
  connectionClosed(): RouterAction[] {
    this.queue = [];
    this.answeredIds.clear();
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
    // Both ask updates carry a workflow: a remote question raised inside a
    // workflow step keeps its run attribution (docs/fix/a2a-question-workflow-label.md).
    const workflow = entry.update.workflow;
    return [
      {
        kind: "prompt",
        sessionId: entry.sessionId,
        requestId: entry.update.requestId,
        request: toPermissionRequest(entry.update),
        ...(entry.turnId !== null ? { turnId: entry.turnId } : {}),
        ...(entry.update.agent
          ? {
              // Forgeable by a pod: bounded, stripped, display only.
              agent: {
                type: progressText(entry.update.agent.type),
                description: progressText(entry.update.agent.description),
                ...(entry.update.agent.id !== undefined
                  ? { id: progressText(entry.update.agent.id) }
                  : {}),
              },
            }
          : {}),
        ...(workflow
          ? {
              workflow: {
                name: progressText(workflow.name),
                ...(workflow.runId !== undefined ? { runId: progressText(workflow.runId) } : {}),
                ...(workflow.stepId !== undefined ? { stepId: progressText(workflow.stepId) } : {}),
                // A pod's number: only finite ones go on (the wire may not bound them).
                ...(Number.isFinite(workflow.index) ? { index: workflow.index } : {}),
                ...(Number.isFinite(workflow.count) ? { count: workflow.count } : {}),
              },
            }
          : {}),
        ...(entry.update.askedOn !== undefined && entry.update.askedOn.length > 0
          ? {
              askedOn: entry.update.askedOn
                .map((label) => progressText(label))
                .filter((l) => l !== ""),
            }
          : {}),
      },
    ];
  }
}
