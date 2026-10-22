/**
 * The laptop's answer to `hooks/trust` (docs/feat/hooks-project-trust.md).
 *
 * The laptop decides, and it alone stores: the runtime picks the resolver
 * (store-backed only for the local worker, never for a pod or `connect`), not
 * what the daemon claims. The question goes through THE single broker (AGENTS
 * §7) as a `hooks_trust` request, which auto-approve never answers. Pure:
 * `trustPrecheck`, `hooksTrustDetail`, `trustOutcome`; I/O: `fileTrustStore`.
 */
import { chmodSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { ProjectHooks } from "@tentacle/config";
import type { PermissionBroker, PermissionResponse } from "@tentacle/core";
import {
  type HooksTrustParams,
  HooksTrustParamsSchema,
  type HooksTrustResult,
} from "@tentacle/protocol";

export const TRUST_FILENAME = "hooks-trust.json";

export interface TrustEntry {
  readonly hash: string;
  readonly decision: "trusted" | "never";
}

/** Pure: what to do before asking anyone. */
export function trustPrecheck(
  entry: TrustEntry | undefined,
  hash: string,
  interactive: boolean,
): "trusted" | "declined" | "ask" {
  if (entry?.decision === "never") {
    return "declined"; // any hash (P2): a declined repo stops asking
  }
  if (entry?.decision === "trusted" && entry.hash === hash) {
    return "trusted";
  }
  return interactive ? "ask" : "declined";
}

/**
 * Pure: a human's answer → the result and what to store. `store` is only
 * ever honoured by the caller when a store exists (the local worker). Every
 * menu choice that trusts carries a scope; a bare `{ allowed: true }` is a
 * headless requester (`allowAll` on a broker with no prompt mounted), never
 * a human — so it does NOT trust.
 */
export function trustOutcome(response: PermissionResponse): {
  trusted: boolean;
  store?: TrustEntry["decision"];
} {
  if (response.dismissed === true) {
    return { trusted: false };
  }
  if (response.allowed) {
    if (response.scope === "session") {
      return { trusted: true, store: "trusted" };
    }
    return { trusted: response.scope === "once" };
  }
  return response.scope === "session" ? { trusted: false, store: "never" } : { trusted: false };
}

/** Pure: the prompt's multi-line detail. */
export function hooksTrustDetail(p: HooksTrustParams): string {
  const lines = [p.folder];
  for (const h of p.hooks) {
    const model = h.model !== undefined ? ` (model: ${h.model})` : "";
    lines.push(
      `${h.event}${h.matcher !== undefined ? ` ${h.matcher}` : ""} → ${h.command}${model}`,
    );
  }
  if (p.files.length > 0) {
    lines.push(`from ${p.files.join(", ")}`);
  }
  if (p.canAllow) {
    lines.push("These hooks can approve tool calls without asking you.");
  }
  lines.push("This trusts these commands, not the contents of the files they run.");
  return lines.join("\n");
}

export interface HooksTrustStore {
  get(folder: string): TrustEntry | undefined;
  set(folder: string, entry: TrustEntry): void;
  delete(folder: string): boolean;
  list(): [string, TrustEntry][];
}

function isEntry(v: unknown): v is TrustEntry {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const e = v as Record<string, unknown>;
  return typeof e.hash === "string" && (e.decision === "trusted" || e.decision === "never");
}

/**
 * File-backed: `<configDir>/hooks-trust.json`, written atomically (temp +
 * rename), 0600. A missing or corrupt file reads as empty (corrupt is
 * reported through `onError`); the next `set` rewrites it.
 */
export function fileTrustStore(
  configDir: string,
  onError?: (message: string) => void,
): HooksTrustStore {
  const path = join(configDir, TRUST_FILENAME);
  const read = (): Record<string, TrustEntry> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return {};
    }
    try {
      const raw: unknown = JSON.parse(text);
      const out: Record<string, TrustEntry> = {};
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [folder, entry] of Object.entries(raw)) {
          if (isEntry(entry)) {
            out[folder] = { hash: entry.hash, decision: entry.decision };
          }
        }
        return out;
      }
    } catch {
      // fall through
    }
    onError?.(`${path} is corrupt; treated as empty`);
    return {};
  };
  const write = (data: Record<string, TrustEntry>): void => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  return {
    get: (folder) => read()[folder],
    set: (folder, entry) => {
      write({ ...read(), [folder]: entry });
    },
    delete: (folder) => {
      const data = read();
      if (!Object.hasOwn(data, folder)) {
        return false;
      }
      const { [folder]: _gone, ...rest } = data;
      write(rest);
      return true;
    },
    list: () => Object.entries(read()),
  };
}

export type HooksTrustResolver = (
  params: HooksTrustParams,
  signal?: AbortSignal,
) => Promise<HooksTrustResult>;

/**
 * The laptop's resolver. `store` is passed for the local worker ONLY (D4); a
 * pod (D5) and `connect` get none, so nothing they ask is ever stored —
 * whatever the request or the answer says.
 */
export function createHooksTrustResolver(opts: {
  readonly broker: PermissionBroker;
  readonly interactive: boolean;
  readonly store?: HooksTrustStore;
  readonly notify?: (line: string) => void;
}): HooksTrustResolver {
  return async (p, signal) => {
    const store = opts.store;
    const pre = trustPrecheck(store?.get(p.folder), p.hash, opts.interactive);
    if (pre === "trusted") {
      return { trusted: true };
    }
    if (pre === "declined") {
      if (!opts.interactive) {
        opts.notify?.(`project hooks of ${p.folder} not run: no one to ask (non-interactive)`);
      }
      return { trusted: false };
    }
    const response = await opts.broker.request(
      {
        kind: "hooks_trust",
        tool: "hooks",
        level: "ask",
        title: "Trust the hooks of this project?",
        detail: hooksTrustDetail(p),
        input: { ...p, storeBacked: store !== undefined },
      },
      signal ? { signal } : undefined,
    );
    const outcome = trustOutcome(response);
    if (store !== undefined && outcome.store !== undefined) {
      store.set(p.folder, { hash: p.hash, decision: outcome.store });
    }
    return { trusted: outcome.trusted };
  };
}

/**
 * `tentacle hooks trust --list | --revoke <folder>` (P3): inspect and revoke
 * the stored decisions. Runs before any TUI, so plain output is fine.
 */
export function hooksTrustCommand(
  store: HooksTrustStore,
  args: {
    readonly positional: readonly string[];
    readonly list: boolean;
    readonly revoke?: string;
  },
  write: (line: string) => void,
): number {
  if (args.positional[0] !== "trust" || (!args.list && args.revoke === undefined)) {
    write("usage: tentacle hooks trust --list | --revoke <folder>\n");
    return 1;
  }
  if (args.list) {
    const entries = store.list();
    if (entries.length === 0) {
      write("no stored project hooks decisions\n");
    }
    for (const [folder, entry] of entries) {
      write(`${entry.decision}\t${entry.hash.slice(0, 12)}\t${folder}\n`);
    }
    return 0;
  }
  // Decisions are keyed by the folder's real path (`discoverProjectHooks`):
  // resolve `.` / relative / symlinked input; a folder gone from disk is
  // revoked by the path as given (resolved).
  const given = args.revoke ?? "";
  let folder = resolvePath(given);
  try {
    folder = realpathSync(given);
  } catch {
    // keep the resolved path
  }
  if (store.delete(folder)) {
    write(`revoked: ${folder}\n`);
    return 0;
  }
  write(`no stored decision for ${folder}\n`);
  return 1;
}

/**
 * Pure: why these project hooks could never be offered for trust — the
 * `hooks/trust` request they make would fail the wire schema (too many,
 * control characters, too long) and be declined at every session. A startup
 * `[hooks]` diagnostic, so it is not only a daemon-log line. Undefined = fine.
 */
export function projectHooksWireProblem(p: ProjectHooks): string | undefined {
  const parsed = HooksTrustParamsSchema.safeParse({
    sessionId: "startup",
    folder: p.folder,
    hash: p.hash,
    files: [...p.files],
    hooks: p.hooks.map((h) =>
      h.matcher !== undefined
        ? { event: h.event, matcher: h.matcher, command: h.command }
        : { event: h.event, command: h.command },
    ),
    canAllow: true,
  });
  if (parsed.success) {
    return undefined;
  }
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `project hooks of ${p.folder} cannot be offered for trust and will not run (${where}${issue?.message ?? "invalid"})`;
}
