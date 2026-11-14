/** `/model` — the label the status bar already shows. */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "shownModel">;

export const command = {
  name: "/model",
  description: "show the active model",
  run: (ctx: Ctx): void => ctx.pushNotice(`Model: \`${ctx.shownModel}\``),
};
