/**
 * `step_verdict` — how a workflow's agent step ends (docs/feat/agent-workflows.md
 * D3, owner decision 2): a TYPED verdict, never a grep of the report. Offered to
 * that step's child only (the runner's per-call `extraTools`). The input is
 * validated here, daemon-side; the FIRST valid call wins and the child is told to
 * stop. A child that ends without one fails with `no verdict` (the driver's rule).
 */
import type { Tool } from "@tentacle/core";
import { WORKFLOW_MAX_REASON } from "@tentacle/core";
import { z } from "zod";

export const STEP_VERDICT_TOOL_NAME = "step_verdict";

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
      "and a short `reason`. Call it exactly once, as your LAST action; then stop.",
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
