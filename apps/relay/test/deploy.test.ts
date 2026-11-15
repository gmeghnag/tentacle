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
import {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  type RELAY_LIMIT_FLAGS,
  relayRoute,
} from "../src/server.ts";

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

/**
 * The unit's logical lines: comments dropped, `\`-continuations joined
 * (systemd.service(5)). Shared by the readers below so none of them can drift
 * on how a continued `ExecStart` is read — the place an operator WILL use it
 * (an override with more flags), and reading that wrong would report a flag
 * mismatch that is not there.
 */
function unitLines(unit: string): string[] {
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
  return joined;
}

/** The `[Service]` section's `key=value` pairs, last one winning (systemd's rule). */
function serviceKeys(unit: string): Map<string, string> {
  const keys = new Map<string, string>();
  let section = "";
  for (const raw of unitLines(unit)) {
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

/**
 * systemd's OWN expansion rule for `ExecStart` (systemd.service(5)): `${VAR}` is
 * replaced by the variable's value "always resulting in exactly a single
 * argument", and "Variables whose value is not known at expansion time are
 * treated as empty strings". So an unset `${VAR}` standing as its own word is a
 * real, EMPTY argument — not an omitted one. That is the rule P10's review broke
 * the unit with, so the guard applies it rather than trusting the eye.
 */
function expandExec(value: string, env: Record<string, string | undefined>): string[] {
  return execArgs(value).map((token) =>
    token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => env[name] ?? ""),
  );
}

/** `/opt/tentacle-relay/tentacle-relay --host … --port …` → `{ program, argv }`. */
function execStart(unit: string): { program: string; argv: string[] } {
  const tokens = execArgs(serviceKeys(unit).get("Service/ExecStart") ?? "");
  return { program: tokens[0] ?? "", argv: tokens.slice(1) };
}

/** The `ExecStart` value exactly as systemd sees it, `${VAR}`s still unexpanded. */
function rawExecStart(unit: string): string {
  return serviceKeys(unit).get("Service/ExecStart") ?? "";
}

/**
 * systemd's rule for REPEATED `ExecStart=` assignments, in file order: an empty
 * value clears the list and a non-empty one appends to it, and a non-`oneshot`
 * service may end up with at most ONE entry or systemd refuses the whole unit
 * ("more than one ExecStart= setting, which is only allowed for Type=oneshot
 * services. Refusing." — systemd.service(5)).
 *
 * `serviceKeys` cannot answer this: it is last-wins, so a drop-in that REPLACES
 * the base unit's command line and one that ADDS a second one read identically.
 * That gap is exactly review round 2's finding 1, so it gets its own reader.
 */
function execStarts(unit: string): string[] {
  const live: string[] = [];
  let section = "";
  for (const raw of unitLines(unit)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== "Service" || !line.startsWith("ExecStart=")) {
      continue;
    }
    const value = line.slice("ExecStart=".length);
    if (value.trim() === "") {
      live.length = 0;
      continue;
    }
    live.push(value);
  }
  return live;
}

/** The `Type=` systemd will see — a later section/assignment wins, as in systemd. */
function unitType(unit: string): string {
  return serviceKeys(unit).get("Service/Type") ?? "simple";
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
    // Anchored on the newline so it hits the LIVE line, never a commented-out
    // example above it (this test's second draft replaced the comment, and went
    // red on a correct unit). The live line is now the FIRST line of a two-line,
    // `\`-continued ExecStart, so the anchor is its `--port 4100 \` tail.
    const continued = real.replace(
      "\nExecStart=/opt/tentacle-relay/tentacle-relay --host 127.0.0.1 --port 4100 \\",
      "\nExecStart=/opt/tentacle-relay/tentacle-relay --host 127.0.0.1 \\\n    --port 4321 \\",
    );
    expect(continued).toContain("--host 127.0.0.1 \\\n    --port 4321 \\\n");
    // The real unit's OWN continuation carries the three limit flags: a reader
    // that dropped it would lose every one of them, which is exactly the false
    // green this guard exists for (and the assertion the limit test stands on).
    expect(serviceKeys(real).get("Service/ExecStart") ?? "").toContain(
      "--max-hellos-per-minute 600",
    );
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

  test("the live ExecStart sizes the three PER-IP limits for ONE shared key", () => {
    // Behind Caddy (`deploy/Caddyfile.relay`) the relay's peer is always
    // 127.0.0.1 — `server.ts` keys its limiter on Bun's `requestIP`, the DIRECT
    // peer — so all three PER-IP limits collapse into ONE bucket for the whole
    // world. Shipped at their per-client defaults the unit would cap every phone
    // on the relay at 16 sockets and every daemon on the planet at 10
    // `hello`s/min (a 200-daemon re-registration after a restart refused for
    // ~20 minutes, and one client able to lock out every phone). A shared bucket
    // is sized for the fleet, so its value must exceed one client's default.
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const parsed = parseRelayArgs(execStart(unit).argv);
    if (!parsed.ok) {
      throw new Error(`relay.service's ExecStart is not argv main.ts accepts: ${parsed.error}`);
    }
    const perClientDefault: Record<string, number> = {
      "max-dials-per-minute": RELAY_LIMITS.dialsPerMinutePerIp,
      "max-streams-per-ip": RELAY_LIMITS.concurrentPerIp,
      "max-hellos-per-minute": RELAY_LIMITS.hellosPerMinutePerIp,
    };
    for (const [flag, perClient] of Object.entries(perClientDefault)) {
      const value = parsed.args.limits[flag as (typeof RELAY_LIMIT_FLAGS)[number]];
      // `undefined` is the bug this test exists for: the flag was omitted from
      // the live ExecStart and the per-client default applied silently. Stated
      // so a red names the flag rather than only "0 > 30".
      if (value === undefined) {
        throw new Error(
          `ExecStart does not pass --${flag}: behind Caddy it falls back to the per-client default of ${perClient}, i.e. one global limit`,
        );
      }
      expect(value).toBeGreaterThan(perClient);
    }
  });

  test("the Caddyfile's account of the limits is true of the unit", () => {
    // The site block's comment says `relay.service` carries the one-shared-key
    // sizes instead. That sentence was false (the values were a commented-out
    // example), which is the half of the finding a reader is misled by: an
    // operator reading the site block concluded the deploy was safe.
    const caddy = read(join(DEPLOY_DIR, "Caddyfile.relay"));
    expect(caddy).toContain("relay.service");
    const argv = execStart(read(join(DEPLOY_DIR, "relay.service"))).argv;
    for (const flag of [
      "--max-dials-per-minute",
      "--max-streams-per-ip",
      "--max-hellos-per-minute",
    ]) {
      // Named in the site block AND live in the unit: neither alone is the claim.
      expect(caddy).toContain(flag.slice(2));
      expect(argv).toContain(flag);
    }
  });

  test("no secret MATERIAL on the command line (argv is world-readable in ps)", () => {
    // NARROWED by P10 (docs/feat/mobile-push.md P10). The guard used to forbid
    // the substring `apns`, which contradicts the only way `main.ts` can be told
    // where the key is: `--apns-key-file`. What leaks a secret is the KEY, not
    // the FLAG or the PATH — the path is `${CREDENTIALS_DIRECTORY}/apns-key`, a
    // read-only copy systemd makes for this unit alone. So the assertion is now
    // what it always meant: no key material, and no literal key path baked into
    // the repository's unit.
    const unit = read(join(DEPLOY_DIR, "relay.service"));
    const { program, argv } = execStart(unit);
    const line = `${program} ${argv.join(" ")}`;
    expect(line).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    // A `.p8` PATH would make the deploy host's layout part of the repo, and a
    // literal token/secret would be one. The credential path is none of these.
    expect(line).not.toMatch(/\.p8\b/);
    expect(line).not.toMatch(/secret|token=/i);
    // The key's CONTENT can never appear: it is a path, and the file it names is
    // 0400 root, so the relay user cannot even read it directly.
    expect(line).not.toContain("apns-key-id=");
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

  test("a Caddy reload drops live streams after a 5m GRACE — and nothing says otherwise", () => {
    // Without the delay a config reload closes every live relay socket at once,
    // i.e. every phone session, which the daemon then has to see re-established
    // (F1/F2). WITH it the cut is only DELAYED: the relay sends pings
    // (`relaySocketOptions` sets `sendPings: true`, `server.ts:121-124`), so a
    // live phone session and every daemon control socket never idle out — Caddy
    // force-closes them 5 minutes after the reload. The first draft of the site
    // block read "5m > the relay's 60 s idle timeout, so a stream ends on its own
    // before the delay can ever fire": false, and the runbook and this test
    // repeated it.
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

describe("P10 relay.service — push is a DROP-IN, so the base unit always boots", () => {
  // docs/feat/mobile-push.md P10 / C2: the relay stops being secretless. The
  // `.p8` is the ONE secret on that host, so the unit has to (a) receive it
  // through systemd rather than a file the relay user could read directly, and
  // (b) hand the binary only the read-only copy's PATH.
  //
  // Review round 1, finding 1 (HIGH): it must ALSO be true that the ordinary
  // relay — installed before Apple's key exists (D2), or with the key removed
  // for a rollback — still starts, because `Restart=always` turns an ExecStart
  // the binary refuses into a crash loop that takes every phone off the relay.
  // So the wiring lives in `relay.service.d/apns.conf`, installed only WITH the
  // key; the base unit carries none of it and boots with push off (F4).
  //
  // What these tests CANNOT prove: that `systemd-analyze verify` accepts the
  // files, that the credential directory exists at boot, or that Apple accepts
  // the token. Those are the runbook's checks on the host (§10), run by the
  // owner at deploy time. The expansion rule below IS pinned, though, because
  // it is the rule that broke the unit.
  const unit = (): string => read(join(DEPLOY_DIR, "relay.service"));
  const dropIn = (): string => read(join(DEPLOY_DIR, "relay.service.d", "apns.conf"));

  test("the shipped base unit parses with every environment variable EMPTY", () => {
    // systemd's rule (systemd.service(5)): an unknown `${VAR}` is "treated as
    // empty", and `${VAR}` standing as its own word is always exactly ONE
    // argument — so the review's finding was an EMPTY argument reaching
    // `parseRelayArgs`, which refused it and exited 1 on every boot.
    //
    // The assertion is the PARSE, not a scan for `${`: a unit that expanded a
    // variable would be red here for the reason the owner cares about (a relay
    // that does not start), and the `\$\{`-free shape is pinned separately below.
    const expanded = expandExec(rawExecStart(unit()), {});
    const parsed = parseRelayArgs(expanded.slice(1));
    if (!parsed.ok) {
      throw new Error(
        `the base relay.service does not start without Apple's key, which is F4 broken: ${parsed.error}`,
      );
    }
    expect(parsed.args.apns).toEqual({});
    expect(expanded.slice(1)).toEqual(execStart(unit()).argv);
  });

  test("the base unit carries no push wiring at all (that is the drop-in's job)", () => {
    // All three would make the base unit depend on a file that may not exist:
    // the four flags (empty args), the `EnvironmentFile` (needs apns.conf) and
    // `LoadCredential` with an ABSOLUTE path (systemd refuses to start the unit
    // when that file is missing — 243/CREDENTIALS). "Optional, and off by
    // default" is only true if the base unit names none of them. The variable
    // scan belongs HERE, next to the wiring it is about.
    const text = unit();
    const keys = serviceKeys(text);
    expect(rawExecStart(text)).not.toMatch(/\$\{/);
    expect(rawExecStart(text)).not.toMatch(/--apns-/);
    expect(keys.has("Service/LoadCredential")).toBe(false);
    expect(keys.has("Service/EnvironmentFile")).toBe(false);
  });

  test("the drop-in declares the credential, from an absolute path", () => {
    // `LoadCredential=ID:PATH` with an ABSOLUTE path is the only form that names
    // a file the operator installs (systemd.exec(5): an absolute path is opened
    // and copied to a read-only per-unit directory; a bare ID would be looked up
    // in a credstore this deploy does not use). A missing file here fails the
    // DROP-IN's unit start — which is correct: it is installed only with the key.
    const declared = /^LoadCredential=([A-Za-z0-9_.-]+):(\/[^\s:]+)$/m.exec(dropIn());
    if (declared === null) {
      throw new Error(
        "the drop-in declares no `LoadCredential=<id>:</absolute/path>`: the .p8 would have to sit somewhere the relay user can read",
      );
    }
    expect(declared[1]).toBe("apns-key");
    expect(declared[2]?.startsWith("/")).toBe(true);
  });

  test("the binary is told the credential's PATH, never its content", () => {
    const { program, argv } = execStart(dropIn());
    const keyFileAt = argv.indexOf("--apns-key-file");
    if (keyFileAt === -1) {
      throw new Error(
        "the drop-in passes no --apns-key-file: the relay starts with push off (F4), so P10's banner could never be produced in production",
      );
    }
    // `${CREDENTIALS_DIRECTORY}` is expanded by systemd for the unit's own
    // ExecStart (systemd.exec(5)), so the unit names no host path at all.
    expect(argv[keyFileAt + 1]).toBe("${CREDENTIALS_DIRECTORY}/apns-key");
    expect(program).toBe(`/opt/tentacle-relay/${RELAY_BINARY_NAME}`);
  });

  test("every --apns-* value is config the drop-in carries, and main.ts parses it", () => {
    const parsed = parseRelayArgs(execStart(dropIn()).argv);
    // A flag the binary refuses is an ExecStart that exits 1 on every boot — the
    // failure this whole describe exists to make impossible.
    if (!parsed.ok) {
      throw new Error(`the drop-in's ExecStart is not argv main.ts accepts: ${parsed.error}`);
    }
    // All four or none: `readApnsKeySource` refuses a partial set, so a drop-in
    // that shipped three would announce no `push` feature and never deliver.
    expect(parsed.args.apns.keyFile).toBe("${CREDENTIALS_DIRECTORY}/apns-key");
    expect(parsed.args.apns.keyId).not.toBeUndefined();
    expect(parsed.args.apns.teamId).not.toBeUndefined();
    expect(parsed.args.apns.topic).toBe("so.tentacle.app");
  });

  test("a HALF-installed drop-in still boots: empty values are push off", () => {
    // The failure mode one level down from the review's finding, and the reason
    // the binary was fixed too: the drop-in installed while `apns.conf` is
    // missing hands the relay two EMPTY arguments. Refusing them would be a
    // crash loop again, this time from an artefact the runbook said was safe to
    // roll back. `parseRelayArgs` drops a blank `--apns-*` value instead (the
    // *missing argument* case is still a refusal), so what is left is a partial
    // set, which `apnsSetupOf` turns into one `push off:` line and a serving
    // relay.
    const expanded = expandExec(rawExecStart(dropIn()), {
      CREDENTIALS_DIRECTORY: "/run/credentials/relay.service",
    });
    const parsed = parseRelayArgs(expanded.slice(1));
    if (!parsed.ok) {
      throw new Error(
        `a drop-in without apns.conf must still boot (push off), not crash-loop: ${parsed.error}`,
      );
    }
    expect(parsed.args.apns.keyId).toBeUndefined();
    expect(parsed.args.apns.teamId).toBeUndefined();
    // Two of the four are real, so this is the partial set — not "no key at all".
    expect(parsed.args.apns.keyFile).toBe("/run/credentials/relay.service/apns-key");
    expect(parsed.args.apns.topic).toBe("so.tentacle.app");
  });

  test("the drop-in's ExecStart is the base unit's, plus exactly the four flags", () => {
    // A drop-in has to REPEAT the whole command line (`ExecStart=` empty resets
    // the list, systemd.service(5)), so the limits move with it and could drift
    // apart from the base unit. Strip the four `--apns-*` pairs and the two must
    // be identical — otherwise installing push silently re-sizes the fleet's
    // limits back to the per-client defaults.
    const base = execStart(unit());
    const withPush = execStart(dropIn());
    const stripped: string[] = [];
    for (let i = 0; i < withPush.argv.length; i += 1) {
      const token = withPush.argv[i] ?? "";
      if (token.startsWith("--apns-")) {
        i += 1;
        continue;
      }
      stripped.push(token);
    }
    expect(withPush.program).toBe(base.program);
    expect(stripped).toEqual(base.argv);
    // Positive control: the eight tokens really were there to strip.
    expect(withPush.argv.length - base.argv.length).toBe(8);
  });

  test("the drop-in RESETS ExecStart before restating it, so the unit still starts", () => {
    // Review round 2, finding 1 (HIGH): a drop-in does not replace the base
    // unit's `ExecStart=`, it is APPENDED to it. `Type=simple` (relay.service:28)
    // allows exactly one entry, so a drop-in holding only the full line hands
    // systemd TWO and it refuses the unit ("more than one ExecStart= setting,
    // which is only allowed for Type=oneshot services. Refusing.") — the install
    // in §6.1 would take every phone off the relay. The empty `ExecStart=` on its
    // own line is the documented way to clear the inherited list first.
    //
    // Read as systemd reads it: base unit first, the drop-in's assignments on
    // top, in file order. `serviceKeys` cannot see this (last-wins), which is how
    // the reviewed tree passed "the drop-in's ExecStart is the base unit's…".
    expect(unitType(unit())).toBe("simple");
    const dropInLines = execStarts(dropIn());
    // The reset is IN the drop-in: its first `ExecStart=` assignment is empty.
    const firstExec = dropIn()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .find((line) => line.trimStart().startsWith("ExecStart="));
    expect(firstExec?.trim()).toBe("ExecStart=");
    // …and the overlay therefore ends with exactly one live command line.
    const overlay = execStarts(`${unit()}\n${dropIn()}`);
    if (overlay.length !== 1) {
      throw new Error(
        `installing the drop-in leaves ${overlay.length} ExecStart= assignments on a Type=simple unit: systemd refuses it, so push-ON would cost every phone the relay`,
      );
    }
    expect(dropInLines.length).toBe(1);
    expect(dropInLines[0]?.trim().startsWith("/opt/tentacle-relay/")).toBe(true);
  });

  test("the sandbox still lets the unit read its own credential directory", () => {
    // `ProtectSystem=strict` makes the whole filesystem read-only, and the
    // credential dir lives under /run/credentials (a tmpfs systemd mounts for the
    // unit). It must stay readable — `ProtectSystem=strict` does not block reads,
    // so the check is that nothing narrower (a `ReadOnlyPaths`/`InaccessiblePaths`
    // covering /run) would make the key unreadable.
    const keys = serviceKeys(unit());
    expect(keys.get("Service/ProtectSystem")).toBe("strict");
    expect(keys.get("Service/InaccessiblePaths")).toBeUndefined();
    expect(keys.get("Service/ProtectHome")).toBe("yes");
  });

  test("the runbook documents the credential, its mode, the flags and rotation", () => {
    const text = read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"));
    // P10's half of R7:
    //  - WHERE the key goes and with what mode (0400 root, unreadable by `relay`)
    //  - the four flags, by name
    //  - rotation, and rollback for a bad key
    expect(text).toContain("LoadCredential");
    expect(text).toMatch(/0400/);
    expect(text).toContain("--apns-key-file");
    expect(text).toContain("--apns-key-id");
    expect(text).toContain("--apns-team-id");
    expect(text).toContain("--apns-topic");
    // A rotation section, and the `push off:` line an operator greps for.
    expect(text).toMatch(/^##+ .*APNs/m);
    expect(text).toContain("push off:");
    // It must NOT claim the relay is secretless any more (task 15's text did).
    expect(text).not.toMatch(/relay holds no secret today/i);
  });

  test("the runbook names the drop-in, and reverts it together with the key", () => {
    // Review round 1, finding 1's DOC half: the unit's wiring moved, so the
    // operator must be told where it went — and, above all, that removing the
    // key means removing the drop-in in the SAME step. A rollback that deletes
    // `/etc/tentacle-relay/apns-key.p8` and leaves `LoadCredential=` behind is
    // the crash loop the fix exists for, and only this text stands between an
    // operator and it.
    const text = read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"));
    expect(text).toContain("relay.service.d/apns.conf");
    // The rollback block removes both, from one command.
    const revert =
      /rm -f \/etc\/systemd\/system\/relay\.service\.d\/apns\.conf[\s\S]{0,200}apns-key\.p8/;
    expect(text).toMatch(revert);
    // And it says WHY, naming the exit code an operator would otherwise meet.
    expect(text).toContain("243");
    // The old claim ("nothing in the unit has to be edited") is no longer the
    // whole story: the drop-in is an installed artefact, not an edit.
    expect(text).toMatch(/drop-in/i);
  });

  test("the runbook gives the KEY-LESS drop-in one fate: 243/CREDENTIALS, not 'fine'", () => {
    // Review round 2, finding 2 (MEDIUM): §6.3 said a drop-in left behind with
    // the key gone costs 243/CREDENTIALS (l.359-361) and then told the operator
    // that same case "is also fine" (l.362-364). The blank-value leniency that
    // sentence leaned on covers a MISSING `apns.conf` — the two IDs — and never
    // a missing `.p8`, which is `LoadCredential=`, i.e. a start failure before
    // the binary runs at all. An operator who trusts it removes the key, keeps
    // the drop-in, and meets a crash loop. One fate, stated once.
    const text = read(join(REPO_ROOT, "docs", "ops", "relay-deploy.md"));
    expect(text).not.toMatch(/with the key\s+gone but the drop-in present,[^.]*?\bfine\b/is);
    // The true statement is still there, in the words an operator greps for.
    expect(text).toMatch(/drop-in left\s+behind[\s\S]{0,200}243\/CREDENTIALS/);
    // …and it names the two settings that make it fatal, so the reason is
    // checkable rather than a bare "do not do this".
    expect(text).toMatch(/LoadCredential/);
  });
});
