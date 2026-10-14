import { describe, expect, test } from "bun:test";
import { SessionHost } from "../src/session-host.ts";
import { isLoopbackHost, originAllowed, startWsServer, tokensMatch } from "../src/ws-server.ts";

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

describe("isLoopbackHost", () => {
  test("recognises loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.17")).toBe(false);
  });
});

describe("tokensMatch", () => {
  test("constant-time compare: equal only for identical tokens", () => {
    expect(tokensMatch("s3cret", "s3cret")).toBe(true);
    expect(tokensMatch("s3cret", "s3cre")).toBe(false);
    expect(tokensMatch("s3cret", "x3cret")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("originAllowed", () => {
  test("no allow-list: a headerless native client is allowed, any browser Origin denied", () => {
    expect(originAllowed(null)).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
    expect(originAllowed("http://localhost:3000")).toBe(false);
  });

  test("with an allow-list: only listed Origins pass, headerless is denied", () => {
    const allow = ["https://app.example"];
    expect(originAllowed("https://app.example", allow)).toBe(true);
    expect(originAllowed("https://evil.example", allow)).toBe(false);
    expect(originAllowed(null, allow)).toBe(false);
    expect(originAllowed("", allow)).toBe(false);
  });

  test("an empty allow-list behaves as none (default-deny Origins)", () => {
    expect(originAllowed(null, [])).toBe(true);
    expect(originAllowed("https://evil.example", [])).toBe(false);
  });
});

describe("startWsServer Origin enforcement (CSRF / DNS-rebinding)", () => {
  const statusFor = async (url: string, headers: Record<string, string>): Promise<number> =>
    (await fetch(url, { headers })).status;

  test("loopback default rejects a cross-origin browser upgrade (401 before upgrade)", async () => {
    const server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: dummyHost });
    const http = `http://127.0.0.1:${server.port}`;
    try {
      // A browser sends Origin → refused at the HTTP upgrade, before the socket.
      expect(await statusFor(http, { Origin: "https://evil.example" })).toBe(401);
      // A native client sends no Origin → passes auth, fails only the WS upgrade.
      expect(await statusFor(http, {})).toBe(426);
    } finally {
      server.stop();
    }
  });

  test("a configured allow-list admits the listed Origin and rejects others", async () => {
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: dummyHost,
      allowedOrigins: ["https://app.example"],
    });
    const http = `http://127.0.0.1:${server.port}`;
    try {
      expect(await statusFor(http, { Origin: "https://app.example" })).toBe(426);
      expect(await statusFor(http, { Origin: "https://evil.example" })).toBe(401);
    } finally {
      server.stop();
    }
  });
});

describe("startWsServer safe bind", () => {
  test("refuses a non-loopback bind without a token", () => {
    expect(() => startWsServer({ host: "0.0.0.0", port: 0, sessionHost: dummyHost })).toThrow(
      /non-loopback/i,
    );
  });

  test("a non-loopback bind WITH a token is allowed", () => {
    const server = startWsServer({
      host: "0.0.0.0",
      port: 0,
      token: "tok",
      sessionHost: dummyHost,
    });
    expect(server.url).toContain("0.0.0.0");
    server.stop();
  });
});
