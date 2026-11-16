/**
 * `/schedule` — the session's armed wakes, in a panel (docs/feat/cron-tool.md
 * S5, mockup M3). No request goes out: this TUI already follows the table for
 * the session's whole life (`onSchedules`, installed with the follow), so the
 * panel OPENS on what the dock holds and follows every later change.
 */
import { schedulesPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "openPanel" | "pushNotice" | "sessionRef" | "schedulesRef">;

/** Shown where this session has no table to report (a pod, an older daemon). */
export const SCHEDULE_UNSUPPORTED = "_Scheduled wakes are not supported by this session._";

export const command = {
  name: "/schedule",
  description: "the wakes this session will be woken by — and delete one",
  run: (ctx: Ctx): void => {
    if (ctx.sessionRef.current?.onSchedules === undefined) {
      // A pod, or a daemon that predates the feature: no table exists, and
      // painting an empty one would claim this session has no wakes.
      ctx.pushNotice(SCHEDULE_UNSUPPORTED);
      return;
    }
    ctx.openPanel(
      schedulesPanel(Date.now(), ctx.schedulesRef.current),
      () => Promise.resolve(schedulesPanel(Date.now(), ctx.schedulesRef.current)),
      () => SCHEDULE_UNSUPPORTED,
    );
  },
};
