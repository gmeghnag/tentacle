/**
 * Who a rejected external caller was (docs/fix/serve-mcp-polish.md P1): an
 * audit line names the peer — its address and a sanitized, capped user-agent —
 * and never the presented token, any part of it, or the query string.
 *
 * Pure and import-free on purpose: `ws-server.ts` and `external/route.ts` both
 * use it, and `route.ts` already imports `ws-server.ts` — an import back would
 * be a cycle.
 */

/** Longest user-agent an audit line repeats. */
export const PEER_UA_MAX = 120;

/** What this helper needs of Bun's server: the peer address, when it can say. */
export interface PeerSource {
  readonly requestIP?: (req: Request) => { readonly address: string } | null;
}

/**
 * The `user-agent` header as ONE printable ASCII line: control characters (CR,
 * LF, TAB, ESC — log forging and ANSI) are dropped, `"` becomes `'` so it cannot
 * close the quoted field, non-ASCII is dropped, and the rest is capped at
 * `PEER_UA_MAX`. Absent, empty or nothing printable left → `-`.
 */
export function sanitizeUserAgent(raw: string | null): string {
  if (raw === null) return "-";
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) continue;
    out += ch === '"' ? "'" : ch;
    if (out.length === PEER_UA_MAX) break;
  }
  return out === "" ? "-" : out;
}

/** `at <address> ua "<ua>"`; `at unknown` when the server cannot say (a fake or hand-rolled `srv`). */
export function describePeer(req: Request, srv: PeerSource): string {
  const address = srv.requestIP?.(req)?.address ?? "";
  const at = address === "" ? "unknown" : address;
  return `at ${at} ua "${sanitizeUserAgent(req.headers.get("user-agent"))}"`;
}
