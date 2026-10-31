/**
 * `tentacle ps`, `tentacle rm <name>` and `attach <name>`'s resolution
 * (docs/feat/engine-ps-rm.md): a thin IO shell over `kept.ts` (decisions) and
 * `kept-index.ts` (the laptop index). No Ink is mounted: plain lines.
 *
 * AGENTS §7 "Pod/container lifecycle": `rm` deletes ONLY a workload the engine
 * says carries tentacle's managed marker AND `tentacle.kept=true`, re-read
 * right before the delete, on the user's explicit command; a foreign workload
 * that took the name is never touched. Every entry is re-verified on every
 * read; an unreachable engine never prunes an entry.
 */
import { rmSync } from "node:fs";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { type KeptFile, forgetKept, readKept } from "./kept-index.ts";
import {
  EMPTY_LINE,
  type KeptEntry,
  type KeptRelay,
  type KeptRow,
  type KeptStatus,
  type Resolved,
  ambiguousMessage,
  isKeptWorkload,
  relayRemoveConfirmation,
  removeConfirmation,
  removedLine,
  renderTable,
  renderVerbose,
  resolveByName,
  sortKept,
  whereOf,
} from "./kept.ts";
import { type ProcOf, lockHolder, residentStop } from "./pod-resident.ts";
import {
  laptopProc,
  ownerKeeps,
  ownerPath,
  readOwner,
  relayLogPath,
  runDirIn,
  statusOf,
} from "./run-state.ts";
import { untrustedText } from "./untrusted-text.ts";
import { isYes } from "./workspace-mount.ts";

/** One engine's answer is bounded: a hung ssh host never hangs `ps`. */
export const VERIFY_TIMEOUT_MS = 3_000;

export interface KeptDeps {
  /** `<configDir>/kept`. */
  readonly dir: string;
  /** The ONE host builder (`buildEngineHost` + `hostOptionsFor`); may throw. */
  readonly hostFor: (entry: KeptEntry) => EngineHost;
  readonly write: (text: string) => void;
  /** Diagnostics when stdout must stay machine-readable (`ps -q`). */
  readonly writeErr: (text: string) => void;
  readonly now: () => number;
  readonly home: string;
  /** Dim marker (identity when not a colour terminal). */
  readonly dim: (text: string) => string;
  /** Present = interactive (the `rm` y/N); absent = no terminal. */
  readonly ask?: (prompt: string) => Promise<string>;
  readonly timeoutMs?: number;
  /** Default `laptopProc`. */
  readonly procOf?: ProcOf;
  /** Stop the relay holding a run dir; default `residentStop`. */
  readonly stopRelay?: (runDir: string) => Promise<unknown>;
}

const message = (error: unknown): string =>
  untrustedText(error instanceof Error ? error.message : String(error));

/** Rejects past `ms`. */
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ask the engine about one entry. Never throws. */
async function verify(
  entry: KeptEntry,
  deps: Pick<KeptDeps, "hostFor" | "timeoutMs">,
): Promise<{ status: KeptStatus; host?: EngineHost }> {
  let host: EngineHost;
  try {
    host = deps.hostFor(entry);
  } catch (error) {
    return { status: { kind: "unreachable", reason: message(error) } };
  }
  try {
    const facts = await bounded(host.describe(entry.name), deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
    if (facts === null) {
      return { status: { kind: "gone" }, host };
    }
    if (!isKeptWorkload(entry.engine, facts.labels)) {
      return { status: { kind: "foreign" }, host };
    }
    return { status: { kind: "state", state: facts.status, labels: facts.labels }, host };
  } catch (error) {
    return { status: { kind: "unreachable", reason: message(error) }, host };
  }
}

function reportProblems(problems: readonly string[], deps: KeptDeps, out: (t: string) => void) {
  for (const problem of problems) {
    out(`${deps.dim(`kept index: ${untrustedText(problem)} — left untouched`)}\n`);
  }
}

/** `tentacle ps [--engine e] [-q] [-v]`. Exit 0: skips are informational. */
export async function psCommand(
  options: {
    readonly engine?: EngineKind | undefined;
    readonly quiet?: boolean;
    readonly verbose?: boolean;
  },
  deps: KeptDeps,
): Promise<number> {
  const index = readKept(deps.dir);
  const entries = index.entries.filter(
    (e) => options.engine === undefined || e.entry.engine === options.engine,
  );
  if (options.quiet) {
    reportProblems(index.problems, deps, deps.writeErr);
    for (const { entry } of sortKept(entries)) {
      deps.write(`${untrustedText(entry.name)}\n`);
    }
    return 0;
  }
  reportProblems(index.problems, deps, deps.write);
  if (entries.length === 0) {
    deps.write(`${EMPTY_LINE}\n`);
    return 0;
  }
  const now = deps.now();
  const rows: KeptRow[] = sortKept(
    await Promise.all(
      entries.map(async ({ entry }) => {
        const { status } = await verify(entry, deps);
        const relay = relayRow(entry, deps, now);
        return { entry, status, ...(relay ? { relay } : {}) };
      }),
    ),
  );
  // One dim line per unreachable location (its rows stay listed: never a silent drop).
  const down = new Map<string, string>();
  for (const { entry, status } of rows) {
    if (status.kind === "unreachable") {
      down.set(`${entry.engine} ${untrustedText(whereOf(entry))}`, status.reason);
    }
  }
  const lines = options.verbose
    ? renderVerbose(rows, now, deps.home)
    : renderTable(rows, now, deps.home);
  deps.write(`${lines.join("\n")}\n`);
  for (const [where, reason] of down) {
    deps.write(`${deps.dim(`${where}: not reachable (skipped) — ${reason}`)}\n`);
  }
  return 0;
}

/** A detached run's row of `ps`; absent with no run dir (no lock: no process is looked at). */
function relayRow(entry: KeptEntry, deps: KeptDeps, now: number): KeptRelay | undefined {
  const dir = runDirIn(deps.dir, entry);
  const holder = lockHolder(dir, deps.procOf ?? laptopProc);
  const read = readOwner(dir);
  const text = statusOf(read, holder !== null, now);
  if (text === null) {
    return undefined;
  }
  const owner = read.kind === "owner" ? read.owner : undefined;
  return {
    text,
    ...(holder ? { pid: holder.pid } : {}),
    ...(owner ? { sessionId: owner.sessionId } : {}),
    log: relayLogPath(dir),
    keep: owner ? ownerKeeps(owner) : true,
  };
}

/**
 * What `removeVerifiedKept` did. Only `unreachable` and `failed` leave the
 * WORKLOAD in place. `forgetError` (on the three others) says how the workload
 * ended (`removalFate`) but its index entry could not be dropped: the two are
 * different facts, so the message must not call it "not removed" — and must not
 * call a `foreign` workload "removed" either.
 */
export type KeptRemoval =
  | { readonly kind: "removed"; readonly forgetError?: string }
  | { readonly kind: "gone"; readonly forgetError?: string }
  | { readonly kind: "foreign"; readonly forgetError?: string }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * What became of the WORKLOAD, in the words the relay's note and `rm` both use:
 * `forgetError` is a fact about the INDEX, never about this (`foreign` was not
 * removed, and saying so would report a delete that never happened).
 */
export function removalFate(kind: "removed" | "gone" | "foreign"): string {
  switch (kind) {
    case "removed":
      return "removed";
    case "gone":
      return "already gone";
    case "foreign":
      return "left alone (not tentacle's)";
  }
}

/** Drop the entry; a failure is a fact to report, never a failed delete. */
function forget(file: string): { readonly forgetError?: string } {
  try {
    forgetKept(file);
    return {};
  } catch (error) {
    return { forgetError: message(error) };
  }
}

/**
 * The ONE path that deletes a kept workload (`rm` and a keep=false relay):
 * what the engine says NOW, right before the delete, closes the list → delete
 * race and the k8s gap (`deletePod` itself checks no label). AGENTS §7: a
 * foreign workload that took the name is never touched.
 */
export async function removeVerifiedKept(
  entry: KeptEntry,
  file: string,
  deps: Pick<KeptDeps, "hostFor" | "timeoutMs">,
): Promise<KeptRemoval> {
  const { status, host } = await verify(entry, deps);
  if (status.kind === "unreachable" || host === undefined) {
    return {
      kind: "unreachable",
      reason: status.kind === "unreachable" ? status.reason : "no engine",
    };
  }
  if (status.kind === "gone" || status.kind === "foreign") {
    return { kind: status.kind, ...forget(file) };
  }
  try {
    await host.remove(entry.name);
  } catch (error) {
    return { kind: "failed", reason: message(error) };
  }
  return { kind: "removed", ...forget(file) };
}

/**
 * Past the relay's own bounds: its stop waits 5 s for the turn, `release` 3 s a
 * step, its delete 30 s (`relay-state.ts`, `local-runtime.ts`, `relay.ts`).
 */
export const RM_STOP_GRACE_MS = 45_000;

/** Delete a run dir whose workload is gone; an `owner.json` this build cannot read stays (§7). */
function dropRunDir(dir: string, write: (text: string) => void): void {
  if (readOwner(dir).kind === "unknown") {
    write(`Left ${ownerPath(dir)}: it is not readable by this version, delete it yourself.\n`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    write(`Could not delete ${dir}: ${message(error)}\n`);
  }
}

/** `tentacle rm [--engine e] [-f] <name>`. */
export async function rmCommand(
  name: string,
  options: { readonly engine?: EngineKind | undefined; readonly force?: boolean },
  deps: KeptDeps,
): Promise<number> {
  const index = readKept(deps.dir);
  reportProblems(index.problems, deps, deps.write);
  const found = resolveByName(name, index.entries, options.engine);
  if (found.kind === "none") {
    deps.write(
      `[error] no kept container or pod named "${untrustedText(name)}" — see \`tentacle ps\`\n`,
    );
    return 1;
  }
  if (found.kind === "ambiguous") {
    deps.write(
      `[error] ${ambiguousMessage(
        name,
        found.candidates.map((c) => c.entry),
      )}\nNothing was removed.\n`,
    );
    return 1;
  }
  const { entry, file } = found.match;
  const label = `${untrustedText(entry.name)} (${entry.engine}, ${untrustedText(whereOf(entry))})`;
  const noun = entry.engine === "kubernetes" ? "pod" : "container";
  const cannotReach = (reason: string): number => {
    deps.write(`[error] cannot reach ${label}: ${reason} — nothing removed, its entry is kept\n`);
    return 1;
  };
  const runDir = runDirIn(deps.dir, entry);
  const procOf = deps.procOf ?? laptopProc;
  const first = await verify(entry, deps);
  const holder = lockHolder(runDir, procOf);
  // Nothing will be removed: a live relay is left to its run.
  if (first.status.kind === "unreachable" && holder) {
    return cannotReach(first.status.reason);
  }
  const running = first.status.kind === "state" && first.status.state === "running";
  if ((running || holder) && !options.force) {
    if (!deps.ask) {
      deps.write(
        holder
          ? `[error] ${label} is owned by a detached run (pid ${holder.pid}). Pass -f to stop it and remove it without asking.\n`
          : `[error] ${label} is running — a session may be attached. Pass -f to remove it without asking.\n`,
      );
      return 1;
    }
    const prompt = holder
      ? relayRemoveConfirmation(
          entry,
          holder.pid,
          statusOf(readOwner(runDir), true, deps.now()) ?? "unknown owner",
        )
      : removeConfirmation(entry);
    if (!isYes(await deps.ask(prompt))) {
      deps.write("Not removed.\n");
      return 1;
    }
  }
  // After the answer: a "no" must cost the run nothing. SIGTERM: the relay
  // cancels the turn, saves and leaves, removing the workload itself on keep=false.
  if (holder) {
    deps.write(`stopping the detached run (pid ${holder.pid})…\n`);
    try {
      await (deps.stopRelay ?? ((dir) => residentStop(dir, RM_STOP_GRACE_MS, procOf)))(runDir);
    } catch (error) {
      deps.write(
        `[error] could not stop the detached run (pid ${holder.pid}): ${message(error)} — nothing removed\n`,
      );
      return 1;
    }
  }
  const removal = await removeVerifiedKept(entry, file, deps);
  // The workload's fate is already reported above; this says only that its index
  // ENTRY survived (a failed `rmSync`): never "not removed" for a delete that worked.
  const entryLeft = (forgetError: string | undefined): void => {
    if (forgetError !== undefined) {
      deps.write(
        `[warn] its entry in the kept index was not dropped: ${forgetError} — delete that file by hand\n`,
      );
    }
  };
  switch (removal.kind) {
    case "unreachable":
      return cannotReach(removal.reason);
    case "failed":
      deps.write(`[error] removing ${label} failed: ${removal.reason} — its entry is kept\n`);
      return 1;
    case "foreign":
      // "dropped its stale entry" only when it really was dropped (finding B).
      deps.write(
        `[error] ${label} is no longer a tentacle-kept ${noun} (no tentacle managed + kept labels) — left it alone${
          removal.forgetError === undefined ? "; dropped its stale entry" : ""
        }\n`,
      );
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.write);
      return 1;
    case "gone":
      // After a stop it is the relay's own keep=false removal: the same result.
      // The line names the WORKLOAD's fate only: on a failed forget the entry
      // is still there, so it must not claim it went (the `[warn]` below says it).
      deps.write(
        holder
          ? `${removedLine(entry, deps.home)}\n`
          : removal.forgetError === undefined
            ? `Removed the entry of ${label}: the ${noun} no longer exists.\n`
            : `The ${noun} of ${label} no longer exists.\n`,
      );
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.write);
      return 0;
    case "removed":
      deps.write(`${removedLine(entry, deps.home)}\n`);
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.write);
      return 0;
  }
}

/** `attach <name>` with no engine/location flag: the index alone decides (nothing dialled). */
export function resolveKeptAttach(
  name: string,
  dir: string,
): { readonly resolved: Resolved<KeptFile>; readonly problems: readonly string[] } {
  const index = readKept(dir);
  return { resolved: resolveByName(name, index.entries), problems: index.problems };
}
