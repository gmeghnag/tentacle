/** `/skills` — every skill found, in a panel (the session's list, read again). */
import { skillsListError } from "../commands.ts";
import { skillsPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "openPanel" | "skillsSync">;

export const command = {
  name: "/skills",
  description: "every skill found: who can use it, and any problems",
  run: (ctx: Ctx): void => {
    // The session's skills read again (docs/feat/skills-hot-reload.md).
    ctx.openPanel(
      skillsPanel(),
      () => ctx.skillsSync.refresh().then((list) => skillsPanel(list)),
      skillsListError,
    );
  },
};
