/**
 * `/help` — the command list (and the skills, which are asked fresh:
 * docs/feat/skills-hot-reload.md).
 */
import { helpText } from "../commands.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "skills" | "skillsSync">;

export const command = {
  name: "/help",
  description: "show this help",
  run: (ctx: Ctx): void => {
    void ctx.skillsSync.settle().then(() => ctx.pushNotice(helpText(ctx.skills())));
  },
};
