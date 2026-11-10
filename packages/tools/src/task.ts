/**
 * The `agent_task` tool — the model-facing surface for delegating to a sub-agent.
 *
 * It owns no agent logic: a runner (built in the wiring layer, where the model
 * and registry live) is injected, so this package stays free of a dependency on
 * `@tentacle/agent`. The tool itself needs no permission — spawning is
 * safe; the child's own tools enforce their permissions and confinement.
 */
import type {
  AgentInbox,
  AgentJobSpec,
  AgentJobs,
  AgentSlot,
  SpawnKind,
  Tool,
  ToolContext,
  ToolProgressEvent,
  ToolResult,
} from "@tentacle/core";
import { foldAgentProgress } from "@tentacle/core";
import { z } from "zod";

export interface TaskRunResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: string;
}

export interface TaskRunControls {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ToolProgressEvent) => void;
  /** This `agent_task` call's id: the sub-agent's permission asks are attributed to it. */
  readonly toolCallId?: string;
  /** The calling session's id: the sub-agent's spilled output is filed under it. */
  readonly sessionId?: string;
  /** Set on a BACKGROUND child: its `sa-N` id. Its permission asks are attributed to it. */
  readonly agentId?: string;
  /**
   * Set on a FOREGROUND child that may become a background one
   * (docs/feat/subagent-detach.md): its asks are withdrawable, and once it
   * moved they are re-asked as `sa-N` on the background path.
   */
  readonly move?: TaskMoveControls;
  /**
   * The child's inbox (docs/feat/agent-message.md): the channel a sender writes
   * into while it runs. A background child's comes from `AgentJobs.start`; a
   * movable foreground one's is the slot's, which `adopt` moves into the entry.
   */
  readonly inbox?: AgentInbox;
}

/** What lets a foreground child's open permission ask be withdrawn at the move. */
export interface TaskMoveControls {
  /** Aborted at the move: the child's open foreground ask is withdrawn. */
  readonly withdrawn: AbortSignal;
  /** `undefined` while the child is still foreground. */
  background(): { readonly id: string; readonly signal: AbortSignal } | undefined;
}

export type TaskRunner = (
  /** `model`: the call's requested `models` name, already checked against the list. */
  opts: { description: string; prompt: string; type: string; model?: string },
  controls?: TaskRunControls,
) => Promise<TaskRunResult>;

export interface TaskAgentType {
  readonly name: string;
  readonly description: string;
}

/** A model the agent may pick (`subagents.selectableModels`, docs/feat/models-map.md). */
export interface TaskModelOption {
  readonly name: string;
  readonly description?: string;
}

/** `subagents.execution`: how a round's `agent_task` calls may overlap. */
export type TaskExecutionMode = "sequential" | "read-only" | "parallel";

export interface TaskToolOptions {
  /** Whether a sub-agent type only reads (asked live). Absent → every type is a writer. */
  readonly readOnlyType?: (name: string) => boolean;
  /** `subagents.agentTaskDescription`: used as is, in every mode. Absent → the neutral text. */
  readonly description?: string | undefined;
  /** What the neutral text states about overlap. Absent → nothing, as `sequential`. */
  readonly mode?: TaskExecutionMode;
  /**
   * `subagents.selectableModels` with their descriptions. Absent or empty → no
   * `model` argument, and the tool is exactly what it was without `models`.
   */
  readonly models?: readonly TaskModelOption[];
  /**
   * The background runtime (docs/feat/subagent-background.md). Present → the
   * tool offers `background` and every child, foreground or background, takes
   * a slot of its ONE cap (`subagents.maxParallel`). Absent → neither.
   */
  readonly background?: AgentJobs;
}

const NEUTRAL_DESCRIPTION =
  "Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so use it to explore or offload work without filling your own context. Prefer it for open-ended search and read-heavy investigation.";

const OVERLAP_NOTE: Record<TaskExecutionMode, string> = {
  parallel:
    " Several agent_task calls in one message may run at the same time. They share one workspace: give each its own files, and do not have two of them commit, or run builds or tests that could overlap.",
  "read-only": " Read-only sub-agents in one message may run at the same time.",
  sequential: "",
};

/**
 * The tool's description: the custom text, or the neutral one, which states the
 * facts of `mode` and never asks for fan-out. The list of types always follows:
 * `subagent_type` is unusable without it.
 */
export function taskToolDescription(
  custom: string | undefined,
  mode: TaskExecutionMode,
  typeList: string,
  modelList = "",
): string {
  const text = custom ?? `${NEUTRAL_DESCRIPTION}${OVERLAP_NOTE[mode]}`;
  const models =
    modelList === ""
      ? ""
      : `\n\nAvailable models (optional \`model\` argument; omit it to use the sub-agent type's own model):\n${modelList}`;
  return `${text}\n\nAvailable sub-agent types:\n${typeList}${models}`;
}

/** One line per selectable model; a description's whitespace runs collapse to one space. */
function renderModelList(models: readonly TaskModelOption[]): string {
  return models
    .map((m) => {
      const about = m.description?.replace(/\s+/g, " ").trim();
      return about ? `- ${m.name}: ${about}` : `- ${m.name}`;
    })
    .join("\n");
}

/**
 * The note `agent_task` appends to a non-clean child's result
 * (the model needs it: it reads the tool result; the TUI's block drops it,
 * `tui/src/subagent-view.ts`).
 */
function foregroundResult(result: TaskRunResult): ToolResult {
  const note =
    result.stopReason === "cancelled"
      ? "\n\n_(sub-agent cancelled)_"
      : result.stopReason === "max_iterations"
        ? "\n\n_(sub-agent hit its iteration cap)_"
        : "";
  const body = result.report.length > 0 ? result.report : "(the sub-agent produced no output)";
  return { content: `${body}${note}` };
}

/** The result of a call that returned but whose child now runs in the background. */
function movedText(agentId: string, description: string): string {
  return `moved to background as ${agentId}: ${description}. Its report will arrive later as a [background] note; you can keep working or end your turn.`;
}

/**
 * The MOVABLE foreground path (`docs/feat/subagent-detach.md` Design 2). While
 * the child runs alone, nothing differs from the old foreground path. The slot
 * also carries a `move`: when `HostedSession` sees a person write, it exchanges
 * the slot for a running entry (`AgentJobs.adopt`), unlinks the child from the
 * turn, switches its progress sink to the row, withdraws its open ask (re-asked
 * as `sa-N`) and answers THIS call with `movedText` — all in one synchronous
 * stretch, so the steer is drained at the very next round boundary.
 *
 * `agentId` alone decides which path won: never which promise of the race
 * settled first (a child finishing in the same tick would otherwise report
 * twice). A failure before the move must still fail the call, so the not-moved
 * path awaits `running`, never `settled`.
 */
async function runMovable(
  bg: AgentJobs,
  slot: AgentSlot & { readonly ok: true },
  run: TaskRunner,
  runOpts: { description: string; prompt: string; type: string; model?: string },
  args: { description: string },
  type: string,
  ctx: ToolContext,
  shape: (outcome: TaskRunResult, signal: AbortSignal | undefined) => Promise<TaskRunResult>,
): Promise<ToolResult> {
  // The child's OWN controller: linked to the turn until the move, unlinked then
  // and never switched back (the child outlives the turn as `sa-N`).
  const own = new AbortController();
  const unlink = linkAbort(ctx.signal, own);
  // Aborted at the move: the child's open foreground ask is withdrawn with it.
  const withdrawn = new AbortController();
  const live = { toolUses: 0, tokens: 0, tail: [] as string[] };
  // THE authority on which path won, set synchronously inside `move`.
  let agentId: string | undefined;
  let finished = false;
  const toolCallId = ctx.toolCallId as string;
  let sink = (event: ToolProgressEvent): void => {
    foldAgentProgress(live, event);
    ctx.emitProgress?.(event);
  };
  const spec: AgentJobSpec = { callId: toolCallId, agentType: type, description: args.description };
  const running = run(runOpts, {
    signal: own.signal,
    onEvent: (event) => sink(event),
    toolCallId,
    sessionId: ctx.sessionId,
    // The SAME inbox object `adopt` moves into the entry: a text sent to `sa-N`
    // after the move is drained by this very child (docs/feat/agent-message.md).
    inbox: slot.inbox,
    move: {
      withdrawn: withdrawn.signal,
      background: () => (agentId !== undefined ? { id: agentId, signal: own.signal } : undefined),
    },
  });
  const settled = running.then(
    (result) => {
      finished = true;
      return result;
    },
    (error: unknown) => {
      finished = true;
      return {
        report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        toolUses: live.toolUses,
        stopReason: "error",
      };
    },
  );
  const moved = Promise.withResolvers<void>();
  slot.movable(() => {
    // Already ending, or the turn was cancelled: nothing to move (the child
    // ends with the turn, as it does today).
    if (finished || own.signal.aborted) {
      return;
    }
    const id = slot.adopt(spec, own, live, async () => {
      const outcome = await settled;
      return shape(outcome, own.signal);
    });
    if (id === undefined) {
      return;
    }
    agentId = id;
    unlink();
    // Its activity goes to its ROW from now on: the turn it belonged to is over.
    sink = (event) => bg.progress(id, event);
    withdrawn.abort();
    ctx.emitProgress?.({
      kind: "subagent_end",
      toolUses: live.toolUses,
      stopReason: "background",
      agentId: id,
    });
    moved.resolve();
  });
  await Promise.race([settled, moved.promise]);
  unlink();
  // Idempotent, and a no-op once `adopt` took the slot away.
  slot.release();
  if (agentId !== undefined) {
    return { content: movedText(agentId, args.description) };
  }
  const result = await running;
  // NEVER `shape`d here: the agent loop applies the call's transforms to this
  // result itself (`agent.ts` `finishCall`), so shaping here would run
  // redaction, the hooks and the spill twice. Only a MOVED child's report is
  // shaped here, because it never returns through that path (as 6a).
  return foregroundResult(result);
}

/** Aborts `own` when `parent` aborts (at once if it already has); returns the unlink. */
function linkAbort(parent: AbortSignal, own: AbortController): () => void {
  const onAbort = (): void => own.abort();
  if (parent.aborted) {
    own.abort();
    return () => {};
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/** Build the `agent_task` tool for the given runner and available sub-agent types. */
export function createTaskTool(
  run: TaskRunner,
  types: readonly TaskAgentType[],
  options: TaskToolOptions = {},
): Tool {
  const names = types.map((t) => t.name);
  const defaultType = names[0] ?? "general";
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const resolveType = (requested: string | undefined): string => {
    const name = requested ?? defaultType;
    return names.includes(name) ? name : defaultType;
  };

  const models = options.models ?? [];
  const modelNames = models.map((m) => m.name);
  const baseSchema = z.object({
    description: z.string().min(1).describe("A short (3-5 word) description of the task"),
    prompt: z.string().min(1).describe("The full task for the sub-agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe(`Which sub-agent to use (default ${defaultType})`),
  });
  // `model` only when the user made models selectable, `background` only when
  // the runtime is wired: otherwise the agent is never told they exist, and a
  // stray one is stripped like any unknown argument.
  const inputSchema = z.object({
    ...baseSchema.shape,
    ...(models.length > 0
      ? {
          model: z
            .string()
            .optional()
            .describe(
              `Which model runs the sub-agent: one of ${modelNames.join(", ")}. Omit it for the type's own model.`,
            ),
        }
      : {}),
    ...(options.background
      ? {
          background: z
            .boolean()
            .optional()
            .describe(
              "Run the sub-agent in the background: this call returns at once with its id (sa-N), you can keep working or end your turn, and its report arrives later as a [background] note that wakes you. Default false.",
            ),
        }
      : {}),
  });

  return {
    name: "agent_task",
    description: taskToolDescription(
      options.description,
      options.mode ?? "sequential",
      typeList,
      renderModelList(models),
    ),
    inputSchema,
    permission: "none",
    // Resolved as `execute` does. Bad input throws: not groupable.
    spawnKind(input): SpawnKind {
      const type = resolveType(inputSchema.parse(input).subagent_type);
      return options.readOnlyType?.(type) ? "read-only" : "writer";
    },
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as z.infer<typeof baseSchema> & { model?: string; background?: boolean };
      const type = resolveType(args.subagent_type);
      const model = models.length > 0 ? args.model : undefined;
      if (model !== undefined && !modelNames.includes(model)) {
        // No child starts: the agent learns the allowed names and may retry.
        return {
          content: `unknown model ${JSON.stringify(model.slice(0, 64))} for agent_task — use one of: ${modelNames.join(", ")}, or omit model`,
          isError: true,
        };
      }
      const runOpts = {
        description: args.description,
        prompt: args.prompt,
        type,
        ...(model !== undefined ? { model } : {}),
      };
      const bg = options.background;
      // The report's transforms, for both paths: redaction, hooks, spill.
      const shape = async (
        outcome: TaskRunResult,
        signal: AbortSignal | undefined,
      ): Promise<TaskRunResult> => {
        const shaped = ctx.shapeResult
          ? await ctx.shapeResult({ content: outcome.report }, signal)
          : { content: outcome.report };
        return { ...outcome, report: shaped.content };
      };
      if (args.background === true && bg) {
        if (ctx.toolCallId === undefined) {
          // A blank callId would write a `subagent_background` the schema refuses.
          return {
            content: "background sub-agents need a tool call id: run it in the foreground",
            isError: true,
          };
        }
        const started = bg.start(
          { callId: ctx.toolCallId, agentType: type, description: args.description },
          async ({ signal, agentId, inbox }) => {
            let outcome: TaskRunResult;
            try {
              // NEVER `ctx.signal`: Esc on the launching turn must not stop the child.
              outcome = await run(runOpts, {
                signal,
                agentId,
                // Its inbox: `AgentJobs.message` finds the SAME object by id.
                inbox,
                // The child's activity, folded into its row (the status line's
                // count and the panel read `bg.rows()`); it reaches no turn.
                onEvent: (event) => bg.progress(agentId, event),
                ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
                sessionId: ctx.sessionId,
              });
            } catch (error) {
              outcome = {
                report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
                toolUses: 0,
                stopReason: "error",
              };
            }
            return shape(outcome, signal);
          },
        );
        return started.ok
          ? {
              content: `started in background as ${started.agentId}: ${args.description}. Its report will arrive later as a [background] note; you can keep working or end your turn.`,
            }
          : { content: started.reason, isError: true };
      }
      // A foreground child takes a slot of the same cap, or is refused at once.
      const slot = bg ? bg.acquire(args.description) : undefined;
      if (slot && !slot.ok) {
        return { content: slot.reason, isError: true };
      }
      // MOVABLE (docs/feat/subagent-detach.md): a slot and a call id is what it
      // takes. Someone writing while this child runs then answers the call here
      // and keeps the child alive, in the background, as `sa-N`.
      if (slot?.ok && bg && ctx.toolCallId !== undefined) {
        return runMovable(bg, slot, run, runOpts, args, type, ctx, shape);
      }
      let result: TaskRunResult;
      try {
        result = await run(runOpts, {
          signal: ctx.signal,
          ...(ctx.emitProgress ? { onEvent: ctx.emitProgress } : {}),
          ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
          sessionId: ctx.sessionId,
        });
      } finally {
        if (slot?.ok) {
          slot.release();
        }
      }
      const note =
        result.stopReason === "cancelled"
          ? "\n\n_(sub-agent cancelled)_"
          : result.stopReason === "max_iterations"
            ? "\n\n_(sub-agent hit its iteration cap)_"
            : "";
      const body = result.report.length > 0 ? result.report : "(the sub-agent produced no output)";
      return { content: `${body}${note}` };
    },
  };
}
