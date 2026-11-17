/**
 * `/artifacts` — the session's presented artifacts (docs/feat/model-artifacts.md
 * D8): the panel opens at once in its loading state, then shows the daemon's
 * `artifact/list` newest-first with each artifact's versions folded under it.
 *
 * Absent when the runtime's session cannot list them (an older daemon, or a
 * bare test session): the command says so rather than opening an empty panel,
 * which is what `/sessions` already does for its own directory.
 */
import { NO_ARTIFACT_LIST, artifactsListError } from "../artifacts-panel.ts";
import { artifactsPanel } from "../panel.ts";
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "pushNotice" | "sessionRef" | "openPanel">;

export const command = {
  name: "/artifacts",
  description: "list the artifacts the model presented here",
  run: (ctx: Ctx): void => {
    const session = ctx.sessionRef.current;
    const list = session?.listArtifacts;
    if (!session || list === undefined) {
      ctx.pushNotice(NO_ARTIFACT_LIST);
      return;
    }
    ctx.openPanel(
      artifactsPanel(null),
      () => list.call(session).then((result) => artifactsPanel(result, Date.now())),
      artifactsListError,
    );
  },
};
