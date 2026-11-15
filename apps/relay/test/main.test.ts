import { describe, expect, test } from "bun:test";
import { apnsSetupOf, parseRelayArgs, relayUsage } from "../src/main.ts";
import { RELAY_LIMITS } from "../src/relay-core.ts";
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, limitsFromFlags } from "../src/server.ts";

describe("parseRelayArgs — flags", () => {
  test("no arguments: the deploy defaults (loopback, the R7 port)", () => {
    const parsed = parseRelayArgs([]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        host: DEFAULT_RELAY_HOST,
        port: DEFAULT_RELAY_PORT,
        limits: {},
        trustProxy: false,
        apns: {},
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
        trustProxy: false,
        apns: {},
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

describe("parseRelayArgs — the real-client-IP flag (H3) and the per-IP id cap (M2)", () => {
  test("--trust-proxy is off by default and on when passed", () => {
    // Off by default: without the flag the relay behaves exactly as it did and
    // `X-Forwarded-For` is not read at all, so an existing deploy is unchanged.
    const off = parseRelayArgs([]);
    expect(off.ok).toBe(true);
    if (off.ok) {
      expect(off.args.trustProxy).toBe(false);
    }
    const on = parseRelayArgs(["--trust-proxy"]);
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.args.trustProxy).toBe(true);
      // The flag takes no value: it must not swallow the next argument.
      expect(on.args.host).toBe(DEFAULT_RELAY_HOST);
    }
    // `--trust-proxy` has nothing to take, so a value after it is a stranger arg.
    expect(parseRelayArgs(["--trust-proxy", "yes"]).ok).toBe(false);
  });

  test("TENTACLE_RELAY_TRUST_PROXY accepts 1/true/0/false only", () => {
    for (const [raw, expected] of [
      ["1", true],
      ["true", true],
      ["TRUE", true],
      ["0", false],
      ["false", false],
    ] as const) {
      const parsed = parseRelayArgs([], { TENTACLE_RELAY_TRUST_PROXY: raw });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args.trustProxy).toBe(expected);
      }
    }
    // Anything else refuses to start, naming the variable: a flag that
    // half-applies is worse than a relay that did not start.
    expect(parseRelayArgs([], { TENTACLE_RELAY_TRUST_PROXY: "yes" })).toEqual({
      ok: false,
      error: "TENTACLE_RELAY_TRUST_PROXY must be 1, true, 0 or false",
    });
  });

  test("--max-ids-per-ip parses, and maps onto the core's registeredPerIp", () => {
    const parsed = parseRelayArgs(["--max-ids-per-ip", "5"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.limits["max-ids-per-ip"]).toBe(5);
      expect(limitsFromFlags(parsed.args.limits)).toEqual({ registeredPerIp: 5 });
    }
    expect(parseRelayArgs(["--max-ids-per-ip", "0"]).ok).toBe(false);
    // The env spelling follows the others.
    const fromEnv = parseRelayArgs([], { TENTACLE_RELAY_MAX_IDS_PER_IP: "7" });
    expect(fromEnv.ok).toBe(true);
    if (fromEnv.ok) {
      expect(fromEnv.args.limits["max-ids-per-ip"]).toBe(7);
    }
  });

  test("--help names both new flags and their environment variables", () => {
    const usage = relayUsage();
    expect(usage).toContain("--trust-proxy");
    expect(usage).toContain("--max-ids-per-ip");
    expect(usage).toContain("TENTACLE_RELAY_TRUST_PROXY");
    expect(usage).toContain("_MAX_IDS_PER_IP");
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
        trustProxy: false,
        apns: {},
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

describe("parseRelayArgs — the APNs key (push is off without it)", () => {
  test("all four --apns-* flags parse into `args.apns`", () => {
    const parsed = parseRelayArgs([
      "--apns-key-file",
      "/etc/tentacle/AuthKey.p8",
      "--apns-key-id",
      "ABC123DEFG",
      "--apns-team-id",
      "TEAM123456",
      "--apns-topic",
      "so.tentacle.app",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.apns).toEqual({
        keyFile: "/etc/tentacle/AuthKey.p8",
        keyId: "ABC123DEFG",
        teamId: "TEAM123456",
        topic: "so.tentacle.app",
      });
    }
  });

  test("no APNs value at all: push is simply off, and that is not an error", () => {
    const parsed = parseRelayArgs([]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.apns).toEqual({});
    }
  });

  test("the environment is read, and a flag wins over it", () => {
    const fromEnv = parseRelayArgs([], {
      TENTACLE_RELAY_APNS_KEY_FILE: "/env.p8",
      TENTACLE_RELAY_APNS_TOPIC: "so.env.app",
    });
    expect(fromEnv.ok).toBe(true);
    if (fromEnv.ok) {
      expect(fromEnv.args.apns).toEqual({ keyFile: "/env.p8", topic: "so.env.app" });
    }
    const overridden = parseRelayArgs(["--apns-topic", "so.flag.app"], {
      TENTACLE_RELAY_APNS_TOPIC: "so.env.app",
    });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.args.apns.topic).toBe("so.flag.app");
    }
  });

  test("an --apns-* flag with no value is a refusal, naming it", () => {
    // A silently ignored key path is a relay that thinks it has push and does not.
    for (const flag of ["--apns-key-file", "--apns-key-id", "--apns-team-id", "--apns-topic"]) {
      expect(parseRelayArgs([flag])).toEqual({ ok: false, error: `${flag} needs a value` });
    }
  });

  test("an --apns-* value that is EMPTY or blank is push off, never a refusal", () => {
    // Review round 1 (finding 1) at the level the binary owns. Deployed through
    // systemd, an unset variable is an EMPTY argument, not a missing one:
    // `${TENTACLE_RELAY_APNS_KEY_ID}` standing as its own word always becomes
    // exactly one argument (systemd.service(5)). Refusing it turns a drop-in
    // installed a moment before `apns.conf` — or a rollback that deletes one
    // file — into `Restart=always` crash-looping the relay, i.e. every phone off
    // the relay because Apple's key is not where it was. So a blank value is
    // simply "not set": what is left is a partial set, which `apnsSetupOf`
    // reports as one `push off:` line while the relay serves.
    //
    // A MISSING argument is still a refusal (the test above): that is an
    // operator's typo, not a deployment shape, and it cannot be told apart from
    // a mistake.
    for (const flag of ["--apns-key-file", "--apns-key-id", "--apns-team-id", "--apns-topic"]) {
      const parsed = parseRelayArgs([flag, ""]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args.apns).toEqual({});
      }
      // Whitespace too: `Environment=`/`EnvironmentFile=` quoting leaves it in.
      const blank = parseRelayArgs([flag, "  "]);
      expect(blank.ok).toBe(true);
      if (blank.ok) {
        expect(blank.args.apns).toEqual({});
      }
    }
  });

  test("one blank value leaves the OTHER three real, so push is off and named", () => {
    // The mixed case is what a half-installed drop-in produces (the credential
    // path and the topic are literal, the two ids are not). It must not become
    // "push on with an empty key id": that would sign a token Apple rejects, and
    // the operator would see `rejected` pushes instead of the one honest
    // `push off:` line the runbook tells them to grep for.
    const parsed = parseRelayArgs([
      "--apns-key-file",
      "${CREDENTIALS_DIRECTORY}/apns-key",
      "--apns-key-id",
      "",
      "--apns-team-id",
      "",
      "--apns-topic",
      "so.tentacle.app",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.apns).toEqual({
        keyFile: "${CREDENTIALS_DIRECTORY}/apns-key",
        topic: "so.tentacle.app",
      });
    }
  });

  test("the new push limit flags parse like the others", () => {
    const parsed = parseRelayArgs([
      "--max-pushes-per-minute",
      "11",
      "--max-pushes-per-token-per-minute",
      "12",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.limits).toEqual({
        "max-pushes-per-minute": 11,
        "max-pushes-per-token-per-minute": 12,
      });
      expect(limitsFromFlags(parsed.args.limits)).toEqual({
        pushesPerMinutePerId: 11,
        pushesPerMinutePerToken: 12,
      });
    }
    expect(parseRelayArgs(["--max-pushes-per-minute", "0"]).ok).toBe(false);
  });
});

describe("apnsSetupOf — a key decides whether the relay carries push", () => {
  /** A real P-256 PKCS#8 private key in PEM armour, as a `.p8` file holds it. */
  async function pem(): Promise<string> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const lines =
      Buffer.from(der)
        .toString("base64")
        .match(/.{1,64}/g) ?? [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }

  const CONFIG = {
    keyFile: "/etc/tentacle/AuthKey.p8",
    keyId: "ABC123DEFG",
    teamId: "TEAM123456",
    topic: "so.tentacle.app",
  };

  test("no key → no push, and the line says so without failing the relay", async () => {
    const lines: string[] = [];
    expect(await apnsSetupOf({}, (line) => lines.push(line))).toBeUndefined();
    expect(lines.join("\n")).toContain("push off");
    // The relay still starts: phone reachability must not depend on Apple's key.
    expect(lines.join("\n")).toContain("no --apns-key-file");
  });

  test("an unreadable key → no push, one line, and the message names the FILE problem", async () => {
    const lines: string[] = [];
    const setup = await apnsSetupOf(
      { ...CONFIG },
      (line) => lines.push(line),
      () => {
        throw new Error("EACCES: permission denied");
      },
    );
    expect(setup).toBeUndefined();
    expect(lines.join("\n")).toContain("push off");
    expect(lines.join("\n")).toContain("unreadable");
    // Nothing from the key's contents is ever logged.
    expect(lines.join("\n")).not.toContain("PRIVATE KEY");
  });

  test("a readable key → the delivery path, one line that names no key material", async () => {
    const lines: string[] = [];
    const text = await pem();
    const setup = await apnsSetupOf(
      { ...CONFIG },
      (line) => lines.push(line),
      () => text,
    );
    expect(setup).toBeDefined();
    expect(setup?.topic).toBe(CONFIG.topic);
    expect(setup?.client.send).toBeFunction();
    const joined = lines.join("\n");
    expect(joined).toContain("push on");
    expect(joined).toContain(CONFIG.keyId);
    expect(joined).not.toContain("PRIVATE KEY");
    expect(joined).not.toContain(text.slice(30, 60));
    setup?.client.close();
  });

  test("a PEM that is not a P-256 PKCS#8 key → no push (never a relay that crashes)", async () => {
    const lines: string[] = [];
    const notAKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from("not a key").toString("base64")}\n-----END PRIVATE KEY-----\n`;
    const setup = await apnsSetupOf(
      { ...CONFIG },
      (line) => lines.push(line),
      () => notAKey,
    );
    expect(setup).toBeUndefined();
    expect(lines.join("\n")).toContain("push off");
  });

  test("a half-configured key (no topic) → no push, naming the rule", async () => {
    const lines: string[] = [];
    const text = await pem();
    const setup = await apnsSetupOf(
      { keyFile: CONFIG.keyFile, keyId: CONFIG.keyId, teamId: CONFIG.teamId },
      (line) => lines.push(line),
      () => text,
    );
    expect(setup).toBeUndefined();
    expect(lines.join("\n")).toContain("apns-topic");
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
      String(RELAY_LIMITS.pushesPerMinutePerId),
      String(RELAY_LIMITS.pushesPerMinutePerToken),
    ]) {
      expect(usage).toContain(value);
    }
    // Every APNs flag this build parses is documented, and the env names too.
    for (const flag of [
      "--apns-key-file",
      "--apns-key-id",
      "--apns-team-id",
      "--apns-topic",
      "--max-pushes-per-minute",
      "--max-pushes-per-token-per-minute",
      "TENTACLE_RELAY_APNS_KEY_FILE",
      "TENTACLE_RELAY_APNS_TOPIC",
    ]) {
      expect(usage).toContain(flag);
    }
  });
});
