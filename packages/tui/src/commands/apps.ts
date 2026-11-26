/**
 * `/apps` — the session's published pages, in a panel
 * (docs/feat/session-apps-publish.md D10). No request goes out: this TUI follows
 * the list for the session's whole life (`onApps`), so the panel opens on what
 * it holds and follows every later change.
 */
import { appsPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "openPanel" | "pushNotice" | "sessionRef" | "appsRef">;

/** Shown where this session cannot report any (a pod, an older client). */
export const APPS_UNSUPPORTED = "_Published apps are not supported by this session._";

export const command = {
  name: "/apps",
  description: "the web pages this session publishes — and stop one",
  run: (ctx: Ctx): void => {
    if (ctx.sessionRef.current?.onApps === undefined) {
      ctx.pushNotice(APPS_UNSUPPORTED);
      return;
    }
    ctx.openPanel(
      appsPanel(ctx.appsRef.current),
      () => Promise.resolve(appsPanel(ctx.appsRef.current)),
      () => APPS_UNSUPPORTED,
    );
  },
};
