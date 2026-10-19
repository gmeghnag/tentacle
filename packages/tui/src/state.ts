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
import type { ToolResultDetail } from "@tentacle/core";

export type ToolStatus = "running" | "ok" | "error";

export interface UserItem {
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly text: string;
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
  readonly startedAt: number;
  readonly endedAt?: number;
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

/** Fold one agent event into the display state. */
export function applyEvent(state: DisplayState, event: AgentEvent, now: number): DisplayState {
  switch (event.type) {
    case "text": {
      const last = state.items.at(-1);
      if (last && last.kind === "assistant") {
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
        startedAt: now,
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
              startedAt: now,
            };
      const finished: ToolItem = {
        ...base,
        status: event.result.isError ? "error" : "ok",
        resultText: event.result.content,
        endedAt: now,
        ...(event.result.details ? { detail: event.result.details } : {}),
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

    // A daemon-side bookkeeping marker, and the loop's own notes to the model
    // (the nudge, a background note — the exit itself renders from
    // `background_exit`): nothing to render.
    case "history_commit":
    case "context_note":
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
