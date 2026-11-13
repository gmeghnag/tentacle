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
import {
  type PairedDevice,
  deviceIdOf,
  readRegistry,
  readSeen,
  removeDevices,
  replaceIdentity,
} from "@tentacle/daemon";
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
}

const HEADER = ["NAME", "ID", "PAIRED", "LAST SEEN"] as const;

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
 */
export function renderDevices(
  devices: readonly PairedDevice[],
  seen: ReadonlyMap<string, number>,
  nowMs: number,
): string[] {
  const cells = devices.map((device) => [
    untrustedText(device.name),
    device.id,
    formatDate(device.pairedAt),
    formatSeen(nowMs, seen.get(device.id)),
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
  if (registry.registry.devices.length === 0) {
    deps.err("No device is paired with this computer yet. Run `tentacle pair`.\n");
    return 0;
  }
  for (const line of renderDevices(
    registry.registry.devices,
    readSeen(deps.configDir),
    deps.now(),
  )) {
    deps.out(`${line}\n`);
  }
  return 0;
}

/** `tentacle devices revoke <name|id-prefix>`. */
export function revokeCommand(word: string, deps: DevicesDeps): number {
  const registry = readRegistry(deps.configDir);
  if (!registry.ok) {
    deps.err(`[error] the device registry is unreadable: ${registry.path}: ${registry.reason}\n`);
    return 1;
  }
  const resolved = resolveDevice(registry.registry.devices, word);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      const names = resolved.matches.map((d) => `${untrustedText(d.name)} (${d.id})`).join(", ");
      deps.err(`[error] '${untrustedText(word)}' matches more than one device: ${names}\n`);
    } else {
      deps.err(`[error] no paired device matches '${untrustedText(word)}'\n`);
    }
    return 1;
  }
  const removed = removeDevices(deps.configDir, [resolved.device.id]);
  if (!removed.ok) {
    deps.err(`[error] cannot write the device registry: ${removed.path}: ${removed.reason}\n`);
    return 1;
  }
  // The name is STDOUT: it is what the user asked for and what was done, the
  // same shape as `rm <name>` printing the workload it removed.
  deps.out(`${untrustedText(resolved.device.name)}\n`);
  deps.err(
    "Revoked. Every tentacle on this computer drops it within a second; its sessions stay open for your other devices.\n",
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
    deps.out("Reset. Every phone must pair again.\n");
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
