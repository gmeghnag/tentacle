/** `/attach <path>` — its own body lives with the attachments (`attachCommand`). */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "attachCommand">;

export const command = {
  name: "/attach",
  description: "attach an image (or drag its file into the terminal)",
  run: (ctx: Ctx, raw: string): void => ctx.attachCommand(raw),
};
