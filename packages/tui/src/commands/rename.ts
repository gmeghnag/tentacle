/** `/rename <title>` — the daemon makes it one line and says what it stored. */
import { parseRename, renameFailedNotice, renamedNotice } from "../commands.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "sessionRef">;

export const command = {
  name: "/rename",
  description: "rename this session (the title every device shows)",
  run: (ctx: Ctx, raw: string): void => {
    const session = ctx.sessionRef.current;
    if (!session?.rename) {
      ctx.pushNotice("_Renaming isn't available on this runtime._");
      return;
    }
    const parsed = parseRename(raw);
    if ("usage" in parsed) {
      ctx.pushNotice(parsed.usage);
      return;
    }
    void session.rename(parsed.title).then(
      (text) => ctx.pushNotice(renamedNotice(text)),
      (error: unknown) => ctx.pushNotice(renameFailedNotice(error)),
    );
  },
};
