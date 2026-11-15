/**
 * Project-hooks trust for a `serve` session (docs/feat/serve-mcp.md S4, owner
 * Q2=a). A `serve` daemon decides trust where the FOLDER is, not where the
 * client is: its host's own `<configDir>/hooks-trust.json` — the file this
 * machine's TUI writes — is read first, and a folder already trusted there
 * needs no prompt. That is what `connect` refuses to do on its side
 * (`connect.ts`: the folder is on another host), and what made a phone turn
 * silently never run project hooks at all.
 *
 * Pure decisions here; the ONE I/O (the file) is behind `fileTrustStore`.
 */
import type { HooksTrustParams } from "@tentacle/protocol";
import { type HooksTrustStore, type TrustEntry, fileTrustStore } from "./hooks-trust.ts";

/**
 * The precheck, over a lookup: `trusted` only for the SAME hooks file the store
 * recorded. Anything else (a changed hooks file, no entry, a `never` decision)
 * is left to the caller — which asks the prompting client.
 */
export function hooksTrustPrecheck(
  get: (folder: string) => TrustEntry | undefined,
  folder: string,
  hash: string,
): "trusted" | "ask" {
  const entry = get(folder);
  // Exactly `trusted` AND the same hash: a changed hooks file is a new question.
  return entry?.decision === "trusted" && entry.hash === hash ? "trusted" : "ask";
}

/**
 * The daemon-side precheck: `true` means "already trusted on this host, do not
 * ask anyone". It only ever answers "trusted" early — it never grants.
 */
export function serveHooksTrustPrecheck(
  configDir: string,
  store: Pick<HooksTrustStore, "get"> = fileTrustStore(configDir),
): (params: Pick<HooksTrustParams, "folder" | "hash">) => boolean {
  return (params) =>
    hooksTrustPrecheck((f) => store.get(f), params.folder, params.hash) === "trusted";
}
