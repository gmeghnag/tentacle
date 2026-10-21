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
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  type PermissionRequester,
  type ToolCall,
  type ToolContext,
  type ToolProgressEvent,
  type ToolResult,
  type Usage,
  allowAll,
} from "@tentacle/core";
import {
  SKILL_TOOL_NAME,
  type ToolRegistry,
  skillActivations,
  skillContentName,
} from "@tentacle/tools";
import { type CarriedSkill, summarizeConversation } from "./compact.ts";
import { EventQueue } from "./event-queue.ts";
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

export interface RunOptions {
  /**
   * Continue a turn suspended before this tool call (a daemon restart): run it
   * and the rest of its round — each through the permission gate again — then
   * the loop as usual. Explicit, never inferred from the history: only the
   * caller's record knows the call never started.
   */
  readonly resumeFrom?: string;
}

/** Max consecutive empty-response auto-nudges before a stall ends the turn. */
const MAX_EMPTY_CONTINUES = 2;
/** The internal nudge injected to un-stick a model that returned an empty round. */
const CONTINUE_NUDGE = "Continue with the task.";
/** Result recorded for a tool call skipped because the user cancelled mid-round,
 * so the assistant's `toolCalls` stay answered in the history. */
const CANCELLED_TOOL_NOTE = "Cancelled by the user before this tool ran.";

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
  | { readonly type: "steer"; readonly text: string }
  // The loop itself added a user-role message to the history (the empty-round
  // nudge, a background-job note): emitted right after the push, so every
  // history message has an event and a replay can rebuild it.
  | {
      readonly type: "context_note";
      readonly text: string;
      readonly reason: "continue" | "background_exit";
    }
  // The history now reflects every event yielded so far (a consistent cut for a
  // snapshot + replay). Carries no data; frontends ignore it. Yielded only
  // where that holds — never between a push and the `pop` that may undo it.
  | { readonly type: "history_commit" }
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
  /** Background-job registry; when set, the shell tools can launch jobs and
   * their exits are surfaced to the model (and frontend) on the next turn. */
  readonly jobs?: JobController;
  /** Transforms applied to every tool result before it enters the conversation
   * (e.g. spilling large output to a file). Applied in order. */
  readonly resultTransforms?: readonly ResultTransform[];
}

/**
 * `work`'s outcome, unless `signal` aborts first: then reject with its reason
 * at once (the work is left to finish unobserved — only for work that is safe
 * to abandon, like a read).
 */
/** A call's arguments as JSON (`{}` when empty or not JSON — as `runTool` reads them). */
function parseArguments(call: ToolCall): unknown {
  try {
    return call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return {};
  }
}

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

export class Agent {
  private readonly config: AgentConfig;
  private readonly gate: PermissionGate;
  /** Background jobs that finished since the last turn, awaiting surfacing. */
  private readonly pendingExits: BackgroundJob[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.gate = new PermissionGate(config.requestPermission ?? allowAll);
    // Collect background-job exits as they happen; they are flushed into the
    // conversation (and event stream) at the top of the next turn.
    config.jobs?.onExit((job) => this.pendingExits.push(job));
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
   * `/compact`): the original activation call is run again through the same
   * path as in a turn (gate, tool, result transforms), with an empty history
   * so it is not deduplicated. When the skill is no longer offered
   * (`unavailable`: not run at all) or the run does not yield it
   * (`unreadable`), the content from the history is used instead. Emits no
   * events: not a turn.
   */
  async reloadSkills(
    sessionId: string,
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarriedSkill[]> {
    const ctx: ToolContext = {
      sessionId,
      signal: signal ?? new AbortController().signal,
      env: this.config.env,
      history: [],
    };
    const skills: CarriedSkill[] = [];
    const tool = this.config.tools.get(SKILL_TOOL_NAME);
    for (const { name, call, content, resultIndex } of skillActivations(messages)) {
      const stored = { name, call, content, resultIndex };
      // No longer offered (removed, hidden, skills disabled): nothing to read.
      if (!tool || !tool.inputSchema.safeParse(parseArguments(call)).success) {
        skills.push({ ...stored, source: "unavailable" });
        continue;
      }
      // A read can hang (a pod's exec, a stuck mount) and `readFile` takes no
      // signal: a cancel must still end the compaction and free the busy slot.
      const result = await unlessAborted(
        (async () => this.transformResult(call, await this.runTool(call, ctx), signal))(),
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
    messages.push(...userMessages);
    yield* this.runMessages(messages, sessionId, signal);
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
    // A negative limit means "unlimited" (the loop only ends on end_turn /
    // cancel / error); otherwise cap the number of model/tool rounds.
    const configured = this.config.maxIterations ?? 16;
    const maxIterations = configured < 0 ? Number.POSITIVE_INFINITY : configured;
    // How many times in a row we auto-nudge a stalled model (an empty round:
    // no text, no tool calls) to continue before giving up, so a stall after a
    // tool result doesn't silently end the turn (the user had to type "go on").
    let emptyRounds = 0;
    const toolContext: ToolContext = {
      sessionId,
      signal: signal ?? new AbortController().signal,
      env: this.config.env,
      ...(this.config.jobs ? { jobs: this.config.jobs } : {}),
      history: messages,
    };

    // A resumed turn first finishes its suspended round — exactly the calls an
    // uninterrupted run would still have run, each asked again — so the round's
    // results follow its assistant message with nothing in between.
    if (resumed) {
      yield* this.runToolCalls(resumed, messages, toolContext, signal);
    }

    // Surface any background jobs that finished since the last turn: emit an
    // event for the frontend and inject a note so the model knows to react.
    // (After a resumed round, never inside it: a note between an assistant's
    // tool calls and their results is an invalid history.)
    for (const event of this.flushBackgroundExits(messages)) {
      yield event;
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) {
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }

      // Inject any user messages queued since the last boundary (steering).
      for (const text of drainSteering?.() ?? []) {
        messages.push({ role: "user", content: text });
        yield { type: "steer", text };
      }

      const request: ChatRequest = {
        messages,
        tools: this.config.tools.definitions(),
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        ...(signal ? { signal } : {}),
      };

      let text = "";
      const toolCalls: ToolCall[] = [];
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
          ...messages,
          {
            role: "user",
            content:
              "You've reached the step limit. Give your final answer/report now, " +
              "using what you've gathered so far. Do not call any tools.",
          },
        ];
        let finalText = "";
        for await (const event of this.config.model.stream({
          messages: finalMessages,
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(signal ? { signal } : {}),
        })) {
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
          yield { type: "turn_end", reason: "cancelled" };
          return;
        }
        // Persist only the summary (not the synthetic nudge), so history stays clean.
        if (finalText.trim() !== "") {
          messages.push({ role: "assistant", content: finalText });
        }
      } catch (error) {
        if (signal?.aborted) {
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

    yield { type: "turn_end", reason: "max_iterations" };
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
      const raw = await resultPromise;
      const result = await this.transformResult(call, raw, signal);
      yield { type: "tool_result", id: call.id, name: call.name, result };
      messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      // After the push, not before: the `tool_result` above precedes it.
      yield { type: "history_commit" };
    }
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
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const transforms = this.config.resultTransforms;
    if (!transforms || transforms.length === 0) {
      return result;
    }
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
    const path = `.tentacle/tool-output/${safe(call.name)}-${safe(call.id)}.txt`;
    return applyResultTransforms(result, transforms, {
      toolName: call.name,
      toolCallId: call.id,
      ...(signal ? { signal } : {}),
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

  /** Authorize (if the tool needs it) and then run a single tool call. */
  private async runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.config.tools.get(call.name);
    if (tool) {
      let input: unknown = {};
      try {
        input = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
      } catch {
        input = {};
      }
      const allowed = await this.gate.authorize(tool, input);
      // The abort first, whatever the answer: a request settled by a cancel
      // comes back as a refusal (the daemon's `cancelled`) and must read as
      // cancelled, never as a denial the user did not give; and an approval
      // that lands after a cancel must not start the tool.
      if (ctx.signal.aborted) {
        return { content: CANCELLED_TOOL_NOTE, isError: true };
      }
      if (!allowed) {
        return {
          content: `Permission denied by the user: \`${call.name}\` was not run.`,
          isError: true,
        };
      }
    }
    return await this.config.tools.execute(call.name, call.arguments, ctx);
  }
}
