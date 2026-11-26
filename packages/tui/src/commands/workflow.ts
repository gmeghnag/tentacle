import { oneLine } from "../commands.ts";
/**
 * `/workflow` (docs/feat/workflows-ui.md D3, and D8 for the project's own files):
 * no argument opens the panel on the runs this TUI already follows
 * (`onWorkflows`, installed with the session — no request goes out) plus the
 * project's workflow catalogue; `run <name> [k=v …]` starts one, `stop` /
 * `resume` act on the run in flight / the newest stopped one. Every word is
 * `workflow-view.ts`'s; a reply or a refusal is a notice, never a throw.
 *
 * D8's two additions here: the panel is opened WITH the catalogue the line already
 * summarises, and every `/workflow` asks for a fresh read (coalesced) — the command
 * is one of the five moments that can change the answer, never a poll.
 */
import { workflowPanel } from "../panel.ts";
import {
  WORKFLOW_ACT_OLD_DAEMON,
  WORKFLOW_NOT_LISTED,
  WORKFLOW_UNSUPPORTED,
  approveReplyNotice,
  catalogueRowFor,
  deleteReplyNotice,
  parseWorkflowCommand,
  startCommandFor,
  workflowDeletePrompt,
  workflowReplyNotice,
  workflowTarget,
} from "../workflow-view.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  "openPanel" | "pushNotice" | "sessionRef" | "workflowsRef" | "workflowCatalogueRef"
> & {
  /** Absent on a host that has no catalogue seam: then nothing is refreshed. */
  readonly refreshCatalogue?: () => void;
  /** Put a prepared command back in the input (a catalogue row that needs inputs). */
  readonly prefill?: (text: string) => void;
};

/**
 * `/workflow run <name>` with a catalogue row behind it (D8): the hash the user
 * SAW is pinned, so a file edited since is refused `changed` (5a) rather than run
 * as something else. A row that needs inputs pre-fills the command instead of
 * starting half-specified; an invalid one says its errors.
 */
function runFromCatalogue(ctx: Ctx, name: string, typed: number): string | null {
  const row = catalogueRowFor(ctx.workflowCatalogueRef.current, name);
  if (row === undefined) {
    // Not in the catalogue (or there is none): today's path, the daemon decides.
    return null;
  }
  const start = startCommandFor(row);
  if (start.kind === "refused") {
    ctx.pushNotice(`_${start.text}_`);
    return "";
  }
  if (start.kind === "prefill" && typed === 0) {
    // Nothing was typed for the required inputs: hand back the command, filled in.
    if (ctx.prefill === undefined) {
      ctx.pushNotice(`_${start.text}_`);
    } else {
      ctx.prefill(start.text);
      ctx.pushNotice(`_${oneLine(name)} needs input — fill in the values and press enter_`);
    }
    return "";
  }
  // Typed inputs for a row that needed them: the row is the one to run, so its
  // hash is pinned too (a file edited since is refused `changed`, 5a). A row the
  // catalogue could not hash (an older daemon) pins nothing, exactly as today.
  return row.hash ?? null;
}

/**
 * `/workflow approve <name>` (docs/feat/mobile-workflows-landing.md D6): pins the
 * hash the catalogue SHOWS. The ask then arrives in this TUI's own permission
 * dialog, and the catalogue re-reads when it closes.
 */
function approve(ctx: Ctx, name: string): void {
  const session = ctx.sessionRef.current;
  if (session?.workflowApprove === undefined) {
    ctx.pushNotice(`_${WORKFLOW_ACT_OLD_DAEMON}_`);
    return;
  }
  const row = catalogueRowFor(ctx.workflowCatalogueRef.current, name);
  if (row === undefined) {
    ctx.pushNotice(`_${oneLine(name)}: ${WORKFLOW_NOT_LISTED}_`);
    return;
  }
  if (!row.ok || row.hash === undefined) {
    // No hash, nothing to approve: say what is wrong with the file.
    const start = startCommandFor(row);
    ctx.pushNotice(`_${start.kind === "refused" ? start.text : WORKFLOW_ACT_OLD_DAEMON}_`);
    return;
  }
  void session.workflowApprove(name, row.hash).then(
    (result) => ctx.pushNotice(approveReplyNotice(name, result)),
    (error: unknown) => ctx.pushNotice(`_${oneLine(String(error))}_`),
  );
}

/**
 * `/workflow delete <name> [confirm]` (D6): without `confirm` NOTHING is sent —
 * the confirming line is put back in the input. With it, the row's hash is pinned
 * (a broken row has none: the daemon then requires it to be still broken).
 */
function remove(ctx: Ctx, name: string, confirmed: boolean): void {
  const session = ctx.sessionRef.current;
  if (session?.workflowDelete === undefined) {
    ctx.pushNotice(`_${WORKFLOW_ACT_OLD_DAEMON}_`);
    return;
  }
  const row = catalogueRowFor(ctx.workflowCatalogueRef.current, name);
  if (row === undefined) {
    ctx.pushNotice(`_${oneLine(name)}: ${WORKFLOW_NOT_LISTED}_`);
    return;
  }
  if (!confirmed) {
    const line = `/workflow delete ${row.name} confirm`;
    const said = workflowDeletePrompt(row.path);
    if (ctx.prefill === undefined) {
      ctx.pushNotice(`_${said}: ${oneLine(line)}_`);
      return;
    }
    ctx.prefill(line);
    ctx.pushNotice(`_${said}_`);
    return;
  }
  void session.workflowDelete(name, row.ok ? row.hash : undefined).then(
    (result) => {
      ctx.pushNotice(deleteReplyNotice(name, result));
      ctx.refreshCatalogue?.();
    },
    (error: unknown) => ctx.pushNotice(`_${oneLine(String(error))}_`),
  );
}

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
    // Every `/workflow` is a re-read (D8): the files may have changed in an editor.
    // A `refused` line still asks: the user is looking at the project's files.
    ctx.refreshCatalogue?.();
    switch (parsed.kind) {
      case "refused":
        ctx.pushNotice(`_${parsed.text}_`);
        return;
      case "open":
        ctx.openPanel(
          workflowPanel(
            Date.now(),
            ctx.workflowsRef.current,
            undefined,
            ctx.workflowCatalogueRef.current,
          ),
          () =>
            Promise.resolve(
              workflowPanel(
                Date.now(),
                ctx.workflowsRef.current,
                undefined,
                ctx.workflowCatalogueRef.current,
              ),
            ),
          () => WORKFLOW_UNSUPPORTED,
        );
        return;
      case "run": {
        const hash = runFromCatalogue(ctx, parsed.name, parsed.inputs.length);
        if (hash === "") {
          return;
        }
        const send = session.workflow({
          action: "start",
          name: parsed.name,
          ...(parsed.inputs.length === 0 ? {} : { inputs: parsed.inputs }),
          ...(hash === null ? {} : { hash }),
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
      case "approve":
        approve(ctx, parsed.name);
        return;
      case "delete":
        remove(ctx, parsed.name, parsed.confirmed);
        return;
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
