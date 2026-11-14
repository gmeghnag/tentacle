/**
 * `/exit` (and `/quit`, its alias) — `requestQuit` decides
 * (`quitCommandStep`): exit, ask first, or stop the turn and exit when it has
 * settled.
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "requestQuit">;

export const command = {
  name: "/exit",
  description: "quit (also /quit)",
  run: (ctx: Ctx): void => ctx.requestQuit(false),
};
