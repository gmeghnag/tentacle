/** `/tokens` — the session's token totals, as last reported. */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "stateRef">;

export const command = {
  name: "/tokens",
  description: "show token usage for the session",
  run: (ctx: Ctx): void => {
    const t = ctx.stateRef.current.sessionTokens;
    ctx.pushNotice(
      `Tokens — prompt ${t.prompt}, completion ${t.completion}, total ${t.prompt + t.completion}`,
    );
  },
};
