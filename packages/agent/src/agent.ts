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
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ContextUsage,
  type ExecutionEnvironment,
  HeuristicTokenCounter,
  type JobController,
  type ModelProvider,
  type PermissionRequester,
  type TokenCounter,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolProgressEvent,
  type ToolResult,
  type Usage,
  allowAll,
} from "@tentacle/core";
import {
  SKILL_TOOL_NAME,
  type SkillActivator,
  type ToolRegistry,
  skillActivations,
  skillContentName,
  userSkillCall,
} from "@tentacle/tools";
import { type CarriedSkill, summarizeConversation } from "./compact.ts";
import {
  type ContextAnchor,
  estimateUsed,
  lastEmitted,
  renderForModel,
  shouldEmit,
} from "./context-awareness.ts";
import { EventQueue } from "./event-queue.ts";
import { type AskHooksTrust, type HookRunner, hookNote } from "./hooks.ts";
import { PermissionGate } from "./permission-gate.ts";
import { type ResultTransform, applyResultTransforms } from "./result-pipeline.ts";
import { suspendedCalls } from "./resume.ts";

export type AgentStopReason = "end_turn" | "cancelled" | "max_iterations";

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
}

/** The context-line estimate's counter when the config names none. */
const DEFAULT_COUNTER = new HeuristicTokenCounter();
/** Max consecutive empty-response auto-nudges before a stall ends the turn. */
const MAX_EMPTY_CONTINUES = 2;
/** Max `turn_end` hook continues per turn (R2, docs/feat/hooks-turn.md). */
const MAX_HOOK_CONTINUES = 3;
/** The internal nudge injected to un-stick a model that returned an empty round. */
const CONTINUE_NUDGE = "Continue with the task.";
/** Result recorded for a tool call skipped because the user cancelled mid-round,
 * so the assistant's `toolCalls` stay answered in the history. */
const CANCELLED_TOOL_NOTE = "Cancelled by the user before this tool ran.";

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
  };
}

/** A tool run's outcome: `durationMs` is set iff the tool (or the skill read) actually ran. */
interface ToolRun {
  readonly result: ToolResult;
  readonly durationMs?: number;
}

/** The last user message's text, for `turn_start` hooks ("" if none). */
function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      return m.content;
    }
  }
  return "";
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
  | { readonly type: "usage"; readonly usage: Usage }
  // Nested sub-agent progress (the `agent_task` tool), keyed by the parent tool-call id.
  | {
      readonly type: "subagent_start";
      readonly id: string;
      readonly agentType: string;
      readonly description: string;
    }
  | { readonly type: "subagent_tool"; readonly id: string; readonly label: string }
  | {
      readonly type: "subagent_end";
      readonly id: string;
      readonly toolUses: number;
      readonly stopReason: string;
    }
  // A background shell job finished; surfaced at the start of the next turn.
  | {
      readonly type: "background_exit";
      readonly jobId: string;
      readonly command: string;
      readonly status: string;
      readonly exitCode: number | null;
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
      };
    case "subagent_tool":
      return { type: "subagent_tool", id, label: event.label };
    case "subagent_end":
      return { type: "subagent_end", id, toolUses: event.toolUses, stopReason: event.stopReason };
  }
}

export interface AgentConfig {
  readonly model: ModelProvider;
  readonly tools: ToolRegistry;
  readonly env: ExecutionEnvironment;
  readonly systemPrompt?: string;
  /** Max tool-call rounds before giving up. Default 16. */
  readonly maxIterations?: number;
  readonly temperature?: number;
  /** Authorizes `"ask"` tools before they run. Defaults to approving all. */
  readonly requestPermission?: PermissionRequester;
  /** User hooks (docs/feat/hooks-core.md): `tool_call` in the gate, `tool_result` in the pipeline. */
  readonly hooks?: HookRunner;
  /** The trust asker when a turn brings none (the in-process TUI: no RPC). */
  readonly askHooksTrust?: AskHooksTrust;
  /** Background-job registry; when set, the shell tools can launch jobs and
   * their exits are surfaced to the model (and frontend) on the next turn. */
  readonly jobs?: JobController;
  /** Transforms applied to every tool result before it enters the conversation
   * (e.g. spilling large output to a file). Applied in order. */
  readonly resultTransforms?: readonly ResultTransform[];
  /**
   * Activates skills: the user's `/name` round and the `/compact` re-read.
   * (The model's `skill` tool, registered in `tools`, is a façade over the
   * same path with the narrower, model-offered enum.) Absent → no skills.
   */
  readonly skills?: SkillActivator;
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
}

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
 * the model's `skill` tool and the activator behind every activation. Absent
 * `tool` = none offered to the model (no `skill` tool); absent `activator` =
 * no skills at all.
 */
export interface SessionSkills {
  readonly tool?: Tool | undefined;
  readonly activator?: SkillActivator | undefined;
}

export class Agent {
  private readonly config: AgentConfig;
  private readonly gate: PermissionGate;
  /**
   * The activator behind every skill activation: `config.skills` at the start,
   * then whatever `installSkills` last put in.
   */
  private activator: SkillActivator | undefined;
  /** Background jobs that finished since the last turn, awaiting surfacing. */
  private readonly pendingExits: BackgroundJob[] = [];
  /**
   * The provider's last measure of each history (keyed by the array a Session
   * keeps for its life), so a turn's first request counts from real numbers.
   * Memory only: a reload starts from the estimate.
   */
  private readonly anchors = new WeakMap<ChatMessage[], ContextAnchor>();

  constructor(config: AgentConfig) {
    this.config = config;
    this.activator = config.skills;
    this.gate = new PermissionGate(config.requestPermission ?? allowAll, config.hooks);
    // Collect background-job exits as they happen; they are flushed into the
    // conversation (and event stream) at the top of the next turn.
    config.jobs?.onExit((job) => this.pendingExits.push(job));
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
    yield* this.runMessages(messages, sessionId, signal, undefined, { newFrom });
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
      yield* this.runToolCalls(resumed, messages, toolContext, signal);
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
    for (const event of this.flushBackgroundExits(messages)) {
      yield event;
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
        for (const steer of drainSteering?.() ?? []) {
          messages.push({ role: "user", content: steer });
          yield { type: "steer", text: steer };
        }
        yield { type: "turn_end", reason: "end_turn" };
        return;
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) {
        this.notifyTurnEnd(sessionId, "cancelled");
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }

      // Inject any user messages queued since the last boundary (steering).
      for (const text of drainSteering?.() ?? []) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }

      const tools = this.config.tools.definitions();
      this.noteContextUsage(messages, unseen, tools);
      // The model's copy: stored context lines rendered into `content`, always
      // (enabled or not), so every request repeats the same bytes for a
      // message an earlier one sent — the provider's prompt cache holds.
      const request: ChatRequest = {
        messages: messages.map(renderForModel),
        tools,
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        ...(signal ? { signal } : {}),
      };
      const sent = messages.length;
      unseen = sent;

      let text = "";
      const toolCalls: ToolCall[] = [];
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
              if (event.usage) {
                this.anchorContext(messages, sent, event.usage);
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

      messages.push(
        toolCalls.length > 0
          ? { role: "assistant", content: text, toolCalls }
          : { role: "assistant", content: text },
      );

      // Any real progress (text or a tool call) resets the stall counter.
      if (toolCalls.length > 0 || text.trim() !== "") {
        emptyRounds = 0;
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
        const late = drainSteering?.() ?? [];
        if (late.length > 0) {
          for (const text of late) {
            messages.push({ role: "user", content: text });
            yield { type: "steer", text };
          }
          continue;
        }
        // Empty round (no text, no tool calls): the model stalled — it stopped
        // after a tool result instead of continuing. Nudge it to carry on, a
        // bounded number of times, rather than ending the turn with nothing
        // (which forced the user to type "go on" to un-stick it). The nudge is
        // internal: it is not surfaced as a `steer` event.
        if (text.trim() === "" && emptyRounds < MAX_EMPTY_CONTINUES) {
          emptyRounds++;
          messages.pop(); // drop the empty assistant turn; keep history clean
          if (messages.at(-1)?.content !== CONTINUE_NUDGE) {
            messages.push({ role: "user", content: CONTINUE_NUDGE });
            yield { type: "context_note", text: CONTINUE_NUDGE, reason: "continue" };
          }
          continue;
        }
        yield { type: "turn_end", reason: "end_turn" };
        return;
      }

      yield* this.runToolCalls(toolCalls, messages, toolContext, signal);
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

    // Out of iterations. Give the model ONE final turn with no tools offered, so
    // it must deliver its answer/report in prose instead of calling yet another
    // tool. Without this, a turn (or a sub-agent) that spent its whole budget on
    // tool calls ends with no visible result at all ("stopped without a report").
    // Best-effort: any failure still ends the turn as `max_iterations`.
    if (!signal?.aborted) {
      // Anything queued during the last allowed round is injected first, so the
      // final report can address it (no round is left to run it otherwise).
      for (const text of drainSteering?.() ?? []) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
      try {
        const finalMessages: ChatMessage[] = [
          ...messages.map(renderForModel),
          {
            role: "user",
            content:
              "You've reached the step limit. Give your final answer/report now, " +
              "using what you've gathered so far. Do not call any tools.",
          },
        ];
        let finalText = "";
        const finalRequest: ChatRequest = {
          messages: finalMessages,
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(signal ? { signal } : {}),
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
      for (const text of drainSteering?.() ?? []) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }
    }

    this.notifyTurnEnd(sessionId, "max_iterations");
    yield { type: "turn_end", reason: "max_iterations" };
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

  /** `turn_end` notification hooks (cancelled / max_iterations): synchronous, never awaited. */
  private notifyTurnEnd(sessionId: string, reason: "cancelled" | "max_iterations"): void {
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
   * Run one round's tool calls in order: each is authorized and run, and its
   * result pushed and committed before the next one starts — so a history
   * suspended inside a call is always "earlier calls answered, this one and
   * the later ones not" (`suspendedCalls`). A call reached after an abort is
   * answered as cancelled without prompting, keeping the round answered.
   */
  private async *runToolCalls(
    calls: readonly ToolCall[],
    messages: ChatMessage[],
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEvent> {
    for (const call of calls) {
      if (signal?.aborted) {
        // The user cancelled while the previous tool ran (or before this one
        // could start). It must not start — and must not prompt for
        // permission either (`authorize` lives inside runTool). Answer it
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
        emitProgress: (event: ToolProgressEvent) => progress.push(progressToEvent(call.id, event)),
      };
      const resultPromise = this.runTool(call, ctx).finally(() => progress.close());
      for await (const event of progress.drain()) {
        yield event;
      }
      const { result: raw, input, durationMs } = await resultPromise;
      // After the duration was taken: a transform is harness time, not the tool's.
      const result = await this.transformResult(call, raw, signal, {
        sessionId: toolContext.sessionId,
        input,
      });
      yield {
        type: "tool_result",
        id: call.id,
        name: call.name,
        result,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      messages.push(toolMessage(call.id, result, durationMs));
      // After the push, not before: the `tool_result` above precedes it.
      yield { type: "history_commit" };
    }
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
    yield { type: "history_commit" };
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
    yield {
      type: "tool_result",
      id: call.id,
      name: call.name,
      result,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    messages.push(toolMessage(call.id, result, durationMs));
    yield { type: "history_commit" };
  }

  /**
   * Drain finished background jobs into the conversation. Returns the events to
   * emit; appends a user-visible note per job so the model learns it ended and
   * can read its output. A no-op when nothing has exited.
   */
  private flushBackgroundExits(messages: ChatMessage[]): AgentEvent[] {
    if (this.pendingExits.length === 0) {
      return [];
    }
    const exits = this.pendingExits.splice(0);
    const events: AgentEvent[] = [];
    for (const job of exits) {
      events.push({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
      const code = job.exitCode !== null ? ` with exit code ${job.exitCode}` : "";
      const note = `[background] job ${job.id} (\`${job.command}\`) ${job.status}${code}. Read its output with shell_output({ job_id: "${job.id}" }) if relevant.`;
      messages.push({ role: "user", content: note });
      events.push({ type: "context_note", text: note, reason: "background_exit" });
    }
    return events;
  }

  /**
   * Run a tool result through the configured transforms. Large output is spilled
   * to `.tentacle/tool-output/<tool>-<id>.txt` in the workspace (written via the
   * confined env, so it is portable to the container environment later) and
   * replaced in-context with a preview + pointer.
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
    const path = `.tentacle/tool-output/${safe(call.name)}-${safe(call.id)}.txt`;
    return applyResultTransforms(result, transforms, {
      toolName: call.name,
      toolCallId: call.id,
      ...(signal ? { signal } : {}),
      sessionId: extra.sessionId,
      input: "input" in extra ? extra.input : parseArguments(call.arguments),
      ...(hooks ? { hooks } : {}),
      writeSpill: async (contents) => {
        try {
          await this.config.env.writeFile(path, contents);
          return path;
        } catch {
          return null;
        }
      },
    });
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
   * Authorize (if the tool needs it) and then run a single tool call. Returns
   * the result and the input it ran with (a `tool_call` hook may rewrite it),
   * for the `tool_result` hooks, and the run's `durationMs` iff `execute` ran:
   * the clock is read only around `execute`, after `authorize` — the prompt
   * wait and the pre-hooks are never tool time.
   */
  private async runTool(call: ToolCall, ctx: ToolContext): Promise<ToolRun & { input: unknown }> {
    const tool = this.config.tools.get(call.name);
    const input = parseArguments(call.arguments);
    if (!tool) {
      const run = await this.timed(() => this.config.tools.execute(call.name, call.arguments, ctx));
      return { ...run, input };
    }
    const outcome = await this.gate.authorize(tool, input, {
      sessionId: ctx.sessionId,
      toolCallId: call.id,
      signal: ctx.signal,
    });
    // The abort first, whatever the answer: a request settled by a cancel
    // comes back as a refusal (the daemon's `cancelled`) and must read as
    // cancelled, never as a denial the user did not give; and an approval
    // that lands after a cancel must not start the tool.
    if (ctx.signal.aborted) {
      return { result: { content: CANCELLED_TOOL_NOTE, isError: true }, input: outcome.input };
    }
    if (!outcome.allowed) {
      if (outcome.by === "hook") {
        const name = outcome.hookName ?? "hook";
        return {
          result: {
            content: `Blocked by a hook: \`${call.name}\` was not run. Reason: ${outcome.reason ?? ""}`,
            isError: true,
            hook: {
              action: "blocked",
              name,
              ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            },
          },
          input: outcome.input,
        };
      }
      if (outcome.by === "unavailable") {
        return {
          result: {
            content: `Permission could not be requested: ${outcome.reason ?? "no client to ask"}. \`${call.name}\` was not run.`,
            isError: true,
          },
          input: outcome.input,
        };
      }
      return {
        result: {
          content: `Permission denied by the user: \`${call.name}\` was not run.`,
          isError: true,
        },
        input: outcome.input,
      };
    }
    if (!outcome.modified) {
      // Unchanged: the raw argument string, byte-identical to a hook-less run.
      const run = await this.timed(() => this.config.tools.execute(call.name, call.arguments, ctx));
      return { ...run, input };
    }
    const name = outcome.hookName ?? "hook";
    const { result, durationMs } = await this.timed(() =>
      this.config.tools.execute(call.name, JSON.stringify(outcome.input), ctx),
    );
    // H4: the history keeps the model's original arguments, so say what ran.
    const ran = clipText(JSON.stringify(outcome.input), 500);
    return {
      result: {
        ...result,
        content: `[hook] input modified by hook ${name}; ran with: ${ran}\n${result.content}`,
        hook: { action: "modified", name },
      },
      ...(durationMs !== undefined ? { durationMs } : {}),
      input: outcome.input,
    };
  }
}

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
