import { oneLine } from "../commands.ts";
/**
 * `/workflow` (docs/feat/workflows-ui.md D3): no argument opens the panel on the
 * runs this TUI already follows (`onWorkflows`, installed with the session — no
 * request goes out); `run <name> [k=v …]` starts one, `stop` / `resume` act on
 * the run in flight / the newest stopped one. Every word is
 * `workflow-view.ts`'s; a reply or a refusal is a notice, never a throw.
 */
import { workflowPanel } from "../panel.ts";
import {
  WORKFLOW_UNSUPPORTED,
  parseWorkflowCommand,
  workflowReplyNotice,
  workflowTarget,
} from "../workflow-view.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "openPanel" | "pushNotice" | "sessionRef" | "workflowsRef">;

export const command = {
  name: "/workflow",
  description: "the workflow run in this session — run, stop, resume, re-run a step",
  run: (ctx: Ctx, raw: string): void => {
    const session = ctx.sessionRef.current;
    if (session?.onWorkflows === undefined || session.workflow === undefined) {
      // A pod, an older daemon, an untrusted one: no run feed exists, and an
      // empty panel would claim this session has no run.
      ctx.pushNotice(WORKFLOW_UNSUPPORTED);
      return;
    }
    const parsed = parseWorkflowCommand(raw.trim().replace(/^\/workflow\b/, ""));
    switch (parsed.kind) {
      case "refused":
        ctx.pushNotice(`_${parsed.text}_`);
        return;
      case "open":
        ctx.openPanel(
          workflowPanel(Date.now(), ctx.workflowsRef.current),
          () => Promise.resolve(workflowPanel(Date.now(), ctx.workflowsRef.current)),
          () => WORKFLOW_UNSUPPORTED,
        );
        return;
      case "run": {
        const send = session.workflow({
          action: "start",
          name: parsed.name,
          ...(parsed.inputs.length === 0 ? {} : { inputs: parsed.inputs }),
        });
        void send.then(
          (result) =>
            ctx.pushNotice(
              workflowReplyNotice(`Started workflow ${oneLine(parsed.name)}.`, result),
            ),
          (error: unknown) => ctx.pushNotice(`_${oneLine(String(error))}_`),
        );
        return;
      }
      case "stop":
      case "resume": {
        const target = workflowTarget(ctx.workflowsRef.current, parsed.kind);
        if ("refused" in target) {
          ctx.pushNotice(`_${target.refused}_`);
          return;
        }
        const asked = parsed.kind === "stop" ? "Stopping" : "Resuming";
        void session.workflow({ action: parsed.kind, runId: target.runId }).then(
          (result) => ctx.pushNotice(workflowReplyNotice(`${asked} ${target.runId}.`, result)),
          (error: unknown) => ctx.pushNotice(`_${oneLine(String(error))}_`),
        );
        return;
      }
    }
  },
};
