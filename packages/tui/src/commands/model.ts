/** `/model` — list the models, or switch this session's (docs/feat/model-switch.md). */
import {
  modelListLines,
  modelSwitchFailedNotice,
  parseModelArg,
  switchedNotice,
} from "../model-switch.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<
  CommandContext,
  "pushNotice" | "sessionRef" | "shownModel" | "modelSwitched" | "contextTokens"
>;

export const command = {
  name: "/model",
  description: "show or switch the model (/model <name>, /model default)",
  run: (ctx: Ctx, raw: string): void => {
    const session = ctx.sessionRef.current;
    if (!session?.models || !session.setModel) {
      ctx.pushNotice(`Model: ${ctx.shownModel} — switching isn't available on this runtime.`);
      return;
    }
    const parsed = parseModelArg(raw);
    if ("usage" in parsed) {
      ctx.pushNotice(parsed.usage);
      return;
    }
    if ("list" in parsed) {
      void session.models().then(
        (result) => ctx.pushNotice(modelListLines(result).join("\n")),
        (error: unknown) => ctx.pushNotice(modelSwitchFailedNotice(error, "list")),
      );
      return;
    }
    const old = ctx.shownModel;
    void session.setModel(parsed.name).then(
      (next) => {
        ctx.modelSwitched({ session, label: next.model, contextWindow: next.contextWindow });
        // A view that moved on meanwhile counts another conversation.
        const tokens = ctx.sessionRef.current === session ? ctx.contextTokens() : null;
        ctx.pushNotice(switchedNotice(old, next, tokens));
      },
      (error: unknown) => ctx.pushNotice(modelSwitchFailedNotice(error)),
    );
  },
};
