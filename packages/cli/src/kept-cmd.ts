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
import { type Kubeconfig, readKubeconfig } from "@tentacle/k8s";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { type KeptFile, forgetKept, readKept } from "./kept-index.ts";
import {
  type KeptEntry,
  type KeptRelay,
  type KeptRow,
  type KeptStatus,
  type Resolved,
  ambiguousMessage,
  createdVerdict,
  isKeptWorkload,
  relayRemoveConfirmation,
  removeConfirmation,
  removedLine,
  renderTable,
  renderVerbose,
  resolveByName,
  runningReason,
  shownInPs,
  sortKept,
  unreachableNote,
  whereOf,
} from "./kept.ts";
import { type ProcOf, lockHolder, residentStop } from "./pod-resident.ts";
import {
  attachers,
  laptopProc,
  ownerPath,
  ownerRemoves,
  readOwner,
  relayLogPath,
  runDirIn,
  runFinished,
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
  /**
   * STDOUT: the data only — `ps`'s table, `ps -q`'s names, the NAME of each
   * workload `rm` removed (docs/fix/cli-output-streams.md D3).
   */
  readonly out: (text: string) => void;
  /** STDERR: everything else — notes, prose, errors, warnings, progress. */
  readonly err: (text: string) => void;
  readonly now: () => number;
  readonly home: string;
  /** Dim marker for `err`'s lines (identity unless stderr is a colour terminal). */
  readonly dim: (text: string) => string;
  /** The laptop kubeconfig for the k8s WHERE; default `readKubeconfig` (undefined = unreadable). */
  readonly kubeconfig?: () => Kubeconfig | undefined;
  /** Present = interactive (the `rm` y/N); absent = no terminal. */
  readonly ask?: (prompt: string) => Promise<string>;
  readonly timeoutMs?: number;
  /** Default `laptopProc`. */
  readonly procOf?: ProcOf;
  /** Stop the relay holding a run dir; default `residentStop`. */
  readonly stopRelay?: (runDir: string) => Promise<unknown>;
}

/** The kubeconfig, read once per command; any failure is `undefined`, never a throw. */
function kubeOf(deps: Pick<KeptDeps, "kubeconfig">): Kubeconfig | undefined {
  try {
    return (deps.kubeconfig ?? readKubeconfig)();
  } catch {
    return undefined;
  }
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
    return {
      status: {
        kind: "state",
        state: facts.status,
        labels: facts.labels,
        ...(facts.annotations ? { annotations: facts.annotations } : {}),
      },
      host,
    };
  } catch (error) {
    return { status: { kind: "unreachable", reason: message(error) }, host };
  }
}

/** The kept index's unreadable files: a note on STDERR (a piped `ps` stays clean). */
function reportProblems(problems: readonly string[], deps: KeptDeps) {
  for (const problem of problems) {
    deps.err(`${deps.dim(`kept index: ${untrustedText(problem)} — left untouched`)}\n`);
  }
}

/** `tentacle ps [--engine e] [-a] [-q] [-v]`. Exit 0: skips are informational. */
export async function psCommand(
  options: {
    readonly engine?: EngineKind | undefined;
    readonly quiet?: boolean;
    readonly verbose?: boolean;
    /** `-a`: also the rows the engine says are gone (`shownInPs`). */
    readonly all?: boolean;
  },
  deps: KeptDeps,
): Promise<number> {
  const index = readKept(deps.dir);
  const entries = index.entries.filter(
    (e) => options.engine === undefined || e.entry.engine === options.engine,
  );
  reportProblems(index.problems, deps);
  if (options.quiet) {
    for (const { entry } of sortKept(entries)) {
      deps.out(`${untrustedText(entry.name)}\n`);
    }
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
  ).filter((row) => shownInPs(row, options.all === true));
  // Nothing to show (none kept, or only `gone` rows hidden): the table has just
  // its header, like `docker ps` (owner Q-R2); `-v` has no blocks, so no output.
  if (rows.length === 0 && options.verbose) {
    return 0;
  }
  // One dim line per unreachable location (its rows stay listed: never a silent drop).
  const kube = rows.some((r) => r.entry.engine === "kubernetes") ? kubeOf(deps) : undefined;
  const down = new Set<string>();
  for (const { entry, status } of rows) {
    if (status.kind === "unreachable") {
      down.add(unreachableNote(entry.engine, untrustedText(whereOf(entry, kube)), status.reason));
    }
  }
  const lines = options.verbose
    ? renderVerbose(rows, now, deps.home)
    : renderTable(rows, now, deps.home, kube);
  deps.out(`${lines.join("\n")}\n`);
  // STDERR: `ps` / `ps -q` piped stay clean.
  for (const note of down) {
    deps.err(`${deps.dim(note)}\n`);
  }
  return 0;
}

/** A detached run's row of `ps`; absent with no run dir (no lock: no process is looked at). */
function relayRow(entry: KeptEntry, deps: KeptDeps, now: number): KeptRelay | undefined {
  const dir = runDirIn(deps.dir, entry);
  const holder = lockHolder(dir, deps.procOf ?? laptopProc);
  const read = readOwner(dir);
  // The TUIs on it (docs/feat/detached-handover.md): their presence files.
  const tuis = attachers(dir, deps.procOf ?? laptopProc)
    .map((a) => a.pid)
    .sort((a, b) => a - b);
  const text = statusOf(read, holder !== null, now, tuis.length);
  if (text === null) {
    return undefined;
  }
  const owner = read.kind === "owner" ? read.owner : undefined;
  // R4: the same tie `planAttach` makes. A record that does not carry THIS
  // entry's `created` belongs to an earlier workload of a reused name: it gives
  // that name no session and no deletion, so `ps` must not show them either.
  const tied = owner !== undefined && owner.created === entry.created;
  const known = tied ? owner : undefined;
  return {
    text,
    ...(tuis.length > 0 ? { attached: tuis } : {}),
    ...(holder ? { pid: holder.pid } : {}),
    ...(known ? { sessionId: known.sessionId } : {}),
    log: relayLogPath(dir),
    rm: known ? ownerRemoves(known) : false,
    ...(tied && runFinished(read, holder !== null, tuis.length) ? { finished: true } : {}),
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
  /** Kept, but its own `created` is another workload's: a reuse OUTSIDE this index. */
  | { readonly kind: "other"; readonly forgetError?: string }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * What became of the WORKLOAD, in the words the relay's note and `rm` both use:
 * `forgetError` is a fact about the INDEX, never about this (`foreign` was not
 * removed, and saying so would report a delete that never happened).
 */
export function removalFate(kind: "removed" | "gone" | "foreign" | "other"): string {
  switch (kind) {
    case "removed":
      return "removed";
    case "gone":
      return "already gone";
    case "foreign":
      return "left alone (not tentacle's)";
    case "other":
      return "left alone (another workload now owns that name)";
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
 * The ONE path that deletes a kept workload (`rm` and an `--rm` relay):
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
  // R3: the labels say tentacle AND kept — but WHICH workload? Its own `created`
  // is the answer: a kept workload re-created at this place outside this index
  // (`run --name box` on another laptop or config dir) carries the same
  // labels, and its entry lives elsewhere. Deleting it would be a stranger's
  // workload; the stale entry here is dropped instead (nothing is deleted).
  if (createdVerdict(entry, status) === "other") {
    return { kind: "other", ...forget(file) };
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

/**
 * `tentacle rm [--engine e] [-f] <name>...` (docs/fix/detach-live-followups.md
 * F3, owner OQ7): one name at a time, in order, each exactly as a lone `rm`
 * (its own engine read, y/N and stop); a repeat runs once. A failure does not
 * stop the next names; exit 1 if any failed.
 */
export async function rmCommand(
  names: string | readonly string[],
  options: { readonly engine?: EngineKind | undefined; readonly force?: boolean },
  deps: KeptDeps,
): Promise<number> {
  let code = 0;
  for (const name of new Set(typeof names === "string" ? [names] : names)) {
    code = Math.max(code, await rmOne(name, options, deps));
  }
  return code;
}

async function rmOne(
  name: string,
  options: { readonly engine?: EngineKind | undefined; readonly force?: boolean },
  deps: KeptDeps,
): Promise<number> {
  const index = readKept(deps.dir);
  reportProblems(index.problems, deps);
  const found = resolveByName(name, index.entries, options.engine);
  // Only a k8s name needs the kubeconfig (as in `ps`).
  const k8sNamed =
    found.kind === "one" ? [found.match] : found.kind === "ambiguous" ? found.candidates : [];
  const kube = k8sNamed.some((m) => m.entry.engine === "kubernetes") ? kubeOf(deps) : undefined;
  if (found.kind === "none") {
    deps.err(
      `[error] no kept container or pod named "${untrustedText(name)}" — see \`tentacle ps\`\n`,
    );
    return 1;
  }
  if (found.kind === "ambiguous") {
    deps.err(
      `[error] ${ambiguousMessage(
        name,
        found.candidates.map((c) => c.entry),
        kube,
      )}\nNothing was removed.\n`,
    );
    return 1;
  }
  const { entry, file } = found.match;
  const label = `${untrustedText(entry.name)} (${entry.engine}, ${untrustedText(whereOf(entry, kube))})`;
  const noun = entry.engine === "kubernetes" ? "pod" : "container";
  const cannotReach = (reason: string): number => {
    deps.err(`[error] cannot reach ${label}: ${reason} — nothing removed, its entry is kept\n`);
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
    // Said only of THIS workload's run (R4): a reused name's record proves nothing.
    const read = readOwner(runDir);
    const finished =
      read.kind === "owner" &&
      read.owner.created === entry.created &&
      runFinished(read, holder !== null, attachers(runDir, procOf).length);
    if (!deps.ask) {
      deps.err(
        holder
          ? `[error] ${label} is owned by a detached run (pid ${holder.pid}). Pass -f to stop it and remove it without asking.\n`
          : `[error] ${label} ${runningReason(finished)}. Pass -f to remove it without asking.\n`,
      );
      return 1;
    }
    const prompt = holder
      ? relayRemoveConfirmation(
          entry,
          holder.pid,
          statusOf(readOwner(runDir), true, deps.now()) ?? "unknown owner",
          kube,
        )
      : removeConfirmation(entry, kube, finished);
    if (!isYes(await deps.ask(prompt))) {
      deps.err("Not removed.\n");
      return 1;
    }
  }
  // After the answer: a "no" must cost the run nothing. SIGTERM: the relay
  // cancels the turn, saves and leaves, removing the workload itself on an `--rm` run.
  if (holder) {
    deps.err(`stopping the detached run (pid ${holder.pid})…\n`);
    try {
      await (deps.stopRelay ?? ((dir) => residentStop(dir, RM_STOP_GRACE_MS, procOf)))(runDir);
    } catch (error) {
      deps.err(
        `[error] could not stop the detached run (pid ${holder.pid}): ${message(error)} — nothing removed\n`,
      );
      return 1;
    }
  }
  const removal = await removeVerifiedKept(entry, file, deps);
  // The workload's fate is already reported above; this says only that its index
  // ENTRY survived (a failed `rmSync`): never "not removed" for a delete that worked.
  // D3 (docs/fix/cli-output-streams.md): an `rm` that succeeded (exit 0) prints
  // the workload's NAME on stdout, like `docker rm`; its prose went to stderr.
  const removedName = (): void => deps.out(`${untrustedText(entry.name)}\n`);
  const entryLeft = (forgetError: string | undefined): void => {
    if (forgetError !== undefined) {
      deps.err(
        `[warn] its entry in the kept index was not dropped: ${forgetError} — delete that file by hand\n`,
      );
    }
  };
  switch (removal.kind) {
    case "unreachable":
      return cannotReach(removal.reason);
    case "failed":
      deps.err(`[error] removing ${label} failed: ${removal.reason} — its entry is kept\n`);
      return 1;
    case "foreign":
      // "dropped its stale entry" only when it really was dropped (finding B).
      deps.err(
        `[error] ${label} is no longer a tentacle-kept ${noun} (no tentacle managed + kept labels) — left it alone${
          removal.forgetError === undefined ? "; dropped its stale entry" : ""
        }\n`,
      );
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.err);
      return 1;
    case "gone":
      // After a stop it is the relay's own `--rm` removal: the same result.
      // The line names the WORKLOAD's fate only: on a failed forget the entry
      // is still there, so it must not claim it went (the `[warn]` below says it).
      deps.err(
        holder
          ? `${removedLine(entry, deps.home, kube)}\n`
          : removal.forgetError === undefined
            ? `Removed the entry of ${label}: the ${noun} no longer exists.\n`
            : `The ${noun} of ${label} no longer exists.\n`,
      );
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.err);
      removedName();
      return 0;
    case "other":
      // R3: the name now holds a KEPT workload that is not this entry's (its own
      // `created` is another's). Nothing was deleted; the stale entry is dropped.
      deps.err(
        `[error] ${label} now names another tentacle workload (its creation time is not this entry's) — left it alone${
          removal.forgetError === undefined ? "; dropped its stale entry" : ""
        }\n`,
      );
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.err);
      return 1;
    case "removed":
      deps.err(`${removedLine(entry, deps.home, kube)}\n`);
      entryLeft(removal.forgetError);
      dropRunDir(runDir, deps.err);
      removedName();
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
