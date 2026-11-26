import { describe, expect, test } from "bun:test";
import { APPS_LIMITS, APPS_LIMIT_NAMES, limitEnv, limitFlag } from "../src/limits.ts";
import { DEFAULT_APPS_STATUS_PORT, appsHostUsage, parseAppsHostArgs } from "../src/main.ts";

const REQUIRED = [
  "--domain",
  "apps.example.so",
  "--abuse-email",
  "abuse@example.so",
  "--terms-url",
  "https://example.so/terms",
];

function ok(argv: string[], env: Record<string, string> = {}) {
  const parsed = parseAppsHostArgs(argv, env);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.args;
}

const error = (argv: string[], env: Record<string, string> = {}): string => {
  const parsed = parseAppsHostArgs(argv, env);
  return parsed.ok ? "" : parsed.error;
};

describe("parseAppsHostArgs", () => {
  test("defaults: loopback, 4200, the system directories, no proxy trust", () => {
    expect(ok(REQUIRED)).toEqual({
      host: "127.0.0.1",
      port: 4200,
      domain: "apps.example.so",
      abuseEmail: "abuse@example.so",
      termsUrl: "https://example.so/terms",
      dataDir: "/var/lib/tentacle-apps",
      operatorDir: "/etc/tentacle-apps",
      trustProxy: false,
      limits: {},
      statusPort: DEFAULT_APPS_STATUS_PORT,
      help: false,
    });
  });

  test("each required value is refused when missing or blank", () => {
    for (const flag of ["--domain", "--abuse-email", "--terms-url"]) {
      const at = REQUIRED.indexOf(flag);
      const without = [...REQUIRED.slice(0, at), ...REQUIRED.slice(at + 2)];
      expect(error(without)).toContain(`${flag} is required`);
      expect(error([...without, flag, "  "])).toContain(flag);
      expect(error([...without, flag])).toContain(`${flag} needs a value`);
    }
  });

  test("the environment supplies values and a flag wins", () => {
    const env = {
      TENTACLE_APPS_DOMAIN: "env.example.so",
      TENTACLE_APPS_ABUSE_EMAIL: "env@example.so",
      TENTACLE_APPS_TERMS_URL: "https://env.example.so/",
      TENTACLE_APPS_HOST: "0.0.0.0",
      TENTACLE_APPS_PORT: "5000",
      TENTACLE_APPS_DATA_DIR: "/data",
      TENTACLE_APPS_OPERATOR_DIR: "/ops",
      TENTACLE_APPS_TRUST_PROXY: "1",
      TENTACLE_APPS_MAX_APP_BYTES: "100",
    };
    expect(ok([], env)).toMatchObject({
      domain: "env.example.so",
      host: "0.0.0.0",
      port: 5000,
      dataDir: "/data",
      operatorDir: "/ops",
      trustProxy: true,
      limits: { maxAppBytes: 100 },
    });
    expect(
      ok(["--domain", "Flag.Example.SO", "--port", "5001", "--max-app-bytes", "200"], env),
    ).toMatchObject({ domain: "flag.example.so", port: 5001, limits: { maxAppBytes: 200 } });
  });

  test("every limit has a flag and an environment variable", () => {
    expect(limitFlag("maxLiveAppsPerKey")).toBe("max-live-apps-per-key");
    expect(limitEnv("maxLiveAppsPerKey")).toBe("TENTACLE_APPS_MAX_LIVE_APPS_PER_KEY");
    for (const name of APPS_LIMIT_NAMES) {
      expect(ok([...REQUIRED, `--${limitFlag(name)}`, "7"]).limits).toEqual({ [name]: 7 });
      expect(ok(REQUIRED, { [limitEnv(name)]: "8" }).limits).toEqual({ [name]: 8 });
      expect(appsHostUsage()).toContain(`--${limitFlag(name)}`);
      expect(appsHostUsage()).toContain(String(APPS_LIMITS[name]));
    }
  });

  test("an invalid value is a refusal, never ignored", () => {
    for (const value of ["0", "-1", "1.5", "ten", ""]) {
      expect(error([...REQUIRED, "--max-app-bytes", value])).toContain("--max-app-bytes");
      expect(error(REQUIRED, { TENTACLE_APPS_LEASE_MS: value })).toContain(
        "TENTACLE_APPS_LEASE_MS",
      );
    }
    for (const port of ["0", "65536", "x"]) {
      expect(error([...REQUIRED, "--port", port])).toContain("--port");
      expect(error(REQUIRED, { TENTACLE_APPS_PORT: port })).toContain("TENTACLE_APPS_PORT");
    }
    expect(error(REQUIRED, { TENTACLE_APPS_TRUST_PROXY: "yes" })).toContain("TRUST_PROXY");
    for (const domain of [
      "https://apps.example.so",
      "apps.example.so:443",
      "localhost",
      "a b.so",
    ]) {
      expect(error([...REQUIRED, "--domain", domain])).toContain("--domain");
    }
    for (const email of ["abuse", "a b@x.so"]) {
      expect(error([...REQUIRED, "--abuse-email", email])).toContain("--abuse-email");
    }
    for (const url of ["javascript:alert(1)", "/terms", "terms"]) {
      expect(error([...REQUIRED, "--terms-url", url])).toContain("--terms-url");
    }
    expect(error([...REQUIRED, "--data-dir", " "])).toContain("--data-dir");
  });

  test("the status port: on by default; a flag or the environment, and the flag wins", () => {
    expect(DEFAULT_APPS_STATUS_PORT).toBe(4201);
    expect(ok(REQUIRED).statusPort).toBe(4201);
    expect(ok([...REQUIRED, "--status-port", "5001"]).statusPort).toBe(5001);
    const env = { TENTACLE_APPS_STATUS_PORT: "5002" };
    expect(ok(REQUIRED, env).statusPort).toBe(5002);
    expect(ok([...REQUIRED, "--status-port", "5001"], env).statusPort).toBe(5001);
    expect(ok([...REQUIRED, "--status-port", "off"]).statusPort).toBeUndefined();
    expect(ok(REQUIRED, { TENTACLE_APPS_STATUS_PORT: "off" }).statusPort).toBeUndefined();
  });

  test("an invalid status port is a refusal, naming the source", () => {
    for (const value of ["0", "65536", "1.5", "on", ""]) {
      expect(error([...REQUIRED, "--status-port", value])).toBe(
        "--status-port must be a port number or off",
      );
      expect(error(REQUIRED, { TENTACLE_APPS_STATUS_PORT: value })).toBe(
        "TENTACLE_APPS_STATUS_PORT must be a port number or off",
      );
    }
    expect(error([...REQUIRED, "--status-port"])).toBe("--status-port needs a value");
  });

  test("a status port equal to the main port is refused, however the two were set", () => {
    const refused = "--status-port must differ from --port";
    expect(error([...REQUIRED, "--status-port", "4200"])).toBe(refused);
    expect(error([...REQUIRED, "--port", "4201"])).toBe(refused);
    expect(error(REQUIRED, { TENTACLE_APPS_PORT: "9000", TENTACLE_APPS_STATUS_PORT: "9000" })).toBe(
      refused,
    );
    expect(error([...REQUIRED, "--port", "4201", "--status-port", "off"])).toBe("");
  });

  test("--help names the status flag, its default and the variable", () => {
    for (const text of ["--status-port", "4201", "TENTACLE_APPS_STATUS_PORT", "/__status"]) {
      expect(appsHostUsage()).toContain(text);
    }
  });

  test("an unknown argument is refused; --help needs nothing else", () => {
    expect(error([...REQUIRED, "--nope"])).toBe("unknown argument: --nope");
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
  });
});
