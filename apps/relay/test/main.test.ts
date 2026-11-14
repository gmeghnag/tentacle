import { describe, expect, test } from "bun:test";
import { parseRelayArgs, relayUsage } from "../src/main.ts";
import { RELAY_LIMITS } from "../src/relay-core.ts";
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT } from "../src/server.ts";

describe("parseRelayArgs — flags", () => {
  test("no arguments: the deploy defaults (loopback, the R7 port)", () => {
    const parsed = parseRelayArgs([]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        host: DEFAULT_RELAY_HOST,
        port: DEFAULT_RELAY_PORT,
        limits: {},
        help: false,
      },
    });
    expect(DEFAULT_RELAY_HOST).toBe("127.0.0.1");
    expect(DEFAULT_RELAY_PORT).toBe(4100);
  });

  test("host, port and every limit flag", () => {
    const parsed = parseRelayArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "8080",
      "--max-dials-per-minute",
      "5",
      "--max-streams-per-ip",
      "6",
      "--max-streams-per-id",
      "7",
      "--max-ids",
      "8",
      "--max-hellos-per-minute",
      "9",
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        host: "0.0.0.0",
        port: 8080,
        limits: {
          "max-dials-per-minute": 5,
          "max-streams-per-ip": 6,
          "max-streams-per-id": 7,
          "max-ids": 8,
          "max-hellos-per-minute": 9,
        },
        help: false,
      },
    });
  });

  test("--help / -h", () => {
    for (const flag of ["--help", "-h"]) {
      const parsed = parseRelayArgs([flag]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args.help).toBe(true);
      }
    }
  });

  test("an invalid value is a REFUSAL, never a silently ignored flag", () => {
    // A limit that did not apply is worse than a relay that did not start.
    expect(parseRelayArgs(["--max-ids", "0"])).toEqual({
      ok: false,
      error: "--max-ids must be a positive integer",
    });
    expect(parseRelayArgs(["--max-ids", "1.5"]).ok).toBe(false);
    expect(parseRelayArgs(["--max-ids", "abc"]).ok).toBe(false);
    expect(parseRelayArgs(["--port", "70000"]).ok).toBe(false);
    expect(parseRelayArgs(["--port", "0"]).ok).toBe(false);
    expect(parseRelayArgs(["--host"])).toEqual({ ok: false, error: "--host needs a value" });
    expect(parseRelayArgs(["--max-ids", "--port", "1"])).toEqual({
      ok: false,
      error: "--max-ids needs a value",
    });
    expect(parseRelayArgs(["--nope"])).toEqual({ ok: false, error: "unknown argument: --nope" });
  });
});

describe("parseRelayArgs — env (a flag wins)", () => {
  test("the environment is read when no flag names the value", () => {
    const parsed = parseRelayArgs([], {
      TENTACLE_RELAY_HOST: "10.0.0.1",
      TENTACLE_RELAY_PORT: "9999",
      TENTACLE_RELAY_MAX_STREAMS_PER_ID: "3",
    });
    expect(parsed).toEqual({
      ok: true,
      args: {
        host: "10.0.0.1",
        port: 9999,
        limits: { "max-streams-per-id": 3 },
        help: false,
      },
    });
  });

  test("a flag overrides the environment variable of the same name", () => {
    const parsed = parseRelayArgs(["--port", "8081", "--max-ids", "42"], {
      TENTACLE_RELAY_PORT: "9999",
      TENTACLE_RELAY_MAX_IDS: "7",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.port).toBe(8081);
      expect(parsed.args.limits["max-ids"]).toBe(42);
    }
  });

  test("an invalid env value refuses to start, naming the variable", () => {
    expect(parseRelayArgs([], { TENTACLE_RELAY_PORT: "http" })).toEqual({
      ok: false,
      error: "TENTACLE_RELAY_PORT must be a port number",
    });
    expect(parseRelayArgs([], { TENTACLE_RELAY_MAX_IDS: "-1" })).toEqual({
      ok: false,
      error: "TENTACLE_RELAY_MAX_IDS must be a positive integer",
    });
  });
});

describe("relayUsage", () => {
  test("the help text names every flag and the real defaults (no stale numbers)", () => {
    const usage = relayUsage();
    expect(usage).toContain("--host");
    expect(usage).toContain("--port");
    for (const value of [
      DEFAULT_RELAY_HOST,
      String(DEFAULT_RELAY_PORT),
      String(RELAY_LIMITS.dialsPerMinutePerIp),
      String(RELAY_LIMITS.concurrentPerIp),
      String(RELAY_LIMITS.streamsPerId),
      String(RELAY_LIMITS.registeredIds),
      String(RELAY_LIMITS.hellosPerMinutePerIp),
    ]) {
      expect(usage).toContain(value);
    }
  });
});
