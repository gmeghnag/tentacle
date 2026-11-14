/**
 * `/agents` — the dock's list (owner Q16 (b)): the same toggle Ctrl+T runs, so
 * the key and the command can never disagree.
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "toggleAgents">;

export const command = {
  name: "/agents",
  description: "background sub-agents and jobs: select, open, stop (ctrl+t)",
  run: (ctx: Ctx): void => ctx.toggleAgents(),
};
