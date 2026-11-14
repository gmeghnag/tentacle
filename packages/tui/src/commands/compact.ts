/**
 * `/compact` — its own three guards (the mid-turn one is the review's MEDIUM 1:
 * compaction under a live turn would rewrite the history being streamed), then
 * the machinery, which is an App-level driver function (`startCompaction()`)
 * because it owns the compaction refs and later moves with S9a
 * (docs/feat/app-decomposition.md M5).
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  "pushNotice" | "sessionRef" | "stateRef" | "busyCompacting" | "startCompaction"
>;

export const command = {
  name: "/compact",
  description: "summarise the conversation to free up context",
  run: (ctx: Ctx): void => {
    const session = ctx.sessionRef.current;
    if (!session?.compact) {
      ctx.pushNotice("_Compaction isn't available for this session._");
      return;
    }
    if (ctx.stateRef.current.running) {
      ctx.pushNotice("_Can't compact while a turn is running._");
      return;
    }
    if (ctx.busyCompacting()) {
      ctx.pushNotice("_A compaction is already running._");
      return;
    }
    ctx.pushNotice("_Compacting the conversation…_");
    ctx.startCompaction();
  },
};
