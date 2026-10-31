/**
 * A detached run's laptop state (docs/feat/detached-relay.md):
 * `<configDir>/kept/runs/<stem>/`, `<stem>` being its kept entry's file name,
 * so the kept index (top-level `*.json` only) never sees it. Dir 0700, files
 * 0600, no secrets: the spec's relay reads its model key from the config or the
 * inherited env, as any laptop process does.
 *
 * - `.lock.<n>`: the generation lock (`acquireResidentLock`), held by the relay.
 * - `spec.json`: what the launcher tells the relay; unlinked once read.
 * - `owner.json`: the relay's state, atomic; it stays as the last state.
 * - `relay.log`: capped, every line through `untrustedText` (`cat` is a terminal too).
 *
 * On-disk records follow AGENTS §7: strict parse, an unknown `schemaVersion` is
 * refused and left untouched.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type KeptFile, keptDir, keptFileName } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import { type ProcStat, procStat } from "./pod-resident.ts";
import { untrustedText } from "./untrusted-text.ts";

/** The relay's hidden subcommand: ONE constant, pinned by a `main` dispatch test. */
export const RELAY_SUBCOMMAND = "__relay";
/** Env: the path of the relay's `spec.json`. */
export const RELAY_SPEC_ENV = "TENTACLE_RELAY_SPEC";
export const RUN_STATE_VERSION = 1;
/** `relay.log` rotates once past this size, one rotation kept. */
export const RELAY_LOG_CAP_BYTES = 1024 * 1024;

export type OwnerState =
  | "starting"
  | "running"
  | "waiting-permission"
  | "idle"
  | "interrupted"
  | "failed";
const OWNER_STATES: readonly string[] = [
  "starting",
  "running",
  "waiting-permission",
  "idle",
  "interrupted",
  "failed",
] satisfies readonly OwnerState[];

export interface OwnerRecord {
  readonly schemaVersion: typeof RUN_STATE_VERSION;
  readonly kind: "relay";
  readonly pid: number;
  readonly appVersion: string;
  readonly sessionId: string;
  readonly state: OwnerState;
  /** The tool a held ask is about (sanitised). */
  readonly tool?: string;
  /** Why the state is what it is (sanitised). */
  readonly detail?: string;
  /** ms since epoch: the last state change. */
  readonly lastActivityAt: number;
  readonly autoAccept: boolean;
  /** False: the relay removes the workload when the run ends. See `ownerKeeps`. */
  readonly keep?: boolean;
}

export type OwnerRead =
  | { readonly kind: "none" }
  /** Corrupt, or another `schemaVersion`: refused, left byte-identical. */
  | { readonly kind: "unknown" }
  | { readonly kind: "owner"; readonly owner: OwnerRecord };

/** What the launcher tells the relay. No location: the kept entry `stem` has it. */
export interface RelaySpec {
  readonly schemaVersion: typeof RUN_STATE_VERSION;
  readonly mode: "start";
  /** The run dir's name, and the kept entry's file name without `.json`. */
  readonly stem: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly autoAccept: boolean;
  /** False: remove the workload when the run ends (`exitPlan`). */
  readonly keep: boolean;
  readonly cwd: string;
  /** The launcher's `--profile`. */
  readonly profile?: string;
}

/** A kept entry's file name without `.json`. */
export function runStem(entry: KeptEntry): string {
  return keptFileName(entry).replace(/\.json$/, "");
}

/** `<kept dir>/runs/<stem>` of a kept entry. */
export function runDirIn(dir: string, entry: KeptEntry): string {
  return join(dir, "runs", runStem(entry));
}

/** `<configDir>/kept/runs/<stem>` of a kept entry. */
export function runDirFor(configDir: string, entry: KeptEntry): string {
  return runDirIn(keptDir(configDir), entry);
}

export function ensureRunDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const ownerPath = (dir: string): string => join(dir, "owner.json");
export const specPath = (dir: string): string => join(dir, "spec.json");
export const relayLogPath = (dir: string): string => join(dir, "relay.log");

/** Temp + rename: a reader sees the old file or the new one, never half of one. */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeOwner(dir: string, owner: OwnerRecord): void {
  writeAtomic(ownerPath(dir), `${JSON.stringify(owner, null, 2)}\n`);
}

/** Parse `value` as a JSON object; `null` when it is not one. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function readOwner(dir: string): OwnerRead {
  let text: string;
  try {
    text = readFileSync(ownerPath(dir), "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // ENOTDIR: no run dir, because a file sits on its path: no record either.
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "none" } : { kind: "unknown" };
  }
  const r = jsonObject(text);
  if (
    r === null ||
    r.schemaVersion !== RUN_STATE_VERSION ||
    r.kind !== "relay" ||
    !time(r.pid) ||
    !str(r.appVersion) ||
    !str(r.sessionId) ||
    !str(r.state) ||
    !OWNER_STATES.includes(r.state) ||
    !time(r.lastActivityAt) ||
    typeof r.autoAccept !== "boolean"
  ) {
    return { kind: "unknown" };
  }
  return {
    kind: "owner",
    owner: {
      schemaVersion: RUN_STATE_VERSION,
      kind: "relay",
      pid: r.pid,
      appVersion: r.appVersion,
      sessionId: r.sessionId,
      state: r.state as OwnerState,
      ...(str(r.tool) ? { tool: r.tool } : {}),
      ...(str(r.detail) ? { detail: r.detail } : {}),
      lastActivityAt: r.lastActivityAt,
      autoAccept: r.autoAccept,
      ...(typeof r.keep === "boolean" ? { keep: r.keep } : {}),
    },
  };
}

export function writeSpec(dir: string, spec: RelaySpec): string {
  const path = specPath(dir);
  writeAtomic(path, `${JSON.stringify(spec, null, 2)}\n`);
  return path;
}

/** The relay's strict read. Throws, naming what is wrong. */
export function readSpec(path: string): RelaySpec {
  const r = jsonObject(readFileSync(path, "utf8"));
  if (r === null) {
    throw new Error(`${path}: not a relay spec`);
  }
  if (r.schemaVersion !== RUN_STATE_VERSION) {
    throw new Error(
      `${path}: schemaVersion ${JSON.stringify(r.schemaVersion)} is not ${RUN_STATE_VERSION}`,
    );
  }
  if (
    r.mode !== "start" ||
    !str(r.stem) ||
    !/^[0-9a-f]{16}$/.test(r.stem) ||
    !str(r.sessionId) ||
    !str(r.prompt) ||
    typeof r.autoAccept !== "boolean" ||
    typeof r.keep !== "boolean" ||
    !str(r.cwd)
  ) {
    throw new Error(`${path}: not a relay spec`);
  }
  return {
    schemaVersion: RUN_STATE_VERSION,
    mode: "start",
    stem: r.stem,
    sessionId: r.sessionId,
    prompt: r.prompt,
    autoAccept: r.autoAccept,
    keep: r.keep,
    cwd: r.cwd,
    ...(str(r.profile) ? { profile: r.profile } : {}),
  };
}

/**
 * One `ps -o stat=,lstart=` line: `Ss   Mon Oct 26 00:15:29 2026`. `start` is
 * the instant in ms, one token: the lock's holder is split on spaces, so the
 * raw text would keep only the weekday.
 */
export function parsePsStat(line: string): ProcStat | undefined {
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }
  const [, stat, lstart] = match;
  const start = Date.parse(lstart ?? "");
  return {
    state: stat?.[0],
    start: Number.isNaN(start) ? undefined : String(start),
  };
}

function psLine(pid: number): string {
  const result = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

/**
 * `pid`'s state and start time on the laptop: `/proc` on Linux, else `ps`
 * (macOS has no `/proc`). `undefined` when it is gone.
 */
export function laptopProc(pid: number): ProcStat | undefined {
  return procStat(pid) ?? parsePsStat(psLine(pid));
}

/** Does this run keep its workload? Absent: a run from before `--detach --keep=false`. */
export function ownerKeeps(owner: OwnerRecord): boolean {
  return owner.keep !== false;
}

/** The sentence of one state; `alive` says whether a relay still acts on it. */
function ownerText(owner: OwnerRecord, alive: boolean, now: number): string {
  const detail = owner.detail !== undefined ? untrustedText(owner.detail) : undefined;
  switch (owner.state) {
    case "starting":
    case "running": {
      const minutes = Math.max(0, Math.floor((now - owner.lastActivityAt) / 60_000));
      return alive
        ? `running ${minutes}m${detail !== undefined ? ` (${detail})` : ""}`
        : "relay lost";
    }
    case "waiting-permission": {
      const tool = owner.tool !== undefined ? ` (${untrustedText(owner.tool)})` : "";
      return alive ? `waiting: permission${tool}` : "relay lost";
    }
    case "failed":
      return detail !== undefined ? `failed: ${detail}` : "failed";
    case "idle":
      // A keep=false run whose delete failed leaves `idle` and says WHY in
      // `detail` (relay.ts `not removed: …`): `ps` must show it, not a plain `idle`.
      return detail !== undefined ? `${owner.state} (${detail})` : owner.state;
    case "interrupted":
      return owner.state;
  }
}

/**
 * STATUS of a detached run (DR-6): `owner.json` and whether its relay lives.
 * `null`: no relay ever. Sanitised: the text comes from a file.
 */
export function statusOf(read: OwnerRead, alive: boolean, now: number): string | null {
  const live = (text: string): string => (alive ? `detached · ${text}` : text);
  switch (read.kind) {
    case "none":
      return alive ? live("starting") : null;
    case "unknown":
      return live("unknown owner");
    case "owner": {
      const text = live(ownerText(read.owner, alive, now));
      return alive && read.owner.autoAccept ? `${text} · auto` : text;
    }
  }
}

/** What `attach` needs to know of a live relay. */
export interface RelayHolder {
  readonly pid: number;
}

/**
 * The live relay on the kept entry named `name` (`--engine` narrows it), if
 * any. A name scan: the workload's real location needs a host, and nothing is
 * dialled before this answers.
 */
export function relayBlocking(
  name: string,
  entries: readonly KeptFile[],
  holderOf: (entry: KeptEntry) => RelayHolder | null,
  engine: string | undefined,
): (RelayHolder & { readonly entry: KeptEntry }) | null {
  for (const { entry } of entries) {
    if (entry.name !== name || (engine !== undefined && entry.engine !== engine)) {
      continue;
    }
    const holder = holderOf(entry);
    if (holder) {
      return { pid: holder.pid, entry };
    }
  }
  return null;
}

/** `attach`'s refusal: who owns the workload and how to get the session back. */
export function relayBlockingMessage(
  name: string,
  relay: { readonly pid: number; readonly owner: OwnerRead; readonly noun?: string },
): string {
  const shown = untrustedText(name);
  const { pid, owner } = relay;
  const state = owner.kind === "owner" ? owner.owner.state : "unknown owner";
  if (owner.kind === "owner" && !ownerKeeps(owner.owner)) {
    const session = untrustedText(owner.owner.sessionId);
    return `${shown}: a detached run owns it (pid ${pid}, ${state}). Wait for it, or \`kill ${pid}\` to stop it: stopping it removes the ${relay.noun ?? "workload"}; the transcript stays in \`tentacle --resume ${session}\` from the folder it ran in`;
  }
  const then =
    owner.kind === "owner"
      ? `, then \`tentacle attach ${shown} --resume ${untrustedText(owner.owner.sessionId)}\` from the folder it ran in`
      : "";
  return `${shown}: a detached run owns it (pid ${pid}, ${state}). Wait for it, or \`kill ${pid}\` to stop it${then}`;
}

/**
 * The relay's log: a line per line of `text`, timestamped and sanitised. The
 * writer is the only one rotating; the relay's raw stdio stays on the old file
 * (a crash trace), and `logTail` sanitises that too.
 */
export function createRelayLog(
  dir: string,
  now: () => number = Date.now,
  capBytes: number = RELAY_LOG_CAP_BYTES,
): (text: string) => void {
  const path = relayLogPath(dir);
  return (text) => {
    const lines = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => `${new Date(now()).toISOString()} ${untrustedText(line)}\n`)
      .join("");
    if (lines === "") {
      return;
    }
    try {
      if (statSync(path).size + lines.length > capBytes) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // No log yet.
    }
    try {
      appendFileSync(path, lines, { mode: 0o600 });
    } catch {
      // A full disk: `owner.json` is written apart, and the relay's failure
      // paths call this, so the log must not be what kills them.
    }
  };
}

/** The log's last `count` lines, safe for a terminal. */
export function logTail(dir: string, count = 10): string[] {
  let text: string;
  try {
    text = readFileSync(relayLogPath(dir), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .map((line) => untrustedText(line));
}
