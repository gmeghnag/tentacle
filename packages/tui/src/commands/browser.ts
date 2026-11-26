/** `/browser` — the user's Chrome in this session: the panel, or one switch by word (docs/feat/browser-inspect.md B6a). */
import { NO_BROWSER_NOTICE, browserCommandStep } from "../browser-view.ts";
import { sessionCapsPhase } from "../capability-toggles.ts";
import { browserPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  "pushNotice" | "sessionRef" | "openPanel" | "capsRef" | "sendSwitch" | "browserStatusRef"
>;

export const command = {
  name: "/browser",
  description: "your Chrome: tabs and switches (on|off|auto|ask|clear|masked)",
  run: (ctx: Ctx, raw: string): void => {
    const session = ctx.sessionRef.current;
    const step = browserCommandStep(raw, sessionCapsPhase(session, ctx.capsRef.current));
    if (step.kind === "notice") {
      ctx.pushNotice(step.text);
    } else if (step.kind === "op") {
      ctx.sendSwitch(step.op);
    } else {
      // Opens on the last read (the App re-reads while the panel is open, and the
      // panel follows each answer): the switches need no request at all.
      const open = () => browserPanel(ctx.browserStatusRef.current);
      ctx.openPanel(
        open(),
        () => Promise.resolve(open()),
        () => NO_BROWSER_NOTICE,
      );
    }
  },
};
