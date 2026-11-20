/**
 * The 9d dispatch seams: `cliMode` knows the two new words, `parseArgs` keeps a
 * REPEATED flag as a list, and `main` routes both commands without loading a
 * model (docs/feat/device-pairing.md 9d).
 *
 * The properties, each naming its mutation:
 * - `cliMode("pair")` / `("devices")` are their own modes (mutation: leave them
 *   out → the word is sent to the MODEL as a prompt, which is what today does);
 * - a repeated `--address` keeps every value (mutation: keep the last → a laptop
 *   with two addresses publishes one);
 * - a non-repeated flag still refuses a repeat (mutation: allow it everywhere →
 *   `--host a --host b` silently means `b`);
 * - `pair`/`devices` never run a key command (mutation: classify them `true` →
 *   a broken `apiKeyCommand` stops a revoke).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "@tentacle/agent";
import { claimPairing, findPairing, writeDaemonRecord } from "@tentacle/daemon";
import { ARGS, USAGE, cliMode, modeUsesModel, parseArgs } from "../src/flags.ts";
import { main } from "../src/index.ts";

const NO_TERMINAL = { stdin: false, stdout: false };
/** The var `configDirFromEnv` reads; a COMPUTED key, the only form `noDelete` allows (§6). */
const ENV_KEY = "TENTACLE_CONFIG_DIR";

describe("cliMode", () => {
  test("pair and devices are commands, not prompts (mutation: omit them)", () => {
    expect(cliMode(["pair"])).toBe("pair");
    expect(cliMode(["pair", "--address", "ws://h:1/e2e"])).toBe("pair");
    expect(cliMode(["devices"])).toBe("devices");
    expect(cliMode(["devices", "revoke", "iPhone"])).toBe("devices");
    expect(cliMode(["devices", "reset"])).toBe("devices");
    // Their neighbours stay what they were.
    expect(cliMode(["ps"])).toBe("ps");
    expect(cliMode(["pairing"])).toBe("prompt");
  });

  test("neither runs the user's key commands (mutation: classify them true)", () => {
    expect(modeUsesModel(cliMode(["pair"]))).toBe(false);
    expect(modeUsesModel(cliMode(["devices"]))).toBe(false);
  });

  test("both have a usage line", () => {
    expect(USAGE.pair).toContain("--address");
    expect(USAGE.pair).toContain("--name");
    expect(USAGE.devices).toContain("revoke");
    expect(USAGE.devices).toContain("reset");
  });
});

describe("--address is a list", () => {
  const parse = (args: readonly string[]) => parseArgs(args, ARGS.pair);

  test("every value is kept, in the order given (mutation: keep the last)", () => {
    const parsed = parse(["--address", "ws://a.test/e2e", "--address=ws://b.test/e2e"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.repeats?.get("address") : []).toEqual([
      "ws://a.test/e2e",
      "ws://b.test/e2e",
    ]);
    // And it is NOT in `flags`: one value per name there would be a second truth.
    expect(parsed.ok ? parsed.flags.has("address") : true).toBe(false);
  });

  test("one --address is still a list", () => {
    const parsed = parse(["--address", "ws://a.test/e2e"]);
    expect(parsed.ok ? parsed.repeats?.get("address") : []).toEqual(["ws://a.test/e2e"]);
  });

  test("none given is an empty map, not undefined entries", () => {
    const parsed = parse(["--name", "laptop"]);
    expect(parsed.ok ? (parsed.repeats?.get("address") ?? []) : ["x"]).toEqual([]);
    expect(parsed.ok ? parsed.flags.get("name") : "").toBe("laptop");
  });

  test("a NON-repeated flag still refuses a repeat (mutation: allow it everywhere)", () => {
    const parsed = parse(["--name", "a", "--name", "b"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toBe("--name given more than once");
  });

  test("a repeated value flag still needs a value", () => {
    const parsed = parse(["--address"]);
    expect(parsed.ok ? "" : parsed.error).toBe("--address needs a value");
  });

  test("a stray word is refused (pair takes no positionals)", () => {
    const parsed = parse(["phone"]);
    expect(parsed.ok ? "" : parsed.error).toBe('unexpected argument "phone"');
  });
});

describe("devices' words", () => {
  test("the verb and its subject, at most two", () => {
    const parsed = parseArgs(["revoke", "iPhone"], ARGS.devices);
    expect(parsed.ok ? parsed.positional : []).toEqual(["revoke", "iPhone"]);
    expect(parseArgs(["a", "b", "c"], ARGS.devices).ok).toBe(false);
  });

  test("--yes (and -y) is the reset confirmation", () => {
    const parsed = parseArgs(["reset", "--yes"], ARGS.devices);
    expect(parsed.ok ? parsed.bools.has("yes") : false).toBe(true);
    const short = parseArgs(["reset", "-y"], ARGS.devices);
    expect(short.ok ? short.bools.has("yes") : false).toBe(true);
  });
});

describe("main dispatches them before any config load", () => {
  test("`tentacle pair` with no serve in the folder refuses with the hint, not a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const out: string[] = [];
      const err: string[] = [];
      // A config dir with no daemon record: no serve runs in the folder
      // (docs/feat/mobile-projects.md §5, Owner Q6).
      const code = await main(["bun", "cli", "pair", "--project", dir], {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("No `tentacle serve` is running in");
      // A prompt would have tried to answer; nothing reached STDOUT.
      expect(out).toEqual([]);
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`tentacle devices` on a fresh config dir lists nothing and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devices-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["bun", "cli", "devices"], {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
      expect(err.join("")).toContain("tentacle pair");
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`tentacle devices revoke` with no word is a usage error, not a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devices-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const err: string[] = [];
      const code = await main(["bun", "cli", "devices", "revoke"], {
        out: () => {},
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("missing argument");
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pair through main with no injected interfaces (review round 1, finding 1)", () => {
  test("a wildcard serve record yields the machine's own addresses", async () => {
    // The production path: `main` passes NO `interfaces`, so whatever
    // `pairAddressesOf` defaults to is what a user gets. A `0.0.0.0` bind is the
    // configuration REACHABLE_HINT recommends, so defaulting to `[]` made the
    // CLI refuse the very setup it tells people to run (mutation: default
    // `interfaces` to `[]` → this exits 1 with "no daemon this phone can
    // reach").
    const v4 = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry?.address ?? "");
    if (v4.length === 0) {
      return; // nothing to expand on this machine (see pair-addresses.test.ts)
    }
    const dir = mkdtempSync(join(tmpdir(), "pair-dispatch-wildcard-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const written = writeDaemonRecord(dir, {
        pid: process.pid,
        host: "0.0.0.0",
        port: 7777,
        tls: false,
        cwd: dir,
        startedAt: 1,
      });
      expect(written.ok).toBe(true);
      const out: string[] = [];
      // A claim, then "n": the run must get far enough to PRINT a payload, and
      // must not wait out the 5-minute window (there is no `sleep` seam here —
      // this is `main`). The claim is written where a real daemon writes it.
      let claimed = false;
      const code = await main(["bun", "cli", "pair", "--project", dir], {
        out: (text) => {
          out.push(text);
          const pairingCode = /[?&]c=([A-Z0-9]{10})/.exec(text)?.[1];
          if (pairingCode === undefined || claimed) return;
          const session = findPairing(dir, { project: projectKey(dir), code: pairingCode });
          if (session === undefined) return;
          claimed = claimPairing(dir, {
            project: projectKey(dir),
            sid: session.sid,
            deviceKey: new Uint8Array(32).fill(4),
            name: "phone",
          }).ok;
        },
        err: () => {},
        ask: async () => "n",
        terminal: NO_TERMINAL,
      });
      const printed = decodeURIComponent(out.join(""));
      for (const address of v4) {
        expect(printed).toContain(`ws://${address}:7777/e2e`);
      }
      // Claimed, so the run really reached the prompt and declined it.
      expect(claimed).toBe(true);
      expect(code).toBe(1);
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pair cleans up the process it ran in", () => {
  test("a returned pair leaves NO signal listener behind", async () => {
    // `pair` installs `exit`/SIGINT/SIGTERM hooks so an interrupted run takes
    // its window with it (F2). They must be DETACHED when it returns: a
    // leftover SIGINT handler runs a cleanup for a window that is already gone
    // and then re-raises the signal, killing the host process. This was found
    // the hard way — the full suite died with exit 130 (SIGINT) once a test
    // drove `main` past the window and a later test emitted SIGINT in-process.
    // (Mutation: drop `dispose?.()` in pair.ts → this test, and the whole suite,
    // fail.)
    const events = ["SIGINT", "SIGTERM", "exit"] as const;
    const before = events.map((event) => process.listenerCount(event));
    const dir = mkdtempSync(join(tmpdir(), "pair-dispatch-cleanup-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      let claimed = false;
      // The folder's live serve (loopback, so it adds no address of its own).
      writeDaemonRecord(dir, {
        pid: process.pid,
        host: "127.0.0.1",
        port: 7778,
        tls: false,
        cwd: dir,
        startedAt: 1,
      });
      // An --address gives it something to publish, so the window really opens.
      await main(["bun", "cli", "pair", "--project", dir, "--address", "ws://10.0.0.1:1/e2e"], {
        out: (text) => {
          if (claimed) return;
          const pairingCode = /[?&]c=([A-Z0-9]{10})/.exec(text)?.[1];
          if (pairingCode === undefined) return;
          const session = findPairing(dir, { project: projectKey(dir), code: pairingCode });
          if (session === undefined) return;
          claimed = claimPairing(dir, {
            project: projectKey(dir),
            sid: session.sid,
            deviceKey: new Uint8Array(32).fill(5),
            name: "phone",
          }).ok;
        },
        err: () => {},
        ask: async () => "n",
        terminal: NO_TERMINAL,
      });
      expect(claimed).toBe(true);
      expect(events.map((event) => process.listenerCount(event))).toEqual([...before]);
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
