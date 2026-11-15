/**
 * The relay's REAL client address, as a pure module (fix/relay-hardening H3;
 * AGENTS §7 "logic lives in pure modules").
 *
 * The relay binds loopback and Caddy terminates TLS in front of it
 * (`deploy/relay.service`, `deploy/Caddyfile.relay`), so Bun's `requestIP` — the
 * DIRECT peer — is `127.0.0.1` for every client on the planet. Keying the
 * per-IP abuse limits on it made them ONE global bucket: one client could burn
 * the 30 dials/min or all 16 phone sockets, and a `hello` flood with random
 * secrets locked EVERY daemon out of re-registering.
 *
 * So the key comes from `X-Forwarded-For` instead — but only under conditions an
 * outside attacker cannot satisfy:
 *
 *  - the header is read ONLY when the peer is loopback (`isLoopback`), i.e. the
 *    proxy hop on this host. A non-loopback peer's header is ignored entirely,
 *    so binding off-loopback by mistake cannot be exploited.
 *  - only when the operator opted in (`--trust-proxy`). Without it the relay
 *    behaves exactly as before and the header is not read at all.
 *  - the hop taken is the RIGHT-MOST untrusted one, walking left from the end.
 *    A client that sends its own `X-Forwarded-For` gets it appended to by the
 *    proxy, so its own value is never the right-most one; and a malformed
 *    right-most entry stops the walk (falls back to the peer) rather than
 *    letting the attacker supply the next key.
 *
 * The result is used for exactly two things: the limiter key, and `open.ip` to
 * the daemon (an untrusted anti-flood key there too). It is never logged.
 */
import { isIP } from "node:net";

/** The most hops read from one header (a header must not cost unbounded work). */
const MAX_FORWARDED_HOPS = 16;

/**
 * Canonical form of one address, for comparison and for use as a key: lowercase,
 * IPv6 brackets stripped, and an IPv4-mapped IPv6 address unmapped to its IPv4
 * form (`::ffff:127.0.0.1` and `127.0.0.1` ARE the same peer — Bun reports the
 * first on a dual-stack socket).
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(unbracketed);
  return mapped?.[1] ?? unbracketed;
}

/**
 * Is this address the local host? `127.0.0.0/8`, `::1`, or an IPv4-mapped form
 * of the first. Anything else — including a malformed string — is not.
 */
export function isLoopback(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = normalized.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** A header value split into its hops, right-most last, bounded to {@link MAX_FORWARDED_HOPS}. */
function forwardedHops(forwardedFor: string): string[] {
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return hops.slice(-MAX_FORWARDED_HOPS);
}

/**
 * The client `ip` to key the limits on (see the module comment for why each
 * condition is there). Every fallback answer is the PEER — the one address that
 * is always true — so a malformed or absent header degrades to today's
 * behaviour instead of to something attacker-chosen.
 */
export function clientIpOf(input: {
  readonly peer: string;
  readonly forwardedFor: string | null;
  readonly trustProxy: boolean;
}): string {
  const peer = normalizeAddress(input.peer);
  if (!input.trustProxy || !isLoopback(peer)) {
    return peer;
  }
  if (input.forwardedFor === null) {
    return peer;
  }
  const hops = forwardedHops(input.forwardedFor);
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = normalizeAddress(hops[index] ?? "");
    // Skip the trusted proxies on this host (there may be more than one: Caddy
    // in a host-network container is a loopback peer itself).
    if (isLoopback(hop)) {
      continue;
    }
    // The first untrusted hop from the right IS the client — if it is an
    // address. When it is not, stop here: entries further left were written by
    // the attacker, and honouring one would hand out a fresh bucket per request.
    return isIP(hop) === 0 ? peer : hop;
  }
  return peer;
}

/**
 * The limiter key for an address: IPv4 as it is, IPv6 collapsed to its `/64`.
 *
 * One IPv6 client normally holds a whole /64 (a phone, a home, a VPS), so
 * keying on the full 128 bits gave it 2^64 free buckets — every limit
 * bypassable by counting up the low bits. The `/64` is the smallest prefix a
 * residential or mobile IPv6 assignment is guaranteed to route.
 */
export function limiterKeyOf(ip: string): string {
  const normalized = normalizeAddress(ip);
  if (isIP(normalized) !== 6) {
    return normalized;
  }
  const hextets = expandIpv6(normalized);
  if (hextets === undefined) {
    return normalized;
  }
  return `${hextets
    .slice(0, 4)
    .map((hextet) => hextet.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or `undefined` if it does not parse. */
function expandIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return undefined;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const compressed = 8 - head.length - tail.length;
  if (compressed < 1) {
    return undefined;
  }
  return [...head, ...new Array<number>(compressed).fill(0), ...tail];
}
