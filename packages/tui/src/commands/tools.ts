/** `/tools` — the session's built-in tools, what each costs the context, and on/off (docs/feat/tool-toggles.md D7). */
import { toolsListError } from "../commands.ts";
import { toolsPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "sessionRef" | "openPanel">;

export const command = {
  name: "/tools",
  description: "built-in tools: what each costs the context — and on/off for this session",
  run: (ctx: Ctx): void => {
    const session = ctx.sessionRef.current;
    if (!session?.tools) {
      ctx.pushNotice("_The tool list isn't available on this runtime._");
      return;
    }
    const list = session.tools.bind(session);
    ctx.openPanel(
      toolsPanel(),
      () => list().then((result) => toolsPanel(result.tools)),
      toolsListError,
    );
  },
};
