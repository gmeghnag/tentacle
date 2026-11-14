import type { SettingsNoticeLine } from "../app-types.ts";
/**
 * `/settings` (docs/feat/session-settings-apply.md) — the pure decision is
 * `settingsCommand`; this is its executor. The host builds the lines; a sync
 * writes them into the transcript itself (`appendNotice`/`replaceWithNotices`)
 * so the pending "Syncing…" line can be replaced in place by the answer.
 */
import { SETTINGS_SYNCING, settingsCommand } from "../settings-command.ts";
import { appendNotice, replaceWithNotices } from "../state.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  | "sessionRef"
  | "stateRef"
  | "syncingRef"
  | "busyCompacting"
  | "setScrollOffset"
  | "flushNow"
  | "askContext"
>;

export const command = {
  name: "/settings",
  description: "the session's settings vs this terminal's (/settings sync to use yours)",
  run: (ctx: Ctx, raw: string): void => {
    const session = ctx.sessionRef.current;
    const lines = (shown: readonly SettingsNoticeLine[]) => {
      for (const { text, hint } of shown) {
        ctx.stateRef.current = appendNotice(ctx.stateRef.current, text, hint ? { hint } : {});
      }
      ctx.setScrollOffset(0);
      ctx.flushNow();
    };
    const step = settingsCommand(raw, {
      running: ctx.stateRef.current.running,
      compacting: ctx.busyCompacting(),
      available: session?.settings !== undefined && session.updateSettings !== undefined,
      syncing: session !== null && ctx.syncingRef.current === session,
    });
    if (step.kind === "notice") {
      lines([{ text: step.text }]);
    } else if (step.kind === "show") {
      lines(session?.settings?.() ?? []);
    } else if (session?.updateSettings) {
      // During an outage it waits for the link: never nothing on screen.
      ctx.syncingRef.current = session;
      lines([{ text: SETTINGS_SYNCING }]);
      const pending = ctx.stateRef.current.items.at(-1);
      const settled = (outcome: readonly SettingsNoticeLine[]) => {
        if (ctx.syncingRef.current === session) {
          ctx.syncingRef.current = null;
        }
        // Moved to another session meanwhile: not that session's news
        // (`/settings` on this one tells the truth when you are back), so the
        // pending line just goes, where a swap kept the transcript.
        const moved = ctx.sessionRef.current !== session;
        if (pending !== undefined) {
          ctx.stateRef.current = replaceWithNotices(
            ctx.stateRef.current,
            pending,
            moved ? [] : outcome,
          );
        }
        ctx.flushNow();
        if (!moved) {
          ctx.setScrollOffset(0);
          // The prompt or tools may have changed: the open figure is stale.
          ctx.askContext(session);
        }
      };
      void session
        .updateSettings()
        .then(settled, () => settled([{ text: "Could not sync the settings." }]));
    }
  },
};
