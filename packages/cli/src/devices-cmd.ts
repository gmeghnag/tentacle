/**
 * `tentacle devices`, `devices revoke <name|id-prefix>`, `devices reset`
 * (docs/feat/device-pairing.md 9d): the registry's three verbs, plain lines, no
 * Ink.
 *
 * Reading is 9a's (`readRegistry` / `readSeen`); deciding is here, because every
 * branch in it is a rule a test wants: which device a word names, whether the
 * answer was `y`, what a revoked device's row said. Writes go through the store
 * (`removeDevices`, `replaceIdentity`), which owns the lock and the atomic
 * replace — so two `revoke`s, or a `revoke` beside a `pair` accept, cannot
 * interleave (F13).
 *
 * `revoke` closes the device's LIVE connections at once, and that is not here:
 * the running daemons poll `registry.json` and drop the sockets a revoked id no
 * longer holds (9b, `DeviceAuthority`). This program's whole job is to make the
 * file say so — which is why it needs no daemon to be running and no socket of
 * its own (§7 "one session path").
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectKey } from "@tentacle/agent";
import {
  type Adoption,
  type DaemonRecord,
  type LiveRegistration,
  type PairedDevice,
  type PushRegistration,
  clearAdoptions,
  clearLiveRegistrations,
  clearPushRegistrations,
  deviceIdOf,
  projectLabel,
  readAdoptions,
  readDaemonRecords,
  readLiveRegistrations,
  readPushRegistrations,
  readRegistry,
  readSeen,
  removeDevices,
  replaceIdentity,
  sweepDeadDaemonRecords,
} from "@tentacle/daemon";
import { DEFAULT_STALE_AFTER_MS } from "./discovery.ts";
import { RELAY_SECRET_FILE } from "./relay-secret.ts";
import { untrustedText } from "./untrusted-text.ts";
import { isYes } from "./workspace-mount.ts";

export interface DevicesDeps {
  /** `<configDir>` — the store is `<configDir>/devices`. */
  readonly configDir: string;
  /** STDOUT: the table, the outcome — data only (docs/fix/cli-output-streams.md). */
  readonly out: (text: string) => void;
  /** STDERR: prose, questions, refusals. */
  readonly err: (text: string) => void;
  readonly now: () => number;
  /** Present = interactive; absent = nobody can answer, so `reset` refuses. */
  readonly ask?: (prompt: string) => Promise<string>;
  /** Default `os.hostname()`. */
  readonly hostname?: string;
  readonly random?: Parameters<typeof replaceIdentity>[1]["random"];
  /** A new identity's display name; `hostname` when omitted. */
  readonly name?: string;
  /** `revoke --project <dir>`: the ONE project whose entry goes (Owner Q7). */
  readonly projectDir?: string;
  /** `revoke --all-projects`: every entry that matches, in every project. */
  readonly allProjects?: boolean;
  /** The folder the command runs in (default `process.cwd()`): `revoke`'s default scope. */
  readonly cwd?: string;
  /** Injectable pid liveness for the "running with no paired device" lines. */
  readonly alive?: (pid: number) => boolean;
}

/** The project an entry opens: its own, the one that adopted it (legacy), or none yet. */
export type EntryProject =
  | { readonly kind: "project"; readonly key: string; readonly cwd: string }
  /** A legacy entry no project has adopted: it binds to the first it connects to (§3). */
  | { readonly kind: "unbound" }
  /** A legacy entry whose adoption record is unreadable: denied everywhere (F16). */
  | { readonly kind: "unreadable" };

/** Where an entry belongs (docs/feat/mobile-projects.md §3/§5). Pure. */
export function entryProject(
  device: PairedDevice,
  adoptions: ReadonlyMap<string, Adoption>,
): EntryProject {
  if (device.project !== undefined) {
    return { kind: "project", key: device.project.key, cwd: device.project.cwd };
  }
  const adoption = adoptions.get(device.id);
  if (adoption === undefined || adoption.kind === "none") {
    return { kind: "unbound" };
  }
  return adoption.kind === "bound"
    ? { kind: "project", key: adoption.project.key, cwd: adoption.project.cwd }
    : { kind: "unreadable" };
}

/** One group `tentacle devices` prints: a header line, then its devices' table. */
export interface DeviceGroup {
  readonly title: string;
  readonly devices: readonly PairedDevice[];
}

/** The legacy group's header (§3): what an entry paired before per-project pairing does. */
export const UNBOUND_TITLE =
  "Not yet used (paired before per-project pairing — binds to the first project it connects to)";
export const UNREADABLE_TITLE =
  "Adoption record unreadable (denied everywhere — revoke it, or fix the file under devices/adopted/)";

/**
 * `tentacle devices`, grouped by project (Owner Q7): one group per project in
 * order of first appearance (a legacy entry under the project that adopted it),
 * then the legacy groups; and the running serves that have NO device — the ones
 * that do not dial the relay — as one line each. Pure, so the grouping is
 * testable without a store.
 */
export function groupDevices(
  devices: readonly PairedDevice[],
  adoptions: ReadonlyMap<string, Adoption>,
  running: readonly DaemonRecord[],
): { readonly groups: readonly DeviceGroup[]; readonly idle: readonly string[] } {
  const byKey = new Map<string, { cwd: string; devices: PairedDevice[] }>();
  const unbound: PairedDevice[] = [];
  const unreadable: PairedDevice[] = [];
  for (const device of devices) {
    const where = entryProject(device, adoptions);
    if (where.kind === "unbound") {
      unbound.push(device);
    } else if (where.kind === "unreadable") {
      unreadable.push(device);
    } else {
      const group = byKey.get(where.key) ?? { cwd: where.cwd, devices: [] };
      group.devices.push(device);
      byKey.set(where.key, group);
    }
  }
  const groups: DeviceGroup[] = [...byKey.values()].map((group) => ({
    title: `${projectLabel(group)} · ${group.cwd}`,
    devices: group.devices,
  }));
  if (unbound.length > 0) groups.push({ title: UNBOUND_TITLE, devices: unbound });
  if (unreadable.length > 0) groups.push({ title: UNREADABLE_TITLE, devices: unreadable });
  const idle: string[] = [];
  for (const record of running) {
    const key = projectKey(record.cwd);
    if (!byKey.has(key) && !idle.includes(record.cwd)) {
      idle.push(record.cwd);
    }
  }
  return { groups, idle };
}

const HEADER = ["NAME", "ID", "PAIRED", "LAST SEEN", "PUSH", "LIVE"] as const;

/** `2m`, `3h`, `5d`, and `—` for a device no daemon has ever seen. */
export function formatSeen(nowMs: number, seenMs: number | undefined): string {
  if (seenMs === undefined) {
    return "never";
  }
  const ms = nowMs - seenMs;
  if (!Number.isFinite(ms) || ms < 0) {
    return "now";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** A timestamp as a short local date (`2026-11-13`). */
function formatDate(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The table `tentacle devices` prints, one line per device. Names and ids come
 * from a file a daemon also writes, so both go through `untrustedText` before
 * they reach the terminal (F17: a name is peer-chosen).
 *
 * `push` is `devices/push/` as read NOW (docs/feat/mobile-push.md Design 6):
 * `on` for a device with a usable registration, `off` otherwise — including an
 * unreadable one, because the column answers "will this phone be notified?" and
 * an unreadable record means no. It is a map, not a set, so the column can gain
 * the environment/age later without changing the callers.
 *
 * `live` is `devices/live/` the same way (docs/feat/mobile-live-activity.md
 * Design 4): `on` for a usable registration whose switch is ON, `off` otherwise.
 * The two columns are separate channels with separate switches, so a phone can
 * legitimately be `PUSH on / LIVE off` (task 16's notification still arrives).
 */
export function renderDevices(
  devices: readonly PairedDevice[],
  seen: ReadonlyMap<string, number>,
  nowMs: number,
  push: ReadonlyMap<string, PushRegistration> = new Map(),
  live: ReadonlyMap<string, LiveRegistration> = new Map(),
): string[] {
  const cells = devices.map((device) => [
    untrustedText(device.name),
    device.id,
    formatDate(device.pairedAt),
    formatSeen(nowMs, seen.get(device.id)),
    push.has(device.id) ? "on" : "off",
    // The switch is part of the answer: a record with `enabled: false` sends
    // nothing, so reading it `on` would misdescribe the phone's behaviour.
    live.get(device.id)?.enabled === true ? "on" : "off",
  ]);
  const all = [[...HEADER], ...cells];
  const widths = HEADER.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  return all.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 3)))
      .join("")
      .trimEnd(),
  );
}

/** A word a user typed, resolved to exactly one device. */
export type ResolvedDevice =
  | { readonly ok: true; readonly device: PairedDevice }
  | {
      readonly ok: false;
      readonly reason: "unknown" | "ambiguous";
      readonly matches: PairedDevice[];
    };

/**
 * `revoke <name|id-prefix>`: an exact name, else an id prefix. Two devices whose
 * names or ids both match a word is an AMBIGUITY, never a first-match: revoking
 * the wrong phone because it sorted first is not a recoverable mistake.
 */
export function resolveDevice(devices: readonly PairedDevice[], word: string): ResolvedDevice {
  const byName = devices.filter((device) => device.name === word);
  if (byName.length === 1 && byName[0] !== undefined) {
    return { ok: true, device: byName[0] };
  }
  if (byName.length > 1) {
    // Possible only if a registry was hand-edited (the store dedupes names);
    // still an ambiguity rather than a guess.
    return { ok: false, reason: "ambiguous", matches: byName };
  }
  const wanted = word.toLowerCase();
  if (!/^[0-9a-f]{1,16}$/.test(wanted)) {
    return { ok: false, reason: "unknown", matches: [] };
  }
  const byId = devices.filter((device) => device.id.startsWith(wanted));
  if (byId.length === 1) {
    const only = byId[0];
    return only !== undefined
      ? { ok: true, device: only }
      : { ok: false, reason: "unknown", matches: [] };
  }
  return byId.length > 1
    ? { ok: false, reason: "ambiguous", matches: byId }
    : { ok: false, reason: "unknown", matches: [] };
}

/**
 * Delete every `<configDir>/daemon/<project>/relay.json` (docs/feat/mobile-relay.md
 * Q5/R5b) and report how many went. Best effort by design: a file that cannot be
 * removed is said once, and the reset itself still succeeded — the identity and
 * the registry are what make a phone pair again, and a stale relay id is a
 * denial of service at worst (the phone's Noise handshake still fails).
 */
function removeRelaySecrets(configDir: string): number {
  const root = join(configDir, "daemon");
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    // No daemon has ever run on this machine: nothing to rotate.
    return 0;
  }
  let removed = 0;
  for (const project of projects) {
    const path = join(root, project, RELAY_SECRET_FILE);
    if (!existsSync(path)) {
      continue;
    }
    try {
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // A file we cannot remove is not a reason to fail a reset.
    }
  }
  return removed;
}

/** `tentacle devices` — the registry, or what is wrong with it. */
export function devicesCommand(deps: DevicesDeps): number {
  const registry = readRegistry(deps.configDir);
  if (!registry.ok) {
    // F14: the file is named and never overwritten. `devices reset` is the way out.
    deps.err(
      `[error] the device registry is unreadable: ${registry.path}: ${registry.reason}\nFix or remove it, or run \`tentacle devices reset\` for a new identity and an empty list.\n`,
    );
    return 1;
  }
  let running: DaemonRecord[] = [];
  try {
    const liveness = {
      freshWithinMs: DEFAULT_STALE_AFTER_MS,
      ...(deps.alive !== undefined ? { alive: deps.alive } : {}),
    };
    sweepDeadDaemonRecords(deps.configDir, liveness);
    running = readDaemonRecords(deps.configDir, liveness);
  } catch {
    // No record readable: the "running with no device" lines are a hint only.
  }
  const { groups, idle } = groupDevices(
    registry.registry.devices,
    readAdoptions(deps.configDir),
    running,
  );
  if (groups.length === 0) {
    deps.err(
      "No device is paired with this computer yet. Run `tentacle pair` in a project's folder.\n",
    );
  }
  const seen = readSeen(deps.configDir);
  const push = readPushRegistrations(deps.configDir).registrations;
  const live = readLiveRegistrations(deps.configDir).registrations;
  groups.forEach((group, index) => {
    if (index > 0) deps.out("\n");
    deps.out(`${untrustedText(group.title)}\n`);
    for (const line of renderDevices(group.devices, seen, deps.now(), push, live)) {
      deps.out(`  ${line}\n`);
    }
  });
  for (const cwd of idle) {
    deps.out(`${untrustedText(cwd)} — running with no paired device (relay not dialled)\n`);
  }
  return 0;
}

/** `project · name · id8` — how an ambiguous match is listed (Owner Q7). */
function describeEntry(device: PairedDevice, adoptions: ReadonlyMap<string, Adoption>): string {
  const where = entryProject(device, adoptions);
  const project =
    where.kind === "project"
      ? projectLabel(where)
      : where.kind === "unbound"
        ? "not yet used"
        : "unreadable";
  return `${untrustedText(project)} · ${untrustedText(device.name)} · ${device.id.slice(0, 8)}`;
}

/** Every entry a word names: exact names first, else id prefixes (`--all-projects`). */
function allMatches(devices: readonly PairedDevice[], word: string): PairedDevice[] {
  const byName = devices.filter((device) => device.name === word);
  if (byName.length > 0) {
    return byName;
  }
  const wanted = word.toLowerCase();
  return /^[0-9a-f]{1,16}$/.test(wanted) ? devices.filter((d) => d.id.startsWith(wanted)) : [];
}

/**
 * `tentacle devices revoke <name|id-prefix>` — ONE project's entry (Owner Q7):
 * the scope is `--project <dir>`, else the current folder's project when the
 * word matches there, else a computer-wide match only if it is UNIQUE; an
 * ambiguity is refused with `project · name · id8` per match, never guessed.
 * `--all-projects` revokes every entry the word names (the phone everywhere).
 */
export function revokeCommand(word: string, deps: DevicesDeps): number {
  const registry = readRegistry(deps.configDir);
  if (!registry.ok) {
    deps.err(`[error] the device registry is unreadable: ${registry.path}: ${registry.reason}\n`);
    return 1;
  }
  const devices = registry.registry.devices;
  const adoptions = readAdoptions(deps.configDir);
  const inProject = (dir: string): PairedDevice[] => {
    const key = projectKey(resolve(dir));
    return devices.filter((device) => {
      const where = entryProject(device, adoptions);
      return where.kind === "project" && where.key === key;
    });
  };
  let chosen: PairedDevice[];
  if (deps.allProjects === true) {
    chosen = allMatches(devices, word);
    if (chosen.length === 0) {
      deps.err(`[error] no paired device matches '${untrustedText(word)}'\n`);
      return 1;
    }
  } else {
    let resolved: ResolvedDevice;
    if (deps.projectDir !== undefined) {
      resolved = resolveDevice(inProject(deps.projectDir), word);
    } else {
      const here = resolveDevice(inProject(deps.cwd ?? process.cwd()), word);
      // The current folder decides when it has a match (even an ambiguous one:
      // a second guess elsewhere would revoke a phone the person did not mean).
      resolved = here.ok || here.reason === "ambiguous" ? here : resolveDevice(devices, word);
    }
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        const list = resolved.matches.map((d) => `  ${describeEntry(d, adoptions)}`).join("\n");
        deps.err(
          `[error] '${untrustedText(word)}' matches more than one device:\n${list}\nName the project with --project <dir> (or run it in that folder), use an id prefix, or --all-projects.\n`,
        );
      } else {
        deps.err(`[error] no paired device matches '${untrustedText(word)}'\n`);
      }
      return 1;
    }
    chosen = [resolved.device];
  }
  const removed = removeDevices(
    deps.configDir,
    chosen.map((device) => device.id),
  );
  if (!removed.ok) {
    deps.err(`[error] cannot write the device registry: ${removed.path}: ${removed.reason}\n`);
    return 1;
  }
  // The names are STDOUT: what the user asked for and what was done, the same
  // shape as `rm <name>` printing the workload it removed.
  for (const device of chosen) {
    deps.out(`${describeEntry(device, adoptions)}\n`);
  }
  deps.err(
    "Revoked. That project's tentacle drops it within a second; its sessions stay open for your other devices, and other projects keep their own pairing.\n",
  );
  return 0;
}

/**
 * `tentacle devices reset [--yes]`: a NEW computer identity and an EMPTY
 * registry (F11, owner Q3). The only recovery from a leaked identity key — and
 * deliberately destructive: every phone must pair again, because they pinned a
 * key this computer no longer holds.
 */
export async function resetCommand(
  deps: DevicesDeps & { readonly yes?: boolean },
): Promise<number> {
  const reset = async (): Promise<number> => {
    // The registry is READ before anything is replaced: an unreadable one is a
    // human's to remove (F14), and it must not be silently emptied — a reset
    // that wiped it would look exactly like a successful one.
    const current = readRegistry(deps.configDir);
    if (!current.ok) {
      deps.err(
        `[error] the device registry is unreadable: ${current.path}: ${current.reason}\nRemove it by hand if you want it gone.\n`,
      );
      return 1;
    }
    const identity = replaceIdentity(deps.configDir, {
      name: deps.name ?? deps.hostname ?? "",
      now: deps.now(),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    if (!identity.ok) {
      deps.err(`[error] cannot write a new identity: ${identity.path}: ${identity.reason}\n`);
      return 1;
    }
    // Empty the list through the store, so the write is locked and atomic. The
    // phones are dropped HERE rather than by the new key alone: a daemon that
    // has not yet noticed the identity change must not keep admitting them.
    const cleared = removeDevices(
      deps.configDir,
      current.registry.devices.map((device) => device.id),
    );
    if (!cleared.ok) {
      deps.err(`[error] cannot clear the device registry: ${cleared.path}: ${cleared.reason}\n`);
      return 1;
    }
    // The mobile relay's ids rotate too (docs/feat/mobile-relay.md Q5): a leaked
    // laptop must be recoverable with ONE verb, and phones must re-pair after a
    // reset anyway — so a new relay address costs nothing extra. Every project
    // store's `relay.json` goes; a running daemon picks a new id on its next
    // start (the reset already says "restart serve").
    const rotated = removeRelaySecrets(deps.configDir);
    // The push registrations go with them (mobile-push F13): the phones pinned a
    // computer key this machine no longer holds, so a surviving token could only
    // ever receive placeholders. `removeDevices` already dropped the paired ones;
    // this catches a file whose device was revoked by hand.
    clearPushRegistrations(deps.configDir);
    // The LIVE registrations go for the same reason (mobile-live-activity F11):
    // a surviving start token could only ever light up a placeholder activity.
    clearLiveRegistrations(deps.configDir);
    // And the legacy adoptions (docs/feat/mobile-projects.md F15): the entries
    // they bound are gone, and an orphan record must never bind a future key.
    clearAdoptions(deps.configDir);
    deps.out("Reset. Every phone must pair again.\n");
    if (rotated > 0) {
      deps.err(
        `The mobile relay address rotated for ${rotated} project${rotated === 1 ? "" : "s"}. Restart every \`tentacle serve\` to pick up the new one.\n`,
      );
    }
    return 0;
  };

  if (deps.yes === true) {
    return reset();
  }
  if (deps.ask === undefined) {
    deps.err(
      "[error] `devices reset` needs a terminal to confirm it (or --yes): it gives this computer a new key and every paired phone must pair again\n",
    );
    return 1;
  }
  const answer = await deps.ask(
    "Give this computer a NEW key? Every paired phone must pair again. [y/N] ",
  );
  if (!isYes(answer)) {
    deps.err("Not reset.\n");
    return 1;
  }
  return reset();
}
