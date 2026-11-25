/**
 * docs/fix/serve-mcp-polish.md P1: the audit lines name the rejected peer —
 * its address and a sanitized, capped user-agent, never the token. Pure, no
 * server: the sanitiser is what an operator's terminal receives from an
 * attacker-controlled header.
 */
import { describe, expect, test } from "bun:test";
import { PEER_UA_MAX, describePeer, sanitizeUserAgent } from "../src/external/peer.ts";

const req = (userAgent?: string): Request =>
  new Request("http://127.0.0.1:4001/mcp", {
    method: "POST",
    headers: userAgent === undefined ? {} : { "user-agent": userAgent },
  });

describe("sanitizeUserAgent — one printable line, capped", () => {
  // Mutation: keep the control characters → the CR/LF/ESC assertions go red (log forging).
  test("drops CR, LF, TAB and ESC; keeps the printable text around them", () => {
    const clean = sanitizeUserAgent("a\r\nb\x1b[2Jc\td");
    expect(clean).toBe("ab[2Jcd");
    expect([...clean].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(false);
  });

  // Mutation: cap by UTF-16 units after replacement, or not at all → red.
  test("caps at PEER_UA_MAX characters, and drops non-ASCII", () => {
    expect(sanitizeUserAgent("x".repeat(400)).length).toBe(PEER_UA_MAX);
    expect(sanitizeUserAgent("café/1")).toBe("caf/1");
  });

  // Mutation: return the raw value → `""` leaks an empty quote pair.
  test('absent or empty is "-"; an inner `"` cannot close the quoted field', () => {
    expect(sanitizeUserAgent(null)).toBe("-");
    expect(sanitizeUserAgent("")).toBe("-");
    expect(sanitizeUserAgent("\r\n\x1b")).toBe("-");
    expect(sanitizeUserAgent('evil" at 1.2.3.4 "')).toBe("evil' at 1.2.3.4 '");
  });
});

describe('describePeer — `at <address> ua "<ua>"`', () => {
  test("names the address the server reports and the sanitized UA", () => {
    const srv = { requestIP: () => ({ address: "203.0.113.9" }) };
    expect(describePeer(req("probe/1"), srv)).toBe('at 203.0.113.9 ua "probe/1"');
  });

  // Mutation: dereference `requestIP` unconditionally → a fake `srv` throws.
  test("no requestIP, or a null answer, is `at unknown` (never a throw)", () => {
    expect(describePeer(req("probe/1"), {})).toBe('at unknown ua "probe/1"');
    expect(describePeer(req("probe/1"), { requestIP: () => null })).toBe('at unknown ua "probe/1"');
    expect(describePeer(req("probe/1"), { requestIP: () => ({ address: "" }) })).toBe(
      'at unknown ua "probe/1"',
    );
  });

  // Mutation: read the Authorization header "for diagnostics" → red.
  test("never reads the Authorization header", () => {
    const withToken = new Request("http://127.0.0.1:4001/mcp", {
      headers: { authorization: "Bearer s3cret", "user-agent": "probe/1" },
    });
    const line = describePeer(withToken, { requestIP: () => ({ address: "::1" }) });
    expect(line).toBe('at ::1 ua "probe/1"');
    expect(line).not.toContain("s3cret");
    expect(line).not.toContain("Bearer");
  });
});
