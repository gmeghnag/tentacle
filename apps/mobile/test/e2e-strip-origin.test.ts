/**
 * `stripOrigin` (docs/feat/mobile-app-shell.md, Owner Q4): removes exactly the
 * `Origin:` header line, keeps every other byte, and reports the value.
 */
import { describe, expect, test } from "bun:test";
import { headEnd, stripOrigin } from "../e2e/strip-origin.ts";

const HEAD = [
  "GET /?token=abc HTTP/1.1",
  "Host: 127.0.0.1:4100",
  "Origin: exp+tentacle://",
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
].join("\r\n");

describe("stripOrigin", () => {
  test("removes exactly the Origin line and reports its value", () => {
    const { head, origin } = stripOrigin(HEAD);
    expect(origin).toBe("exp+tentacle://");
    expect(head).toBe(
      [
        "GET /?token=abc HTTP/1.1",
        "Host: 127.0.0.1:4100",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ].join("\r\n"),
    );
    expect(head).not.toContain("Origin");
  });

  test("every other byte is byte-identical (a reformatting proxy would hide bugs)", () => {
    const without = HEAD.split("\r\n")
      .filter((line) => !line.startsWith("Origin:"))
      .join("\r\n");
    expect(stripOrigin(HEAD).head).toBe(without);
    const encoder = new TextEncoder();
    expect(encoder.encode(stripOrigin(HEAD).head)).toEqual(encoder.encode(without));
  });

  test("the field name is case-insensitive, and every Origin line goes", () => {
    const head = "GET / HTTP/1.1\r\norigin: http://a\r\nORIGIN : http://b\r\nHost: h";
    const stripped = stripOrigin(head);
    expect(stripped.head).toBe("GET / HTTP/1.1\r\nHost: h");
    expect(stripped.origin).toBe("http://b"); // the last one is what was reported
  });

  test("no Origin → unchanged, origin null", () => {
    const head = "GET / HTTP/1.1\r\nHost: h";
    expect(stripOrigin(head)).toEqual({ head, origin: null });
  });

  test("a header merely starting with 'Origin' is not touched", () => {
    const head = "GET / HTTP/1.1\r\nOrigin-Agent-Cluster: ?1\r\nHost: h";
    expect(stripOrigin(head)).toEqual({ head, origin: null });
  });

  test("headEnd finds the blank line that ends the head", () => {
    const bytes = new TextEncoder().encode(`${HEAD}\r\n\r\nbody`);
    expect(headEnd(bytes)).toBe(HEAD.length);
    expect(headEnd(new TextEncoder().encode("GET / HTTP/1.1"))).toBe(-1);
  });
});
