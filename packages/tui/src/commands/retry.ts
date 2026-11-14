/**
 * `/retry` — re-send the last prompt (or, if it was a skill activation, activate
 * that skill again: `retryPlan`).
 */
import { lastUserText, retryPlan } from "../commands.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  "pushNotice" | "stateRef" | "lastUserRef" | "lastHadImagesRef" | "skills" | "run"
>;

export const command = {
  name: "/retry",
  description: "re-send the last prompt",
  run: (ctx: Ctx): void => {
    const last = ctx.lastUserRef.current ?? lastUserText(ctx.stateRef.current.items);
    if (!last) {
      ctx.pushNotice("_Nothing to retry yet._");
      return;
    }
    const plan = retryPlan(last, ctx.skills());
    // Read BEFORE `run`: the retry's own turn resets it (it names no images).
    const hadImages = ctx.lastHadImagesRef.current;
    if (plan.kind === "gone") {
      ctx.pushNotice(`_Can't retry: ${plan.command} is no longer available._`);
    } else if (plan.kind === "skill") {
      void ctx.run(plan.text, { skill: plan.name });
    } else {
      void ctx.run(plan.text);
    }
    if (hadImages) {
      // Text only, said out loud (decision 8): the refs of the last prompt are
      // not kept — 5×15 MB per prompt is too much for a rare key.
      ctx.pushNotice("_retry sends the text only: attach the image again with /attach_");
    }
  },
};
