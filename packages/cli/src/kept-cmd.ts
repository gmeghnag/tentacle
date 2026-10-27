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
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { type KeptFile, forgetKept, readKept } from "./kept-index.ts";
import {
  EMPTY_LINE,
  type KeptEntry,
  type KeptRow,
  type KeptStatus,
  type Resolved,
  ambiguousMessage,
  isKeptWorkload,
  removeConfirmation,
  removedLine,
  renderTable,
  renderVerbose,
  resolveByName,
  sortKept,
  summaryLine,
  whereOf,
} from "./kept.ts";
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
}

const message = (error: unknown): string =>
  untrustedText(error instanceof Error ? error.message : String(error));

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ask the engine about one entry. Never throws. */
async function verify(
  entry: KeptEntry,
  deps: KeptDeps,
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
  const rows: KeptRow[] = sortKept(
    await Promise.all(
      entries.map(async ({ entry }) => ({ entry, status: (await verify(entry, deps)).status })),
    ),
  );
  // One dim line per unreachable location (its rows stay listed: never a silent drop).
  const down = new Map<string, string>();
  for (const { entry, status } of rows) {
    if (status.kind === "unreachable") {
      down.set(`${entry.engine} ${untrustedText(whereOf(entry))}`, status.reason);
    }
  }
  const now = deps.now();
  const lines = options.verbose
    ? renderVerbose(rows, now, deps.home)
    : [...renderTable(rows, now, deps.home), ""];
  deps.write(`${lines.join("\n")}\n`);
  for (const [where, reason] of down) {
    deps.write(`${deps.dim(`${where}: not reachable (skipped) — ${reason}`)}\n`);
  }
  deps.write(`${summaryLine(rows.length)}\n`);
  return 0;
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
  // Decide on what the engine says NOW; returns the host when it may be removed.
  const check = async (): Promise<EngineHost | number> => {
    const { status, host } = await verify(entry, deps);
    if (status.kind === "unreachable" || host === undefined) {
      deps.write(
        `[error] cannot reach ${label}: ${status.kind === "unreachable" ? status.reason : "no engine"} — nothing removed, its entry is kept\n`,
      );
      return 1;
    }
    if (status.kind === "gone") {
      forgetKept(file);
      deps.write(`Removed the entry of ${label}: the ${noun} no longer exists.\n`);
      return 0;
    }
    if (status.kind === "foreign") {
      forgetKept(file);
      deps.write(
        `[error] ${label} is no longer a tentacle-kept ${noun} (no tentacle managed + kept labels) — left it alone; dropped its stale entry\n`,
      );
      return 1;
    }
    return host;
  };
  const first = await verify(entry, deps);
  if (first.status.kind === "state" && first.status.state === "running" && !options.force) {
    if (!deps.ask) {
      deps.write(
        `[error] ${label} is running — a session may be attached. Pass -f to remove it without asking.\n`,
      );
      return 1;
    }
    if (!isYes(await deps.ask(removeConfirmation(entry)))) {
      deps.write("Not removed.\n");
      return 1;
    }
  }
  // Re-verified right before the delete: closes the list → delete race and
  // the k8s gap (`deletePod` itself checks no label).
  const checked = await check();
  if (typeof checked === "number") {
    return checked;
  }
  try {
    await checked.remove(entry.name);
  } catch (error) {
    deps.write(`[error] removing ${label} failed: ${message(error)} — its entry is kept\n`);
    return 1;
  }
  forgetKept(file);
  deps.write(`${removedLine(entry, deps.home)}\n`);
  return 0;
}

/** `attach <name>` with no engine/location flag: the index alone decides (nothing dialled). */
export function resolveKeptAttach(
  name: string,
  dir: string,
): { readonly resolved: Resolved<KeptFile>; readonly problems: readonly string[] } {
  const index = readKept(dir);
  return { resolved: resolveByName(name, index.entries), problems: index.problems };
}
