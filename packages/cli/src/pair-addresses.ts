import { networkInterfaces } from "node:os";
import type { DaemonRecord } from "@tentacle/daemon";
/**
 * The addresses `tentacle pair` puts in the QR (docs/feat/device-pairing.md 9d,
 * Design "Addresses"): a PHONE must be able to dial them, so a daemon's own bind
 * tells us which of them exist, and nothing here decides whether one works.
 *
 * The rules, one per record from `<configDir>/daemons/*.json` (9a):
 * - a LOOPBACK bind (`127.0.0.0/8`, `::1`, `localhost`) contributes nothing — a
 *   phone on the LAN cannot reach it, and putting it in the QR would make the
 *   app try an address that can never answer;
 * - `0.0.0.0` / `::` (every interface) → each non-internal IPv4 of this
 *   machine: the LAN address and a Tailscale `100.64/10` one are what a phone
 *   actually reaches. IPv6 is deliberately left out: a link-local or
 *   privacy-temporary address in a QR is noise, and a phone that needs IPv6 can
 *   be given `--address`;
 * - a specific address → itself (`--host 192.168.1.8`);
 * - `ws`/`wss` follows the daemon's TLS (`tls: true` = `wss`), and every URL
 *   ends in the device route's `/e2e` (9b).
 *
 * Every `--address` is appended as given (it may be a relay URL one day, task
 * 15), then duplicates are removed keeping the FIRST occurrence: the order is
 * the order the phone tries, so it must be ours and stable.
 *
 * Pure and React-free (AGENTS §7) with the interface table injected: the
 * addresses of this machine are the only thing not derivable from the config
 * dir, and a test cannot fabricate them.
 */
import {
  MAX_PAIRING_ADDRESSES,
  PAIRING_ADDRESS_SUFFIX,
  isPairingAddress,
} from "@tentacle/protocol";

/** One `os.networkInterfaces()` entry, as much of it as the rule uses. */
export interface InterfaceEntry {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}

/** `os.networkInterfaces()`, flat (Node's is a map of lists). */
export type Interfaces = () => readonly InterfaceEntry[];

/**
 * This machine's addresses, flat — Node's `os.networkInterfaces()` is a map of
 * lists. `pairAddresses` needs them whenever a `serve` binds a WILDCARD
 * (`0.0.0.0`), which is the documented way to be reachable (REACHABLE_HINT); a
 * caller that defaulted to `[]` would refuse exactly the `serve` it recommends.
 * Only the rule's two fields are kept, so nothing else about the machine leaks.
 *
 * The DEFAULT for both readers of the rule — `pair`'s QR and the daemon's
 * sibling announcement — so the two cannot disagree.
 */
export function machineInterfaces(): readonly InterfaceEntry[] {
  const flat: InterfaceEntry[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      flat.push({ address: entry.address, family: entry.family, internal: entry.internal });
    }
  }
  return flat;
}

/** Every bind that means "every interface". */
const WILDCARD = new Set(["0.0.0.0", "::", "[::]", "*"]);

/**
 * Is this bind reachable from another machine? Loopback (and the empty host a
 * `serve` never has) is not; everything else is, and a wildcard is expanded.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "" || bare === "localhost") {
    return true;
  }
  if (bare.includes(":")) {
    // IPv6: `::1`, and the v4-mapped form a `Bun.serve` on 127.0.0.1 can report.
    return bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare.startsWith("::ffff:127.");
  }
  return /^127\./.test(bare);
}

/**
 * CGNAT — RFC 6598 `100.64.0.0/10`, which is where Tailscale puts a node. Kept
 * as a named predicate because "why is there a 100.64 address in my QR?" is
 * the question this answers.
 */
export function isCarrierGradeNat(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  return parts.length === 4 && a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** The `ws(s)://host:port/e2e` URL one daemon record means for one host. */
function urlFor(record: DaemonRecord, host: string): string {
  const scheme = record.tls ? "wss" : "ws";
  // An IPv6 literal needs brackets in a URL; nothing else does.
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${authority}:${record.port}${PAIRING_ADDRESS_SUFFIX}`;
}

/** Keep the first occurrence of each address (the phone's dial order is ours). */
function unique(addresses: readonly string[]): string[] {
  return [...new Set(addresses)];
}

/**
 * The addresses to publish: every reachable one a live `serve` listens on, then
 * the `--address` ones. Unusable `--address` values are REFUSED, not dropped —
 * a typo silently missing from the QR is a pairing that fails with no reason.
 */
export type PairAddressResult =
  | { readonly ok: true; readonly addresses: readonly string[] }
  /** Not a `ws(s)` URL ending in `/e2e`. */
  | { readonly ok: false; readonly reason: "invalid"; readonly invalid: readonly string[] }
  /** More than a QR may carry: too many `--address` values, a typo worth naming. */
  | { readonly ok: false; readonly reason: "too_many"; readonly count: number };

export function pairAddresses(input: {
  readonly records: readonly DaemonRecord[];
  readonly interfaces: readonly InterfaceEntry[];
  readonly extra?: readonly string[];
}): PairAddressResult {
  const extra = input.extra ?? [];
  const invalid = extra.filter((address) => !isPairingAddress(address));
  if (invalid.length > 0) {
    return { ok: false, reason: "invalid", invalid };
  }
  // The QR's own bound is a refusal, never a silent truncation: the address it
  // dropped would be one a user asked for by hand.
  if (extra.length > MAX_PAIRING_ADDRESSES) {
    return { ok: false, reason: "too_many", count: extra.length };
  }
  // The machine's own reachable IPv4 addresses, once: two daemons on `0.0.0.0`
  // (different ports) both use them.
  const reachable = input.interfaces
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const fromRecords: string[] = [];
  for (const record of input.records) {
    if (WILDCARD.has(record.host)) {
      for (const address of reachable) {
        fromRecords.push(urlFor(record, address));
      }
      continue;
    }
    if (isLoopbackHost(record.host)) {
      continue;
    }
    fromRecords.push(urlFor(record, record.host));
  }
  const addresses = unique([...fromRecords, ...extra]);
  // Distinct addresses after dedup are what the QR holds: more than a QR may
  // carry is a refusal (the one it would drop could be the reachable one) —
  // never a silent truncation.
  return addresses.length <= MAX_PAIRING_ADDRESSES
    ? { ok: true, addresses }
    : { ok: false, reason: "too_many", count: addresses.length };
}

/** The refusal when nothing a phone can dial exists: the two ways to make one. */
export const REACHABLE_HINT =
  "no daemon this phone can reach: start one with `tentacle serve --host 0.0.0.0`, or pass --address ws://<host>:<port>/e2e";
