/**
 * Sub-agents: delegating a self-contained task to a child `Agent` with its own
 * isolated conversation. The child runs to completion and only its final report
 * (its visible output) is returned to the parent — the parent's context is never
 * polluted by the child's intermediate steps.
 *
 * The child inherits the parent's model, confined execution environment, and
 * permission requester (so writes stay confined and approval prompts still reach
 * the user). Its tool-set is restricted by the chosen agent *type*, and the
 * spawn tool itself is always removed from the child (depth-1 guard — no runaway
 * recursion). This module builds the child; the `agent_task` tool (in
 * `@tentacle/tools`) is the model-facing surface that calls it.
 */
import {
  type AgentInbox,
  type AgentNotifyResult,
  type ExecutionEnvironment,
  type ModelProvider,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  type Tool,
  type ToolProgressEvent,
  toolLabel,
} from "@tentacle/core";
import {
  AGENT_CONTROL_TOOL_NAME,
  AGENT_KILL_TOOL_NAME,
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_NOTIFY_TOOL_NAME,
  AGENT_STATUS_TOOL_NAME,
  CONTEXT_RESET_TOOL_NAME,
  ToolRegistry,
  createAgentNotifyTool,
} from "@tentacle/tools";
import { Agent, type AgentConfig, type AgentStopReason } from "./agent.ts";
import type { HookRunner } from "./hooks.ts";
import type { ResultTransform } from "./result-pipeline.ts";
import { classOf, isReadClass } from "./round-plan.ts";
import { SessionGrants } from "./session-grants.ts";

/** A kind of sub-agent: its system prompt and the tools it may use. */
export interface AgentType {
  readonly name: string;
  /** When to use it — shown to the model in the `agent_task` tool description. */
  readonly description: string;
  readonly prompt: string;
  /** Tool names the child may use; `"all"` = every parent tool (minus the spawn tool). */
  readonly tools: "all" | readonly string[];
  /**
   * The `agents/*.md` `model`: a `models` name, else a model id on the main
   * endpoint (docs/feat/models-map.md); resolved via `SubagentDeps.modelFor`.
   */
  readonly model?: string;
  /**
   * That model's context window (tokens), for the child's context line
   * (docs/feat/context-awareness.md). Absent → the parent's window.
   */
  readonly contextWindow?: number;
}

const GENERAL_PROMPT = `You are an autonomous sub-agent working on a focused task delegated by a
parent agent. Work independently to complete it end to end using the tools
available, then finish with a concise report of what you found or did — that
report is the ONLY thing the parent receives, so make it self-contained.`;

const EXPLORE_PROMPT = `You are a read-only investigator sub-agent. SEARCH first, then read: use
\`search\` to locate a symbol, string or file before you open anything, and
\`fs_read\` with \`offset\`/\`limit\` to read only the lines a hit pointed at.
Never open a file end to end "to get the picture" — a whole file, or one
large file read in slices, stays in your context for every later step and is
what makes an investigation expensive. Narrow the search (a file, a glob, a
tighter pattern) instead of reading more files.

You cannot modify anything. Finish with a concise, self-contained report of
your findings, citing concrete file paths and line references — that report is
the only thing the parent receives.`;

/** The built-in sub-agent types. */
export const BUILTIN_AGENT_TYPES: readonly AgentType[] = [
  {
    name: "general",
    description:
      "General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.",
    prompt: GENERAL_PROMPT,
    tools: "all",
  },
  {
    name: "explore",
    description:
      "Read-only investigator: searches and reads files to answer a question. Cannot modify anything.",
    prompt: EXPLORE_PROMPT,
    tools: ["fs_read", "search"],
  },
];

export interface SubagentRunOptions {
  readonly description: string;
  readonly prompt: string;
  /** The agent type name; falls back to the first type if unknown. */
  readonly type: string;
  /** The call's requested `models` name (the tool checked it); passed to `modelFor`. */
  readonly model?: string;
}

/** A child's model, chosen by the wiring (docs/feat/models-map.md). */
export interface SubagentModel {
  readonly provider: ModelProvider;
  /** The window the child counts against; absent → the parent's. */
  readonly contextWindow?: number;
  /** The model id the child's hooks report (`model` in a hook payload). */
  readonly modelId?: string;
  /**
   * The `models` NAME the child runs on (never an id, a URL or a key: AGENTS §7).
   * Set only by a pick that named an entry — absent for the parent's own model
   * (the `default` choice, where there is nothing to tell apart) and for a bare
   * frontmatter id. Whether the panel SHOWS it is the daemon's decision, taken
   * on every publish against the main agent's model of that moment
   * (docs/feat/subagent-panel.md, Review round 3 M2).
   */
  readonly name?: string;
}

export interface SubagentResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: AgentStopReason;
}

/**
 * Set on a child that may MOVE to the background while it runs
 * (docs/feat/subagent-detach.md). A foreground child's ask holds the turn,
 * which a move must leave: its ask is withdrawn (`withdrawn`) and asked again
 * on the background path, with the `sa-N` `background()` reports.
 */
export interface SubagentMoveControls {
  /** Aborted when the child moved: its open foreground ask is withdrawn. */
  readonly withdrawn: AbortSignal;
  /** `undefined` while the child is still foreground. */
  background(): { readonly id: string; readonly signal: AbortSignal } | undefined;
}

export interface SubagentRunControls {
  readonly signal?: AbortSignal;
  /** Live progress sink (start, each child tool call, end). */
  readonly onEvent?: (event: ToolProgressEvent) => void;
  /** The parent's `agent_task` call id: the child's permission asks are attributed to it. */
  readonly toolCallId?: string;
  /**
   * The parent's session id: the child's spilled output is filed under it, so
   * it goes with the session (docs/fix/tool-output-location.md). Absent → the
   * child's throwaway id.
   */
  readonly sessionId?: string;
  /**
   * Set on a BACKGROUND child (`sa-N`): its asks carry the id and its own
   * `signal`, so they outlive the launching turn and settle with the child.
   */
  readonly agentId?: string;
  /**
   * Set on a FOREGROUND child that may become a background one: its asks are
   * then withdrawable and, once it moved, re-asked as `sa-N`.
   */
  readonly move?: SubagentMoveControls;
  /**
   * The child's inbox (docs/feat/agent-message.md): every text a sender wrote
   * while it runs, drained at its next round boundary like a steer, and CLOSED
   * when the child stops reading (so a late text is refused, never lost).
   */
  readonly inbox?: AgentInbox;
}

/**
 * A child's requester: the parent's, with each ask attributed to the parent's
 * `agent_task` call (`parentCallId`) and tagged with the asking sub-agent.
 * These fields WIN over the child gate's own: the child's call ids are unknown
 * to the parent history, so one must never escape — without a parent id the
 * ask carries no `toolCallId` at all.
 *
 * `background`: a background child's ask carries the child's id and its own
 * signal, which the daemon uses to hold the ask apart from any turn.
 *
 * `move`: a FOREGROUND child that may move (docs/feat/subagent-detach.md). Its
 * ask carries `withdraw` while it is foreground; a `dismissed` answer reached
 * because of that withdrawal is re-asked ONCE on the background path, with the
 * `sa-N` id. A human's refusal is never `dismissed`, so it is never re-asked.
 */
export function subagentRequester(
  requester: PermissionRequester,
  parentCallId: string | undefined,
  agent: { readonly type: string; readonly description: string },
  background?:
    | { readonly id: string; readonly signal: AbortSignal }
    | { readonly move: SubagentMoveControls },
): PermissionRequester {
  const fixed = background !== undefined && "id" in background ? background : undefined;
  const move = background !== undefined && "move" in background ? background.move : undefined;
  const ask = (
    req: PermissionRequest,
    options: PermissionRequestOptions | undefined,
    owner: { readonly id: string; readonly signal: AbortSignal } | undefined,
    withdraw: AbortSignal | undefined,
  ): Promise<PermissionResponse> => {
    // A child's call ids are unknown to the parent history: never forwarded.
    const { toolCallId: _childCallId, groupStart: _childGroup, ...rest } = options ?? {};
    return requester(req, {
      ...rest,
      ...(parentCallId !== undefined ? { toolCallId: parentCallId } : {}),
      origin: "subagent",
      agent: owner ? { ...agent, id: owner.id } : agent,
      ...(owner ? { signal: owner.signal } : {}),
      ...(withdraw !== undefined ? { withdraw } : {}),
    });
  };
  return async (req, options) => {
    // A background child, or one that has already moved: the 6a path, at once.
    const owner = fixed ?? move?.background();
    const first = await ask(req, options, owner, owner ? undefined : move?.withdrawn);
    if (first.dismissed !== true || owner !== undefined) {
      return first;
    }
    // Withdrawn by the MOVE (not by a TUI unmounting): ask it again as `sa-N`.
    const moved = move?.background();
    if (moved === undefined) {
      return first;
    }
    return ask(req, options, moved, undefined);
  };
}

export type SubagentRunner = (
  opts: SubagentRunOptions,
  controls?: SubagentRunControls,
) => Promise<SubagentResult>;

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** A short label for a child tool call, for the nested progress tree. */
export function childToolLabel(name: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    return name;
  }
  const obj = asRecord(parsed);
  const str = (key: string): string | undefined =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;
  switch (name) {
    case "shell":
      return `$ ${str("command") ?? ""}`.trimEnd();
    case "fs_read":
      return `Read ${str("path") ?? ""}`.trimEnd();
    case "fs_write":
      return `Write ${str("path") ?? ""}`.trimEnd();
    case "fs_edit":
      return `Edit ${str("path") ?? ""}`.trimEnd();
    case "search": {
      // `Search <pattern> in <path>`. A pod's pattern is pod text (§7): the
      // label path already bounds it (`mapping.ts:64-66`).
      const target = str("pattern") ?? str("glob") ?? "";
      const path = str("path") ?? ".";
      return `Search ${target} in ${path}`.trimEnd();
    }
    default:
      return toolLabel(name);
  }
}

export interface SubagentDeps {
  readonly model: ModelProvider;
  /**
   * The child's model for a type and the call's requested `models` name.
   * `undefined` (or absent) → `model`, with the type's own `contextWindow`
   * if any, else the parent's window — the behaviour before `models`.
   */
  readonly modelFor?: (type: AgentType, requested: string | undefined) => SubagentModel | undefined;
  readonly env: ExecutionEnvironment;
  /** The parent's registry; a child gets a filtered subset, never the spawn tool. */
  readonly tools: ToolRegistry;
  readonly requestPermission?: PermissionRequester;
  readonly maxIterations?: number;
  /**
   * Token budget for each child's whole life (`prompt + completion` summed over
   * its model calls, across continuation passes); a positive integer or `-1`
   * (unlimited). Reaching it forces the child's final report —
   * docs/feat/subagent-token-budget.md.
   */
  readonly maxTokens?: number;
  readonly types?: readonly AgentType[];
  /**
   * Tools a child may use that the PARENT's registry does not hold, by type name
   * (docs/feat/explore-search.md: `explore` alone gets `search`, so the main
   * agent and `general` cannot call it). A name here is still subject to the
   * type's own allow-list, and to the spawn-tool exclusion below.
   */
  readonly extraTools?: (type: AgentType) => readonly Tool[];
  /** The spawn tool's name, always excluded from children (default `agent_task`). */
  readonly spawnToolName?: string;
  /** Result transforms (e.g. spill large output) given to each child agent. */
  readonly resultTransforms?: readonly ResultTransform[];
  /** The parent's hook runner; each child gets one tagged with its identity (H2). */
  readonly hooks?: HookRunner;
  /** Each child's own context lines over its own history (the parent's window). */
  readonly contextAwareness?: AgentConfig["contextAwareness"];
  /**
   * The session tree's approvals and ask lane: one "always" covers the parent
   * and every child (docs/feat/parallel-agents.md, Design 3). Absent → one
   * store shared by this runner's children.
   */
  readonly grants?: SessionGrants;
  /**
   * `tools.execution` / `tools.maxParallel` for each child's own rounds. Safe:
   * a child's asks stay in its own phase 1 and it never reaches a `beforeRun`;
   * the parent's `inFlight` already covers it (docs/feat/parallel-agents.md,
   * Design 5). Absent → sequential.
   */
  readonly toolExecution?: AgentConfig["toolExecution"];
  /** Where a child's large output is spilled (the parent's sink). Absent → the child's `env`. */
  readonly toolOutput?: AgentConfig["toolOutput"];
  /**
   * A running BACKGROUND child's way back to its parent agent
   * (docs/feat/agent-message-two-way.md): the session's `AgentJobs.notify`.
   * Absent (`subagents.twoWay` off) → no child is offered `agent_notify`.
   */
  readonly notify?: (agentId: string, text: string) => AgentNotifyResult;
}

/** Build a sub-agent runner plus the agent types it exposes. */
export function createSubagentRunner(deps: SubagentDeps): {
  run: SubagentRunner;
  types: readonly AgentType[];
  /**
   * Whether a type only reads: a closed list, every tool the registry has is
   * read-class. Asked live: MCP tools register after the runner is built.
   */
  readOnlyType(name: string): boolean;
} {
  const types = deps.types && deps.types.length > 0 ? deps.types : BUILTIN_AGENT_TYPES;
  const spawnToolName = deps.spawnToolName ?? "agent_task";
  const grants = deps.grants ?? new SessionGrants();

  const run: SubagentRunner = async (opts, controls) => {
    const type = types.find((t) => t.name === opts.type) ?? types[0];
    if (!type) {
      return { report: "no sub-agent type available", toolUses: 0, stopReason: "end_turn" };
    }
    // The child's model, picked BEFORE its start event so the row carries it: a
    // `models` name for the wire (never an id, AGENTS §7) and the resolved ID
    // daemon-side only, which is what a `model` label is decided against on
    // every publish (docs/feat/subagent-panel.md, Review round 3 M2).
    const chosen = deps.modelFor?.(type, opts.model);
    const onEvent = controls?.onEvent;
    onEvent?.({
      kind: "subagent_start",
      agentType: type.name,
      description: opts.description,
      ...(chosen?.name !== undefined ? { model: chosen.name } : {}),
      ...(chosen?.modelId !== undefined ? { modelId: chosen.modelId } : {}),
    });

    // Restrict the child's tools to the type's allow-list, always dropping the
    // spawn tool so a sub-agent cannot spawn its own sub-agents.
    const childTools = new ToolRegistry();
    // A type may need a tool the PARENT's registry does not hold (owner Q1 c:
    // `explore` alone gets `search`), so the runner offers it before filtering.
    // A name the parent already holds wins: one instance per tool in a child.
    const extra = deps.extraTools?.(type) ?? [];
    const parentTools = deps.tools.list();
    const parentNames = new Set(parentTools.map((tool) => tool.name));
    for (const tool of [...parentTools, ...extra.filter((tool) => !parentNames.has(tool.name))]) {
      // Nor its context reset (a child's context is its own, and short-lived),
      // nor `agent_control`: only where `background` is, the PARENT may see,
      // write to or stop a child it launched (owner Q1 a); a child given it could
      // read and kill its siblings silently (`permission: "none"`, sequential
      // ids) — `docs/feat/agent-status.md`. Its three old names stay listed: an
      // old `agents/*.md` may name one, and an old session's replay must not
      // hand it to a child either.
      if (
        tool.name === spawnToolName ||
        tool.name === CONTEXT_RESET_TOOL_NAME ||
        tool.name === AGENT_CONTROL_TOOL_NAME ||
        tool.name === AGENT_KILL_TOOL_NAME ||
        tool.name === AGENT_MESSAGE_TOOL_NAME ||
        tool.name === AGENT_STATUS_TOOL_NAME ||
        // A child's own `agent_notify` is built below, from the id it was given:
        // a parent registry must never hand one over.
        tool.name === AGENT_NOTIFY_TOOL_NAME
      ) {
        continue;
      }
      if (type.tools === "all" || type.tools.includes(tool.name)) {
        childTools.register(tool);
      }
    }
    // Only a child launched in the BACKGROUND has an `sa-N` to name itself by
    // (owner Q3 a): a foreground child's report already IS its reply. It
    // bypasses `type.tools` on purpose — a channel back, not a capability — so
    // a read-only `explore` child gets it too.
    if (deps.notify && controls?.agentId !== undefined) {
      childTools.register(createAgentNotifyTool(controls.agentId, deps.notify));
    }

    const model = chosen?.provider ?? deps.model;
    // The child counts against its own model's window: the chosen one's, else
    // (no choice) the type's own, else the parent's.
    const window = chosen !== undefined ? chosen.contextWindow : type.contextWindow;
    const contextAwareness =
      deps.contextAwareness && window !== undefined
        ? { ...deps.contextAwareness, window }
        : deps.contextAwareness;
    const child = new Agent({
      model,
      tools: childTools,
      env: deps.env,
      systemPrompt: type.prompt,
      ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
      ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      ...(deps.requestPermission
        ? {
            requestPermission: subagentRequester(
              deps.requestPermission,
              controls?.toolCallId,
              { type: type.name, description: opts.description },
              controls?.agentId !== undefined && controls.signal
                ? { id: controls.agentId, signal: controls.signal }
                : controls?.move !== undefined
                  ? { move: controls.move }
                  : undefined,
            ),
          }
        : {}),
      grants,
      // A server may reuse call ids: two children must not share a spill file.
      spillScope: crypto.randomUUID().slice(0, 8),
      ...(deps.toolOutput
        ? {
            toolOutput: {
              // Under the PARENT's session when known: deleting it deletes this.
              write: (sid: string, tool: string, id: string, contents: string) =>
                deps.toolOutput?.write(controls?.sessionId ?? sid, tool, id, contents) ??
                Promise.resolve(null),
            },
          }
        : {}),
      ...(deps.toolExecution ? { toolExecution: deps.toolExecution } : {}),
      ...(deps.resultTransforms ? { resultTransforms: deps.resultTransforms } : {}),
      ...(contextAwareness ? { contextAwareness } : {}),
      ...(deps.hooks
        ? {
            hooks: deps.hooks.forAgent(
              { type: type.name, description: opts.description },
              chosen?.modelId ?? (chosen === undefined ? type.model : undefined),
            ),
          }
        : {}),
    });

    let report = "";
    let toolUses = 0;
    let stopReason: AgentStopReason = "end_turn";
    // The child's own spend, summed from the same `usage` events the tree's row
    // counts (`subagent_usage`): the cap itself lives in the child's `Agent`,
    // but the REPORT has to say how much was spent, and only the runner knows
    // the cap and the count together.
    let tokens = 0;
    // ONE history and ONE session id across every pass of this child: a
    // continuation reads the same conversation (`Agent.run` would hide it, so
    // the runner drives `runMessages` itself).
    const messages = child.startConversation();
    const newFrom = messages.length;
    messages.push({ role: "user", content: opts.prompt });
    const sid = crypto.randomUUID();
    const inbox = controls?.inbox;
    // What `closeIfEmpty` handed back, for the pass that is about to start.
    let carry: string[] = [];
    // Texts the passes DRAINED with no model round left to answer them: the
    // `max_iterations` drain after the forced final report, and the drain a
    // `turn_start` stop does before ending the pass. They were pushed into the
    // history, so the inbox is empty and `close()` cannot see them; a child has
    // no next turn, so the report must. Counted per `steer` event and reset by
    // the first event that proves a round consumed the request carrying it
    // (`text`, `tool_start`, `usage`) — otherwise a text read at a boundary is
    // counted as unread too.
    let unanswered = 0;
    const drain = inbox
      ? () => (carry.length > 0 ? [...carry.splice(0), ...inbox.drain()] : inbox.drain())
      : undefined;
    let first = true;
    try {
      for (;;) {
        for await (const event of child.runMessages(
          messages,
          sid,
          controls?.signal,
          drain,
          first ? { newFrom, userMessage: true } : { userMessage: true },
        )) {
          if (event.type === "text") {
            report += event.delta;
            unanswered = 0;
          } else if (event.type === "tool_start") {
            toolUses += 1;
            unanswered = 0;
            onEvent?.({
              kind: "subagent_tool",
              label: childToolLabel(event.name, event.arguments),
            });
          } else if (event.type === "usage") {
            unanswered = 0;
            tokens += event.usage.promptTokens + event.usage.completionTokens;
            onEvent?.({
              kind: "subagent_usage",
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
            });
          } else if (event.type === "steer") {
            // Drained into the history for a round that may never come (see
            // `unanswered`): it is READ only if a round answers it.
            unanswered += 1;
          } else if (event.type === "turn_end") {
            stopReason = event.reason;
          }
        }
        first = false;
        // Only a clean end can continue: a cancelled, failed or capped child
        // stops here (its leftovers are reported below).
        if (
          inbox === undefined ||
          stopReason !== "end_turn" ||
          controls?.signal?.aborted === true
        ) {
          break;
        }
        // SYNCHRONOUS, in the same stretch as the run's end (the load-bearing
        // assumption, docs/feat/agent-message.md): a text that slipped in after
        // the last drain comes back and gets one more pass; an empty inbox is
        // CLOSED here, so no sender can push a text nobody would read.
        const more = inbox.closeIfEmpty();
        if (more.length === 0) {
          break;
        }
        carry = more;
      }
    } catch (error) {
      // Texts nobody will read are reported by the caller's path below
      // (`close` is idempotent); the report itself is the failure.
      carry.splice(0);
      inbox?.close();
      // The tree must not keep its live row beside the call's error.
      onEvent?.({ kind: "subagent_end", toolUses, stopReason: "error" });
      throw error;
    }
    // Whatever was never read is REPORTED, never silently dropped. `carry` holds
    // what `closeIfEmpty` handed back for a pass that may never have drained it
    // (a cancel between the two): it counts as unread, not as lost. `unanswered`
    // holds the texts the passes drained but no round answered (H1): the inbox
    // is empty then, so `close()` cannot see them, and a child has no next turn.
    const unread = [...carry.splice(0), ...(inbox?.close() ?? [])];
    const missed = unread.length + unanswered;
    if (missed > 0) {
      report += `\n\n(${missed} message(s) sent to this sub-agent arrived after it stopped and were not read.)`;
    }
    // Say WHY it stopped where the parent reads it: the model gets the tool
    // result, so it can narrow the task instead of re-spawning blindly. The
    // count is the runner's own (the cap's overshoot included), never rounded.
    // Appended to `finalReport` BELOW the empty-report fallback, which must still
    // fire for a child that wrote nothing (the note is not a report).
    const budgetNote =
      stopReason === "max_token_budget" && deps.maxTokens !== undefined && deps.maxTokens > 0
        ? `\n\n(token budget reached: ${tokens.toLocaleString("en-US")} of ${deps.maxTokens.toLocaleString("en-US")} tokens used)`
        : "";
    onEvent?.({ kind: "subagent_end", toolUses, stopReason });
    // Never hand the parent an empty report (the agent loop forces a final
    // summary even at the step limit, but a provider hiccup could still yield
    // nothing): a note explaining what happened beats silent emptiness.
    const trimmed = report.trim();
    const finalReport =
      trimmed !== ""
        ? trimmed
        : `(The ${type.name} sub-agent finished (${stopReason}) after ${toolUses} tool use(s) without producing a report. Try a narrower task or a higher limit.)`;
    return { report: `${finalReport}${budgetNote}`, toolUses, stopReason };
  };

  const readOnlyType = (name: string): boolean => {
    const type = types.find((t) => t.name === name);
    if (!type || type.tools === "all") {
      return false;
    }
    // The tool a CHILD of this type actually gets: the parent's, else the one
    // `extraTools` offers it (M1). Resolving through `deps.tools` alone made
    // every allow-listed name absent from the parent registry short-circuit to
    // "read-only" — `search` is exactly that name (drift 1), so its
    // `concurrency` was never consulted and a mutation to `exclusive` stayed
    // green.
    const offered = deps.extraTools?.(type) ?? [];
    return type.tools.every((toolName) => {
      // Never given to a child, so they make it no less read-only.
      if (
        toolName === spawnToolName ||
        toolName === CONTEXT_RESET_TOOL_NAME ||
        toolName === AGENT_CONTROL_TOOL_NAME ||
        toolName === AGENT_KILL_TOOL_NAME ||
        toolName === AGENT_MESSAGE_TOOL_NAME ||
        toolName === AGENT_STATUS_TOOL_NAME ||
        toolName === AGENT_NOTIFY_TOOL_NAME
      ) {
        return true;
      }
      // The parent's instance wins, as it does when the child's registry is
      // built (`parentNames` above): one tool, one concurrency key.
      const tool =
        deps.tools.get(toolName) ?? offered.find((candidate) => candidate.name === toolName);
      // Nothing provides it (an `agents/*.md` naming an absent tool), so it can
      // do nothing: read-only by default, which is the safe direction.
      if (tool === undefined) {
        return true;
      }
      // The probe gives a path-keyed tool its key; other tools ignore it.
      return isReadClass(classOf(tool, { path: "_" }));
    });
  };

  return { run, types, readOnlyType };
}
