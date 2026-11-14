/** `/mcp` — the servers' reachability and their tools, as a panel. */
import { mcpStatusError } from "../commands.ts";
import { mcpPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "mcpStatus" | "openPanel">;

export const command = {
  name: "/mcp",
  description: "MCP servers: reachability and their tools",
  run: (ctx: Ctx): void => {
    const mcpStatus = ctx.mcpStatus;
    if (!mcpStatus) {
      ctx.pushNotice("_MCP status isn't available on this runtime._");
      return;
    }
    ctx.openPanel(
      mcpPanel(),
      () => mcpStatus().then((servers) => mcpPanel(servers)),
      mcpStatusError,
    );
  },
};
