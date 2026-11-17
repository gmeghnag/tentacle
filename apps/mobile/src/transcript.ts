import type { EndReason, SessionEvent } from "@tentacle/client";
/**
 * The transcript model (docs/feat/mobile-session-view.md 12b): a pure fold from
 * what a session yields into the ROWS a virtualised `FlatList` renders.
 *
 * Same semantics as the TUI's fold (`packages/tui/src/state.ts`), pinned to it
 * by `test/transcript-parity.test.ts` on shared fixtures — the phone owns its
 * fold (Owner Q5), and this module is the one place its behaviour is decided
 * (AGENTS §7 "logic lives in pure modules": a component only renders rows).
 *
 * Inputs are exactly what a `RemoteSession` gives a consumer: its
 * `SessionEvent`s, its `history` activity, the turn bracket, the link status and
 * the session's end. No React, no client, no I/O.
 */
import type { AttachmentRef, ChatMessage, ToolDiffDetail } from "@tentacle/core";
import { describeEmptyTurn, describeRepairs, describeTruncation, toolLabel } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { historyRows, restartPromptOf } from "./transcript-history.ts";
import {
  type ImageRef,
  type LocalPhoto,
  type Row,
  type SubProgress,
  type ToolRow,
  type ToolStatus,
  type TurnRow,
  imageRef,
  imageRefWithLocal,
} from "./transcript-rows.ts";

export type {
  AssistantRow,
  ImageRef,
  LocalPhoto,
  NoticeRow,
  ReasoningRow,
  Row,
  SubProgress,
  ToolRow,
  ToolStatus,
  TurnRow,
  UserRow,
} from "./transcript-rows.ts";
export { imageRef, imageRefWithLocal, imageRowText } from "./transcript-rows.ts";
export {
  CONTEXT_RESET_HEADER,
  CONTEXT_RESET_SEPARATOR,
  restartPromptOf,
} from "./transcript-history.ts";

/** A turn's outcome, as `turn_end` / a cut stream gives it. */
export type TurnOutcome = "ended" | "cancelled" | "interrupted" | "lost" | "failed";

/**
 * The agent's own events, derived from `SessionEvent` instead of naming
 * `@tentacle/agent`'s `AgentEvent`: the app package must not reference the agent
 * at all (plan P8 — the TUI's `resume.ts` pulling it at runtime is exactly what
 * this slice avoids), and the client's union already contains them.
 */
type StreamEvent = Exclude<
  SessionEvent,
  { readonly type: "history_reset" | "user_message" | "unsupported" }
>;

/**
 * What the fold takes. The `SessionEvent` members stand on their own (the same
 * objects a `RemoteSession` yields); the rest are the session-level facts a
 * client raises beside the turn stream.
 */
export type TranscriptInput =
  | SessionEvent
  | {
      readonly type: "history";
      readonly messages: readonly ChatMessage[];
      /** The barrier that caused it (`RemoteSession`'s activity reason). */
      readonly reason: "compact" | "context_reset" | "clear" | null;
      /** This client caused the compaction: another device's notice is not ours. */
      readonly own?: true;
    }
  /**
   * This phone's OWN prompt, folded before the daemon re-delivers it (a
   * `user_message` the client never sends back to its sender). `photos` is the
   * LOCAL copy of each ref this phone just uploaded (item 2): the only pixels
   * that exist for a fresh send (`thumbnails.ts:19-25` — no read-back method).
   */
  | {
      readonly type: "own_prompt";
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
      readonly photos?: readonly LocalPhoto[];
    }
  | { readonly type: "turn_started"; readonly turnId: string; readonly own: boolean }
  | {
      readonly type: "turn_ended";
      readonly outcome: TurnOutcome;
      /** The failure's own words (for `failed`). */
      readonly message?: string;
    }
  | { readonly type: "closed"; readonly reason: EndReason }
  | { readonly type: "link"; readonly status: "up" | "down" };

/** A turn's token figures (the TUI's shape, `state.ts`'s `TokenTotals`). */
export interface TokenTotals {
  readonly prompt: number;
  readonly completion: number;
}

/**
 * The fold's state. `rows` is the transcript (oldest first; the last row may
 * still be streaming); `turn` is the running bracket, which the screen draws as
 * its indicator — one place decides it, and no row is a moving target for a
 * virtualised list's keys.
 */
export interface State {
  readonly rows: readonly Row[];
  readonly turn: TurnRow | null;
  readonly link: "up" | "down";
  /** The session ended daemon-side: rows stay, nothing new arrives. */
  readonly closed: EndReason | null;
  /** Update kinds already reported (one notice per kind, ever). */
  readonly unsupported: readonly string[];
  /**
   * This session's token totals as its turns measured them (`agent_usage`).
   * They are the SESSION's, not this history's: a replaced history keeps them
   * (docs/feat/mobile-session-info.md, the TUI's `sessionTokens`).
   */
  readonly sessionTokens: TokenTotals;
  /**
   * The last measured turn's figures — its `prompt` is the CONTEXT FILL, which is
   * what the header's bar shows. `null` until a turn measures one, and after a
   * replaced history (it described the chat that was dropped).
   */
  readonly lastTurnTokens: TokenTotals | null;
  /** Row-key counter: monotonic, never reused. */
  readonly seq: number;
}

export const initialState: State = {
  rows: [],
  turn: null,
  link: "up",
  closed: null,
  unsupported: [],
  sessionTokens: { prompt: 0, completion: 0 },
  lastTurnTokens: null,
  seq: 0,
};

/** The notice for an update type this client does not know (the TUI's wording). */
export function unsupportedNotice(kind: string): string {
  return `the daemon uses features newer than this client (\`${kind}\`): update tentacle`;
}

/** Another device compacted the conversation: said once, the transcript kept. */
export const FOREIGN_COMPACTED_NOTICE = "_the conversation was compacted on another device_";

/** A turn whose stream ended with no outcome: unknown here, never guessed. */
export const TURN_INTERRUPTED_NOTICE = "_that turn was interrupted before it finished_";

/** A turn whose stream vanished (a cut link): what arrived is what is shown. */
export const TURN_LOST_NOTICE = "_that turn's stream was lost — what reached the phone is shown_";

/** How a session that ended elsewhere reads (the screen's banner carries the state). */
export function closedNotice(reason: EndReason): string {
  if (reason === "gone") {
    return "_this session ended on the daemon while the link was down_";
  }
  return reason === "deleted"
    ? "_this session was deleted on another device_"
    : "_this session was closed on another device_";
}

/** A tool row's status after a phase signal: a settled row never moves (the TUI's rule). */
export function nextToolStatus(current: ToolStatus, phase: "queued" | "running"): ToolStatus {
  if (current === "ok" || current === "error" || current === "denied") {
    return current;
  }
  return phase;
}

function keyOf(state: State): string {
  return `r${state.seq + 1}`;
}

function push(state: State, make: (key: string) => Row): State {
  return { ...state, rows: [...state.rows, make(keyOf(state))], seq: state.seq + 1 };
}

/** Append `rows`, minting each key from the state's counter (one bump per row). */
function append(state: State, build: (nextKey: () => string) => readonly Row[]): State {
  let seq = state.seq;
  const rows = build(() => {
    seq += 1;
    return `r${seq}`;
  });
  return { ...state, rows: [...state.rows, ...rows], seq };
}

/** The last row, when it is the kind a delta can extend. */
function lastTextRow<T extends "assistant" | "reasoning">(
  state: State,
  kind: T,
): (Row & { kind: T }) | undefined {
  const last = state.rows[state.rows.length - 1];
  return last !== undefined && last.kind === kind ? (last as Row & { kind: T }) : undefined;
}

/** The local copies by the ref id they became (empty when there are none). */
function photosById(photos: readonly LocalPhoto[] | undefined): ReadonlyMap<string, LocalPhoto> {
  return new Map((photos ?? []).map((photo) => [photo.id, photo]));
}

/** Fold one input into the transcript. */
export function apply(state: State, input: TranscriptInput): State {
  switch (input.type) {
    case "history":
      return applyHistory(state, input);
    case "turn_started":
      return startTurn(state, input.turnId, input.own);
    case "turn_ended":
      return endTurn(state, input);
    case "closed":
      return push({ ...state, closed: input.reason }, (key) => ({
        kind: "notice",
        key,
        text: closedNotice(input.reason),
      }));
    case "link":
      return state.link === input.status ? state : { ...state, link: input.status };
    case "history_reset":
      // A reset REPLACED the history (the branch below appends): the measured
      // fill goes with it, the session's totals stay.
      return apply(
        { ...state, lastTurnTokens: null },
        { type: "history", messages: input.messages, reason: null },
      );
    case "own_prompt":
      // The phone's own message: the refs AND the local files behind them, so
      // the bubble shows the photo that was just sent (item 2).
      return push(state, (key) => ({
        kind: "user",
        key,
        text: input.text,
        images: (input.attachments ?? []).map(
          (ref): ImageRef => imageRefWithLocal(ref, photosById(input.photos).get(ref.id)),
        ),
      }));
    case "user_message":
      return push(state, (key) => ({
        kind: "user",
        key,
        text: input.text,
        images: (input.attachments ?? []).map((ref): ImageRef => imageRef(ref)),
        // The fired turn's own ref (docs/feat/cron-tool.md S6, M8): display data
        // the client already trust-gated and sanitized, carried as sent. Absent
        // for every ordinary prompt and after a reload (option A).
        ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      }));
    case "unsupported":
      return applyUnsupported(state, input.kind);
    default:
      return applyAgentEvent(state, input);
  }
}

/** Begin a turn: the bracket the screen draws as its running indicator. */
export function startTurn(state: State, turnId: string, own: boolean): State {
  return {
    ...state,
    turn: { kind: "turn", key: keyOf(state), turnId, own },
    seq: state.seq + 1,
  };
}

/** End a turn: the bracket goes; an outcome nobody stated becomes a notice. */
export function endTurn(
  state: State,
  input: Extract<TranscriptInput, { type: "turn_ended" }>,
): State {
  const base: State = { ...state, turn: null };
  const notice = outcomeNotice(input);
  return notice === null ? base : push(base, (key) => ({ kind: "notice", key, text: notice }));
}

function outcomeNotice(input: Extract<TranscriptInput, { type: "turn_ended" }>): string | null {
  switch (input.outcome) {
    case "interrupted":
      return TURN_INTERRUPTED_NOTICE;
    case "lost":
      return TURN_LOST_NOTICE;
    case "failed":
      return `⚠ ${input.message !== undefined && input.message !== "" ? input.message : "the turn failed"}`;
    default:
      return null; // ended / cancelled: the transcript says what happened
  }
}

function applyUnsupported(state: State, kind: string): State {
  if (state.unsupported.includes(kind)) {
    return state;
  }
  const next = { ...state, unsupported: [...state.unsupported, kind] };
  return push(next, (key) => ({ kind: "notice", key, text: unsupportedNotice(kind) }));
}

/** Append the daemon's history after what is shown (a context reset keeps the old transcript). */
function appendHistory(state: State, messages: readonly ChatMessage[]): State {
  return append(state, (nextKey) => historyRows(messages, nextKey));
}

/** The daemon's history replaced what is shown (a resync, `/clear`, a fresh attach). */
function withHistory(state: State, messages: readonly ChatMessage[]): State {
  // The measured fill described the chat this replace just dropped: forgotten,
  // or the header's bar would sit at the old conversation's figure for ever
  // (the TUI's `forgetContextFill`, `packages/tui/src/state.ts:645-654`).
  return append({ ...state, rows: [], lastTurnTokens: null }, (nextKey) =>
    historyRows(messages, nextKey),
  );
}

function applyHistory(state: State, input: Extract<TranscriptInput, { type: "history" }>): State {
  if (input.reason === "context_reset") {
    // The old transcript stays; the new history follows it (decision 9).
    return appendHistory(state, input.messages);
  }
  if (input.reason === "compact") {
    // The transcript stays; another device's compaction says so once.
    return input.own === true
      ? state
      : push(state, (key) => ({ kind: "notice", key, text: FOREIGN_COMPACTED_NOTICE }));
  }
  return withHistory(state, input.messages);
}

/** Fold one `StreamEvent` (the turn's own stream, from here or another device). */
function applyAgentEvent(state: State, event: StreamEvent): State {
  switch (event.type) {
    case "text": {
      const last = lastTextRow(state, "assistant");
      if (last !== undefined) {
        return {
          ...state,
          rows: [
            ...state.rows.slice(0, -1),
            {
              ...last,
              text: last.text + event.delta,
              version: last.text.length + event.delta.length,
            },
          ],
        };
      }
      return push(state, (key) => ({
        kind: "assistant",
        key,
        text: event.delta,
        version: event.delta.length,
      }));
    }
    case "reasoning": {
      const last = lastTextRow(state, "reasoning");
      if (last !== undefined) {
        return {
          ...state,
          rows: [
            ...state.rows.slice(0, -1),
            {
              ...last,
              text: last.text + event.delta,
              version: last.text.length + event.delta.length,
            },
          ],
        };
      }
      return push(state, (key) => ({
        kind: "reasoning",
        key,
        text: event.delta,
        version: event.delta.length,
      }));
    }
    case "tool_start":
      return pushTool(state, (key) => ({
        kind: "tool",
        key,
        id: event.id,
        name: event.name,
        label: toolLabel(event.name),
        args: event.arguments,
        status: "running",
      }));
    case "tool_phase":
      return updateTool(state, event.id, (row) => {
        const status = nextToolStatus(row.status, event.phase);
        return status === row.status ? row : { ...row, status };
      });
    case "tool_result":
      return applyToolResult(state, event);
    // The daemon's OWN explanation for something the person would otherwise see
    // as a silent anomaly. Each is a notice, as in the TUI: dropping one hides
    // why a reply was cut, why the history was repaired, or that a turn produced
    // nothing at all (plan F20's sibling rule — never silent on what a client
    // must act on).
    case "truncated_reply": {
      // A re-asked round repeats its cause: said ONCE per turn, as the TUI does
      // (`noticeSeenThisTurn`) — a re-ask that cuts again has its own wording,
      // so the dedupe is by TEXT, never by kind.
      const text = describeTruncation(event.reason, {
        answered: hasAnswerText(state),
        retrying: event.retrying,
      });
      return noticeSeenThisTurn(state, text) ? state : pushNotice(state, text);
    }
    case "empty_turn":
      return pushNotice(state, describeEmptyTurn());
    case "history_repaired":
      return pushNotice(state, describeRepairs(event));
    case "dsml_leak":
      return pushNotice(state, event.text);
    case "context_note":
      // Only a HOOK's note is shown (the loop's own nudge and background note
      // reach the model, not the person).
      return event.reason === "hook" ? pushNotice(state, event.text) : state;
    case "steer":
      // A queued message was injected mid-turn: it belongs in the transcript at
      // the point it entered the conversation.
      return push(state, (key) => ({ kind: "user", key, text: event.text, images: [] }));
    case "history_commit":
      // A bookkeeping marker: nothing to show.
      return state;
    case "usage": {
      // The turn's token figures (docs/feat/mobile-session-info.md Owner
      // decision 4): the header's context bar shows the FILL (`prompt`), and the
      // session's counters accumulate — the same rule as the TUI's fold
      // (`packages/tui/src/state.ts:485-497`), pinned by `transcript-parity`.
      return {
        ...state,
        sessionTokens: {
          prompt: state.sessionTokens.prompt + event.usage.promptTokens,
          completion: state.sessionTokens.completion + event.usage.completionTokens,
        },
        lastTurnTokens: {
          prompt: event.usage.promptTokens,
          completion: event.usage.completionTokens,
        },
      };
    }
    case "context_reset":
      // The model renewed its context mid-turn: the old transcript stays, the
      // new history follows it.
      return appendHistory(state, event.messages);
    // A foreground sub-agent's progress, on its `agent_task` row — the TUI's
    // rules (`packages/tui/src/state.ts`). Dropping these made a long, legitimate
    // child look like a hang (docs/fix/mobile-chat-glitches.md, item 10). An
    // unknown call id is a no-op (`updateTool`).
    case "subagent_start":
      return updateTool(state, event.id, (row) => ({ ...row, sub: EMPTY_SUB }));
    case "subagent_usage":
      return updateTool(state, event.id, (row) => {
        const prev = row.sub ?? EMPTY_SUB;
        return {
          ...row,
          sub: { ...prev, tokens: prev.tokens + event.promptTokens + event.completionTokens },
        };
      });
    case "subagent_tool":
      return updateTool(state, event.id, (row) => {
        const prev = row.sub ?? EMPTY_SUB;
        return {
          ...row,
          sub: {
            ...prev,
            activities: [...prev.activities, subLabel(event.label)].slice(-SUB_ACTIVITY_CAP),
            toolUses: prev.toolUses + 1,
          },
        };
      });
    case "subagent_end":
      return updateTool(state, event.id, (row) => ({
        ...row,
        sub: {
          ...(row.sub ?? EMPTY_SUB),
          toolUses: event.toolUses,
          done: true,
          stopReason: event.stopReason,
          ...(event.agentId !== undefined ? { movedTo: event.agentId } : {}),
        },
      }));
    default:
      // Background exits, `turn_end`: the phone has no job dock in this slice
      // (later tasks decide it) — and neither is a silent drop, since each is
      // either a counter or (for `turn_end`) the turn bracket's job.
      return state;
  }
}

/** Append a standalone notice (the TUI's `appendNotice`, same wording). */
function pushNotice(state: State, text: string): State {
  return push(state, (key) => ({ kind: "notice", key, text }));
}
/** Whether this turn's MODEL text reached the screen (a cut reply with none must not claim an answer). */
function hasAnswerText(state: State): boolean {
  const at = state.rows.findLastIndex((row) => row.kind === "user");
  return state.rows
    .slice(at + 1)
    .some((row) => (row.kind === "assistant" && row.text.trim() !== "") || row.kind === "tool");
}

/** Whether this turn already carries a notice with this exact text (`noticeSeenThisTurn`). */
function noticeSeenThisTurn(state: State, text: string): boolean {
  const at = state.rows.findLastIndex((row) => row.kind === "user");
  return state.rows.slice(at + 1).some((row) => row.kind === "notice" && row.text === text);
}

function pushTool(state: State, make: (key: string) => ToolRow): State {
  return push(state, make);
}

/**
 * How many sub-agent activities a row keeps. The phone draws only the latest
 * (the TUI's panel lists more: its cap is 50), so 3 bounds a long child's row.
 */
export const SUB_ACTIVITY_CAP = 3;
/** A sub-agent label's longest (the client already strips and bounds it: belt and braces). */
export const SUB_LABEL_MAX = 120;

const EMPTY_SUB: SubProgress = { activities: [], toolUses: 0, tokens: 0, done: false };

function subLabel(label: string): string {
  return label.length > SUB_LABEL_MAX ? `${label.slice(0, SUB_LABEL_MAX - 1)}…` : label;
}

/** A result lands on its call's row (a result with no call opens one: never dropped). */
function applyToolResult(
  state: State,
  event: Extract<StreamEvent, { type: "tool_result" }>,
): State {
  const at = state.rows.findLastIndex((row) => row.kind === "tool" && row.id === event.id);
  // A diff and an artifact are the two details an own card carries; each stays
  // in its own field (`diff` opens below the row, `artifact` IS the card).
  const settled: ToolDiffDetail | undefined =
    event.result.details?.kind === "diff" ? event.result.details : undefined;
  const artifact: ArtifactMeta | undefined =
    event.result.details?.kind === "artifact" ? event.result.details.artifact : undefined;
  const update = (row: ToolRow): ToolRow => ({
    ...row,
    // A refusal with a reply is its own status (the TUI shows `✗ Denied · <text>`).
    status:
      event.result.denialReply !== undefined
        ? "denied"
        : event.result.isError === true
          ? "error"
          : "ok",
    output: event.result.content,
    ...(settled !== undefined ? { diff: settled } : {}),
    ...(artifact !== undefined ? { artifact } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.result.hook !== undefined ? { hook: event.result.hook } : {}),
    ...(event.result.spill !== undefined ? { spill: event.result.spill } : {}),
    ...(event.result.denialReply !== undefined ? { denialReply: event.result.denialReply } : {}),
  });
  if (at >= 0) {
    const row = state.rows[at] as ToolRow;
    const rows = [...state.rows];
    rows[at] = update(row);
    return { ...state, rows };
  }
  return push(state, (key) =>
    update({
      kind: "tool",
      key,
      id: event.id,
      name: event.name,
      label: toolLabel(event.name),
      args: "",
      status: "running",
    }),
  );
}

/** Replace a tool row (by id) via `fn`; a no-op when it is not there. */
function updateTool(state: State, id: string, fn: (row: ToolRow) => ToolRow): State {
  const at = state.rows.findLastIndex((row) => row.kind === "tool" && row.id === id);
  if (at < 0) {
    return state;
  }
  const row = state.rows[at] as ToolRow;
  const nextRow = fn(row);
  if (nextRow === row) {
    return state;
  }
  const rows = [...state.rows];
  rows[at] = nextRow;
  return { ...state, rows };
}

/** Whether `text` is a context reset's restart prompt (the history mapper's rule). */
export function isRestartPrompt(text: string): boolean {
  return restartPromptOf(text) !== null;
}
