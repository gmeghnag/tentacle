/**
 * The deploy artefacts are inert files the OWNER applies on a real server, so a
 * mismatch between them and the code would first show up in production
 * (the relay's `deploy.test.ts` pattern). What this cannot prove — that systemd
 * and Caddy accept the files — is the runbook's checks.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPS_HOST_BINARY_NAME,
  appsHostBuildTarget,
  appsHostEntrypoint,
  appsHostOutfile,
} from "../deploy/build.ts";
import { APPS_LIMITS, APPS_LIMIT_NAMES, limitFlag } from "../src/limits.ts";
import { parseAppsHostArgs } from "../src/main.ts";
import { parseKillSwitch, parseTakedowns } from "../src/operator-files.ts";
import { DEFAULT_APPS_HOST, DEFAULT_APPS_PORT } from "../src/server.ts";

const APP = join(import.meta.dir, "..");
const ROOT = join(APP, "..", "..");
const read = (path: string): string => readFileSync(path, "utf8");
const unit = read(join(APP, "deploy", "apps-host.service"));
const caddy = read(join(APP, "deploy", "Caddyfile.apps"));
const runbook = read(join(ROOT, "docs", "ops", "apps-host-deploy.md"));

const directives = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");

/** The unit's live lines, `Section/Key=value`. */
function unitEntries(text: string): [string, string][] {
  let section = "";
  const entries: [string, string][] = [];
  for (const line of directives(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      section = trimmed.slice(1, -1);
    } else if (trimmed.includes("=")) {
      const eq = trimmed.indexOf("=");
      entries.push([`${section}/${trimmed.slice(0, eq)}`, trimmed.slice(eq + 1)]);
    }
  }
  return entries;
}

const entries = unitEntries(unit);
const values = (key: string): string[] => entries.filter(([k]) => k === key).map(([, v]) => v);
const service = (key: string): string | undefined => values(`Service/${key}`).at(-1);

describe("apps-host.service", () => {
  const starts = values("Service/ExecStart");
  const [program, ...argv] = (starts[0] ?? "").split(/\s+/);

  test("one ExecStart, parsed by main.ts at the default address behind the proxy", () => {
    expect(starts).toHaveLength(1);
    const parsed = parseAppsHostArgs(argv);
    if (!parsed.ok) {
      throw new Error(`the unit's ExecStart is refused: ${parsed.error}`);
    }
    expect(parsed.args.host).toBe(DEFAULT_APPS_HOST);
    expect(parsed.args.port).toBe(DEFAULT_APPS_PORT);
    expect(parsed.args.domain).toBe("apps.tentacle.so");
    expect(parsed.args.trustProxy).toBe(true);
    expect(parsed.args.limits).toEqual({});
    expect(parsed.args.dataDir).toBe(`/var/lib/${service("StateDirectory")}`);
    expect(parsed.args.operatorDir).toBe(`/etc/${service("ConfigurationDirectory")}`);
  });

  test("the program is the installed binary the runbook names", () => {
    expect(program).toBe(`/opt/tentacle-apps-host/${APPS_HOST_BINARY_NAME}`);
    expect(runbook).toContain(`/opt/tentacle-apps-host/${APPS_HOST_BINARY_NAME}`);
  });

  test("no secret in argv, and no environment file", () => {
    expect(starts[0]).not.toMatch(/token|secret|password|\.p8|\$\{/i);
    expect(unit).not.toMatch(/^(EnvironmentFile|LoadCredential|Environment)=/m);
  });

  test("its own user, sandbox, directories and bounds", () => {
    const wanted: Record<string, string> = {
      User: "tentacle-apps",
      Group: "tentacle-apps",
      StateDirectory: "tentacle-apps",
      StateDirectoryMode: "0700",
      ConfigurationDirectory: "tentacle-apps",
      ReadOnlyPaths: "/etc/tentacle-apps",
      MemoryMax: "512M",
      Restart: "always",
      NoNewPrivileges: "yes",
      ProtectSystem: "strict",
      ProtectHome: "yes",
      PrivateTmp: "yes",
      PrivateDevices: "yes",
      ProtectKernelTunables: "yes",
      ProtectKernelModules: "yes",
      ProtectKernelLogs: "yes",
      ProtectControlGroups: "yes",
      ProtectClock: "yes",
      ProtectHostname: "yes",
      ProtectProc: "invisible",
      RestrictAddressFamilies: "AF_INET AF_INET6",
      RestrictNamespaces: "yes",
      RestrictRealtime: "yes",
      RestrictSUIDSGID: "yes",
      LockPersonality: "yes",
      SystemCallArchitectures: "native",
      CapabilityBoundingSet: "",
      AmbientCapabilities: "",
      UMask: "0077",
    };
    for (const [key, value] of Object.entries(wanted)) {
      expect([key, service(key)]).toEqual([key, value]);
    }
    // The relay's sandbox block, line for line.
    const relay = unitEntries(read(join(ROOT, "apps/relay/deploy/relay.service")));
    for (const [key, value] of relay.filter(([k]) =>
      /\/(Protect|Restrict|Private|Capability|Ambient|NoNew|Lock|SystemCall|UMask)/.test(k),
    )) {
      expect([key, values(key).at(-1)]).toEqual([key, value]);
    }
    // Bun JIT-compiles: these two would kill it.
    expect(service("MemoryDenyWriteExecute")).toBeUndefined();
    expect(service("SystemCallFilter")).toBeUndefined();
    expect(values("Unit/StartLimitBurst")).toHaveLength(1);
    expect(values("Unit/StartLimitIntervalSec")).toHaveLength(1);
  });
});

describe("Caddyfile.apps", () => {
  const live = directives(caddy);

  test("one site block for the wildcard and the apex of the unit's domain", () => {
    expect(live).toMatch(/^\*\.apps\.tentacle\.so, apps\.tentacle\.so \{$/m);
  });

  test("DNS-01 for the wildcard, with the token from the environment", () => {
    expect(live).toMatch(/tls \{\s*dns <provider> \{env\.TENTACLE_APPS_DNS_TOKEN\}/);
  });

  test("proxies to the default port, replaces XFF, strips cookies and the banner", () => {
    expect(live).toContain(`reverse_proxy ${DEFAULT_APPS_HOST}:${DEFAULT_APPS_PORT} {`);
    expect(live).toContain("header_up X-Forwarded-For {remote_host}");
    expect(live).toContain("header_down -Set-Cookie");
    expect(live).toMatch(/^\s*-Set-Cookie$/m);
    expect(live).toMatch(/^\s*-Server$/m);
    expect(live).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(live).not.toMatch(/includeSubDomains|preload|header_up Host/);
  });

  test("the body limit is at least the app limit, in MiB, and nothing is logged", () => {
    const size = /max_size (\d+)MiB/.exec(live)?.[1];
    expect(Number(size) * 1024 * 1024).toBeGreaterThanOrEqual(APPS_LIMITS.maxAppBytes);
    expect(live).not.toMatch(/^\s*log\b/m);
  });
});

describe("build.ts", () => {
  test("the entry point exists, the binary lands in dist, for the deploy host", () => {
    expect(existsSync(appsHostEntrypoint(ROOT))).toBe(true);
    expect(appsHostOutfile(ROOT)).toBe(join(ROOT, "dist", APPS_HOST_BINARY_NAME));
    expect(appsHostBuildTarget({})).toEqual({ ok: true, target: "bun-linux-x64" });
    expect(appsHostBuildTarget({ TARGET: "bun-linux-arm64" })).toEqual({
      ok: true,
      target: "bun-linux-arm64",
    });
    expect(appsHostBuildTarget({ TARGET: "linux-x64" }).ok).toBe(false);
  });
});

describe("the runbook", () => {
  const fenced = (tag: string): string[] =>
    [...runbook.matchAll(new RegExp(`\`\`\`${tag}\\n([\\s\\S]*?)\`\`\``, "g"))].map(
      (m) => m[1] ?? "",
    );

  test("its takedown examples parse, every line", () => {
    const examples = fenced("takedowns");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const parsed = parseTakedowns(example);
      expect(parsed.invalid).toEqual([]);
      expect(parsed.apps.size).toBeGreaterThan(0);
      expect(parsed.keys.size).toBeGreaterThan(0);
    }
  });

  test("its kill-switch words are the ones the parser knows", () => {
    const words = [...runbook.matchAll(/echo (\S+) > \S*kill-switch/g)].map((m) => m[1] ?? "");
    expect([...new Set(words)].sort()).toEqual(["all", "publish"]);
    for (const word of words) {
      expect(parseKillSwitch({ kind: "text", text: `${word}\n` }).invalid).toBe(false);
    }
  });

  test("names the build, the health check, every limit flag, and whose step it is", () => {
    expect(runbook).toContain("bun apps/apps-host/deploy/build.ts");
    expect(runbook).toContain(`dist/${APPS_HOST_BINARY_NAME}`);
    expect(runbook).toContain("https://apps.tentacle.so/healthz");
    expect(runbook).toContain("Deploy is the owner's step, never an executor's");
    for (const name of APPS_LIMIT_NAMES) {
      expect(runbook).toContain(`--${limitFlag(name)}`);
    }
  });

  test("has every section", () => {
    const headings = [...runbook.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
    expect(headings).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(runbook).toContain("## Deploy log");
  });
});
