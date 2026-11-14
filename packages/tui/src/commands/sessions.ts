/**
 * `/sessions` — the panel opens at once in its loading state, then shows the
 * daemon's list (no "current" session is captured here: it is read live when
 * rendered and used, R3-1).
 */
import { sessionsPanel } from "../panel.ts";
import { sessionsListError } from "../sessions-panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "sessions" | "openPanel">;

export const command = {
  name: "/sessions",
  description: "list this daemon's sessions and switch",
  run: (ctx: Ctx): void => {
    const sessions = ctx.sessions;
    if (!sessions) {
      ctx.pushNotice("_Sessions aren't available on this runtime._");
      return;
    }
    ctx.openPanel(
      sessionsPanel(Date.now()),
      () => sessions.list().then((view) => sessionsPanel(Date.now(), view)),
      sessionsListError,
    );
  },
};
