/**
 * docs/feat/session-apps-container-ports.md OD4/OD5: what a visitor's request
 * may do before anything is dialled, and what goes up and comes back. Pure.
 */
import { describe, expect, test } from "bun:test";
import {
  SHARE_COOKIE,
  filterResponseHeaders,
  shareGate,
  upstreamRequest,
} from "../src/share-gate.ts";

const SECRET = "s3cr3tS3cr3tS3cr3tS3cr3";
const COOKIE = `${SHARE_COOKIE}=${SECRET}`;
type Headers = [string, string][];

const gate = (target: string, headers: Headers = [], method = "GET", secret?: string | null) =>
  shareGate({ method, target, headers }, secret === null ? undefined : (secret ?? SECRET));

const statusOf = (d: ReturnType<typeof gate>): number => (d.kind === "respond" ? d.status : 0);
const header = (d: ReturnType<typeof gate>, name: string): string | undefined =>
  d.kind === "respond" ? d.headers.find(([n]) => n.toLowerCase() === name)?.[1] : undefined;

describe("shareGate: the secret link", () => {
  test("the cap path with the secret: 303 to / with a host-only cookie", () => {
    const d = gate(`/__tentacle/cap/${SECRET}`);
    expect(statusOf(d)).toBe(303);
    expect(header(d, "location")).toBe("/");
    expect(header(d, "set-cookie")).toBe(`${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  });

  test("a wrong secret and any other /__tentacle path: 404, never forwarded", () => {
    for (const target of [
      "/__tentacle/cap/wrong",
      `/__tentacle/cap/${SECRET}x`,
      `/__tentacle/cap/${SECRET.slice(0, -1)}`,
      `/__tentacle/cap/${SECRET}/more`,
      "/__tentacle/cap/",
      "/__tentacle/other",
    ]) {
      expect(statusOf(gate(target, [["cookie", COOKIE]]))).toBe(404);
    }
    expect(statusOf(gate(`/__tentacle/cap/${SECRET}`, [], "POST"))).toBe(404);
  });

  test("no cookie, or a wrong one: 403 and nothing forwarded", () => {
    for (const headers of [
      [],
      [["cookie", `${SHARE_COOKIE}=wrong`]],
      [["cookie", `x${COOKIE}`]],
      [["cookie", `other=${SECRET}`]],
    ] as Headers[]) {
      expect(statusOf(gate("/", headers))).toBe(403);
    }
  });

  test("a valid cookie is forwarded WITHOUT the cookie", () => {
    const d = gate("/a?b=1", [
      ["cookie", `a=1; ${COOKIE}; b=2`],
      ["cookie", COOKIE],
      ["accept", "*/*"],
    ]);
    expect(d.kind).toBe("forward");
    expect(d.kind === "forward" ? d.headers : []).toEqual([
      ["cookie", "a=1; b=2"],
      ["accept", "*/*"],
    ]);
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });
});

describe("shareGate: public", () => {
  test("no secret is asked; /__tentacle stays 404", () => {
    expect(gate("/", [], "GET", null).kind).toBe("forward");
    expect(statusOf(gate(`/__tentacle/cap/${SECRET}`, [], "GET", null))).toBe(404);
  });
});

describe("only an origin-form request goes on", () => {
  for (const [method, target] of [
    ["GET", "//evil.example/x"],
    ["GET", "/\\evil.example/x"],
    ["GET", "http://192.168.1.1/"],
    ["OPTIONS", "*"],
    ["CONNECT", "/"],
    ["CONNECT", "host:22"],
    ["TRACE", "/"],
    ["track", "/"],
    ["GET", "x"],
    ["GET", ""],
  ] as const) {
    test(`${method} ${target || "(empty)"}: 400`, () => {
      expect(statusOf(gate(target, [["cookie", COOKIE]], method))).toBe(400);
      expect(statusOf(gate(target, [], method, null))).toBe(400);
    });
  }
});

const APP = "https://abcdefghijklmnop.apps.example.so";
const up = (target: string, headers: Headers = []) =>
  upstreamRequest({ method: "GET", target, headers }, { hostPort: 8080, publicOrigin: APP });

describe("upstreamRequest", () => {
  test("the URL stays on the fixed loopback origin", () => {
    expect(up("/a/b?c=%2F")?.url).toBe("http://127.0.0.1:8080/a/b?c=%2F");
    expect(up("//evil.example/x")).toBeUndefined();
    expect(up("/\\evil.example/x")).toBeUndefined();
    expect(up("http://evil.example/")).toBeUndefined();
    // Tabs and newlines are removed by the URL parser: checked after building.
    expect(up("/\t/evil.example/x")).toBeUndefined();
  });

  test("hop-by-hop and forwarding headers are dropped; Host is localhost", () => {
    const headers = up("/", [
      ["connection", "keep-alive, x-private"],
      ["x-private", "1"],
      ["keep-alive", "1"],
      ["te", "trailers"],
      ["trailer", "a"],
      ["transfer-encoding", "chunked"],
      ["upgrade", "websocket"],
      ["proxy-authorization", "p"],
      ["forwarded", "for=1.2.3.4"],
      ["x-forwarded-for", "1.2.3.4"],
      ["x-forwarded-proto", "http"],
      ["host", "abcdefghijklmnop.apps.example.so"],
      ["content-length", "3"],
      ["expect", "100-continue"],
      ["sec-websocket-key", "k"],
      ["accept", "text/html"],
    ])?.headers;
    expect(headers).toEqual([
      ["accept", "text/html"],
      ["host", "localhost:8080"],
      ["x-forwarded-proto", "https"],
      ["x-forwarded-host", "abcdefghijklmnop.apps.example.so"],
    ]);
  });

  test("Origin is rewritten only when it is the app's own", () => {
    const originOf = (origin: string) =>
      up("/", [["origin", origin]])?.headers.find(([n]) => n === "origin")?.[1];
    expect(originOf(APP)).toBe("http://localhost:8080");
    expect(originOf("https://evil.example")).toBe("https://evil.example");
    expect(originOf(`${APP}.evil.example`)).toBe(`${APP}.evil.example`);
  });
});

describe("filterResponseHeaders", () => {
  test("drops hop-by-hop headers, Domain cookies and the capability's own name", () => {
    expect(
      filterResponseHeaders([
        ["connection", "close"],
        ["transfer-encoding", "chunked"],
        ["proxy-authenticate", "x"],
        ["set-cookie", "mine=1; Path=/"],
        ["set-cookie", "t=1; Domain=.tentacle.so"],
        ["set-cookie", "t=2; path=/; domain=example.so"],
        ["set-cookie", `${SHARE_COOKIE}=fixed; Path=/; Secure`],
        ["Set-Cookie", ` ${SHARE_COOKIE} =fixed`],
        ["content-type", "text/html"],
      ]),
    ).toEqual([
      ["set-cookie", "mine=1; Path=/"],
      ["content-type", "text/html"],
    ]);
  });
});
