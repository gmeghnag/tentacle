/**
 * Display state model + pure reducer.
 *
 * Translates the agent's `AgentEvent` stream into a flat list of display items
 * (the transcript), token totals, and timing anchors. The TUI renders this list
 * itself into a virtualized scroll buffer (see `render-lines.ts`), so — unlike
 * an Ink `<Static>` approach — there is no committed/active split here: the last
 * item may still be streaming. Keeping the reducer pure makes the whole UI
 * logic testable without React.
 */
import type { AgentEvent, AgentStopReason } from "@tentacle/agent";
import type { ChatMessage, ToolResult, ToolResultDetail, ToolResultSpill } from "@tentacle/core";
import { messagesToItems } from "./resume.ts";

export type ToolStatus = "running" | "ok" | "error";

export interface UserItem {
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly text: string;
  /**
   * A command's reply (`/mcp`, `/model`, …), rendered like the model's text.
   * Model text never extends it: a notice can land mid-reply (or, for an async
   * one like `/mcp`, after the next prompt started), so the next chunk opens a
   * new item instead of merging into the notice.
   */
  readonly notice?: true;
}

/** A standalone system line (e.g. a background job finishing). */
export interface NoticeItem {
  readonly kind: "notice";
  readonly text: string;
  /** Identifies a background-job notice so the live + event paths dedupe. */
  readonly jobId?: string;
}

/** Live progress of a sub-agent spawned by an `agent_task` tool call. */
export interface SubAgentProgress {
  readonly agentType: string;
  readonly description: string;
  /** Child tool-call labels, newest last (capped). */
  readonly activities: readonly string[];
  readonly toolUses: number;
  readonly done: boolean;
}

export interface ToolItem {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly status: ToolStatus;
  readonly resultText?: string;
  readonly detail?: ToolResultDetail;
  /** A user hook blocked this call or rewrote its input (H1, docs/feat/hooks-core.md). */
  readonly hook?: ToolResult["hook"];
  /** The result was spilled: shown as a short note, not the model's banner (docs/feat/tui-spill-note.md). */
  readonly spill?: ToolResultSpill;
  /** The daemon-measured run time; absent when the tool never ran or the record predates it (docs/fix/tool-duration.md). */
  readonly durationMs?: number;
  /** Set when this tool call is a sub-agent (`agent_task`) with nested progress. */
  readonly sub?: SubAgentProgress;
}

export type DisplayItem = UserItem | AssistantItem | ToolItem | NoticeItem;

export interface TokenTotals {
  readonly prompt: number;
  readonly completion: number;
}

export interface DisplayState {
  /** The transcript, oldest first. The final item may still be streaming. */
  readonly items: readonly DisplayItem[];
  readonly running: boolean;
  readonly reasoning: boolean;
  readonly reasoningStartedAt: number | null;
  readonly turnStartedAt: number | null;
  readonly sessionTokens: TokenTotals;
  readonly lastTurnTokens: TokenTotals | null;
  readonly lastStopReason: AgentStopReason | null;
}

export const initialState: DisplayState = {
  items: [],
  running: false,
  reasoning: false,
  reasoningStartedAt: null,
  turnStartedAt: null,
  sessionTokens: { prompt: 0, completion: 0 },
  lastTurnTokens: null,
  lastStopReason: null,
};

function append(items: readonly DisplayItem[], item: DisplayItem): DisplayItem[] {
  return [...items, item];
}

/** Build the display notice for a finished background job. */
export function backgroundExitNotice(
  jobId: string,
  command: string,
  status: string,
  exitCode: number | null,
): NoticeItem {
  const code = exitCode !== null ? ` (exit=${exitCode})` : "";
  return { kind: "notice", jobId, text: `background job ${jobId} ${status}${code}: ${command}` };
}

/** Append a standalone system notice (e.g. a failed session save). */
export function appendNotice(state: DisplayState, text: string): DisplayState {
  return { ...state, items: append(state.items, { kind: "notice", text }) };
}

/**
 * Append a background-job notice, unless one for the same job is already shown
 * — the live `JobController` subscription and the agent's `background_exit`
 * event both surface the same exit, whichever arrives first.
 */
export function appendBackgroundExit(state: DisplayState, notice: NoticeItem): DisplayState {
  if (notice.jobId && state.items.some((i) => i.kind === "notice" && i.jobId === notice.jobId)) {
    return state;
  }
  return { ...state, items: append(state.items, notice) };
}

/** Max child activity lines retained for a sub-agent's nested progress tree. */
const SUB_ACTIVITY_CAP = 50;

const EMPTY_SUB: SubAgentProgress = {
  agentType: "sub-agent",
  description: "",
  activities: [],
  toolUses: 0,
  done: false,
};

/** Replace a tool item (by id) via `fn`; a no-op if it isn't found. */
function updateTool(
  state: DisplayState,
  id: string,
  fn: (tool: ToolItem) => ToolItem,
): DisplayState {
  const idx = state.items.findIndex((i) => i.kind === "tool" && i.id === id);
  const item = idx >= 0 ? state.items[idx] : undefined;
  if (!item || item.kind !== "tool") {
    return state;
  }
  const items = state.items.slice();
  items[idx] = fn(item);
  return { ...state, items };
}

/** End a turn abnormally (e.g. a model/network error), surfacing a message. */
export function failTurn(state: DisplayState, message: string, _now: number): DisplayState {
  return {
    ...state,
    items: append(state.items, { kind: "assistant", text: `⚠ ${message}` }),
    running: false,
    reasoning: false,
    reasoningStartedAt: null,
  };
}

/** Begin a new turn: append the user's message and mark the turn running. */
export function startTurn(state: DisplayState, text: string, now: number): DisplayState {
  return {
    ...state,
    items: append(state.items, { kind: "user", text }),
    running: true,
    reasoning: false,
    reasoningStartedAt: null,
    turnStartedAt: now,
    lastStopReason: null,
  };
}

/**
 * Begin an autonomous continuation turn: mark the turn running WITHOUT appending
 * a user message (there is no user input — the agent is reacting to a
 * background-job exit injected server-side at turn start).
 */
export function startContinuation(state: DisplayState, now: number): DisplayState {
  return {
    ...state,
    running: true,
    reasoning: false,
    reasoningStartedAt: null,
    turnStartedAt: now,
    lastStopReason: null,
  };
}

/**
 * An own prompt lost the slot before its turn streamed anything (another
 * device's turn took it, docs/feat/tui-foreign-turns.md C3): its bubble —
 * `item`, the object `startTurn` appended, removed by IDENTITY, never by text
 * — goes, and the turn is not running. A reset meanwhile already replaced it:
 * nothing to remove.
 */
export function withdrawUserTurn(state: DisplayState, item: DisplayItem | undefined): DisplayState {
  return {
    ...state,
    items: item === undefined ? state.items : state.items.filter((i) => i !== item),
    running: false,
    reasoning: false,
    reasoningStartedAt: null,
  };
}

/**
 * A foreign turn's stream closed with no end (it ended behind a resync's cut):
 * idle, with NO stop reason — its outcome is unknown here and never guessed.
 */
export function endWithoutOutcome(state: DisplayState): DisplayState {
  return {
    ...state,
    running: false,
    reasoning: false,
    reasoningStartedAt: null,
    lastStopReason: null,
  };
}

/** Append a command's reply (see `AssistantItem.notice`). */
export function pushNoticeItem(state: DisplayState, text: string): DisplayState {
  return { ...state, items: append(state.items, { kind: "assistant", text, notice: true }) };
}

/** Fold one agent event into the display state. */
export function applyEvent(state: DisplayState, event: AgentEvent, now: number): DisplayState {
  switch (event.type) {
    case "text": {
      const last = state.items.at(-1);
      if (last && last.kind === "assistant" && !last.notice) {
        const items = state.items.slice(0, -1);
        items.push({ kind: "assistant", text: last.text + event.delta });
        return { ...state, items, reasoning: false };
      }
      return {
        ...state,
        items: append(state.items, { kind: "assistant", text: event.delta }),
        reasoning: false,
      };
    }

    case "reasoning":
      return {
        ...state,
        reasoning: true,
        reasoningStartedAt: state.reasoningStartedAt ?? now,
      };

    case "tool_start": {
      const tool: ToolItem = {
        kind: "tool",
        id: event.id,
        name: event.name,
        args: event.arguments,
        status: "running",
      };
      return { ...state, items: append(state.items, tool), reasoning: false };
    }

    case "tool_result": {
      const idx = state.items.findIndex((i) => i.kind === "tool" && i.id === event.id);
      const base: ToolItem =
        idx >= 0 && state.items[idx]?.kind === "tool"
          ? (state.items[idx] as ToolItem)
          : {
              kind: "tool",
              id: event.id,
              name: event.name,
              args: "",
              status: "running",
            };
      const finished: ToolItem = {
        ...base,
        status: event.result.isError ? "error" : "ok",
        resultText: event.result.content,
        // The daemon's value only, never this client's receipt time (docs/fix/tool-duration.md).
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.result.details ? { detail: event.result.details } : {}),
        ...(event.result.hook ? { hook: event.result.hook } : {}),
        ...(event.result.spill ? { spill: event.result.spill } : {}),
      };
      const items = state.items.slice();
      if (idx >= 0) {
        items[idx] = finished;
      } else {
        items.push(finished);
      }
      return { ...state, items };
    }

    case "usage": {
      const sessionTokens: TokenTotals = {
        prompt: state.sessionTokens.prompt + event.usage.promptTokens,
        completion: state.sessionTokens.completion + event.usage.completionTokens,
      };
      return {
        ...state,
        sessionTokens,
        lastTurnTokens: {
          prompt: event.usage.promptTokens,
          completion: event.usage.completionTokens,
        },
      };
    }

    case "subagent_start":
      return updateTool(state, event.id, (t) => ({
        ...t,
        sub: {
          agentType: event.agentType,
          description: event.description,
          activities: [],
          toolUses: 0,
          done: false,
        },
      }));

    case "subagent_tool":
      return updateTool(state, event.id, (t) => {
        const prev = t.sub ?? EMPTY_SUB;
        return {
          ...t,
          sub: {
            ...prev,
            activities: [...prev.activities, event.label].slice(-SUB_ACTIVITY_CAP),
            toolUses: prev.toolUses + 1,
          },
        };
      });

    case "subagent_end":
      return updateTool(state, event.id, (t) => ({
        ...t,
        sub: { ...(t.sub ?? EMPTY_SUB), toolUses: event.toolUses, done: true },
      }));

    case "background_exit":
      return appendBackgroundExit(
        state,
        backgroundExitNotice(event.jobId, event.command, event.status, event.exitCode),
      );

    case "steer":
      // A queued message was injected into the running turn; show it as a user
      // turn at the point it entered the conversation.
      return { ...state, items: append(state.items, { kind: "user", text: event.text }) };

    // A user hook's note is shown, dimmed (R1, docs/feat/hooks-turn.md): a
    // user must see what their hooks injected. The loop's own notes (the
    // nudge, a background note — the exit itself renders from
    // `background_exit`) stay hidden.
    case "context_note":
      return event.reason === "hook" ? appendNotice(state, event.text) : state;

    // A daemon-side bookkeeping marker: nothing to render.
    case "history_commit":
      return state;

    case "turn_end":
      return {
        ...state,
        running: false,
        reasoning: false,
        reasoningStartedAt: null,
        lastStopReason: event.reason,
      };
  }
}

/**
 * What a session yields to the App: the agent's events, plus two that only a
 * remote session produces after a reconnect that had to resync — replace the
 * transcript with the daemon's history, and the turn's own prompt re-delivered
 * after that reset (docs/feat/client-reattach.md). Same shape as
 * `@tentacle/client`'s `SessionEvent`.
 */
export type SessionEvent =
  | AgentEvent
  | { readonly type: "history_reset"; readonly messages: readonly ChatMessage[] }
  | { readonly type: "user_message"; readonly text: string }
  /** A newer daemon's update type this client does not know (once per type per session). */
  | { readonly type: "unsupported"; readonly kind: string };

/** The notice for an update type this client does not know. */
export function unsupportedNotice(kind: string): string {
  return `the daemon uses features newer than this client (\`${kind}\`): update tentacle`;
}

/**
 * Replace the transcript with `messages` (a resync), keeping the turn's state.
 * A call with no result in a turn that is still running is running (or waiting
 * for approval), not done — `messagesToItems` marks every historical call `ok`.
 */
export function resetHistory(state: DisplayState, messages: readonly ChatMessage[]): DisplayState {
  const items = messagesToItems(messages).map((item) =>
    state.running && item.kind === "tool" && item.resultText === undefined
      ? { ...item, status: "running" as const }
      : item,
  );
  return { ...state, items };
}

/** Fold one session event: the two reconnect events here, everything else in `applyEvent`. */
export function applySessionEvent(
  state: DisplayState,
  event: SessionEvent,
  now: number,
): DisplayState {
  if (event.type === "history_reset") {
    return resetHistory(state, event.messages);
  }
  if (event.type === "user_message") {
    return { ...state, items: append(state.items, { kind: "user", text: event.text }) };
  }
  if (event.type === "unsupported") {
    return appendNotice(state, unsupportedNotice(event.kind));
  }
  return applyEvent(state, event, now);
}
