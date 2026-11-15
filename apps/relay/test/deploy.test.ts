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
import { RELAY_LIMITS } from "../src/relay-core.ts";
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, relayRoute } from "../src/server.ts";

/** A well-formed (frozen 22 base64url chars) relay id, for the route tables. */
const ID = "fgkrQr2vTa2JTEe75Kl66v";

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

/** A Caddyfile without its comments: the directives, which is what Caddy reads. */
function caddyDirectives(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

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
    // there — a false RED on a correct artefact is as bad as a false GREEN. The
    // fixture is SYNTHETIC on purpose: the live ExecStart is now one line (it
    // carries `--trust-proxy` and no limit override), so binding this guard to
    // the live text would test the unit, not the reader.
    const continued = [
      "[Service]",
      "ExecStart=/opt/tentacle-relay/tentacle-relay --host 127.0.0.1 \\",
      "    --port 4321 \\",
      "    --trust-proxy",
    ].join("\n");
    // The continued line carries a NON-default port: with the default there, a
    // dropped continuation would read as "no --port" and pass by falling back to
    // the same value (this test's first draft did exactly that).
    expect(serviceKeys(continued).get("Service/ExecStart") ?? "").toContain("--trust-proxy");
    const parsed = parseRelayArgs(execStart(continued).argv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.port).toBe(4321);
      expect(parsed.args.trustProxy).toBe(true);
    }
    // And the LIVE unit has exactly one uncommented ExecStart: a second one would
    // be an override systemd silently prefers, and a commented example is not it.
    const live = read(join(DEPLOY_DIR, "relay.service"))
      .split("\n")
      .filter((line) => line.startsWith("ExecStart="));
    expect(live).toHaveLength(1);
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

  test("the live ExecStart requests --trust-proxy and overrides NO per-IP limit", () => {
    // The unit used to carry FLEET sizes for the three per-IP limits because
    // every client collapsed into one 127.0.0.1 bucket. `--trust-proxy` is what
    // makes the key the real client (H3), so those overrides must be GONE: left
    // behind they would hand every client 6000 dials/min and 2000 sockets — the
    // per-client limits would stop existing. Red before this change (no flag, and
    // all three overrides present).
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const parsed = parseRelayArgs(execStart(unit).argv);
    if (!parsed.ok) {
      throw new Error(`relay.service's ExecStart is not argv main.ts accepts: ${parsed.error}`);
    }
    expect(parsed.args.trustProxy).toBe(true);
    // No per-IP limit is overridden: the core's per-client defaults apply.
    for (const flag of [
      "max-dials-per-minute",
      "max-streams-per-ip",
      "max-hellos-per-minute",
      "max-ids-per-ip",
      "--max-ids",
    ]) {
      const name = flag.replace(/^--/, "");
      expect(parsed.args.limits).not.toHaveProperty(name);
    }
    // And the values that DO apply are the per-client defaults, not fleet sizes.
    expect(RELAY_LIMITS.dialsPerMinutePerIp).toBe(30);
    expect(RELAY_LIMITS.concurrentPerIp).toBe(16);
    expect(RELAY_LIMITS.hellosPerMinutePerIp).toBe(10);
  });

  test("the Caddyfile explains --trust-proxy instead of the old one-shared-key sizes", () => {
    // The site block used to say the unit carries fleet sizes BECAUSE XFF is not
    // read. Both halves are now false, and a comment that says so is what an
    // operator acts on: it must name the flag and the header it reads.
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    expect(caddy).toContain("--trust-proxy");
    expect(caddy).toContain("X-Forwarded-For");
    expect(caddy).not.toMatch(/Nor does the relay read X-Forwarded-For/i);
    // The old fleet sizes must not linger as advice anywhere in the site block.
    expect(caddyDirectives(caddy)).not.toContain("--max-streams-per-ip");
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

  test("metadata hygiene: HSTS, no Server banner, and XFF replaced (L1, L2, H3)", () => {
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    const directives = caddyDirectives(caddy);
    expect(directives).toMatch(/Strict-Transport-Security "max-age=31536000"/);
    // No includeSubDomains / preload: this box serves one name, and the owner
    // must stay able to move it.
    expect(directives).not.toContain("includeSubDomains");
    expect(directives).not.toContain("preload");
    // `-Server` (a deferred removal, so the upstream cannot re-add it).
    expect(directives).toMatch(/^\s*-Server\s*$/m);
    // The header the relay reads is the one Caddy is told to send.
    expect(directives).toContain("header_up X-Forwarded-For {remote_host}");
    expect(directives).toContain("stream_close_delay 5m");
  });

  test("the Caddy route regex matches EXACTLY what `relayRoute` serves", () => {
    // Caddy 404s unknown paths before the proxy (L2), so its regex is a second
    // routing table — and a drift from `server.ts`'s would either expose a path
    // the relay never meant to serve or 404 a route the app dials. The phone
    // shape is frozen (an installed app dials it), which makes this the pin.
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    const match = /path_regexp (\S+)$/m.exec(caddy);
    if (match?.[1] === undefined) {
      throw new Error("Caddyfile.relay has no `path_regexp` route guard");
    }
    const regex = new RegExp(match[1]);
    const paths = [
      "/healthz",
      "/v1/daemon",
      "/v1/accept",
      `/d/${ID}/e2e`,
      "/",
      "/.env",
      "/d/x/e2e",
      `/d/${ID}/e2e/x`,
      `/d/${ID.slice(0, 21)}/e2e`,
      "/v1/daemon/",
      "/v1/daemon/x",
      "/healthz/x",
      "/v1/accept/",
      "/D/AAAAAAAAAAAAAAAAAAAAAA/e2e",
    ];
    for (const path of paths) {
      expect({ path, matched: regex.test(path) }).toEqual({
        path,
        matched: relayRoute(path).kind !== "notfound",
      });
    }
    // Mutation guard: the four real routes are routable (a regex that matched
    // nothing would satisfy "⇔ notfound" only if relayRoute agreed, so state it).
    for (const path of ["/healthz", "/v1/daemon", "/v1/accept", `/d/${ID}/e2e`]) {
      expect(regex.test(path)).toBe(true);
    }
  });

  test("a Caddy reload drops live streams after a 5m GRACE — and nothing says otherwise", () => {
    // Without the delay a config reload closes every live relay socket at once,
    // i.e. every phone session, which the daemon then has to see re-established
    // (F1/F2). WITH it the cut is only DELAYED: the relay sends pings
    // (`relaySocketOptions` sets `sendPings: true`, `server.ts`), so a live phone
    // session and every daemon control socket never idle out — Caddy force-closes
    // them 5 minutes after the reload. The first draft of the site block read
    // "5m > the relay's 60 s idle timeout, so a stream ends on its own before the
    // delay can ever fire": false, and the runbook and this test repeated it.
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    expect(caddy).toContain("stream_close_delay 5m");
    expect(caddy).not.toMatch(/before the delay can ever fire/i);
    expect(caddy).not.toMatch(/never (cuts|closes|drops)/i);
    // The grace, stated as a grace: its duration appears in both artefacts the
    // owner reads, so nobody plans a reload as a no-op.
    expect(caddy).toMatch(/5 min/);
    expect(read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"))).toMatch(/5 min/);
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

  test("the Caddy steps are the PODMAN ones this host actually runs (L3)", () => {
    // The runbook said `systemctl reload caddy` / `caddy validate`, but Caddy
    // runs in a podman container with a bind-mounted /etc/caddy on this host: an
    // operator following it would find no caddy unit and no `caddy` binary.
    const text = runbook();
    expect(text).toContain("podman exec caddy caddy reload");
    expect(text).toContain("podman exec caddy caddy validate");
    expect(text).not.toMatch(/^systemctl reload caddy$/m);
  });

  test("§9 no longer presents the ONE shared bucket as the current state (H3)", () => {
    // It was true, and the unit compensated with fleet sizes. Both are gone: the
    // limits are per client now, so a runbook still saying otherwise sends an
    // operator to raise a flag they no longer need.
    const text = runbook();
    expect(text).not.toMatch(/are ONE shared bucket/i);
    expect(text).toContain("--trust-proxy");
    // The residual the design accepts, stated where an operator looks: a local
    // process can forge the header, and a carrier NAT shares one bucket.
    expect(text).toMatch(/local|loopback/i);
    expect(text).toMatch(/NAT/i);
  });

  test("§5 lists the log lines the relay actually writes, prefixes only", () => {
    const text = runbook();
    for (const line of ["ready", "dial-open", "accept", "dial-refused", "pending-refused"]) {
      expect(text).toContain(line);
    }
    // The stream token is no longer logged at all (L1): a runbook that still
    // promises it would be describing a line that never appears.
    expect(text).not.toMatch(/dial-open <id> <stream>/);
  });

  test("it says a reload with live streams behind it is not harmless", () => {
    // §7's rollback said a reload behind a live relay "is harmless". With
    // `stream_close_delay` the harm is merely deferred 5 minutes.
    expect(runbook()).not.toMatch(/reload with a live relay behind it is\s+harmless/i);
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

  test("it does not promise a Caddy reload is a no-op for live sessions", () => {
    // The same false claim the site block made, in the two places an operator
    // acts on it: §4 ("load-bearing") and §9 ("what only a deploy proves").
    const text = runbook();
    expect(text).not.toMatch(/reload not cutting live streams/i);
    expect(text).not.toMatch(/before the delay can ever fire/i);
    // Instead: a reload is a staggered drop bounded by the 5-minute grace, and
    // the owner is told to schedule it (F1/F2 resync cover the drop).
    expect(text).toMatch(/staggered|grace/i);
    expect(text).toMatch(/5 min/);
  });
});
