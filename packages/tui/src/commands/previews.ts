/**
 * `/previews` — the session's shared containers, in a panel
 * (docs/feat/session-apps-container-ports.md S4). No request goes out: this TUI
 * follows the list for the session's whole life (`onPreviews`).
 */
import { previewsPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "openPanel" | "pushNotice" | "sessionRef" | "previewsRef">;

/** Shown where this session cannot report any (a pod, an older client). */
export const PREVIEWS_UNSUPPORTED = "_Shared containers are not supported by this session._";

export const command = {
  name: "/previews",
  description: "the containers this session shows — copy a link or stop one",
  run: (ctx: Ctx): void => {
    if (ctx.sessionRef.current?.onPreviews === undefined) {
      ctx.pushNotice(PREVIEWS_UNSUPPORTED);
      return;
    }
    ctx.openPanel(
      previewsPanel(ctx.previewsRef.current),
      () => Promise.resolve(previewsPanel(ctx.previewsRef.current)),
      () => PREVIEWS_UNSUPPORTED,
    );
  },
};
