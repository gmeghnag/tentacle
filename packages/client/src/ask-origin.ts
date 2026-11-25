/**
 * Who asked, in one shape for every surface (docs/fix/mobile-ask-surfaces.md D2).
 *
 * Pure. The input is what the router hands a requester: `agent` and `workflow`
 * are pod-supplied display text (AGENTS §7: a pod is not trusted), so nothing
 * here feeds a decision, the icon comes from `kind` and never from the text,
 * and nothing is ever parsed out of `description`/`id`.
 */

export interface AskOriginInput {
  readonly agent?: { readonly type: string; readonly description: string; readonly id?: string };
  readonly workflow?: {
    readonly name: string;
    readonly runId?: string;
    readonly stepId?: string;
    readonly index?: number;
    readonly count?: number;
  };
}

export type AskOrigin =
  | { readonly kind: "main" }
  | { readonly kind: "subagent"; readonly type: string; readonly task: string }
  | {
      readonly kind: "workflow";
      readonly name: string;
      readonly runId: string | null;
      readonly stepId: string | null;
      /** 1-based `n` of `m` steps; null when the pod's numbers are not sane. */
      readonly position: { readonly n: number; readonly m: number } | null;
    };

const NAME_MAX = 64;
const STEP_MAX = 64;
const TASK_MAX = 120;
/** `WorkflowRowSchema.steps.max(64)` (protocol/session.ts). */
const MAX_STEPS = 64;

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function position(
  index: number | undefined,
  count: number | undefined,
): { n: number; m: number } | null {
  if (
    typeof index !== "number" ||
    typeof count !== "number" ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 0 ||
    count > MAX_STEPS ||
    index >= count
  ) {
    return null;
  }
  return { n: index + 1, m: count };
}

export function askOrigin(options: AskOriginInput): AskOrigin {
  const wf = options.workflow;
  if (wf) {
    return {
      kind: "workflow",
      name: cut(wf.name, NAME_MAX),
      runId: wf.runId ?? null,
      stepId: wf.stepId !== undefined ? cut(wf.stepId, STEP_MAX) : null,
      position: position(wf.index, wf.count),
    };
  }
  const agent = options.agent;
  if (agent) {
    return {
      kind: "subagent",
      type: cut(agent.type, NAME_MAX),
      task: cut(agent.description, TASK_MAX),
    };
  }
  return { kind: "main" };
}

/** The label, in two runs: a bold `lead` and a quieter `rest` (may be empty). */
export function originWords(origin: AskOrigin): { lead: string; rest: string } {
  switch (origin.kind) {
    case "main":
      return { lead: "Main agent", rest: "" };
    case "subagent":
      return { lead: `Sub-agent ${origin.type}`, rest: origin.task };
    case "workflow": {
      if (origin.stepId === null) {
        return { lead: origin.name, rest: "approval" };
      }
      const pos = origin.position ? ` · ${origin.position.n} of ${origin.position.m}` : "";
      return { lead: origin.name, rest: `step ${origin.stepId}${pos}` };
    }
  }
}
