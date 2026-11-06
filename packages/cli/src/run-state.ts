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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { keptDir, keptFileName } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import { type ProcOf, type ProcStat, holderAlive, procStat } from "./pod-resident.ts";
import { untrustedText } from "./untrusted-text.ts";

/** The relay's hidden subcommand: ONE constant, pinned by a `main` dispatch test. */
export const RELAY_SUBCOMMAND = "__relay";
/** Env: the path of the relay's `spec.json`. */
export const RELAY_SPEC_ENV = "TENTACLE_RELAY_SPEC";
export const RUN_STATE_VERSION = 2;
/** `relay.log` rotates once past this size, one rotation kept. */
export const RELAY_LOG_CAP_BYTES = 1024 * 1024;

export type OwnerState =
  | "starting"
  | "running"
  | "waiting-permission"
  | "idle"
  | "interrupted"
  | "failed"
  /** A TUI's record (docs/feat/detached-handover.md): who is attached is the presence files'. */
  | "attached";
const OWNER_STATES: readonly string[] = [
  "starting",
  "running",
  "waiting-permission",
  "idle",
  "interrupted",
  "failed",
  "attached",
] satisfies readonly OwnerState[];

export interface OwnerRecord {
  readonly schemaVersion: typeof RUN_STATE_VERSION;
  /**
   * `tui`: the run was handed over to (or joined by) TUIs; the record then says
   * what the run IS (`sessionId`, `rm`, `cwd`), not who is here: that is
   * `attachers`. An older build refuses it as `unknown` and leaves it.
   */
  readonly kind: "relay" | "tui";
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
  /** True (`run --rm`): the relay removes the workload when the run ends. See `ownerRemoves`. */
  readonly rm?: boolean;
  /** The folder the run belongs to: its session's laptop copy is filed under it. */
  readonly cwd?: string;
  /** The relay's control socket (`control-socket.ts`), when it is not `<runDir>/control.sock`. */
  readonly control?: string;
  /** The kept entry's `created`: ties the record to THAT workload (a run dir outlives a reused name). */
  readonly created?: string;
  /**
   * The id of the run's own turn, minted by its relay (docs/fix/detach-live.md
   * B2): a TUI that takes the run over owns that turn, so auto-accept may
   * answer its asks. Absent: it stays foreign (the safe side).
   */
  readonly runTurnId?: string;
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
  /** True (`run --rm`): remove the workload when the run ends (`exitPlan`). */
  readonly rm: boolean;
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
    (r.kind !== "relay" && r.kind !== "tui") ||
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
      kind: r.kind,
      pid: r.pid,
      appVersion: r.appVersion,
      sessionId: r.sessionId,
      state: r.state as OwnerState,
      ...(str(r.tool) ? { tool: r.tool } : {}),
      ...(str(r.detail) ? { detail: r.detail } : {}),
      lastActivityAt: r.lastActivityAt,
      autoAccept: r.autoAccept,
      ...(typeof r.rm === "boolean" ? { rm: r.rm } : {}),
      ...(str(r.cwd) ? { cwd: r.cwd } : {}),
      ...(str(r.control) ? { control: r.control } : {}),
      ...(str(r.created) ? { created: r.created } : {}),
      ...(str(r.runTurnId) ? { runTurnId: r.runTurnId } : {}),
    },
  };
}

/**
 * `<runDir>/auto-accept/<sessionId>`: that session's auto-accept, shared by
 * the TUIs on it (docs/fix/detach-live.md B3). Laptop-only, like the run dir.
 */
export const autoAcceptPath = (dir: string, sessionId: string): string =>
  join(dir, "auto-accept", sessionId);

/** The file's one word; `null` for anything else (OFF for the caller, never ON). */
export function parseAutoAccept(text: string): boolean | null {
  const word = text.trim();
  return word === "on" ? true : word === "off" ? false : null;
}

/** Write that file: 0600, temp + rename, in a 0700 dir. Throws on failure. */
export function writeAutoAccept(path: string, on: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, on ? "on" : "off");
}

/** `<runDir>/attach`: one presence file per TUI on the run. */
export const attachDirOf = (dir: string): string => join(dir, "attach");

/** `<pid>-<start>`, or `<pid>` where the start time is unknown. */
function presenceName(pid: number, start: string | undefined): string {
  return start !== undefined ? `${pid}-${start}` : String(pid);
}

/**
 * Say "this TUI is on the run": a 0600 file named after the process (pid +
 * start time, the lock's own identity) whose body is the session it is on
 * (docs/fix/detach-live.md A4). Not exclusive: N TUIs join one run. Returns
 * its path, for `setPresenceSession` and `removePresence`. Throws when it
 * cannot be written: without it the exit net and the last quit would lie.
 */
export function writePresence(dir: string, pid: number, procOf: ProcOf, sessionId = ""): string {
  const attach = attachDirOf(dir);
  mkdirSync(attach, { recursive: true, mode: 0o700 });
  const path = join(attach, presenceName(pid, procOf(pid)?.start));
  writeFileSync(path, sessionId, { mode: 0o600 });
  return path;
}

/**
 * The TUI moved to another session (`/clear`): its presence says so. In
 * place, not temp + rename: `attachers` sweeps any other name in the dir.
 */
export function setPresenceSession(path: string, sessionId: string): void {
  writeFileSync(path, sessionId, { mode: 0o600 });
}

/**
 * Other live TUIs on `sessionId` (laptop truth: the presence files; a TUI on
 * another session of the run, or a draining relay, is not counted).
 */
export function othersOnSession(
  dir: string,
  procOf: ProcOf,
  pid: number,
  sessionId: string,
): number {
  return attachers(dir, procOf).filter((a) => a.pid !== pid && a.sessionId === sessionId).length;
}

/** A presence file's session id; `undefined` when it names none. */
function presenceSession(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^[\w-]{1,128}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Idempotent. */
export function removePresence(path: string): void {
  rmSync(path, { force: true });
}

/**
 * The TUIs on the run now, by their presence files, with the lock's liveness
 * test (`holderAlive`): a dead process and a reused pid (another start time)
 * are swept. No dir: none. `sessionId`: the session each is on, if it says.
 */
export function attachers(
  dir: string,
  procOf: ProcOf,
): readonly { readonly pid: number; readonly path: string; readonly sessionId?: string }[] {
  let names: string[];
  try {
    names = readdirSync(attachDirOf(dir));
  } catch {
    return [];
  }
  const live: { pid: number; path: string; sessionId?: string }[] = [];
  for (const name of names) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(name);
    const path = join(attachDirOf(dir), name);
    const pid = Number(match?.[1]);
    if (
      match &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      holderAlive({ pid, start: match[2] }, procOf)
    ) {
      const sessionId = presenceSession(path);
      live.push(sessionId !== undefined ? { pid, path, sessionId } : { pid, path });
      continue;
    }
    rmSync(path, { force: true });
  }
  return live;
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
    typeof r.rm !== "boolean" ||
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
    rm: r.rm,
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

/** Does this run remove its workload when it ends (`run --rm`)? Absent: not removed. */
export function ownerRemoves(owner: OwnerRecord): boolean {
  return owner.rm === true;
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
      // An `--rm` run whose delete failed leaves `idle` and says WHY in
      // `detail` (relay.ts `not removed: …`): `ps` must show it, not a plain `idle`.
      return detail !== undefined ? `${owner.state} (${detail})` : owner.state;
    case "interrupted":
      // The relay's save veto (`not saved — workload kept: …`) is in `detail`.
      return detail !== undefined ? `${owner.state} (${detail})` : owner.state;
    case "attached":
      // No presence is alive (`statusOf` checked): the last TUI went without a quit.
      return "tui lost";
  }
}

/**
 * STATUS of a detached run (DR-6): `owner.json`, whether its lock's holder
 * lives, and `attached`, the TUIs on it (`attachers`). Presence wins over any
 * record (a lost write cannot lie), except a live relay's own row. A TUI
 * record's lock holder is the last TUI closing the run. `null`: no relay ever.
 * Sanitised: the text comes from a file.
 *
 * An `--rm` run whose owner went mid-run (`lost`) is `not saved`
 * (docs/fix/detach-live.md R6, owner 2026-11-02): its exit net deletes only a
 * save it confirmed, a crash's state is unknown, so the workload stays until
 * `rm` (`statusCell` shows this text only while the workload is there).
 */
export function statusOf(
  read: OwnerRead,
  alive: boolean,
  now: number,
  attached = 0,
): string | null {
  const tui = read.kind === "owner" && read.owner.kind === "tui";
  if (!(alive && !tui) && attached > 0) {
    return attached === 1 ? "attached" : `attached (${attached})`;
  }
  const lost = (owner: OwnerRecord): string => {
    const text = ownerText(owner, false, now);
    return ownerRemoves(owner) && text.endsWith(" lost") ? `${text} · not saved` : text;
  };
  if (tui && read.kind === "owner") {
    return alive ? "closing" : lost(read.owner);
  }
  const live = (text: string): string => (alive ? `detached · ${text}` : text);
  switch (read.kind) {
    case "none":
      return alive ? live("starting") : null;
    case "unknown":
      return live("unknown owner");
    case "owner": {
      const text = alive ? live(ownerText(read.owner, true, now)) : lost(read.owner);
      return alive && read.owner.autoAccept ? `${text} · auto` : text;
    }
  }
}

/**
 * The detached run is over: no relay, no TUI on it, and its record says how it
 * ended (a `… lost` owner went mid-run: that is not this). What the engine still
 * reports is the WORKLOAD, not the run (docs/fix/detached-autowake.md).
 */
export function runFinished(read: OwnerRead, alive: boolean, attached: number): boolean {
  // A TUI record only says its last terminal left: that detaches, and jobs or a
  // turn may be alive in the pod. A relay's `idle` read 0 jobs before it left.
  if (alive || attached > 0 || read.kind !== "owner" || read.owner.kind !== "relay") {
    return false;
  }
  const { state } = read.owner;
  return state === "idle" || state === "failed" || state === "interrupted";
}

/** What `attach` needs to know of a live relay. */
export interface RelayHolder {
  readonly pid: number;
}

/**
 * `attach`'s refusal when the user's OWN location flags name a place other than
 * a live detached run's (S2's comparison). It must not offer `kill <pid>`: that
 * stops the run and, on an `--rm` run, REMOVES the workload — of another place than
 * the one asked for. So it names both places and the safe next step: the index
 * alone (no location flag) resolves the run where it actually is.
 */
export function elsewhereMessage(
  name: string,
  run: { readonly pid: number; readonly owner: OwnerRead },
  places: { readonly run: string; readonly asked: string | null },
): string {
  const shown = untrustedText(name);
  const owner = run.owner.kind === "owner" ? run.owner.owner : null;
  const where = `a detached run owns it in ${untrustedText(places.run)} (pid ${run.pid}, ${owner?.state ?? "unknown owner"})`;
  const mismatch =
    places.asked === null
      ? "your location flags do not resolve to a place"
      : `not in ${untrustedText(places.asked)}, the place your flags name`;
  const session = owner === null ? "" : ` Its session is ${untrustedText(owner.sessionId)}.`;
  return `${shown}: ${where}, ${mismatch}. Nothing was dialled, and nothing was stopped: drop the location flags (\`tentacle attach ${shown}\`) to reach the run where it is.${session}`;
}

/** `attach`'s refusal: who owns the workload and how to get the session back. */
export function relayBlockingMessage(
  name: string,
  relay: { readonly pid: number; readonly owner: OwnerRead; readonly noun?: string },
): string {
  const shown = untrustedText(name);
  const { pid, owner } = relay;
  const state = owner.kind === "owner" ? owner.owner.state : "unknown owner";
  if (owner.kind === "owner" && ownerRemoves(owner.owner)) {
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
