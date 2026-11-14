/** `/copy` — the last assistant reply to the clipboard. */
import { lastAssistantText } from "../commands.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "stateRef" | "clipboard">;

export const command = {
  name: "/copy",
  description: "copy the last assistant reply to the clipboard",
  run: (ctx: Ctx): void => {
    const text = lastAssistantText(ctx.stateRef.current.items);
    if (!text) {
      ctx.pushNotice("_No assistant reply to copy._");
      return;
    }
    void ctx.clipboard(text).then(
      () => ctx.pushNotice("_Copied last reply to the clipboard._"),
      () => ctx.pushNotice("_Clipboard unavailable._"),
    );
  },
};
