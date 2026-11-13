/**
 * The agent loop.
 *
 * One turn drives model/tool rounds until the model stops calling tools
 * (`end_turn`), the caller aborts (`cancelled`), or a safety cap is hit
 * (`max_iterations`):
 *
 *   model.stream → collect text + tool calls
 *     → append the assistant message
 *     → if no tool calls: done
 *     → else run each tool, append its result as a `tool` message, loop
 *
 * `runMessages` operates on a caller-owned (mutable) message list, so a `Session`
 * can keep multi-turn history simply by reusing the same array. The loop is
 * transport-agnostic: it emits `AgentEvent`s a CLI, daemon or test can consume.
 */
import {
  type AgentJobExit,
  type AgentJobs,
  type AgentNotify,
  type AttachmentSource,
  type BackgroundJob,
  COUNT_TOKENS_CAP_MS,
  type ChatMessage,
  type ChatRequest,
  type ContextUsage,
  DSML_REASK_NOTE,
  DsmlToolCallLeakError,
  type ExecutionEnvironment,
  HeuristicTokenCounter,
  type JobController,
  type ModelProvider,
  type ModelStopReason,
  ModelStreamCutError,
  NOTE_KIND,
  type PermissionRequester,
  type TokenCounter,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolProgressEvent,
  type ToolResult,
  type Usage,
  allowAll,
  answerOutstandingCalls,
  countTokensBounded,
  subagentReportNote,
} from "@tentacle/core";
import {
  CONTEXT_RESET_TOOL_NAME,
  SKILL_TOOL_NAME,
  type SkillActivator,
  ToolRegistry,
  skillActivations,
  skillContentName,
  userSkillCall,
} from "@tentacle/tools";
import { type CarriedSkill, carryOverSkills, summarizeConversation } from "./compact.ts";
import {
  type ContextAnchor,
  estimateUsed,
  lastEmitted,
  modelView,
  renderForModel,
  shouldEmit,
} from "./context-awareness.ts";
import {
  contextResetHistory,
  offeredSkillNames,
  resetPromptOf,
  resetRefusal,
  skillSetDelta,
} from "./context-reset.ts";
import { EventQueue } from "./event-queue.ts";
import { type AskHooksTrust, type HookRunner, hookNote } from "./hooks.ts";
import { type GateOutcome, PermissionGate } from "./permission-gate.ts";
import { type ResultTransform, applyResultTransforms } from "./result-pipeline.ts";
import { suspendedCalls } from "./resume.ts";
import {
  type CallState,
  type ExecutionMode,
  classOf,
  dependencies,
  nextRunnable,
  planRound,
  spawnDependencies,
  spawnKindOf,
} from "./round-plan.ts";
import type { SessionGrants } from "./session-grants.ts";
import { EMPTY_SKILL_LISTING, type SkillListing, userRescanListing } from "./session-skills.ts";
import type { ToolOutputSink } from "./tool-output.ts";

export type AgentStopReason = "end_turn" | "cancelled" | "max_iterations" | "max_token_budget";

/**
 * `runMessages` was asked to resume before a tool call the history is not
 * suspended on (`suspendedCalls`). Thrown before anything is yielded, pushed or
 * run: resuming a call that may have been RUNNING would repeat its effects.
 */
export class ResumeShapeError extends Error {
  constructor(readonly toolCallId: string) {
    super(`cannot resume: the history is not suspended before tool call ${toolCallId}`);
    this.name = "ResumeShapeError";
  }
}

/**
 * The user asked for a skill this agent cannot activate for them (unknown, not
 * user-invocable, skills disabled), or for one with nothing to say. Thrown
 * before anything is pushed or yielded.
 */
export class UnknownSkillError extends Error {
  constructor(readonly skill: string) {
    super(`unknown skill "${skill}": not invocable here`);
    this.name = "UnknownSkillError";
  }
}

export interface RunOptions {
  /**
   * Continue a turn suspended before this tool call (a daemon restart): run it
   * and the rest of its round — each through the permission gate again — then
   * the loop as usual. Explicit, never inferred from the history: only the
   * caller's record knows the call never started.
   */
  readonly resumeFrom?: string;
  /**
   * The user activates this skill (`/name`): before the model's first round,
   * the loop writes a `skill` round — the call, then its result — exactly as
   * if the model had called the tool, so dedup, compaction and replay treat
   * both alike (docs/feat/skills-slash.md). The caller checked
   * `canActivateForUser`; not combinable with `resumeFrom`.
   */
  readonly skill?: string;
  /**
   * Asks the client with a human behind this turn whether to run the
   * project's hooks (docs/feat/hooks-project-trust.md); beats the agent's own
   * `askHooksTrust`. Asked once per session, before a fresh turn's hooks.
   */
  readonly askHooksTrust?: AskHooksTrust;
  /**
   * The first history index this turn added (the caller's push of the user
   * prompt): only a message at or past it may carry a context line — never one
   * an earlier request already sent (docs/feat/context-awareness.md). Absent →
   * the history's length at entry (nothing of the caller's is new).
   */
  readonly newFrom?: number;
  /**
   * The turn starts with a new user message (a `send` with text): the
   * per-message count of context resets restarts. Absent → a continuation or
   * a resume, which keep it.
   */
  readonly userMessage?: boolean;
  /**
   * Make a group's start durable before it runs (R2,
   * docs/feat/round-groups-persistence.md). Contract for the round executor:
   * awaited after a group of MORE THAN ONE call is authorized (one at a time,
   * in call order) and before any of its calls runs, with `ids` = the calls
   * that will run (authorized, not cancelled); never for a call alone. Then
   * the abort is checked again: aborted → those calls are answered cancelled
   * and never start. Resolves whether the set landed (`false`: a failed write,
   * or an abort released the wait) — on `false` the executor runs the group
   * one call at a time, a commit after each (`runGroup`). Absent → nothing to
   * persist. Called only when `toolExecution` groups calls.
   */
  readonly beforeRun?: BeforeRun;
  /**
   * A call of the resumed round (`resumeFrom`) is about to run: awaited
   * before the resumed round's first start of each group — for a call alone
   * after its allow, for a group once between its phases, BEFORE `beforeRun`
   * (docs/feat/parallel-tools.md) — then the abort is checked again (aborted
   * → answered cancelled, never started). The daemon makes "this call may
   * have started" durable here when no ask did
   * (docs/fix/resumed-call-pending.md). Never for a later round. Absent →
   * nothing to persist.
   */
  readonly beforeResumedCall?: BeforeResumedCall;
}

/** `RunOptions.beforeRun`: resolves whether the group's in-flight set is durable. */
export type BeforeRun = (ids: readonly string[], signal: AbortSignal) => Promise<boolean>;

/** `RunOptions.beforeResumedCall`: resolves once it is safe to start the call (never rejects). */
export type BeforeResumedCall = (signal: AbortSignal) => Promise<void>;

/** The context-line estimate's counter when the config names none. */
const DEFAULT_COUNTER = new HeuristicTokenCounter();

/** The bound on a provider's exact count at open: past it the estimate is shown. */
export const CONTEXT_COUNT_TIMEOUT_MS = COUNT_TOKENS_CAP_MS;
/** Max consecutive empty-response auto-nudges before a stall ends the turn. */
const MAX_EMPTY_CONTINUES = 2;
/** Max `turn_end` hook continues per turn (R2, docs/feat/hooks-turn.md). */
const MAX_HOOK_CONTINUES = 3;
/** The internal nudge injected to un-stick a model that returned an empty round. */
const CONTINUE_NUDGE = "Continue with the task.";
/** Max re-asks per turn after the model leaked a tool call as DSML text (never unbounded). */
const MAX_DSML_REASKS = 1;
/**
 * Max re-asks per turn after a reply was CUT at the model's output limit: ONE,
 * because a truncation caused by a full context re-truncates at once — a second
 * would loop (docs/fix/truncated-reply-silent.md, Q1a; the `dsml_leak` shape).
 */
const MAX_TRUNCATION_REASKS = 1;
/** The internal note that re-asks a model whose reply was cut at its output limit. */
const TRUNCATION_REASK_NOTE =
  "Your previous reply was cut off at the output limit. Continue from exactly where it stopped — no preamble, no repetition of what you already wrote.";
/** Result recorded for a tool call skipped because the user cancelled mid-round,
 * so the assistant's `toolCalls` stay answered in the history. */
const CANCELLED_TOOL_NOTE = "Cancelled by the user before this tool ran.";

/**
 * A call the turn's unexpected stop (a throw, or a consumer that stopped at a
 * yield) reached before it started: certainly not run (`authorizeCall` never
 * runs a tool). Error-phrased, like every synthesized answer — never read as a
 * success (docs/feat/history-validity-invariant.md, Part B).
 */
const TURN_STOPPED_NOT_RUN_NOTE =
  "Not run: the turn stopped unexpectedly before this call started. Ask again if it is still needed.";
/** A call that had started when the turn stopped unexpectedly: it may have run. */
const TURN_STOPPED_INTERRUPTED_NOTE =
  "Interrupted: the turn stopped unexpectedly after this tool started; its result was not recorded. It may have completed — check before retrying.";

/**
 * A finished call's history message. A spill rides with it, so a resume or a
 * snapshot shows the same note as the live row (docs/feat/tui-spill-note.md);
 * the model never sees it (providers copy field by field). So does the run's
 * measured duration, when the tool actually ran (docs/fix/tool-duration.md).
 */
function toolMessage(callId: string, result: ToolResult, durationMs?: number): ChatMessage {
  return {
    role: "tool",
    content: result.content,
    toolCallId: callId,
    ...(result.spill ? { spill: result.spill } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(result.denialReply !== undefined ? { denialReply: result.denialReply } : {}),
  };
}

/** A tool run's outcome: `durationMs` is set iff the tool (or the skill read) actually ran. */
interface ToolRun {
  readonly result: ToolResult;
  readonly durationMs?: number;
}

/** The last user message's text, for `turn_start` hooks ("" if none). */
/**
 * Does the history end in a final answer — an assistant message with no tool
 * calls? The stale-wake guard's precondition: only then is a continuation over
 * it a turn with nothing to do (`docs/feat/agent-message-two-way.md`).
 */
function endsWithFinalAnswer(messages: readonly ChatMessage[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" && (last.toolCalls === undefined || last.toolCalls.length === 0)
  );
}

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      return m.content;
    }
  }
  return "";
}

/** A finished background job awaiting its note: a shell job, or a sub-agent (`agentId` in it). */
export type PendingExit = BackgroundJob | AgentJobExit | PendingAgentMessage | PendingUserNote;

/**
 * A running background child's `agent_notify` text, queued for the parent agent
 * (docs/feat/agent-message-two-way.md). It rides the SAME queue as an exit, so
 * every existing waker (a turn's start flush, `serve`'s `pendingExitCount`, an
 * attach's `unflushedExits`) sees it with no second path. `kind` is checked
 * FIRST: an exit has `agentId` too, and the shell job has neither.
 */
export type PendingAgentMessage = { readonly kind: "agent_message" } & AgentNotify;

const isAgentMessage = (job: PendingExit): job is PendingAgentMessage =>
  "kind" in job && job.kind === "agent_message";

/**
 * The USER wrote directly to a running background child
 * (`session/subagent_message`, docs/feat/subagent-panel.md). It rides the SAME
 * queue as an exit — so it inherits the carry-over on agent replacement and the
 * flush point — but it wakes NOBODY (`pendingExitCount` skips it) and emits no
 * event (the user was already told, by the update).
 */
export type PendingUserNote = {
  readonly kind: "user_note";
  readonly agentId: string;
  readonly text: string;
};

/** Checked AFTER `isAgentMessage`: both are notes, with an `agentId` too. */
const isUserNote = (job: PendingExit): job is PendingUserNote =>
  "kind" in job && job.kind === "user_note";

/**
 * The note a user's direct message to a background child leaves in the parent's
 * conversation: a `user` message (the model reads it as a fact it may act on),
 * tagged so a resume renders it as a notice and never as a row the person typed.
 *
 * The second line is owner question P7 (a): a small local model otherwise tends
 * to act on the text itself — re-send it to the child, or do the work.
 */
export function userToSubagentNote(note: PendingUserNote): ChatMessage {
  return {
    role: "user",
    content: `[user → ${note.agentId}] ${note.text}\n(the user wrote this directly to background sub-agent ${note.agentId}; it was delivered to it. For your information: no reply is expected.)`,
    note: { kind: NOTE_KIND.userToSubagent, id: note.agentId },
  };
}

/**
 * The note a running background child's `agent_notify` leaves in the parent's
 * conversation (docs/feat/agent-message-two-way.md): a `user` message, so the
 * model reads it as something it must react to, tagged so a resume renders it
 * as a notice and never as a row the person typed.
 */
export function agentMessageNote(note: AgentNotify): ChatMessage {
  return {
    role: "user",
    content: `[sub-agent ${note.agentId} → you] ${note.text}\n(background sub-agent ${note.agentId} (${note.description}) sent this while it was running. To answer, use agent_control({ action: "message", agent_id: "${note.agentId}", text }). Its final report still arrives as a [background] note.)`,
    note: { kind: NOTE_KIND.subagentMessage, id: note.agentId },
  };
}

export type AgentEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | {
      readonly type: "tool_start";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly name: string;
      readonly result: ToolResult;
      /** The tool's own run time (ms); absent when it never ran (denied, blocked, cancelled). */
      readonly durationMs?: number;
    }
  // A call's phase in its round (docs/feat/parallel-tools.md): `queued` —
  // approved in a group, not started yet; `running` — yielded right BEFORE
  // the call starts (every executed call; never one that did not start).
  // Rendering-only: never persisted.
  | { readonly type: "tool_phase"; readonly id: string; readonly phase: "queued" | "running" }
  | { readonly type: "usage"; readonly usage: Usage }
  // Nested sub-agent progress (the `agent_task` tool), keyed by the parent tool-call id.
  | {
      readonly type: "subagent_start";
      readonly id: string;
      readonly agentType: string;
      readonly description: string;
      /**
       * The model id the child runs on — a DAEMON-side fact, never on the wire
       * (AGENTS §7: `tool_progress` carries the `models` NAME or nothing). It is
       * what a row's `model` label is decided against on every publish, so a
       * mid-session `/model` re-decides it (docs/feat/subagent-panel.md, M2).
       */
      readonly modelId?: string;
    }
  | { readonly type: "subagent_tool"; readonly id: string; readonly label: string }
  | {
      readonly type: "subagent_usage";
      readonly id: string;
      readonly promptTokens: number;
      readonly completionTokens: number;
    }
  | {
      readonly type: "subagent_end";
      readonly id: string;
      readonly toolUses: number;
      readonly stopReason: string;
      /**
       * Set when the child MOVED to the background (someone wrote while it ran):
       * the `sa-N` it now is (docs/feat/subagent-detach.md). Its report arrives
       * later as a `[background]` note; the tool call ends here.
       */
      readonly agentId?: string;
    }
  // A background shell job finished; surfaced at the start of the next turn.
  | {
      readonly type: "background_exit";
      readonly jobId: string;
      readonly command: string;
      readonly status: string;
      readonly exitCode: number | null;
      /** Set for a sub-agent's exit (`jobId` is its `sa-N`). */
      readonly agent?: { readonly stopReason: string; readonly toolUses: number };
    }
  // A user message queued mid-turn ("steering") was injected into the loop.
  // `id`: its enqueue id — set by the daemon (the loop knows only texts).
  | { readonly type: "steer"; readonly text: string; readonly id?: string }
  // The loop itself added a user-role message to the history (the empty-round
  // nudge, a background-job note, a hook's note): emitted right after the
  // push, so every history message has an event and a replay can rebuild it.
  | {
      readonly type: "context_note";
      readonly text: string;
      readonly reason: "continue" | "background_exit" | "hook";
    }
  // The model wrote a tool call as DSML text and the reply was refused; the
  // re-ask note rides the conversation, this is the notice to show
  // (docs/fix/deepseek-dsml-leak.md). Its own event, not a `context_note`
  // reason: it crosses the wire as its own update KIND, so an older client
  // skips it as `unsupported` instead of failing its schema (Review MEDIUM-1).
  | { readonly type: "dsml_leak"; readonly text: string }
  // The model's reply was CUT at its output limit (`finish_reason: "length"`,
  // `max_tokens`) — or its stream was cut outright (`cut`: no stop reason at
  // all, which the loop turns into a failed turn). Its own display KIND, for
  // the same reason as `dsml_leak` (docs/fix/truncated-reply-silent.md).
  //
  // `retrying` is what the LOOP knows and the frontends cannot guess: whether
  // it is re-asking the model once from where it stopped. A re-ask that cuts
  // again reports `false`, so the user is told the recovery failed instead of
  // being promised a continuation that never comes (Review MEDIUM-2).
  | {
      readonly type: "truncated_reply";
      readonly reason: "length" | "cut";
      readonly retrying: boolean;
    }
  // The turn is ending with NOTHING produced: the model kept returning an empty
  // reply and the loop's bounded nudges ran out. Before this, the turn ended
  // `end_turn` in complete silence and the TUI looked hung. Display only.
  | { readonly type: "empty_turn" }
  // The model was sent a repaired copy of the history
  // (docs/feat/history-validity-invariant.md): invalid tool arguments replaced
  // by a marker, unanswered calls answered, stray tool results left out. The
  // STORED history is unchanged, so this is never a commit point; it is display
  // only, and the daemon sends it at most once per session.
  | {
      readonly type: "history_repaired";
      readonly invalidArguments: number;
      readonly unansweredCalls: number;
      readonly orphanResults: number;
    }
  // The history now reflects every event yielded so far (a consistent cut for a
  // snapshot + replay). Carries no data; frontends ignore it. Yielded only
  // where that holds — never between a push and the `pop` that may undo it.
  | { readonly type: "history_commit" }
  // The history was REPLACED in place inside the turn (the model renewed its
  // own context): `messages` is the new history, the turn goes on over it. A
  // commit point too (the history reflects every event so far) — and, for the
  // daemon, a barrier: a new epoch whose cut names the running turn.
  | { readonly type: "context_reset"; readonly messages: readonly ChatMessage[] }
  | { readonly type: "turn_end"; readonly reason: AgentStopReason };

/** Map a tool's neutral progress event onto a nested `AgentEvent` for a call. */
function progressToEvent(id: string, event: ToolProgressEvent): AgentEvent {
  switch (event.kind) {
    case "subagent_start":
      return {
        type: "subagent_start",
        id,
        agentType: event.agentType,
        description: event.description,
        ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
      };
    case "subagent_tool":
      return { type: "subagent_tool", id, label: event.label };
    case "subagent_usage":
      return {
        type: "subagent_usage",
        id,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
      };
    case "subagent_end":
      return {
        type: "subagent_end",
        id,
        toolUses: event.toolUses,
        stopReason: event.stopReason,
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
      };
  }
}

export interface AgentConfig {
  readonly model: ModelProvider;
  /**
   * The model ID `model` was built for (the wiring's `config.model`). DAEMON-side
   * only, and `undefined` when this process cannot know it — a pod's main model
   * is a tunnel to the laptop's (AGENTS §7). It is what a sub-agent row's `model`
   * label is decided against on every publish (docs/feat/subagent-panel.md, M2).
   */
  readonly modelId?: string;
  readonly tools: ToolRegistry;
  readonly env: ExecutionEnvironment;
  readonly systemPrompt?: string;
  /** Max tool-call rounds before giving up. Default 16. */
  readonly maxIterations?: number;
  /**
   * Token budget for this whole conversation: `promptTokens + completionTokens`
   * summed over every model call, never reset by a `context_reset`. Reaching it
   * exits the round loop like a spent step budget does, forcing the final
   * report (`max_token_budget`). Absent or `-1` = unlimited (only a sub-agent is
   * given one today, docs/feat/subagent-token-budget.md).
   */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Authorizes `"ask"` tools before they run. Defaults to approving all. */
  readonly requestPermission?: PermissionRequester;
  /** User hooks (docs/feat/hooks-core.md): `tool_call` in the gate, `tool_result` in the pipeline. */
  readonly hooks?: HookRunner;
  /**
   * Where this side reads an image ref's bytes from (docs/feat/attachments-core.md).
   * Carried on every request the loop builds — the run, the step-limit final
   * request and the context count — so all three inline the same images. Nothing
   * wires one in this task: until a producer exists, every ref is a placeholder.
   */
  readonly attachments?: AttachmentSource;
  /** The trust asker when a turn brings none (the in-process TUI: no RPC). */
  readonly askHooksTrust?: AskHooksTrust;
  /** Background-job registry; when set, the shell tools can launch jobs and
   * their exits are surfaced to the model (and frontend) on the next turn. */
  readonly jobs?: JobController;
  /**
   * The background sub-agent runtime (docs/feat/subagent-background.md); its
   * exits are surfaced like a job's, as a noted report. Carried across a rebuild.
   */
  readonly agentJobs?: AgentJobs;
  /** Transforms applied to every tool result before it enters the conversation
   * (e.g. spilling large output to a file). Applied in order. */
  readonly resultTransforms?: readonly ResultTransform[];
  /**
   * Activates skills: the user's `/name` round and the `/compact` re-read.
   * (The model's `skill` tool, registered in `tools`, is a façade over the
   * same path with the narrower, model-offered enum.) Absent → no skills.
   */
  readonly skills?: SkillActivator;
  /** The listing of the skill set at the start (`skills` and the `skill` tool's). Absent → empty. */
  readonly skillListing?: SkillListing;
  /**
   * Re-read the skill folders into a full fresh set (docs/feat/skills-hot-reload.md):
   * `refreshUserSkills` installs its activator and listing, never its tool.
   * It may throw (nothing is installed). Absent → the installed set is
   * answered as is, with no I/O.
   */
  readonly rescanSkills?: () => Promise<SessionSkills>;
  /**
   * The monotonic clock (ms) a tool run is timed on: read right before and
   * right after `execute`, so the permission prompt, the pre-hooks and the
   * result transforms are never counted. Default `performance.now`; tests
   * inject a fake one.
   */
  readonly now?: () => number;
  /**
   * Tell the model how full its context is (docs/feat/context-awareness.md): a
   * `[context: …]` line on the message that crosses each new `stepPercent` of
   * `window`. Absent → no new line (stored ones are still rendered). `counter`
   * estimates what the provider has not measured; default the heuristic.
   */
  readonly contextAwareness?: {
    readonly window: number;
    readonly stepPercent: number;
    readonly counter?: TokenCounter;
  };
  /**
   * The model may renew its own context (`context_reset`, registered in
   * `tools`; docs/feat/context-reset.md): the loop runs it — refusals, the
   * approval, then the history and the skill set replaced between rounds.
   * `maxPerMessage`: resets per user message, -1 = unlimited. `refresh`
   * re-reads the files the session's context is built from (the system prompt
   * and the skill set); it may throw (the reset is then refused). Absent → a
   * `context_reset` call is not intercepted.
   */
  readonly contextReset?: {
    readonly maxPerMessage: number;
    refresh(): Promise<{ readonly systemPrompt: string; readonly skills: SessionSkills }>;
  };
  /**
   * How a round's calls may overlap (`tools.execution` / `tools.maxParallel`,
   * docs/feat/parallel-tools.md). Absent → sequential: every call alone, as
   * every agent built without it (tests) expects.
   */
  readonly toolExecution?: { readonly mode: ExecutionMode; readonly maxParallel: number };
  /**
   * How a round's `agent_task` calls may overlap (`subagents.execution` /
   * `subagents.maxParallel`, docs/feat/parallel-agents.md): their own lane,
   * independent of `toolExecution`. The cap is exactly `maxParallel`: no server
   * is asked for its slots (owner 2026-11-08, docs/feat/models-map.md). Absent →
   * sequential.
   */
  readonly subagentExecution?: {
    readonly mode: ExecutionMode;
    readonly maxParallel: number;
  };
  /**
   * The session tree's approvals and ask lane, shared with its sub-agents
   * (docs/feat/parallel-agents.md, Design 3). Absent → this agent's own.
   */
  readonly grants?: SessionGrants;
  /**
   * A prefix for this agent's spill files. A sub-agent has one: the path is
   * built from a call id the server chose, which two children may share.
   */
  readonly spillScope?: string;
  /**
   * Where a large output is spilled (docs/fix/tool-output-location.md): the
   * daemon host's cache, outside the workspace-confined `env`. Absent → the
   * library fallback: `.tentacle/tool-output/` through `env.writeFile`.
   */
  readonly toolOutput?: ToolOutputSink;
}

/** What `runToolCalls` reports to the loop: an accepted context reset ran. */
type RoundOutcome = "context_reset" | undefined;

/** The `RunOptions` hooks a round's executor calls (the resumed round gets both). */
interface RoundHooks {
  readonly beforeRun?: BeforeRun | undefined;
  readonly beforeResumedCall?: BeforeResumedCall | undefined;
}

/** What a group's phase 2 runs under: its lane's cap and dependency rule. */
interface GroupRule {
  readonly cap: number;
  dependencies(
    calls: readonly { readonly tool: Tool | undefined; readonly input: unknown }[],
  ): number[][];
}

/** An item of a group's queue: a call's live progress, or a call's settled run. */
type GroupItem =
  | { readonly kind: "event"; readonly event: AgentEvent }
  | { readonly kind: "done"; readonly index: number; readonly run: ToolRun };

/**
 * `work`'s outcome, unless `signal` aborts first: then reject with its reason
 * at once (the work is left to finish unobserved — only for work that is safe
 * to abandon, like a read).
 */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A session's skill set, built once from a discovery (`buildSessionSkills`):
 * the model's `skill` tool, the activator behind every activation and the
 * listing (`session/skills`). Absent `tool` = none offered to the model (no
 * `skill` tool); absent `activator` = no skills at all; absent `listing` =
 * an empty one.
 */
export interface SessionSkills {
  readonly tool?: Tool | undefined;
  readonly activator?: SkillActivator | undefined;
  readonly listing?: SkillListing | undefined;
}

export class Agent {
  private readonly config: AgentConfig;
  private readonly gate: PermissionGate;
  /**
   * The activator behind every skill activation: `config.skills` at the start,
   * then whatever `installSkills` last put in.
   */
  private activator: SkillActivator | undefined;
  /** The installed set's listing (`skillListing`), replaced with the activator. */
  private listing: SkillListing;
  /**
   * Bumped by every install (a context reset's, a user rescan's): a rescan
   * whose scan started before another install landed installs nothing — its
   * disk snapshot may be older than that install's (F3).
   */
  private skillsGeneration = 0;
  /** The user rescan in flight: concurrent askers share it (one scan). */
  private rescan: Promise<SkillListing> | null = null;
  /** Background jobs that finished since the last turn, awaiting surfacing. */
  private readonly pendingExits: PendingExit[] = [];
  /** Leaves the jobs' exit stream (`retire`). */
  private unsubscribeExits: (() => void) | undefined;
  /** Leaves the sub-agents' exit stream (`retire`). */
  private unsubscribeAgentExits: (() => void) | undefined;
  /** Leaves the sub-agents' notify stream (`retire`). */
  private unsubscribeAgentNotify: (() => void) | undefined;
  /**
   * A child's note was flushed INTO a running turn (docs/feat/agent-message-two-way.md):
   * a continuation armed by that note's notice would start a turn over a
   * history with nothing new. Memory only; cleared by the turn's start flush,
   * and read by the narrow stale-wake guard.
   */
  private notesFlushedMidTurn = false;
  /**
   * The provider's last measure of each history (keyed by the array a Session
   * keeps for its life), so a turn's first request counts from real numbers.
   * Memory only: a reload starts from the estimate.
   */
  private readonly anchors = new WeakMap<ChatMessage[], ContextAnchor>();
  /**
   * Tokens each conversation has spent so far (keyed by the array a Session — or
   * a sub-agent — keeps for its life, as `anchors` is), against
   * `AgentConfig.maxTokens`. Memory only: a new conversation starts at 0, and a
   * reload cannot resume a child's count.
   */
  private readonly spend = new WeakMap<ChatMessage[], { tokens: number }>();
  /** Spill names already used on the env fallback path: see `spillId`. Memory only. */
  private readonly spillNames = new Set<string>();
  /**
   * The context-reset guard (one agent per session): accepted resets since
   * the last user message, and whether the model made another tool call since
   * the last one. Memory only: a reload starts permissive.
   */
  private resetsThisMessage = 0;
  private otherCallSinceReset = true;

  constructor(config: AgentConfig) {
    this.config = config;
    this.activator = config.skills;
    this.listing = config.skillListing ?? EMPTY_SKILL_LISTING;
    this.gate = new PermissionGate(
      config.requestPermission ?? allowAll,
      config.hooks,
      config.grants,
    );
    // Collect background-job exits as they happen; they are flushed into the
    // conversation (and event stream) at the top of the next turn.
    this.unsubscribeExits = config.jobs?.onExit((job) => this.pendingExits.push(job));
    this.unsubscribeAgentExits = config.agentJobs?.onExit((exit) => this.pendingExits.push(exit));
    // A running child's `agent_notify` joins the SAME queue, so every existing
    // waker (the turn-start flush, `pendingExitCount`, `unflushedExits`) sees it.
    this.unsubscribeAgentNotify = config.agentJobs?.onNotify((note) =>
      this.pendingExits.push({ kind: "agent_message", ...note }),
    );
  }

  /**
   * This agent is replaced (docs/feat/session-settings-apply.md): it stops
   * collecting job exits and hands back the ones no turn has surfaced yet, for
   * the next agent's `adoptExits`. Idempotent.
   */
  retire(): PendingExit[] {
    this.unsubscribeExits?.();
    this.unsubscribeExits = undefined;
    this.unsubscribeAgentExits?.();
    this.unsubscribeAgentExits = undefined;
    this.unsubscribeAgentNotify?.();
    this.unsubscribeAgentNotify = undefined;
    return this.pendingExits.splice(0);
  }

  /**
   * What runs in the background right now: shell jobs and sub-agents. A history
   * replacement (compaction, context reset) names them to the model.
   */
  runningBackground(): {
    readonly jobs: readonly { readonly id: string; readonly command: string }[];
    readonly agents: readonly { readonly agentId: string; readonly description: string }[];
  } {
    return {
      jobs: (this.config.jobs?.list() ?? [])
        .filter((j) => j.status === "running")
        .map((j) => ({ id: j.id, command: j.command })),
      agents: (this.config.agentJobs?.list() ?? []).map((a) => ({
        agentId: a.agentId,
        description: a.description,
      })),
    };
  }

  /**
   * Job exits no turn has surfaced yet: what the next turn's start will flush.
   * A child's note counts only when it ASKS for a wake: a note over the wake
   * budget is still delivered at the next start, it just wakes nobody. Neither
   * does the USER's own note (`user_note`): they were told at send time, and it
   * is not a child's report to react to now (docs/feat/subagent-panel.md).
   */
  get pendingExitCount(): number {
    return this.pendingExits.filter(
      (job) => !isUserNote(job) && (!isAgentMessage(job) || job.wakes),
    ).length;
  }

  /** Job exits a retired agent had not surfaced: told at this agent's next turn. */
  adoptExits(exits: readonly PendingExit[]): void {
    this.pendingExits.unshift(...exits);
  }

  /**
   * The model ID this agent's provider was built for (daemon-side; `undefined`
   * when this process cannot know it). What a child row's `model` label is
   * decided against, live (docs/feat/subagent-panel.md, Review round 3 M2).
   */
  get mainModelId(): string | undefined {
    return this.config.modelId;
  }

  /**
   * The user wrote to a background child (`session/subagent_message`,
   * docs/feat/subagent-panel.md): queue the parent's note. Synchronous and
   * never throwing — the daemon has already put the text in the child's inbox
   * by the time it calls this, and it must not undo that.
   *
   * Wakes nobody: it is not a child's report, and the user is watching.
   */
  noteUserToSubagent(agentId: string, text: string): void {
    this.pendingExits.push({ kind: "user_note", agentId, text });
  }

  /** Whether the user may activate `name` (`/name`) in this agent. */
  canActivateForUser(name: string): boolean {
    return this.activator?.userInvocable(name) ?? false;
  }

  /**
   * Swap the session's skill set: the registry's `skill` tool (set, or removed
   * when none is offered) and the activator. Synchronous, so a caller can do it
   * in the same stretch as a history replacement; takes effect from the next
   * model round (the tool list is read per round) and the next activation.
   */
  installSkills(skills: SessionSkills): void {
    this.config.tools.replace(SKILL_TOOL_NAME, skills.tool);
    this.activator = skills.activator;
    this.listing = skills.listing ?? EMPTY_SKILL_LISTING;
    this.skillsGeneration++;
  }

  /** The installed skill set's listing: what `/name` may activate now, and who else may. */
  skillListing(): SkillListing {
    return this.listing;
  }

  /**
   * The user's rescan (docs/feat/skills-hot-reload.md): read the skill folders
   * again and install the fresh ACTIVATOR and listing — never the model's
   * `skill` tool (its set changes only at a context reset), so `/name` follows
   * the disk while the model's catalog stays as it is. Resolves with the
   * INSTALLED listing: when a context reset installed meanwhile, the scan
   * installs nothing (it may be older) and the reset's set is answered.
   * Concurrent calls share one scan. Rejects when the scan throws (nothing
   * installed). Allowed mid-turn: a user round captured its activator.
   */
  refreshUserSkills(): Promise<SkillListing> {
    const rescanSkills = this.config.rescanSkills;
    if (!rescanSkills) {
      return Promise.resolve(this.listing);
    }
    if (this.rescan) {
      return this.rescan;
    }
    const generation = this.skillsGeneration;
    const rescan = rescanSkills()
      .then((fresh) => {
        // One synchronous stretch from the check to the install.
        if (this.skillsGeneration === generation) {
          this.activator = fresh.activator;
          this.listing = userRescanListing(
            fresh.listing ?? EMPTY_SKILL_LISTING,
            offeredSkillNames(this.config.tools.definitions()),
          );
          this.skillsGeneration++;
        }
        return this.listing;
      })
      .finally(() => {
        if (this.rescan === rescan) {
          this.rescan = null;
        }
      });
    this.rescan = rescan;
    return rescan;
  }

  /** Seed message list for a new conversation (the system prompt, if configured). */
  startConversation(): ChatMessage[] {
    return this.config.systemPrompt ? [{ role: "system", content: this.config.systemPrompt }] : [];
  }

  /**
   * Summarise a conversation (for `/compact`) using the configured model,
   * leaving out the bodies of the skills in `keep` (the rebuilt history
   * carries them).
   */
  summarize(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
    keep: readonly CarriedSkill[] = [],
  ): Promise<string> {
    return summarizeConversation(this.config.model, messages, signal, keep);
  }

  /**
   * The session's history was replaced (`/compact`): the next `model_request`
   * hook reports the whole history as new.
   */
  forgetModelRequestBaseline(sessionId: string): void {
    this.config.hooks?.forgetModelRequestBaseline(sessionId);
  }

  /**
   * The skills active in `messages`, each with its content read again (for
   * `/compact`) through the activator — the path every activation takes, the
   * user's included, so a skill hidden from the model is re-read too — then
   * the result transforms, with an empty history so it is not deduplicated.
   * When the activator no longer knows it (`unavailable`: removed, skills
   * disabled) or the read does not yield it (`unreadable`), the content from
   * the history is used instead. Emits no events: not a turn. `activator`
   * reads through another skill set than the installed one (the NEW set of a
   * context reset, before it is installed); omitted (`undefined`) → the
   * installed one, `null` → none (every skill is `unavailable`).
   */
  async reloadSkills(
    sessionId: string,
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
    through?: SkillActivator | null,
  ): Promise<CarriedSkill[]> {
    const activator = through === undefined ? this.activator : (through ?? undefined);
    const ctx: ToolContext = {
      sessionId,
      signal: signal ?? new AbortController().signal,
      env: this.config.env,
      history: [],
    };
    const skills: CarriedSkill[] = [];
    for (const { name, call, content, resultIndex } of skillActivations(messages)) {
      const stored = { name, call, content, resultIndex };
      // No longer activatable (removed, skills disabled): nothing to read.
      if (!activator?.has(name)) {
        skills.push({ ...stored, source: "unavailable" });
        continue;
      }
      // A read can hang (a pod's exec, a stuck mount) and `readFile` takes no
      // signal: a cancel must still end the compaction and free the busy slot.
      const result = await unlessAborted(
        (async () =>
          this.transformResult(call, await activator.activate(name, ctx), signal, { sessionId }))(),
        signal,
      );
      // Only the skill's own content is fresh: an error, or a result a
      // transform reshaped (no marker), keeps the earlier copy.
      if (!result.isError && skillContentName(result.content) === name) {
        skills.push({ ...stored, content: result.content, source: "fresh" });
      } else {
        skills.push({ ...stored, source: "unreadable" });
      }
    }
    return skills;
  }

  /** Single-shot: run to completion over the system prompt + the given user messages. */
  async *run(
    sessionId: string,
    userMessages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const messages = this.startConversation();
    const newFrom = messages.length;
    messages.push(...userMessages);
    yield* this.runMessages(messages, sessionId, signal, undefined, {
      newFrom,
      userMessage: true,
    });
  }

  /**
   * Drive one turn over an existing (mutable) message list — the caller's
   * conversation history — appending the assistant and tool messages it produces.
   *
   * `drainSteering`, when given, is polled at each iteration boundary; any
   * strings it returns are injected as user messages before the next model
   * round (interactive "steering" while a turn is already running).
   *
   * `opts.resumeFrom` resumes a suspended turn instead of starting with a model
   * round (see `RunOptions`); a history not suspended there → `ResumeShapeError`.
   */
  async *runMessages(
    messages: ChatMessage[],
    sessionId: string,
    signal?: AbortSignal,
    drainSteering?: () => readonly string[],
    opts: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    // Checked before anything runs or is yielded: a wrong resume point is a
    // caller bug, never a reason to re-run a call.
    const resumed =
      opts.resumeFrom !== undefined ? suspendedCalls(messages, opts.resumeFrom) : null;
    if (opts.resumeFrom !== undefined && resumed === null) {
      throw new ResumeShapeError(opts.resumeFrom);
    }
    if (opts.skill !== undefined && opts.resumeFrom !== undefined) {
      throw new Error("a user skill cannot be activated while resuming a suspended turn");
    }
    // A negative limit means "unlimited" (the loop only ends on end_turn /
    // cancel / error); otherwise cap the number of model/tool rounds.
    const configured = this.config.maxIterations ?? 16;
    const maxIterations = configured < 0 ? Number.POSITIVE_INFINITY : configured;
    // The same for the conversation's token budget: a negative limit is
    // unlimited, so the extra loop condition is always false.
    const configuredTokens = this.config.maxTokens ?? Number.POSITIVE_INFINITY;
    const maxTokens = configuredTokens < 0 ? Number.POSITIVE_INFINITY : configuredTokens;
    /** Whether this conversation has spent its token budget. Checked at a round
     * boundary, like the step cap, so the overshoot is at most one round. */
    const overBudget = (): boolean => this.spendOf(messages) >= maxTokens;
    // A user message — the turn's own, or a steer drained into it — restarts
    // the per-message count of context resets, and the sub-agents' notify
    // budgets (docs/feat/agent-message-two-way.md): a person wrote, so ping-pong
    // with a child is allowed again.
    if (opts.userMessage === true) {
      this.resetsThisMessage = 0;
      this.config.agentJobs?.userMessage();
    }
    const drain = (): readonly string[] => {
      const texts = drainSteering?.() ?? [];
      if (texts.length > 0) {
        this.resetsThisMessage = 0;
        this.config.agentJobs?.userMessage();
      }
      return texts;
    };
    // How many times in a row we auto-nudge a stalled model (an empty round:
    // no text, no tool calls) to continue before giving up, so a stall after a
    // tool result doesn't silently end the turn (the user had to type "go on").
    let emptyRounds = 0;
    // `turn_end` hook continues so far this turn (capped at MAX_HOOK_CONTINUES).
    let hookContinues = 0;
    const toolContext: ToolContext = {
      sessionId,
      signal: signal ?? new AbortController().signal,
      env: this.config.env,
      ...(this.config.jobs ? { jobs: this.config.jobs } : {}),
      history: messages,
    };

    // The user's prompt for `turn_start` hooks, read before any note lands.
    const prompt = lastUserText(messages);
    // From here on, the messages the model has not seen yet: the only ones a
    // context line may ride on (moves past each request as it is sent).
    let unseen = Math.min(opts.newFrom ?? messages.length, messages.length);

    // Project hooks run only once trusted: decided before a fresh turn runs
    // any hook or tool (never on a resumed turn, which already started).
    const runner = this.config.hooks;
    if (opts.resumeFrom === undefined && runner?.needsProjectTrust()) {
      await runner.resolveProjectTrust(
        sessionId,
        opts.askHooksTrust ?? this.config.askHooksTrust,
        signal,
      );
    }

    // A resumed turn first finishes its suspended round — exactly the calls an
    // uninterrupted run would still have run, each asked again — so the round's
    // results follow its assistant message with nothing in between.
    if (resumed) {
      // A reset in it: the fresh history is all unseen (the loop below starts
      // at round 0 anyway).
      if (
        (yield* this.runToolCalls(resumed, messages, toolContext, signal, {
          beforeRun: opts.beforeRun,
          beforeResumedCall: opts.beforeResumedCall,
        })) === "context_reset"
      ) {
        unseen = 0;
      }
    }

    // The user's `/name`: its `skill` round goes right after their message and
    // before anything else is injected, so the model's first round sees it.
    if (opts.skill !== undefined) {
      yield* this.runUserSkill(opts.skill, messages, toolContext, signal);
    }

    // Surface any background jobs that finished since the last turn: emit an
    // event for the frontend and inject a note so the model knows to react.
    // (After a resumed round, never inside it: a note between an assistant's
    // tool calls and their results is an invalid history.)
    const flushedAtStart = this.flushBackgroundExits(messages);
    for (const event of flushedAtStart.events) {
      yield event;
    }

    // The stale-wake guard (owner Q4 a): a client arms a continuation on a
    // child's note NOTICE, which may land while this turn is already running.
    // The note was then delivered mid-turn (below), so this continuation has
    // nothing new to answer: end it at once, with no model request. Narrow on
    // purpose — only a continuation (no user message, no resume, no skill), only
    // after a mid-turn note, only over a history ending in a final answer, and
    // only when nothing was flushed at this start.
    if (
      this.notesFlushedMidTurn &&
      opts.userMessage !== true &&
      opts.resumeFrom === undefined &&
      opts.skill === undefined &&
      flushedAtStart.events.length === 0 &&
      endsWithFinalAnswer(messages)
    ) {
      this.notesFlushedMidTurn = false;
      const early = drain();
      if (early.length === 0) {
        yield { type: "turn_end", reason: "end_turn" };
        return;
      }
      for (const text of early) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
    }
    this.notesFlushedMidTurn = false;
    // Q4 (a) holds at the START too: a client arms on a note's NOTICE, so two
    // notices in one stretch (a child's parallel calls, or two children) arm TWO
    // continuations; the first turn's start flush takes BOTH notes, and the
    // second continuation would then run a model round over nothing new. So a
    // start flush that delivered a note counts as the note having been consumed.
    if (flushedAtStart.deliveredNote) {
      this.notesFlushedMidTurn = true;
    }

    // `turn_start` hooks: not on a resumed turn, which already started (R4).
    // A cancel during them is handled by the loop's first check.
    const hooks = this.config.hooks;
    if (opts.resumeFrom === undefined && hooks?.hasAny("turn_start")) {
      const start = await hooks.turnStart({
        sessionId,
        prompt,
        ...(signal ? { signal } : {}),
      });
      for (const note of start.notes) {
        messages.push({ role: "user", content: note });
        yield { type: "context_note", text: note, reason: "hook" };
      }
      if (start.stop) {
        const text = hookNote("turn_start", `turn stopped: ${start.reason}`);
        messages.push({ role: "user", content: text });
        yield { type: "context_note", text, reason: "hook" };
        // A steer accepted while the hook ran is kept and echoed, never
        // accepted and then dropped — but gets NO model round: the stop holds,
        // and the steer must not reach the model without passing `turn_start`
        // (the user's next message starts a turn that runs it). Same no-await
        // invariant as the late-steer drain: nothing awaits from here to `turn_end`.
        for (const steer of drain()) {
          messages.push({ role: "user", content: steer });
          yield { type: "steer", text: steer };
        }
        yield { type: "turn_end", reason: "end_turn" };
        return;
      }
    }

    // The round the budget counts from: an accepted context reset restarts it
    // ("fresh context, fresh rounds"). `iteration` stays the turn's round
    // index (the `model_request` hook's).
    let budgetFrom = 0;
    /** Re-asks spent on a DSML-leaked tool call, per turn (`MAX_DSML_REASKS`). */
    let dsmlReasks = 0;
    /** Re-asks spent on a reply cut at the output limit, per turn (`MAX_TRUNCATION_REASKS`). */
    let truncationReasks = 0;
    /**
     * Whether ANY of this turn's replies carried text. A later empty round must
     * not report `empty_turn` then: the turn did produce something (a cut reply's
     * text is kept, owner Q1a), so the honest end is silence on that count.
     */
    let turnSaidSomething = false;
    for (let iteration = 0; iteration - budgetFrom < maxIterations && !overBudget(); iteration++) {
      if (signal?.aborted) {
        this.notifyTurnEnd(sessionId, "cancelled");
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }

      // Inject any user messages queued since the last boundary (steering).
      for (const text of drain()) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
      // A child's note that arrived while this turn ran is delivered HERE, at
      // the round boundary, in the same turn (docs/feat/agent-message-two-way.md):
      // it is a steer the parent must see before its next step, never a wake.
      const midNotes = this.flushAgentMessages(messages);
      if (midNotes.length > 0) {
        this.notesFlushedMidTurn = true;
        for (const event of midNotes) {
          yield event;
        }
      }

      const tools = this.config.tools.definitions();
      this.noteContextUsage(messages, unseen, tools);
      // The model's copy: stored context lines rendered into `content`, always
      // (enabled or not), so every request repeats the same bytes for a
      // message an earlier one sent — the provider's prompt cache holds.
      const view = modelView(messages);
      const request: ChatRequest = {
        messages: view.messages,
        tools,
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        ...(signal ? { signal } : {}),
        ...(this.config.attachments ? { attachments: this.config.attachments } : {}),
      };
      if (view.repairs !== null) {
        yield { type: "history_repaired", ...view.repairs };
      }
      const sent = messages.length;
      unseen = sent;

      let text = "";
      const toolCalls: ToolCall[] = [];
      /** Why the provider's stream ended; `undefined` from a provider that does not say. */
      let stopReason: ModelStopReason | undefined;
      this.notifyModelRequest(sessionId, iteration, request);
      try {
        for await (const event of this.config.model.stream(request)) {
          switch (event.type) {
            case "text":
              text += event.delta;
              yield { type: "text", delta: event.delta };
              break;
            case "reasoning":
              yield { type: "reasoning", delta: event.delta };
              break;
            case "tool_call":
              toolCalls.push(event.toolCall);
              break;
            case "done":
              stopReason = event.stopReason;
              if (event.usage) {
                this.anchorContext(messages, sent, event.usage);
                this.addSpend(messages, event.usage);
                yield { type: "usage", usage: event.usage };
              }
              break;
          }
        }
      } catch (error) {
        // A mid-stream abort rejects the underlying fetch/stream read with an
        // AbortError. Turn it into the clean cancellation path (not an error the
        // frontend renders as a failed turn); any other error propagates.
        if (signal?.aborted) {
          this.notifyTurnEnd(sessionId, "cancelled");
          yield { type: "turn_end", reason: "cancelled" };
          return;
        }
        // The model leaked a tool call as DSML text (docs/fix/deepseek-dsml-leak.md):
        // not an answer, so never stored as one. Tell the model how to call for
        // real and run the round again — bounded to ONE re-ask (a second leak is
        // a model-side failure the user must see, not a loop to sit in).
        // `continue` needs no history fixup: nothing was pushed for this round.
        if (error instanceof DsmlToolCallLeakError && dsmlReasks < MAX_DSML_REASKS) {
          dsmlReasks++;
          yield { type: "dsml_leak", text: DSML_REASK_NOTE };
          messages.push({ role: "user", content: DSML_REASK_NOTE });
          // The re-ask replaces the leaked round, not the turn's budget for
          // real work (as an accepted context reset does, as `budgetFrom`).
          budgetFrom--;
          continue;
        }
        // A DSML leak is NOT an answer: the text is dropped, never pushed, so a
        // second leak fails the turn without storing markup as the assistant's
        // reply. A failure after other text was streamed (a lost model
        // connection) keeps what the user already saw, so a later attach or
        // resume shows it too (docs/fix/detach-live.md round 10, owner B).
        if (text !== "" && !(error instanceof DsmlToolCallLeakError)) {
          messages.push({ role: "assistant", content: text });
        }
        throw error;
      }

      // The provider may complete normally *after* the abort (a batch fallback,
      // a third-party provider that swallows its signal, or an Esc landing just
      // after the last event). Don't keep the late reply or run its tools — end
      // the turn cancelled. (Providers that THROW on abort take the catch above.)
      if (signal?.aborted) {
        this.notifyTurnEnd(sessionId, "cancelled");
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }

      // A stream with NO stop reason at all ended mid-reply: missing data, not a
      // short answer (owner Q2a), so the turn FAILS. The text already shown is
      // kept in the history, as in the provider-throw path below — this is a
      // decision on a completed stream, not a throw from the provider
      // (docs/fix/truncated-reply-silent.md).
      if (stopReason === "other") {
        // Never retried: a stream that was cut is missing data, not a short
        // answer, so no re-ask follows (owner Q2a).
        yield { type: "truncated_reply", reason: "cut", retrying: false };
        if (text !== "") {
          messages.push({ role: "assistant", content: text });
        }
        throw new ModelStreamCutError("no-stop-reason", text.trim() !== "");
      }

      // A reply cut at the output limit (`finish_reason: "length"`) is real work,
      // just unfinished. Never run its tool call: the arguments may be partial
      // JSON (measured: 17 rounds on one cut call), so it is refused exactly as
      // `AnthropicProvider` already refuses one (case 5).
      if (stopReason === "length" && toolCalls.length > 0) {
        // Refused outright, so no re-ask follows either.
        yield { type: "truncated_reply", reason: "length", retrying: false };
        throw new ModelStreamCutError("cut-tool-call", text.trim() !== "", {
          toolCalls: toolCalls.length,
          argumentBytes: toolCalls.reduce((n, call) => n + call.arguments.length, 0),
        });
      }

      // A reply cut at the output limit: keep whatever text it managed as the
      // answer (it is real work, just unfinished), show the notice, and re-ask
      // ONCE from where it stopped (owner Q1a — the bounded `dsml_leak` shape).
      // With NO text either, the same one re-ask applies: an empty `length`
      // round is not the model's choice to say nothing (case 3).
      const cutByLength = stopReason === "length";
      if (cutByLength) {
        // Only the loop knows whether a re-ask is still available: a bounded
        // budget may already be spent, and a frontend guessing it from the
        // reason promised a continuation that never came (Review MEDIUM-2).
        yield {
          type: "truncated_reply",
          reason: "length",
          retrying: truncationReasks < MAX_TRUNCATION_REASKS,
        };
      }

      messages.push(
        toolCalls.length > 0
          ? { role: "assistant", content: text, toolCalls }
          : { role: "assistant", content: text },
      );

      // Any real progress (text or a tool call) resets the stall counter.
      if (toolCalls.length > 0 || text.trim() !== "") {
        emptyRounds = 0;
      }
      if (text.trim() !== "") {
        turnSaidSomething = true;
      }
      // A round with tool calls is kept as is: commit it. (Not without tool
      // calls: an empty round's message is popped again below.)
      if (toolCalls.length > 0) {
        yield { type: "history_commit" };
      }

      if (toolCalls.length === 0) {
        // `turn_end` hooks may ask for another round (R2: at most 3 per turn).
        // Awaited HERE, before the late-steer drain: anything queued while a
        // hook runs is drained below, so the no-await invariant holds. Not on
        // a stalled (empty) round — the nudge handles that.
        const stalled = text.trim() === "" && emptyRounds < MAX_EMPTY_CONTINUES;
        if (!stalled && hooks?.hasAny("turn_end") && hookContinues < MAX_HOOK_CONTINUES) {
          const end = await hooks.turnEnd({
            sessionId,
            reason: "end_turn",
            lastAssistantMessage: text,
            continued: hookContinues,
            ...(signal ? { signal } : {}),
          });
          if (signal?.aborted) {
            this.notifyTurnEnd(sessionId, "cancelled");
            yield { type: "turn_end", reason: "cancelled" };
            return;
          }
          if (end.continue) {
            hookContinues++;
            const note = hookNote("turn_end", end.reason);
            messages.push({ role: "user", content: note });
            yield { type: "context_note", text: note, reason: "hook" };
            continue;
          }
        }
        // Before ending, handle anything the user queued during the reply so a
        // last-moment steer is not dropped — inject it and run another round.
        // INVARIANT: from this drain to the `turn_end` yield (and on through the
        // daemon's `HostedSession.finishTurn` clearing its controller and fanning
        // `turn_end` out to every attached client, never awaited) there must be
        // NO `await` — no end-of-turn hook, no async persist. (`serve`'s
        // turn-end write is `persister.schedule` inside the synchronous
        // `finishTurn`: a capture, never awaited — never `await` a flush there.) A transport message
        // is a macrotask and cannot interleave, so a remote `session/enqueue` is
        // either drained here or rejected as `NoTurnRunning`. An await here
        // reopens a window where it is accepted and then silently dropped.
        // Pinned by the daemon test "no macrotask fits between the last
        // steering drain and the turn's end"; the `max_iterations` path below
        // keeps the same invariant.
        const late = drain();
        const lateNotes = this.flushAgentMessages(messages);
        if (late.length > 0 || lateNotes.length > 0) {
          for (const text of late) {
            messages.push({ role: "user", content: text });
            yield { type: "steer", text };
          }
          if (lateNotes.length > 0) {
            this.notesFlushedMidTurn = true;
            for (const event of lateNotes) {
              yield event;
            }
          }
          continue;
        }
        // Empty round (no text, no tool calls): the model stalled — it stopped
        // after a tool result instead of continuing. Nudge it to carry on, a
        // bounded number of times, rather than ending the turn with nothing
        // (which forced the user to type "go on" to un-stick it). The nudge is
        // internal: it is not surfaced as a `steer` event.
        //
        // A CUT reply (`length`) is not the model's choice to stop: whatever it
        // managed is the answer (text) or nothing at all (empty), and either way
        // it gets ONE re-ask from where it stopped — not the stall nudge, so a
        // cut round never spends `MAX_EMPTY_CONTINUES`. Bounded to ONE: a
        // truncation caused by a full context re-truncates at once, so a second
        // would loop. The `truncated_reply` notice above already told the user.
        if (cutByLength && truncationReasks < MAX_TRUNCATION_REASKS) {
          truncationReasks++;
          if (text.trim() === "") {
            messages.pop(); // drop the empty assistant turn; keep history clean
          }
          messages.push({ role: "user", content: TRUNCATION_REASK_NOTE });
          yield { type: "context_note", text: TRUNCATION_REASK_NOTE, reason: "continue" };
          // The re-ask replaces the cut round, not the turn's budget for real
          // work: `budgetFrom` moves WITH the iteration, so the next round costs
          // what this one would have (the `context_reset` shape, one step).
          budgetFrom++;
          continue;
        }
        if (text.trim() === "" && emptyRounds < MAX_EMPTY_CONTINUES) {
          emptyRounds++;
          messages.pop(); // drop the empty assistant turn; keep history clean
          if (messages.at(-1)?.content !== CONTINUE_NUDGE) {
            messages.push({ role: "user", content: CONTINUE_NUDGE });
            yield { type: "context_note", text: CONTINUE_NUDGE, reason: "continue" };
          }
          continue;
        }
        // Nothing was produced and nothing is left to try: SAY so. Before this
        // the turn ended in complete silence and the TUI looked hung
        // (`agent4.ts`: 3 model calls, no user-visible event at all). Only when
        // the WHOLE turn said nothing — a cut reply's text was already shown.
        if (text.trim() === "" && !turnSaidSomething) {
          yield { type: "empty_turn" };
        }
        // A spent token budget still ends the turn honestly, even when the
        // child answers in prose on that very round: the cap is why it ended.
        const clean: AgentStopReason = overBudget() ? "max_token_budget" : "end_turn";
        if (clean !== "end_turn") {
          this.notifyTurnEnd(sessionId, clean);
        }
        yield { type: "turn_end", reason: clean };
        return;
      }

      if (
        (yield* this.runToolCalls(toolCalls, messages, toolContext, signal, {
          beforeRun: opts.beforeRun,
        })) === "context_reset"
      ) {
        budgetFrom = iteration + 1;
        // The model has seen nothing of the fresh history: its context line
        // may ride on any of it (the next request's).
        unseen = 0;
      }
    }

    // The cap was hit. If the user cancelled while the last tool ran (after the
    // iteration-top check, before the final stream below could even start), the
    // cancel wins over the `max_iterations` report. (An abort *during* the final
    // stream is handled inside it, below.)
    if (signal?.aborted) {
      this.notifyTurnEnd(sessionId, "cancelled");
      yield { type: "turn_end", reason: "cancelled" };
      return;
    }
    // WHY the loop ended: a spent token budget is never blamed on steps (a
    // spend-shaped stop must say so), and when both are spent in the same
    // boundary the token one is the honest answer.
    const capped: AgentStopReason = overBudget() ? "max_token_budget" : "max_iterations";
    // The same in prose: a token-capped child told about a step limit would be
    // told a falsehood, and it is what the report it writes is shaped by.
    const nudge =
      capped === "max_token_budget"
        ? "You've reached the token budget for this task. Give your final answer/report now, " +
          "using what you've gathered so far. Do not call any tools."
        : "You've reached the step limit. Give your final answer/report now, " +
          "using what you've gathered so far. Do not call any tools.";

    // Out of iterations. Give the model ONE final turn with no tools offered, so
    // it must deliver its answer/report in prose instead of calling yet another
    // tool. Without this, a turn (or a sub-agent) that spent its whole budget on
    // tool calls ends with no visible result at all ("stopped without a report").
    // Best-effort: any failure still ends the turn as `max_iterations`.
    if (!signal?.aborted) {
      // Anything queued during the last allowed round is injected first, so the
      // final report can address it (no round is left to run it otherwise).
      for (const text of drain()) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
      try {
        const view = modelView(messages);
        if (view.repairs !== null) {
          yield { type: "history_repaired", ...view.repairs };
        }
        const finalMessages: ChatMessage[] = [
          ...view.messages,
          {
            role: "user",
            content: nudge,
          },
        ];
        let finalText = "";
        const finalRequest: ChatRequest = {
          messages: finalMessages,
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(signal ? { signal } : {}),
          ...(this.config.attachments ? { attachments: this.config.attachments } : {}),
        };
        this.notifyModelRequest(sessionId, "final", finalRequest);
        for await (const event of this.config.model.stream(finalRequest)) {
          if (event.type === "text") {
            finalText += event.delta;
            yield { type: "text", delta: event.delta };
          } else if (event.type === "reasoning") {
            yield { type: "reasoning", delta: event.delta };
          } else if (event.type === "done" && event.usage) {
            yield { type: "usage", usage: event.usage };
          }
          // tool_call events are ignored: no tools were offered.
        }
        // The final stream may complete after an abort (mirrors the post-stream
        // check above): the cancel wins over the `max_iterations` report, and
        // the late reply is not kept (providers that THROW take the catch below).
        if (signal?.aborted) {
          this.notifyTurnEnd(sessionId, "cancelled");
          yield { type: "turn_end", reason: "cancelled" };
          return;
        }
        // Persist only the summary (not the synthetic nudge), so history stays clean.
        if (finalText.trim() !== "") {
          messages.push({ role: "assistant", content: finalText });
        }
      } catch (error) {
        if (signal?.aborted) {
          this.notifyTurnEnd(sessionId, "cancelled");
          yield { type: "turn_end", reason: "cancelled" };
          return;
        }
        // Otherwise fall through: the turn still ends as max_iterations below.
      }
      // Queued DURING the final report: no round is left to answer it, but it
      // is kept in the history (the model sees it next turn) rather than being
      // accepted and then dropped by the next send's reset. Same no-await
      // invariant as the late-steer drain above: nothing awaits from here to
      // `turn_end`.
      for (const text of drain()) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
    }

    this.notifyTurnEnd(sessionId, capped);
    yield { type: "turn_end", reason: capped };
  }

  /**
   * Before a request: when the context has crossed a new step since the last
   * line, put the current count on the LAST user/tool message the model has
   * not seen (index >= `unseen`) — a copy replacing it, its other fields kept.
   * None such → no line now; the next one carries it. Synchronous.
   */
  private noteContextUsage(
    messages: ChatMessage[],
    unseen: number,
    tools: NonNullable<ChatRequest["tools"]>,
  ): void {
    const awareness = this.config.contextAwareness;
    if (!awareness) {
      return;
    }
    let target = -1;
    for (let i = messages.length - 1; i >= unseen; i--) {
      const role = messages[i]?.role;
      if (role === "user" || role === "tool") {
        target = i;
        break;
      }
    }
    const message = messages[target];
    if (message === undefined) {
      return;
    }
    const current: ContextUsage = {
      used: estimateUsed(
        messages,
        tools,
        this.anchors.get(messages),
        awareness.counter ?? DEFAULT_COUNTER,
      ),
      window: awareness.window,
    };
    if (shouldEmit(current, lastEmitted(messages), awareness.stepPercent)) {
      messages[target] = { ...message, contextUsage: current };
    }
  }

  /** The provider measured the request of `messages[0, sent)`: anchor the next estimate there. */
  private anchorContext(messages: ChatMessage[], sent: number, usage: Usage): void {
    const ref = messages[sent - 1];
    // 0 = the provider did not report it (`?? 0`): keep estimating.
    if (usage.promptTokens > 0 && ref !== undefined) {
      this.anchors.set(messages, { promptTokens: usage.promptTokens, len: sent, ref });
    }
  }

  /** Tokens this conversation has spent (`prompt + completion`, cache included). */
  private spendOf(messages: ChatMessage[]): number {
    return this.spend.get(messages)?.tokens ?? 0;
  }

  /**
   * Add one model call's spend to the conversation's running total — the same
   * `done`-with-usage branch as `anchorContext`, so every call that is measured
   * is counted, the forced final report's included. Keyed by the CONVERSATION
   * array: a continuation pass cannot refill its budget, and a `context_reset`
   * un-spends nothing (it restarts rounds, not tokens).
   */
  private addSpend(messages: ChatMessage[], usage: Usage): void {
    const entry = this.spend.get(messages);
    const spent = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (entry === undefined) {
      this.spend.set(messages, { tokens: spent });
    } else {
      entry.tokens += spent;
    }
  }

  /**
   * The size of the request `messages` would become now — the context a client
   * shows BEFORE any turn measured it (docs/feat/tui-target-badge.md). Counted
   * by the provider without generating when it can (`countTokens`, bounded by
   * `timeoutMs`); otherwise (cannot, failed, too slow, `signal` aborted) the
   * estimate, silently. Never throws.
   */
  async contextUsage(
    messages: ChatMessage[],
    signal?: AbortSignal,
    timeoutMs: number = CONTEXT_COUNT_TIMEOUT_MS,
  ): Promise<{ readonly used: number; readonly exact: boolean }> {
    const tools = this.config.tools.definitions();
    // Bounded and silent (`countTokensBounded`): a count that cannot, fails or
    // is slow falls through to the estimate.
    const exact = await countTokensBounded(
      this.config.model,
      {
        messages: modelView(messages).messages,
        tools,
        ...(this.config.attachments ? { attachments: this.config.attachments } : {}),
      },
      signal,
      timeoutMs,
    );
    if (exact !== undefined) {
      return { used: exact, exact: true };
    }
    return {
      used: estimateUsed(messages, tools, this.anchors.get(messages), DEFAULT_COUNTER),
      exact: false,
    };
  }

  /** `turn_end` notification hooks (cancelled / a spent budget): synchronous, never awaited. */
  private notifyTurnEnd(
    sessionId: string,
    reason: "cancelled" | "max_iterations" | "max_token_budget",
  ): void {
    if (this.config.hooks?.hasAny("turn_end")) {
      void this.config.hooks.turnEndNotify({ sessionId, reason });
    }
  }

  /** `model_request` notification hooks: synchronous, never awaited (D2). */
  private notifyModelRequest(
    sessionId: string,
    iteration: number | "final",
    request: ChatRequest,
  ): void {
    this.config.hooks?.notifyModelRequest({
      sessionId,
      iteration,
      messages: request.messages,
      toolNames: (request.tools ?? []).map((t) => t.name),
    });
  }

  /**
   * Run one round's tool calls, group by group (`planRound`, by
   * `toolExecution` and `subagentExecution`; absent = sequential, every call
   * alone). A call alone is
   * authorized and run, and its result pushed and committed before the next
   * one starts — so a history suspended inside it is "earlier calls answered,
   * this one and the later ones not" (`suspendedCalls`). A group of several
   * is `runGroup`. A call reached after an abort is answered as cancelled
   * without prompting, keeping the round answered.
   */
  private async *runToolCalls(
    calls: readonly ToolCall[],
    messages: ChatMessage[],
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
    hooks: RoundHooks = {},
  ): AsyncGenerator<AgentEvent, RoundOutcome> {
    const mode = this.config.toolExecution?.mode ?? "sequential";
    const maxParallel = this.config.toolExecution?.maxParallel ?? 1;
    const classes = calls.map((call) =>
      classOf(this.config.tools.get(call.name), parseArguments(call.arguments)),
    );
    const kinds = calls.map((call) =>
      spawnKindOf(this.config.tools.get(call.name), parseArguments(call.arguments)),
    );
    const agents = this.config.subagentExecution;
    const agentMode = agents?.mode ?? "sequential";
    // The user's `subagents.maxParallel`, exactly (owner 2026-11-08: no slot probe).
    const agentCap = agents?.maxParallel ?? 1;
    const rules: Record<"tools" | "agents", GroupRule> = {
      tools: {
        cap: maxParallel,
        dependencies: (items) =>
          dependencies(
            items.map((item) => classOf(item.tool, item.input)),
            mode,
          ),
      },
      agents: {
        cap: agentCap,
        dependencies: (items) =>
          spawnDependencies(
            items.map((item) => spawnKindOf(item.tool, item.input)),
            agentMode,
          ),
      },
    };
    const round = planRound(
      classes,
      kinds,
      { mode, maxParallel },
      { mode: agentMode, cap: agentCap },
    );
    // Part B (docs/feat/history-validity-invariant.md): an abnormal exit (a
    // throw, or a consumer that stopped at a yield) must never leave the
    // stored history with an assistant tool call no result answers. Nothing
    // here yields or awaits — the `finally` below cannot.
    const owner = messages.findLast(
      (m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === calls[0]?.id),
    );
    /** Ids whose `executeCall`/`runPrepared` was invoked: "it may have run". */
    const started = new Set<string>();
    /** An alone call's finished message, between its `tool_result` yield and its push. */
    let inHand: ChatMessage | undefined;
    /** Set immediately before every normal return. */
    let settled = false;
    try {
      for (const { indexes, lane } of round) {
        const group = indexes.flatMap((i) => (calls[i] ? [calls[i]] : []));
        if (group.length > 1) {
          yield* this.runGroup(group, messages, toolContext, hooks, rules[lane], started);
          continue;
        }
        const call = group[0];
        if (call === undefined) {
          continue;
        }
        const resetConfig = this.config.contextReset;
        if (
          call.name === CONTEXT_RESET_TOOL_NAME &&
          resetConfig !== undefined &&
          this.config.tools.get(CONTEXT_RESET_TOOL_NAME) !== undefined
        ) {
          if (yield* this.runContextReset(call, resetConfig, messages, toolContext, signal)) {
            // The only call of its message (checked): the round is over.
            settled = true;
            return "context_reset";
          }
          continue;
        }
        this.otherCallSinceReset = true;
        if (signal?.aborted) {
          // The user cancelled while the previous tool ran (or before this one
          // could start). It must not start — and must not prompt for
          // permission either (`authorizeCall` asks). Answer it
          // synthetically so the assistant's `toolCalls` stay valid in the
          // history; the next iteration top ends the turn as cancelled.
          messages.push({
            role: "tool",
            content: CANCELLED_TOOL_NOTE,
            toolCallId: call.id,
          });
          yield {
            type: "tool_result",
            id: call.id,
            name: call.name,
            result: { content: CANCELLED_TOOL_NOTE, isError: true },
          };
          yield { type: "history_commit" };
          continue;
        }
        yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };
        // Interleave the tool's live progress (e.g. a sub-agent's activity) into
        // our own stream while it runs, then yield the final result.
        const progress = new EventQueue<AgentEvent>();
        const ctx: ToolContext = {
          ...toolContext,
          emitProgress: (event: ToolProgressEvent) =>
            progress.push(progressToEvent(call.id, event)),
          toolCallId: call.id,
          shapeResult: (result, sig) =>
            this.transformResult(call, result, sig, { sessionId: toolContext.sessionId }),
        };
        const prepared = await this.authorizeCall(call, ctx, {
          beforeStart: hooks.beforeResumedCall,
        });
        let run: ToolRun & { input: unknown };
        if (prepared.kind === "done") {
          run = prepared;
        } else if (yield* this.signalRunning(call.id, toolContext.signal)) {
          // Cancelled in the hop after the signal: never started.
          run = { result: cancelledResult(), input: prepared.input };
        } else {
          started.add(call.id);
          const resultPromise = this.executeCall(prepared, ctx).finally(() => progress.close());
          for await (const event of progress.drain()) {
            yield event;
          }
          run = await resultPromise;
        }
        const { result: raw, input, durationMs } = run;
        // After the duration was taken: a transform is harness time, not the tool's.
        const transformed = await this.transformResult(call, raw, signal, {
          sessionId: toolContext.sessionId,
          input,
        });
        const result = keepDenialReply(raw, transformed);
        // In hand across the yield below: a consumer that stops at the
        // `tool_result` has seen this result, so it must reach the history.
        const message = toolMessage(call.id, result, durationMs);
        inHand = message;
        yield {
          type: "tool_result",
          id: call.id,
          name: call.name,
          result,
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        messages.push(message);
        inHand = undefined;
        // After the push, not before: the `tool_result` above precedes it.
        yield { type: "history_commit" };
      }
      settled = true;
      return undefined;
    } finally {
      // No yield, no await: synchronous pushes only. The answers are in
      // `session.messages` before the error reaches either consumer, so both
      // persist them (`Session.send`'s finally, `drive`'s closeFailedTurn).
      if (!settled && owner !== undefined && messages.lastIndexOf(owner) !== -1) {
        if (inHand !== undefined) {
          // The REAL result, already transformed (redaction/spill applied):
          // pushing the raw output could leak what a transform hides.
          messages.push(inHand);
        }
        messages.push(
          ...answerOutstandingCalls(messages, owner, calls, (c) =>
            started.has(c.id) ? TURN_STOPPED_INTERRUPTED_NOTE : TURN_STOPPED_NOT_RUN_NOTE,
          ),
        );
      }
    }
  }

  /**
   * A group of several calls (docs/feat/parallel-tools.md), in two phases.
   *
   * PHASE 1 — authorize, serially, in call order, each ask carrying the
   * group's head as `groupStart`. A refusal or a cancel is answered at once
   * (its `tool_result`); nothing is pushed. A call's OWN ask happens only here.
   *
   * A sub-agent's ask may be raised in phase 2, while its `agent_task` runs
   * (docs/feat/parallel-agents.md, the load-bearing assumption). That cannot
   * break the disk or the replay: such an ask is never resumable and the
   * group's `inFlight` is durable before any child starts, so a reload never
   * re-runs the group; and the group's one commit follows every child, so the
   * cut cannot pass a live ask.
   *
   * BETWEEN — if some call may run and no abort: the resumed round's F3 hold
   * (`beforeResumedCall`), then `beforeRun` with the ids that will run, each
   * followed by an abort check (aborted → those calls answered cancelled,
   * none starts).
   *
   * PHASE 2 — `beforeRun` landed: the calls run concurrently, each once the
   * earlier calls its lane's rule makes it wait for (on its EFFECTIVE input)
   * have settled, at most the lane's cap at a time; results are yielded as they complete and
   * pushed in call order with ONE commit at the end. Not landed: one at a
   * time, in call order, a commit after each (never parallel without a
   * durable record). Either way, a result-processing failure is that call's
   * error (the turn goes on); a running call is never abandoned.
   */
  private async *runGroup(
    calls: readonly ToolCall[],
    messages: ChatMessage[],
    toolContext: ToolContext,
    hooks: RoundHooks,
    rule: GroupRule,
    started: Set<string>,
  ): AsyncGenerator<AgentEvent, void> {
    const signal = toolContext.signal;
    const head = calls[0]?.id;
    // One queue for the whole group: live progress of every call, and the
    // completions of phase 2.
    const queue = new EventQueue<GroupItem>();
    const answered = new Map<number, ToolRun>();
    const ready = new Map<number, { prepared: RunPrepared; ctx: ToolContext }>();
    const answer = (index: number, call: ToolCall, run: ToolRun): AgentEvent => {
      answered.set(index, run);
      return {
        type: "tool_result",
        id: call.id,
        name: call.name,
        result: run.result,
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      };
    };
    // Part B (docs/feat/history-validity-invariant.md): results the clients
    // already saw are kept on an abnormal exit, and no call is left
    // unanswered (the callers' `finally` classifies what this group did not do).
    const pushed = new Set<number>();
    let groupSettled = false;
    try {
      // PHASE 1.
      for (const [index, call] of calls.entries()) {
        this.otherCallSinceReset = true;
        if (signal.aborted) {
          yield answer(index, call, { result: cancelledResult() });
          continue;
        }
        yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };
        const ctx: ToolContext = {
          ...toolContext,
          emitProgress: (event: ToolProgressEvent) =>
            queue.push({ kind: "event", event: progressToEvent(call.id, event) }),
          toolCallId: call.id,
          shapeResult: (result, sig) =>
            this.transformResult(call, result, sig, { sessionId: toolContext.sessionId }),
        };
        const prepared = await this.authorizeCall(call, ctx, {
          ...(head !== undefined ? { groupStart: head } : {}),
        });
        if (prepared.kind === "done") {
          yield answer(index, call, await this.finishCall(call, prepared, toolContext));
          continue;
        }
        ready.set(index, { prepared, ctx });
        yield { type: "tool_phase", id: call.id, phase: "queued" };
      }

      // BETWEEN.
      let landed = true;
      if (ready.size > 0 && !signal.aborted) {
        await hooks.beforeResumedCall?.(signal);
        if (!signal.aborted && hooks.beforeRun) {
          const ids = [...ready.keys()].flatMap((i) => (calls[i] ? [calls[i].id] : []));
          landed = await hooks.beforeRun(ids, signal);
        }
      }
      if (signal.aborted) {
        for (const index of ready.keys()) {
          const call = calls[index];
          if (call) {
            yield answer(index, call, { result: cancelledResult() });
          }
        }
        ready.clear();
      }

      if (!landed) {
        // One at a time, a commit after each: the first commit clears the
        // daemon's in-memory in-flight set, after which "the first unanswered
        // call is the only one that may have started" holds again.
        for (const [index, call] of calls.entries()) {
          const entry = ready.get(index);
          if (entry !== undefined) {
            if (signal.aborted || (yield* this.signalRunning(call.id, signal))) {
              yield answer(index, call, { result: cancelledResult() });
            } else {
              const settled = this.runPrepared(
                entry.prepared,
                entry.ctx,
                toolContext,
                started,
              ).then((run) => {
                queue.push({ kind: "done", index, run });
              });
              yield* this.drainUntilDone(queue, index, (run) => answer(index, call, run));
              await settled;
            }
          }
          const run = answered.get(index);
          if (run !== undefined) {
            messages.push(toolMessage(call.id, run.result, run.durationMs));
            pushed.add(index);
            yield { type: "history_commit" };
          }
        }
        queue.close();
        groupSettled = true;
        return;
      }

      // PHASE 2 (landed): concurrent, under the dependency order and the cap.
      const order = [...ready.keys()];
      const deps = rule.dependencies(
        order.map((i) => ({
          tool: this.config.tools.get(calls[i]?.name ?? ""),
          input: ready.get(i)?.prepared.input,
        })),
      );
      const states: CallState[] = order.map(() => "pending");
      let running = 0;
      while (true) {
        while (!signal.aborted) {
          const k = nextRunnable(deps, states, rule.cap);
          const index = k === undefined ? undefined : order[k];
          const entry = index === undefined ? undefined : ready.get(index);
          const call = index === undefined ? undefined : calls[index];
          if (k === undefined || index === undefined || entry === undefined || call === undefined) {
            break;
          }
          if (yield* this.signalRunning(call.id, signal)) {
            break; // cancelled in the hop: still pending, answered cancelled below
          }
          states[k] = "running";
          running++;
          void this.runPrepared(entry.prepared, entry.ctx, toolContext, started).then((run) => {
            queue.push({ kind: "done", index, run });
          });
        }
        if (signal.aborted) {
          // Never started: answered cancelled. Running ones are awaited below.
          for (const [k, state] of states.entries()) {
            const index = order[k];
            const call = index === undefined ? undefined : calls[index];
            if (state === "pending" && index !== undefined && call !== undefined) {
              states[k] = "settled";
              yield answer(index, call, { result: cancelledResult() });
            }
          }
        }
        if (running === 0) {
          break;
        }
        const item = await queue.next();
        if (item === undefined) {
          break;
        }
        if (item.kind === "event") {
          yield item.event;
          continue;
        }
        running--;
        states[order.indexOf(item.index)] = "settled";
        const call = calls[item.index];
        if (call) {
          yield answer(item.index, call, item.run);
        }
      }
      queue.close();
      for (const [index, call] of calls.entries()) {
        const run = answered.get(index);
        if (run !== undefined) {
          messages.push(toolMessage(call.id, run.result, run.durationMs));
          pushed.add(index);
        }
      }
      // After every push: the group's results precede it. No ask is pending: every
      // call settled, so every sub-agent's ask did too.
      groupSettled = true;
      yield { type: "history_commit" };
    } finally {
      // No yield, no await. A closed queue drops late completions, so a call
      // still running cannot push after the answers below.
      queue.close();
      if (!groupSettled) {
        for (const [index, call] of calls.entries()) {
          const run = answered.get(index);
          if (run !== undefined && !pushed.has(index)) {
            messages.push(toolMessage(call.id, run.result, run.durationMs));
          }
        }
      }
    }
  }

  /**
   * Tell the stream a call is about to start (`tool_phase` `running`) — the
   * call starts only when the consumer pulls again, so every frame of the
   * signal precedes the start (the laptop's exact cut labels rely on it).
   * Returns whether a cancel landed in that hop (then the call must not start).
   */
  private async *signalRunning(
    id: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, boolean> {
    yield { type: "tool_phase", id, phase: "running" };
    return signal.aborted;
  }

  /** Yield `queue`'s progress until `index` completes; then yield its answer. */
  private async *drainUntilDone(
    queue: EventQueue<GroupItem>,
    index: number,
    answer: (run: ToolRun) => AgentEvent,
  ): AsyncGenerator<AgentEvent, void> {
    while (true) {
      const item = await queue.next();
      if (item === undefined) {
        return;
      }
      if (item.kind === "event") {
        yield item.event;
      } else if (item.index === index) {
        yield answer(item.run);
        return;
      }
    }
  }

  /** Run an authorized call of a group and process its result: never rejects. */
  private async runPrepared(
    prepared: RunPrepared,
    ctx: ToolContext,
    toolContext: ToolContext,
    started: Set<string>,
  ): Promise<ToolRun> {
    // First statement, before the await: from here the call may have run.
    started.add(prepared.call.id);
    const run = await this.executeCall(prepared, ctx);
    return this.finishCall(prepared.call, run, toolContext);
  }

  /**
   * A group's call's result through the transforms. A throw there is that
   * call's error result (the rest of the group and the turn go on —
   * decision 4 of docs/feat/parallel-tools.md); a call alone keeps failing
   * the turn.
   */
  private async finishCall(
    call: ToolCall,
    run: ToolRun & { readonly input: unknown },
    toolContext: ToolContext,
  ): Promise<ToolRun> {
    try {
      const transformed = await this.transformResult(call, run.result, toolContext.signal, {
        sessionId: toolContext.sessionId,
        input: run.input,
      });
      return {
        result: keepDenialReply(run.result, transformed),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      };
    } catch (error) {
      return {
        result: {
          content: `Result processing failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        },
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      };
    }
  }

  /**
   * A `context_reset` call (docs/feat/context-reset.md). Refused — before the
   * gate, so nothing is asked for a call that cannot run — or denied: an error
   * result like any call's. Accepted: PREPARE (all I/O: the fresh system
   * prompt and skill set, the active skills re-read through the NEW
   * activator), then COMMIT in one synchronous stretch — the history replaced
   * in place, the skill set installed, the guard updated — up to the
   * `context_reset` event, the daemon's barrier. Only where a `history_commit`
   * may be yielded (between calls: no push is pending its `pop`). Returns
   * whether the context was reset. A cancel or a failure before the commit
   * leaves the history, the skill set and the counters untouched.
   */
  private async *runContextReset(
    call: ToolCall,
    config: NonNullable<AgentConfig["contextReset"]>,
    messages: ChatMessage[],
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEvent, boolean> {
    const answer = function* (result: ToolResult): Generator<AgentEvent> {
      yield { type: "tool_result", id: call.id, name: call.name, result };
      messages.push(toolMessage(call.id, result));
      yield { type: "history_commit" };
    };
    const cancelled: ToolResult = { content: CANCELLED_TOOL_NOTE, isError: true };
    if (signal?.aborted) {
      // As any call reached after a cancel: answered, never asked.
      yield* answer(cancelled);
      return false;
    }
    yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };
    const input = parseArguments(call.arguments);
    // Its own assistant message (the last one naming it, a resumed round too).
    const own = messages.findLast((m) => m.toolCalls?.some((c) => c.id === call.id));
    const refusal = resetRefusal({
      calls: own?.toolCalls?.length ?? 0,
      prompt: (input as { prompt?: unknown }).prompt,
      otherCallSinceReset: this.otherCallSinceReset,
      resetsThisMessage: this.resetsThisMessage,
      maxPerMessage: config.maxPerMessage,
    });
    if (refusal !== null) {
      yield* answer({ content: refusal, isError: true });
      return false;
    }
    const tool = this.config.tools.get(CONTEXT_RESET_TOOL_NAME);
    if (!tool) {
      return false; // unreachable: the caller checked it
    }
    const outcome = await this.gate.authorize(tool, input, {
      sessionId: toolContext.sessionId,
      toolCallId: call.id,
      signal: toolContext.signal,
    });
    if (signal?.aborted) {
      yield* answer(cancelled);
      return false;
    }
    if (!outcome.allowed) {
      yield* answer(gateRefusal(call, outcome));
      return false;
    }
    // A `tool_call` hook may have rewritten the input: checked again.
    const prompt = resetPromptOf(outcome.input);
    if (prompt === null) {
      yield* answer({
        content: resetRefusal({
          calls: 1,
          prompt: undefined,
          otherCallSinceReset: true,
          resetsThisMessage: 0,
          maxPerMessage: -1,
        }) as string,
        isError: true,
      });
      return false;
    }

    // PREPARE — every read, no effect: a cancel or a failure leaves all as is.
    let fresh: Awaited<ReturnType<typeof config.refresh>>;
    let carried: ReturnType<typeof carryOverSkills>;
    try {
      fresh = await unlessAborted(config.refresh(), signal);
      carried = carryOverSkills(
        await this.reloadSkills(
          toolContext.sessionId,
          messages,
          signal,
          fresh.skills.activator ?? null,
        ),
      );
    } catch (error) {
      if (signal?.aborted) {
        yield* answer(cancelled);
        return false;
      }
      yield* answer({
        content: `context_reset failed: could not rebuild the context: ${error instanceof Error ? error.message : String(error)}; the context was NOT reset.`,
        isError: true,
      });
      return false;
    }
    if (signal?.aborted) {
      yield* answer(cancelled);
      return false;
    }
    const before = offeredSkillNames(this.config.tools.definitions());
    const after = fresh.skills.tool
      ? offeredSkillNames(new ToolRegistry().register(fresh.skills.tool).definitions())
      : [];
    const next = contextResetHistory({
      systemPrompt: fresh.systemPrompt,
      prompt,
      ...this.runningBackground(),
      skills: carried,
    });
    const delta = skillSetDelta(before, after);
    // Display only, NOT pushed: the call is discarded with the old history.
    yield {
      type: "tool_result",
      id: call.id,
      name: call.name,
      result: {
        content: `Context reset — continuing from the restart prompt.${delta === "" ? "" : `\n${delta}`}`,
      },
    };

    // COMMIT (a cancel from here on lands on the fresh history: the loop's
    // top ends the turn there) — one synchronous stretch, no `await`, up to the event.
    messages.length = 0;
    messages.push(...next);
    this.installSkills(fresh.skills);
    this.anchors.delete(messages);
    this.config.hooks?.forgetModelRequestBaseline(toolContext.sessionId);
    this.resetsThisMessage++;
    this.otherCallSinceReset = false;
    yield { type: "context_reset", messages: [...messages] };
    return true;
  }

  /**
   * Write the user's skill activation as a `skill` round, the same events and
   * history a model call of the tool produces: the assistant's call
   * (committed), `tool_start`, the activator's result (transformed like any
   * tool result), `tool_result`, the `tool` message (committed). Already
   * active → the activator's "already loaded" note: the round still runs, so
   * neither the user nor the model is left guessing. A cancel during the read
   * answers the call as cancelled (the round stays valid); the loop's top then
   * ends the turn.
   */
  private async *runUserSkill(
    name: string,
    messages: ChatMessage[],
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEvent> {
    const call = userSkillCall(name);
    messages.push({ role: "assistant", content: "", toolCalls: [call] });
    const owner = messages.at(-1);
    let inHand: ChatMessage | undefined;
    let settled = false;
    yield { type: "history_commit" };
    try {
      yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };
      const cancelled: ToolResult = { content: CANCELLED_TOOL_NOTE, isError: true };
      let run: ToolRun;
      const activator = this.activator;
      if (signal?.aborted) {
        run = { result: cancelled };
      } else if (!activator) {
        run = { result: { content: `Unknown skill "${name}".`, isError: true } };
      } else {
        // Like the compaction re-read: a read can hang and takes no signal, so
        // a cancel must not wait for it. Only the read is timed, not the transforms.
        run = await unlessAborted(
          (async (): Promise<ToolRun> => {
            const timed = await this.timed(() => activator.activate(name, toolContext));
            return {
              result: await this.transformResult(call, timed.result, signal, {
                sessionId: toolContext.sessionId,
              }),
              ...(timed.durationMs !== undefined ? { durationMs: timed.durationMs } : {}),
            };
          })(),
          signal,
        ).catch(
          (error: unknown): ToolRun =>
            signal?.aborted
              ? { result: cancelled }
              : {
                  result: {
                    content: `Could not load skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                  },
                },
        );
      }
      const { result, durationMs } = run;
      // In hand across the yield: a consumer that stops at the `tool_result` has
      // seen this result, so it must reach the history (Part B).
      const message = toolMessage(call.id, result, durationMs);
      inHand = message;
      yield {
        type: "tool_result",
        id: call.id,
        name: call.name,
        result,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      messages.push(message);
      inHand = undefined;
      settled = true;
      yield { type: "history_commit" };
    } finally {
      // No yield, no await. A skill read has no "not started" window worth
      // distinguishing: "Interrupted" is the conservative answer.
      if (!settled && owner !== undefined && messages.lastIndexOf(owner) !== -1) {
        if (inHand !== undefined) {
          messages.push(inHand);
        }
        messages.push(
          ...answerOutstandingCalls(messages, owner, [call], () => TURN_STOPPED_INTERRUPTED_NOTE),
        );
      }
    }
  }

  /**
   * Drain the running children's notes ONLY (`agent_message` members), leaving
   * every exit in place: a child's or a shell job's exit keeps today's
   * turn-start behaviour. Synchronous (the late-drain invariant) and order
   * preserving.
   */
  private flushAgentMessages(messages: ChatMessage[]): AgentEvent[] {
    const notes: PendingAgentMessage[] = [];
    let kept = 0;
    for (let i = 0; i < this.pendingExits.length; i++) {
      const job = this.pendingExits[i];
      if (job !== undefined && isAgentMessage(job)) {
        notes.push(job);
      } else if (job !== undefined) {
        this.pendingExits[kept++] = job;
      }
    }
    if (notes.length === 0) {
      return [];
    }
    this.pendingExits.length = kept;
    const events: AgentEvent[] = [];
    for (const note of notes) {
      const message = agentMessageNote(note);
      messages.push(message);
      events.push({ type: "context_note", text: message.content, reason: "background_exit" });
    }
    return events;
  }

  /**
   * Drain finished background jobs into the conversation. Returns the events to
   * emit; appends a user-visible note per job so the model learns it ended and
   * can read its output. A no-op when nothing has exited. `deliveredNote` says a
   * child's `agent_notify` was among them: that note is the ONE thing a notice
   * asked a client to wake for, so the turn it wakes must not be cut short as a
   * stale wake (Q4 a, docs/feat/agent-message-two-way.md).
   */
  private flushBackgroundExits(messages: ChatMessage[]): {
    readonly events: AgentEvent[];
    readonly deliveredNote: boolean;
  } {
    if (this.pendingExits.length === 0) {
      return { events: [], deliveredNote: false };
    }
    const exits = this.pendingExits.splice(0);
    const events: AgentEvent[] = [];
    let deliveredNote = false;
    for (const job of exits) {
      // BEFORE the `agentId` branch: a note has an id too, and its own note shape.
      if (isAgentMessage(job)) {
        const message = agentMessageNote(job);
        messages.push(message);
        deliveredNote = true;
        events.push({ type: "context_note", text: message.content, reason: "background_exit" });
        continue;
      }
      // The user's own note (docs/feat/subagent-panel.md): the message, and NO
      // event — the live notice came from `session/subagent_message`.
      if (isUserNote(job)) {
        messages.push(userToSubagentNote(job));
        continue;
      }
      if ("agentId" in job) {
        const status = job.stopReason === "cancelled" ? "killed" : "exited";
        events.push({
          type: "background_exit",
          jobId: job.agentId,
          command: job.description,
          status,
          exitCode: null,
          agent: { stopReason: job.stopReason, toolUses: job.toolUses },
        });
        // The same helper as a load's note, with the live headline.
        const message = subagentReportNote(
          { ...job, state: "ended" },
          `[background] sub-agent ${job.agentId} (${job.description}) finished (${job.stopReason}):`,
        );
        messages.push(message);
        events.push({ type: "context_note", text: message.content, reason: "background_exit" });
        continue;
      }
      events.push({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
      const code = job.exitCode !== null ? ` with exit code ${job.exitCode}` : "";
      const note = `[background] job ${job.id} (\`${job.command}\`) ${job.status}${code}. Read its output with shell_output({ job_id: "${job.id}" }) if relevant.`;
      // `note`: a resume renders it as a notice, not as a row the person typed
      // (docs/feat/subagent-ledger-log.md, M3). The model still sees `content`.
      messages.push({
        role: "user",
        content: note,
        note: { kind: NOTE_KIND.backgroundExit, id: job.id },
      });
      events.push({ type: "context_note", text: note, reason: "background_exit" });
    }
    return { events, deliveredNote };
  }

  /**
   * Run a tool result through the configured transforms. Large output is spilled
   * and replaced in-context with a preview + pointer. With `config.toolOutput`
   * it goes to the daemon host's cache (never the project, never through the
   * confined `env`); without one, to `.tentacle/tool-output/<tool>-<id>.txt` via
   * `env.writeFile` (the library fallback).
   */
  private async transformResult(
    call: ToolCall,
    result: ToolResult,
    signal: AbortSignal | undefined,
    extra: { readonly sessionId: string; readonly input?: unknown },
  ): Promise<ToolResult> {
    const transforms = this.config.resultTransforms;
    if (!transforms || transforms.length === 0) {
      return result;
    }
    const hooks = this.config.hooks;
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
    const scope = this.config.spillScope;
    const callId = this.spillId(extra.sessionId, scope, call);
    const path = `.tentacle/tool-output/${scope !== undefined ? `${safe(scope)}-` : ""}${safe(call.name)}-${safe(callId)}.txt`;
    const sink = this.config.toolOutput;
    return applyResultTransforms(result, transforms, {
      toolName: call.name,
      toolCallId: call.id,
      ...(signal ? { signal } : {}),
      sessionId: extra.sessionId,
      input: "input" in extra ? extra.input : parseArguments(call.arguments),
      ...(hooks ? { hooks } : {}),
      writeSpill: async (contents) => {
        try {
          if (sink) {
            return await sink.write(
              extra.sessionId,
              call.name,
              scope !== undefined ? `${scope}-${callId}` : callId,
              contents,
            );
          }
          await this.config.env.writeFile(path, contents);
          return path;
        } catch {
          return null;
        }
      },
    });
  }

  /**
   * The env FALLBACK path only (no `toolOutput` sink; the sink's store creates
   * files exclusively and is the truth on names): a call id unique within this
   * agent, since a server may reuse one (two `agent_task` calls of one message).
   * The first use keeps the id as is. The check and the claim are synchronous,
   * so parallel calls cannot both take a name.
   */
  private spillId(sessionId: string, scope: string | undefined, call: ToolCall): string {
    if (this.config.toolOutput) {
      return call.id;
    }
    let id = call.id;
    for (let n = 2; ; n += 1) {
      const key = `${sessionId}\0${scope ?? ""}\0${call.name}\0${id}`;
      if (!this.spillNames.has(key)) {
        this.spillNames.add(key);
        return id;
      }
      id = `${call.id}~${n}`;
    }
  }

  /**
   * Run `work` (a tool's `execute`, a skill read) timed on the monotonic
   * clock: its integer ms ≥ 0 rides as `durationMs` (docs/fix/tool-duration.md).
   */
  private async timed(work: () => Promise<ToolResult>): Promise<ToolRun> {
    const now = this.config.now ?? (() => performance.now());
    const start = now();
    const result = await work();
    return { result, durationMs: Math.max(0, Math.round(now() - start)) };
  }

  /**
   * Phase 1 of a call: authorize it (if the tool needs it). `done`: a result
   * without running — cancelled (the abort is checked first, whatever the
   * answer: a request settled by a cancel comes back as a refusal, the
   * daemon's `cancelled`, and must read as cancelled, never as a denial the
   * user did not give; an approval that lands after a cancel must not start
   * the tool) or refused. `run`: the arguments it will run with (a
   * `tool_call` hook may rewrite them) and the effective input, for the
   * `tool_result` hooks and the scheduler's keys. `groupStart`: the head of
   * the call's group (absent = a call alone, its own group —
   * docs/feat/round-groups-persistence.md). `beforeStart` (a resumed round's
   * call alone) is awaited after an allow, then the abort is checked again.
   * Never runs the tool.
   */
  private async authorizeCall(
    call: ToolCall,
    ctx: ToolContext,
    opts: { readonly groupStart?: string; readonly beforeStart?: BeforeResumedCall | undefined },
  ): Promise<Prepared> {
    const tool = this.config.tools.get(call.name);
    const input = parseArguments(call.arguments);
    if (!tool) {
      // Unknown: the registry answers it (an error result), timed like a run.
      return { kind: "run", call, args: call.arguments, input };
    }
    const outcome = await this.gate.authorize(tool, input, {
      sessionId: ctx.sessionId,
      toolCallId: call.id,
      ...(opts.groupStart !== undefined ? { groupStart: opts.groupStart } : {}),
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) {
      return { kind: "done", result: cancelledResult(), input: outcome.input };
    }
    if (!outcome.allowed) {
      return { kind: "done", result: gateRefusal(call, outcome), input: outcome.input };
    }
    if (opts.beforeStart) {
      await opts.beforeStart(ctx.signal);
      // A cancel released the wait: the call must not start.
      if (ctx.signal.aborted) {
        return { kind: "done", result: cancelledResult(), input: outcome.input };
      }
    }
    if (!outcome.modified) {
      // Unchanged: the raw argument string, byte-identical to a hook-less run.
      return { kind: "run", call, args: call.arguments, input };
    }
    return {
      kind: "run",
      call,
      args: JSON.stringify(outcome.input),
      input: outcome.input,
      hookName: outcome.hookName ?? "hook",
    };
  }

  /**
   * Phase 2 of a call: run an authorized call. Returns the result, the input
   * it ran with, and the run's `durationMs`: the clock is read only around
   * `execute` — the prompt wait and the pre-hooks are never tool time. Never
   * throws (`ToolRegistry.execute` catches everything).
   */
  private async executeCall(
    prepared: RunPrepared,
    ctx: ToolContext,
  ): Promise<ToolRun & { input: unknown }> {
    const { call, args, input, hookName } = prepared;
    const run = await this.timed(() => this.config.tools.execute(call.name, args, ctx));
    if (hookName === undefined) {
      return { ...run, input };
    }
    // H4: the history keeps the model's original arguments, so say what ran.
    const ran = clipText(args, 500);
    return {
      result: {
        ...run.result,
        content: `[hook] input modified by hook ${hookName}; ran with: ${ran}\n${run.result.content}`,
        hook: { action: "modified", name: hookName },
      },
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      input,
    };
  }
}

/** An authorized call, ready to run (`Agent.authorizeCall`). */
interface RunPrepared {
  readonly kind: "run";
  readonly call: ToolCall;
  /** The argument string it runs with: the model's, or the hook-rewritten input. */
  readonly args: string;
  /** The effective input (for the `tool_result` hooks and the scheduler's keys). */
  readonly input: unknown;
  /** Set iff a `tool_call` hook rewrote the input (the H4 banner). */
  readonly hookName?: string;
}

/** A call's phase-1 outcome: answered without running, or ready to run. */
type Prepared =
  | { readonly kind: "done"; readonly result: ToolResult; readonly input: unknown }
  | RunPrepared;

/** A fresh cancelled result (a call that never started). */
function cancelledResult(): ToolResult {
  return { content: CANCELLED_TOOL_NOTE, isError: true };
}

/** The result of a call the gate refused: blocked by a hook, nobody to ask, or denied. */
function gateRefusal(
  call: ToolCall,
  outcome: Extract<GateOutcome, { allowed: false }>,
): ToolResult {
  if (outcome.by === "hook") {
    const name = outcome.hookName ?? "hook";
    return {
      content: `Blocked by a hook: \`${call.name}\` was not run. Reason: ${outcome.reason ?? ""}`,
      isError: true,
      hook: {
        action: "blocked",
        name,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      },
    };
  }
  if (outcome.by === "unavailable") {
    return {
      content: `Permission could not be requested: ${outcome.reason ?? "no client to ask"}. \`${call.name}\` was not run.`,
      isError: true,
    };
  }
  const denied = `Permission denied by the user: \`${call.name}\` was not run.`;
  if (outcome.message === undefined) {
    return { content: denied, isError: true };
  }
  // The person's reply (docs/feat/permission-reply.md): the turn goes on, so
  // the model answers it or changes plan instead of guessing why.
  return {
    content: `${denied} The user replied:\n${outcome.message}\n${REPLY_GUIDANCE}`,
    isError: true,
    denialReply: outcome.message,
  };
}

/**
 * A denial's reply survives the result transforms only if they left the
 * content byte-identical: a redaction, a hook or a spill that rewrote it means
 * the structured copy could show what the model did not see (or a secret).
 */
function keepDenialReply(raw: ToolResult, transformed: ToolResult): ToolResult {
  if (transformed.denialReply === undefined || transformed.content === raw.content) {
    return transformed;
  }
  const { denialReply: _dropped, ...rest } = transformed;
  return rest;
}

/** The line after a denial's reply: what the model should do with it. */
const REPLY_GUIDANCE =
  "Answer the user or change your approach; request this tool again only if you still need it.";

/** A call's parsed arguments; `{}` when empty or malformed (the registry reports those). */
function parseArguments(args: string): unknown {
  try {
    return args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    return {};
  }
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
