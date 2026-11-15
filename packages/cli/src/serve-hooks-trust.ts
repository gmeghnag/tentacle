/**
 * Project-hooks trust for a `serve` session (docs/feat/serve-mcp.md S4, owner
 * Q2=a). A `serve` daemon decides trust where the FOLDER is, not where the
 * client is: its host's own `<configDir>/hooks-trust.json` — the file this
 * machine's TUI writes — is read first, and a folder already decided there
 * needs no prompt. That is what `connect` refuses to do on its side
 * (`connect.ts`: the folder is on another host), and what made a phone turn
 * silently never run project hooks at all.
 *
 * Pure decisions here; the ONE I/O (the file) is behind `fileTrustStore`.
 */
import type { HooksTrustPrecheck } from "@tentacle/daemon";
import type { HooksTrustParams } from "@tentacle/protocol";
import { type HooksTrustStore, type TrustEntry, fileTrustStore } from "./hooks-trust.ts";

/**
 * The precheck, over a lookup — the SAME three-way answer the TUI's own
 * `trustPrecheck` gives (`hooks-trust.ts`), minus the "interactive" axis a
 * daemon does not have:
 *
 * - `trusted`: the store trusted exactly this hooks file (the same hash);
 * - `declined`: the store was told `never` for this folder — a DECISION about
 *   where the folder is, valid for any hash (P2: a declined repo stops asking),
 *   so a remote client does not get to re-ask it;
 * - `ask`: no entry, or an entry for a changed hooks file — a new question, left
 *   to the caller, which asks the prompting client.
 */
export function hooksTrustPrecheck(
  get: (folder: string) => TrustEntry | undefined,
  folder: string,
  hash: string,
): "trusted" | "declined" | "ask" {
  const entry = get(folder);
  if (entry?.decision === "never") {
    return "declined";
  }
  // Exactly `trusted` AND the same hash: a changed hooks file is a new question.
  return entry?.decision === "trusted" && entry.hash === hash ? "trusted" : "ask";
}

/**
 * The daemon-side precheck: the host's own decision, before any client is
 * asked. It only ever answers early — it never grants an untrusted folder.
 */
export function serveHooksTrustPrecheck(
  configDir: string,
  store: Pick<HooksTrustStore, "get"> = fileTrustStore(configDir),
): HooksTrustPrecheck {
  return (params: Pick<HooksTrustParams, "folder" | "hash">) =>
    hooksTrustPrecheck((f) => store.get(f), params.folder, params.hash);
}
