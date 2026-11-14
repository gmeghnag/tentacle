import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELAY_BINARY_NAME,
  relayBuildTarget,
  relayEntrypoint,
  relayOutfile,
} from "../deploy/build.ts";
import { parseRelayArgs } from "../src/main.ts";
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, relayRoute } from "../src/server.ts";

/**
 * R7's drift guard (docs/feat/mobile-relay.md): the deploy artefacts are inert
 * files, applied by the OWNER on a real server (slice D), so a mismatch between
 * them — a flag `main.ts` does not parse, a port Caddy does not forward, an
 * install path the runbook names differently — would first surface in
 * production. These assertions bind the four artefacts to the code they deploy;
 * none of them needs a server, a Caddy or a systemd.
 *
 * What they CANNOT prove (stated, not papered over): that `systemd-analyze
 * verify` / `caddy validate` accept the files, that the public certificate
 * works, or that a stream splices through the proxy. Those are the runbook's
 * checks (`docs/ops/relay-deploy.md` §3, §4, §5), run by the owner on the host.
 */
const RELAY_DIR = join(import.meta.dir, "..");
const DEPLOY_DIR = join(RELAY_DIR, "deploy");
const REPO_ROOT = join(RELAY_DIR, "..", "..");

const read = (path: string): string => readFileSync(path, "utf8");

/** The `[Service]` section's `key=value` pairs, last one winning (systemd's rule). */
function serviceKeys(unit: string): Map<string, string> {
  const keys = new Map<string, string>();
  let section = "";
  // systemd joins a line ending in `\` with the next one. `ExecStart` is the
  // place an operator WILL use it (an override with more flags), and reading
  // that wrong would report a flag mismatch that is not there.
  const joined: string[] = [];
  let pending = "";
  for (const raw of unit.split("\n")) {
    if (raw.trimStart().startsWith("#") || raw.trimStart().startsWith(";")) {
      continue;
    }
    if (raw.endsWith("\\")) {
      pending += raw.slice(0, -1);
      continue;
    }
    joined.push(pending + raw);
    pending = "";
  }
  if (pending !== "") {
    joined.push(pending);
  }
  for (const raw of joined) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    // `Section/Key` so `[Install] WantedBy` and `[Service] WantedBy` cannot alias.
    keys.set(`${section}/${line.slice(0, eq)}`, line.slice(eq + 1));
  }
  return keys;
}

/** The argv of a continued `ExecStart` (whitespace-separated, as systemd's own rule). */
function execArgs(value: string): string[] {
  return value.split(/\s+/).filter((t) => t !== "");
}

/** `/opt/tentacle-relay/tentacle-relay --host … --port …` → `{ program, argv }`. */
function execStart(unit: string): { program: string; argv: string[] } {
  const tokens = execArgs(serviceKeys(unit).get("Service/ExecStart") ?? "");
  return { program: tokens[0] ?? "", argv: tokens.slice(1) };
}

describe("R7 relay.service — the unit starts the binary the runbook installs", () => {
  test("a continued ExecStart is read as ONE value (the reader's own guard)", () => {
    // `serviceKeys` is the test's own parser: if it silently dropped a `\`-joined
    // line, a live unit with an override would report a flag mismatch that is not
    // there — a false RED on a correct artefact is as bad as a false GREEN.
    // The continued line carries a NON-default port on purpose: with the default
    // there, a dropped continuation would read as "no --port" and pass by falling
    // back to the same value (this test's first draft did exactly that).
    const real = read(join(DEPLOY_DIR, "relay.service"));
    // Anchored on the newline so it hits the LIVE line, never the commented-out
    // example above it (this test's second draft replaced the comment, and went
    // red on a correct unit).
    const continued = real.replace(
      "\nExecStart=/opt/tentacle-relay/tentacle-relay --host 127.0.0.1 --port 4100",
      "\nExecStart=/opt/tentacle-relay/tentacle-relay --host 127.0.0.1 \\\n    --port 4321",
    );
    expect(continued).toContain("--host 127.0.0.1 \\\n    --port 4321");
    // The live ExecStart is unique and uncommented: a second one would be an
    // override systemd silently prefers, and a commented example is not it.
    const live = real.split("\n").filter((line) => line.startsWith("ExecStart="));
    expect(live.length).toBe(1);
    const parsed = parseRelayArgs(execStart(continued).argv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.port).toBe(4321);
    }
  });

  test("ExecStart's program is /opt/tentacle-relay/<binary>, as the runbook names it", () => {
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const installed = `/opt/tentacle-relay/${RELAY_BINARY_NAME}`;
    expect(execStart(unit).program).toBe(installed);
    expect(read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"))).toContain(installed);
  });

  test("every ExecStart flag is one main.ts parses, at the relay's own default address", () => {
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const parsed = parseRelayArgs(execStart(unit).argv);
    // A flag the binary refuses is an ExecStart that exits 1 on every boot.
    if (!parsed.ok) {
      throw new Error(`relay.service's ExecStart is not argv main.ts accepts: ${parsed.error}`);
    }
    expect(parsed.args.host).toBe(DEFAULT_RELAY_HOST);
    expect(parsed.args.port).toBe(DEFAULT_RELAY_PORT);
    expect(parsed.args.help).toBe(false);
  });

  test("no secret on the command line (argv is world-readable in ps)", () => {
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const { program, argv } = execStart(unit);
    expect(`${program} ${argv.join(" ")}`).not.toMatch(/secret|token|apns|\.p8|credential/i);
  });

  test("the sandbox and the restart policy the runbook promises are in the unit", () => {
    const keys = serviceKeys(read(join(DEPLOY_DIR, "relay.service")));
    expect(keys.get("Service/User")).toBe("relay");
    expect(keys.get("Service/Group")).toBe("relay");
    expect(keys.get("Service/Restart")).toBe("always");
    expect(keys.get("Service/NoNewPrivileges")).toBe("yes");
    expect(keys.get("Service/ProtectSystem")).toBe("strict");
    expect(keys.get("Service/ProtectHome")).toBe("yes");
    expect(keys.get("Service/PrivateTmp")).toBe("yes");
    expect(keys.get("Service/MemoryMax")).toBe("512M");
    // The relay needs no capability at all: it binds loopback and writes nothing.
    expect(keys.get("Service/CapabilityBoundingSet")).toBe("");
    expect(keys.get("Install/WantedBy")).toContain("multi-user.target");
  });

  test("the start limit lives in [Unit], and no hardening blocks the JIT", () => {
    const keys = serviceKeys(read(join(DEPLOY_DIR, "relay.service")));
    // systemd ignores StartLimit* in [Service]: a crash loop would spin forever.
    expect(keys.get("Unit/StartLimitIntervalSec")).toBe("30s");
    expect(keys.get("Unit/StartLimitBurst")).toBe("5");
    expect(keys.has("Service/StartLimitBurst")).toBe(false);
    expect(keys.has("Service/StartLimitIntervalSec")).toBe(false);
    // Bun IS JavaScriptCore: it JITs, so it needs writable-then-executable
    // memory. Either of these makes the relay die on the host only, where CI
    // never runs the unit — the exact failure a deploy artefact must not ship.
    expect(keys.has("Service/MemoryDenyWriteExecute")).toBe(false);
    expect(keys.get("Service/SystemCallFilter") ?? "").not.toContain("@system-service");
  });
});

describe("R7 Caddyfile.relay — TLS in front, the port the unit binds behind", () => {
  test("the site forwards to the relay's bind address", () => {
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    expect(caddy).toContain("relay.tentacle.so {");
    expect(caddy).toContain(`reverse_proxy ${DEFAULT_RELAY_HOST}:${DEFAULT_RELAY_PORT}`);
  });

  test("a stream outlives a Caddy reload (stream_close_delay)", () => {
    // Without it a config reload closes every live relay socket, i.e. every
    // phone session, which the daemon then has to see re-established (F1/F2).
    expect(read(join(DEPLOY_DIR, "Caddyfile.relay"))).toContain("stream_close_delay 5m");
  });
});

describe("R7 deploy/build.ts — the compile script", () => {
  test("it compiles the relay's own entrypoint to dist/tentacle-relay", () => {
    const entrypoint = relayEntrypoint(REPO_ROOT);
    expect(entrypoint).toBe(join(REPO_ROOT, "apps", "relay", "src", "main.ts"));
    expect(existsSync(entrypoint)).toBe(true);
    expect(RELAY_BINARY_NAME).toBe("tentacle-relay");
    expect(relayOutfile(REPO_ROOT)).toBe(join(REPO_ROOT, "dist", "tentacle-relay"));
  });

  test("linux-x64 by default (the deploy host), TARGET overrides, a non-Bun triple is refused", () => {
    const byDefault = relayBuildTarget({});
    expect(byDefault).toEqual({ ok: true, target: "bun-linux-x64" });
    expect(relayBuildTarget({ TARGET: "bun-linux-arm64" })).toEqual({
      ok: true,
      target: "bun-linux-arm64",
    });
    // `bun build --compile` takes Bun triples only; a bare "linux-x64" would
    // silently produce a host binary (a macOS executable on a dev machine).
    const refused = relayBuildTarget({ TARGET: "linux-x64" });
    expect(refused.ok).toBe(false);
  });
});

describe("R7 docs/ops/relay-deploy.md — the runbook", () => {
  const runbook = (): string => read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"));

  test("its smoke test is the route the relay actually serves", () => {
    expect(relayRoute("/healthz")).toEqual({ kind: "health" });
    expect(runbook()).toContain("/healthz");
  });

  test("it carries a rollback, and the log command an operator needs", () => {
    const text = runbook();
    expect(text).toMatch(/^##+ .*Rollback/m);
    expect(text).toContain("systemctl");
    expect(text).toContain("journalctl");
  });

  test("it says deploy is the owner's step, never an executor's", () => {
    expect(runbook()).toMatch(/owner/i);
  });
});
