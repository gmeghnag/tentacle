/**
 * `/close` — end this session (every device sees it closed) and quit. The
 * runtime's exit path delivers the close before the socket goes, so the command
 * only asks for both.
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "exit" | "sessionRef">;

export const command = {
  name: "/close",
  description: "end this session and quit",
  run: (ctx: Ctx): void => {
    ctx.sessionRef.current?.close?.();
    ctx.exit();
  },
};
