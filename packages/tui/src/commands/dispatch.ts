/**
 * `dispatchCommand` — the ONE place typed `/…` text turns into an effect
 * (docs/feat/app-decomposition.md S2). This is what stays here, by design: the
 * shared guards around the individual commands. Everything a command DOES lives
 * in `commands/<name>.ts`; this file only decides whether it may run.
 *
 * The guards, in this order (they are safety, not bookkeeping):
 * 1. a skill activation is a PROMPT: recalled into the history, refused mid-turn
 *    (it is a round, not a steering message) and refused while a switch is latched;
 * 2. a command is refused while a session switch is latched;
 * 3. a session-mutating command is refused mid-turn — except an in-place
 *    `/clear` (it stops an own turn first; the daemon refuses another device's).
 */
import { resolveSlash } from "../commands.ts";
import { isSessionMutating } from "../commands.ts";
import { pushHistory } from "../history.ts";
import { switchingRefusal } from "../sessions-panel.ts";
import type { CommandContext } from "./context.ts";
import { findCommand } from "./registry.ts";

/** What the dispatcher needs: the guards' facts and the command context. */
type Ctx = CommandContext;

/**
 * Run what `raw` asks for. `again`: this line was already resolved once and the
 * skill list has just been re-asked (an unknown `/name` may be a new skill) —
 * never loop a second time (docs/feat/skills-hot-reload.md).
 */
export function dispatchCommand(ctx: Ctx, raw: string, again = false): void {
  const resolved = resolveSlash(raw, ctx.skills());
  if (resolved.kind === "skill") {
    // A skill activation is a prompt (it starts a turn): recallable with ↑,
    // and refused mid-turn — it is a round, not a steering message.
    ctx.historyRef.current = pushHistory(ctx.historyRef.current, resolved.text);
    ctx.histIndexRef.current = ctx.historyRef.current.length;
    ctx.draftRef.current = "";
    if (ctx.stateRef.current.running) {
      ctx.pushNotice(
        `_Can't run /${resolved.name} while a turn is running — stop it first (esc)._`,
      );
      return;
    }
    const refusedSkill = switchingRefusal(ctx.switchingRef.current, { kind: "prompt" });
    if (refusedSkill) {
      ctx.restoreInput(raw, refusedSkill);
      return;
    }
    void ctx.run(resolved.text, { skill: resolved.name });
    return;
  }
  const cmd = raw.split(/\s+/)[0];
  const refused = cmd
    ? switchingRefusal(ctx.switchingRef.current, { kind: "command", name: cmd })
    : null;
  if (refused) {
    ctx.pushNotice(refused);
    return;
  }
  // Guard turn-starting / session-swapping commands while a turn runs: they
  // would corrupt the session (concurrent send) or cancel-handle state.
  // `/clear` on a session that can `clear` is exempt: it resets in place (it
  // stops an own turn first, and the daemon refuses another device's); only the
  // legacy close-and-replace would swap the session under a turn.
  const clearsInPlace = cmd === "/clear" && typeof ctx.sessionRef.current?.clear === "function";
  if (cmd && isSessionMutating(cmd) && ctx.stateRef.current.running && !clearsInPlace) {
    ctx.pushNotice(`_Can't run ${cmd} while a turn is running — stop it first (esc)._`);
    return;
  }
  const found = cmd ? findCommand(cmd) : undefined;
  if (found) {
    found.run(ctx, raw);
    return;
  }
  // Maybe a skill made since the list was last asked: ask once more, then
  // resolve the text AGAIN, once (docs/feat/skills-hot-reload.md).
  if (!again && ctx.skillsSync.stale()) {
    void ctx.skillsSync.settle().then((same) => {
      if (same) {
        ctx.reResolve(raw); // not on a session switched meanwhile
      }
    });
    return;
  }
  ctx.pushNotice(`_Unknown command: ${cmd}. Try /help._`);
}
