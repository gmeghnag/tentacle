/**
 * The session ids of an external caller (docs/feat/a2a.md, Design; protocol-
 * neutral per the owner's decision of 2026-11-25: A2A today, MCP next). PURE.
 *
 * A caller's context is the session `<protocol>-<caller>-<contextId>`: the
 * caller is IN the id, so a caller only ever opens or reads its own sessions,
 * and never a phone session (whose ids carry no such prefix).
 */

/** The caller name a token carries (`default` from the CLI). No `-`: it delimits the id. */
const CALLER_RE = /^[A-Za-z0-9_]{1,32}$/;
const CONTEXT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A protocol's id word (`a2a`, `mcp`): no `-` either. */
const PROTOCOL_RE = /^[a-z0-9]{1,16}$/;

/** `<protocol>-<caller>-<contextId>`; null when a part is not a safe word (InvalidParams). */
export function externalSessionId(
  protocol: string,
  caller: string,
  contextId: string,
): string | null {
  const prefix = callerPrefix(protocol, caller);
  return prefix === null || !CONTEXT_RE.test(contextId) ? null : `${prefix}${contextId}`;
}

/** The session ids of ONE caller start with this (no part holds a `-`, so it is exact). */
export function callerPrefix(protocol: string, caller: string): string | null {
  return PROTOCOL_RE.test(protocol) && CALLER_RE.test(caller) ? `${protocol}-${caller}-` : null;
}

/** The contextId of a session this caller owns; null for anyone else's or a phone session. */
export function contextIdOf(protocol: string, caller: string, sessionId: string): string | null {
  const prefix = callerPrefix(protocol, caller);
  if (prefix === null || !sessionId.startsWith(prefix)) {
    return null;
  }
  const context = sessionId.slice(prefix.length);
  return CONTEXT_RE.test(context) ? context : null;
}
