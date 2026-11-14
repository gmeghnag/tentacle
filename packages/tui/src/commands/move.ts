/**
 * `/move` — one line: the grammar is `hop-command.ts`'s (`parseHopCommand`), the
 * turn-boundary decision too (`hopStep`), and the machine (build, plan, commit)
 * is the host's `hop` feed. This file only hands the typed line over
 * (docs/feat/session-hop.md D3); the App owns the refs that say whether a hop
 * may start now (`requestHop`), so it is an App-level driver like `/clear`.
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "requestHop">;

export const command = {
  name: "/move",
  description: "move this session to a container, or back to local",
  run: (ctx: Ctx, raw: string): void => ctx.requestHop(raw),
};
