/** `/save` — the transcript as Markdown, under `cwd`. */
import { transcriptToMarkdown } from "../commands.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "stateRef" | "cwd" | "saveFile">;

export const command = {
  name: "/save",
  description: "save the transcript to a Markdown file",
  run: (ctx: Ctx): void => {
    const path = `${ctx.cwd}/tentacle-transcript-${Date.now()}.md`;
    const md = transcriptToMarkdown(ctx.stateRef.current.items);
    void ctx.saveFile(path, md).then(
      () => ctx.pushNotice(`_Saved transcript to ${path}_`),
      (error) => ctx.pushNotice(`_Save failed: ${String(error)}_`),
    );
  },
};
