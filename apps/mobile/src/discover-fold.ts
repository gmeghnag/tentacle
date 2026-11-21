/**
 * What a project record learns from `daemon/discover` after a successful dial
 * (docs/feat/mobile-projects.md §6 "Address refresh", F2). A device principal
 * gets ONLY its own daemon (`self`, Owner Q4), so this never adds a project —
 * it refreshes the one the record already opens:
 *
 * - `addresses`: `mergeAddresses` (the client's `discovery.ts` rule): announced
 *   first, then the known ones kept, capped. A serve restarted on a new port or
 *   a new LAN IP is reachable again with no re-pairing.
 * - `project`: a LEGACY record (paired before per-project pairing) has none;
 *   `self.cwd` names it once (§3), so it is grouped and retired like any other.
 *
 * Pure: returns the patch, or `undefined` when nothing changed (ONE write per
 * change, never one per dial).
 */
import { mergeAddresses } from "@tentacle/client";
import type { DaemonDiscovery } from "@tentacle/protocol";
import type { PairedComputer, RecordProject } from "./computer-store.ts";

/** The folder's own name — what `tentacle pair` prints as `p=` (`basename(cwd)`). */
function basenameOf(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? cwd;
}

export interface DiscoveryPatch {
  readonly addresses?: readonly string[];
  readonly project?: RecordProject;
}

export function discoveryPatch(
  record: Pick<PairedComputer, "addresses" | "project">,
  discovery: DaemonDiscovery | undefined,
  now: number,
): DiscoveryPatch | undefined {
  if (discovery === undefined) {
    return undefined; // an older daemon (MethodNotFound): keep what pairing gave (F8)
  }
  const self =
    discovery.daemons.find((daemon) => daemon.self === true) ??
    (discovery.daemons.length === 1 ? discovery.daemons[0] : undefined);
  if (self === undefined) {
    return undefined;
  }
  if (record.project !== undefined && record.project.cwd !== self.cwd) {
    // Not the project this record opens (a stale address now on another serve
    // would 404 before this, P8): never fold another project's addresses in.
    return undefined;
  }
  // The record keeps no per-address stamps, so every known address counts as
  // seen now: none expires here (see the plan's Execution, "drift").
  const merged = mergeAddresses(
    [{ cwd: self.cwd, addresses: record.addresses, lastSeenAt: now, startedAt: 0 }],
    { rev: discovery.rev, daemons: [self] },
    now,
  ).projects[0];
  const addresses = merged?.addresses ?? record.addresses;
  const changed =
    addresses.length > 0 &&
    (addresses.length !== record.addresses.length ||
      addresses.some((address, i) => address !== record.addresses[i]));
  const project =
    record.project === undefined ? { cwd: self.cwd, label: basenameOf(self.cwd) } : undefined;
  if (!changed && project === undefined) {
    return undefined;
  }
  return { ...(changed ? { addresses } : {}), ...(project === undefined ? {} : { project }) };
}
