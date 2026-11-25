/**
 * `step_verdict` — how a workflow's agent step ends (docs/feat/agent-workflows.md
 * D3, owner decision 2): a TYPED verdict, never a grep of the report. Offered to
 * that step's child only (the runner's per-call `extraTools`). The input is
 * validated here, daemon-side; the FIRST valid call wins and the child is told to
 * stop. A child that ends without one is asked ONE more time (`planVerdictReminder`,
 * docs/fix/workflow-no-verdict) and then fails with `NO_VERDICT_REASON`.
 */
import type { Tool } from "@tentacle/core";
import { WORKFLOW_MAX_REASON } from "@tentacle/core";
import { z } from "zod";

export const STEP_VERDICT_TOOL_NAME = "step_verdict";

/**
 * Why a step failed when no verdict was ever recorded — ONE sentence for the log
 * entry, the step row, the machine's run-level line and both clients. Honest for a
 * child that ignored the reminder and for one that was never reminded (its outcome
 * already decided, or its budget spent): the step's order in the log says which.
 */
export const NO_VERDICT_REASON = "no verdict — the step ended without calling step_verdict";

/** How much of the first run's report a reminder carries. A conclusion lives at a
 * report's END, and the cap keeps a huge report from doubling the step's spend. */
export const STEP_REMINDER_REPORT_MAX = 4_000;

/** ONE more child turn for a step that ended without a verdict. */
export interface StepReminder {
  readonly prompt: string;
  /** The step's REMAINING budget; absent → the runner's default, as for run 1. */
  readonly maxTokens?: number;
}

const StepVerdictInputSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string().min(1).max(WORKFLOW_MAX_REASON),
});

export interface StepVerdict {
  readonly verdict: "pass" | "fail";
  readonly reason: string;
}

/** One step's verdict slot: the tool, and what it recorded (first valid call). */
export function createStepVerdict(): { tool: Tool; verdict(): StepVerdict | undefined } {
  let recorded: StepVerdict | undefined;
  const tool: Tool = {
    name: STEP_VERDICT_TOOL_NAME,
    description:
      "End this workflow step with its verdict: `pass` if the step's goal is met, `fail` otherwise, " +
      "and a short `reason`. Call it exactly once, as your LAST action; then stop. " +
      "A PASS/FAIL line in your text is NOT a verdict — only this tool call is.",
    inputSchema: StepVerdictInputSchema,
    permission: "none",
    execute: (input) => {
      const parsed = StepVerdictInputSchema.safeParse(input);
      if (!parsed.success) {
        return Promise.resolve({
          content: `invalid verdict: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        });
      }
      if (recorded !== undefined) {
        return Promise.resolve({
          content: `the verdict is already recorded (${recorded.verdict}); stop now`,
        });
      }
      recorded = parsed.data;
      return Promise.resolve({ content: `verdict recorded: ${recorded.verdict}. Stop now.` });
    },
  };
  return { tool, verdict: () => recorded };
}

/**
 * The reminder turn's plan, or `undefined` when this step gets none — the gates are
 * the driver's Preconditions in order (docs/fix/workflow-no-verdict):
 *
 * - `aborted`: a cancelled / timed-out / interrupted step's outcome is already
 *   decided (`cutEvent`), so an extra child would only fight it.
 * - a spent step budget: the cap is PER CALL (`SubagentRunControls.maxTokens`), so
 *   reusing the step's own would double it; a remainder of nothing means no turn.
 *
 * The prompt carries the reminder sentence and the END of the first run's report
 * (the two children share no history, so the work itself must travel).
 */
export function planVerdictReminder(input: {
  readonly stepId: string;
  readonly report: string;
  readonly usedTokens: number;
  readonly tokens: number | undefined;
  readonly aborted: boolean;
}): StepReminder | undefined {
  if (input.aborted) {
    return undefined;
  }
  let maxTokens: number | undefined;
  if (input.tokens !== undefined) {
    const remaining = input.tokens - input.usedTokens;
    if (remaining <= 0) {
      return undefined;
    }
    maxTokens = remaining;
  }
  const tail =
    input.report.length > STEP_REMINDER_REPORT_MAX
      ? input.report.slice(-STEP_REMINDER_REPORT_MAX)
      : input.report;
  const lines = [
    `Step \`${input.stepId}\` ended without a verdict, so it is about to fail. Call the \`${STEP_VERDICT_TOOL_NAME}\` tool NOW, exactly once: \`pass\` if the step's goal is met, else \`fail\`, with a one-line \`reason\`.`,
    "A text line saying PASS or FAIL is NOT a verdict — only the tool call is.",
  ];
  if (tail.trim() !== "") {
    lines.push("", "Your work ended with this report:", "", tail);
  }
  return { prompt: lines.join("\n"), ...(maxTokens !== undefined ? { maxTokens } : {}) };
}
