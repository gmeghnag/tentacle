/**
 * Project-hooks trust on the PHONE (docs/feat/serve-mcp.md S4, owner Q2=a).
 *
 * The phone had no `hooksTrust` at all, so a phone turn in a project with
 * project hooks answered `{trusted:false}` through `RemoteClient`'s default and
 * the hooks silently never ran. This resolver raises a `hooks_trust` ask on the
 * phone's OWN link broker — the permission sheet routes it to a person, and
 * auto-accept never answers it (`permission-sheet.ts`: a `hooks_trust` ask
 * always reaches a human).
 *
 * Nothing is stored here: the folder lives on the computer, and the serve host's
 * own trust file is checked there first (`serve-hooks-trust.ts`). The answer is
 * session-scoped by the daemon, exactly like a terminal's "not stored from here".
 *
 * Pure and RN-free, so it is tested without React Native (AGENTS §7).
 */
import type { PermissionBroker } from "@tentacle/core";
import type { HooksTrustParams, HooksTrustResult } from "@tentacle/protocol";

/** The multi-line detail a phone sheet shows: folder, then each hook. */
export function phoneHooksTrustDetail(params: HooksTrustParams): string {
  const lines = [params.folder];
  for (const hook of params.hooks) {
    const model = hook.model !== undefined ? ` (model: ${hook.model})` : "";
    promptMatcher(hook.matcher) === ""
      ? lines.push(`${hook.event} → ${hook.command}${model}`)
      : lines.push(`${hook.event} ${hook.matcher} → ${hook.command}${model}`);
  }
  if (params.files.length > 0) {
    lines.push(`from ${params.files.join(", ")}`);
  }
  if (params.canAllow) {
    lines.push("These hooks can approve tool calls without asking you.");
  }
  lines.push("This trusts these commands, not the contents of the files they run.");
  return lines.join("\n");
}

const promptMatcher = (matcher: string | undefined): string => matcher ?? "";

/**
 * The phone's resolver: one `hooks_trust` ask through the link broker. `deny`
 * and a dismissed prompt both answer `{trusted:false}` — the hooks do not run,
 * which is the refusal the daemon then reports.
 */
export function phoneHooksTrust(broker: PermissionBroker) {
  return async (params: HooksTrustParams, signal?: AbortSignal): Promise<HooksTrustResult> => {
    const response = await broker.request(
      {
        kind: "hooks_trust",
        tool: "hooks",
        level: "ask",
        title: "Trust the hooks of this project?",
        detail: phoneHooksTrustDetail(params),
        // A phone never stores a decision (the folder is on another host), so
        // there is nothing to offer as "always": the daemon answers per session.
        input: { ...params, storeBacked: false },
      },
      signal ? { signal } : undefined,
    );
    return { trusted: response.allowed === true && response.dismissed !== true };
  };
}
