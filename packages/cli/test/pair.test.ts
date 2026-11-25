/**
 * `tentacle pair`, driven with an injected clock, random and stdin
 * (docs/feat/device-pairing.md 9d; the plan's 9d test list).
 *
 * The seam that makes this a real test: `sleep` is where a live phone acts. It
 * reads the code out of the payload `pair` just printed and claims the window
 * exactly as 9c's daemon does (the key taken from the channel, never from the
 * claim's input) — so the poll, the prompt and the writes are the real ones and
 * only the waiting is fake.
 *
 * One property per block, each naming its mutation:
 * - the claim's name is printed SANITIZED (mutation: raw print → a `\x1b[2J` in
 *   a device name clears the user's terminal);
 * - `y` writes the registry entry, `N` writes none (mutation: always accept);
 * - the registry is written BEFORE the decision (F3; mutation: swap them — a
 *   `pair` that dies in between leaves a phone that is not paired). Pinned by
 *   the injected `writes` seam, which is the only place the two synchronuous
 *   writes can be observed in order (review round 1, finding 3);
 * - a `y` typed after the window closed pairs nobody (mutation: drop the expiry
 *   check at answer time → a device the phone was told `timeout` for), and the
 *   question is BOUNDED by the window (mutation: await `ask` → hangs);
 * - a wildcard `serve` record expands to this machine's real interfaces when
 *   none are injected, which is what `main` passes (mutation: default to `[]`
 *   → the CLI refuses the `serve` its own hint recommends);
 * - the window's files are gone when `pair` returns, on every path (mutation:
 *   close only on the success path);
 * - nothing reachable → exit 1 with the hint, and NO window opened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "@tentacle/agent";
import {
  addDevice,
  claimPairing,
  deviceIdOf,
  findPairing,
  loadOrCreateIdentity,
  readRegistry,
  writeDaemonRecord,
  writePairingDecision,
} from "@tentacle/daemon";
import { pairingSas } from "@tentacle/transport/noise";
import type { InterfaceEntry } from "../src/pair-addresses.ts";
import {
  PAIR_POLL_MS,
  type PairTimer,
  type PairWrites,
  newPairingCode,
  pairCommand,
  pairPrompt,
} from "../src/pair.ts";

/** The folder `pair` targets (`--project`), whose live `serve` record it pairs with. */
const PROJECT_DIR = "/elsewhere";
const PROJECT_KEY = projectKey(PROJECT_DIR);

const LAN: readonly InterfaceEntry[] = [
  { address: "192.168.1.8", family: "IPv4", internal: false },
];

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pair-cmd-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A live daemon record, so `pair` has an address to publish. */
const recordServing = (configDir: string, port = 4000): void => {
  const written = writeDaemonRecord(configDir, {
    pid: process.pid,
    host: "0.0.0.0",
    port,
    tls: false,
    cwd: PROJECT_DIR,
    startedAt: 1,
  });
  if (!written.ok) throw new Error(written.reason);
};

interface PairRun {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly addresses: readonly string[];
  readonly payload: string;
}

const payloadCode = (payload: string): string => /[?&]c=([A-Z0-9]{10})/.exec(payload)?.[1] ?? "";
const key32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/**
 * Run `pair`; `phone` is called once with the payload it printed, so it can
 * claim the window exactly as a real daemon would (and read the code).
 */
async function runPair(input: {
  readonly configDir: string;
  readonly answer?: string;
  readonly extraAddresses?: readonly string[];
  readonly ttlMs?: number;
  readonly name?: string;
  readonly writes?: PairWrites;
  /** A timer that replaces the default (the prompt's bound). */
  readonly timer?: (ms: number) => PairTimer;
  /** The human answers this long after the prompt (the window can expire first). */
  readonly lateAnswerMs?: number;
  readonly phone?: (payload: string) => void;
  readonly signalled?: (cleanup: () => void) => (() => void) | undefined;
}): Promise<PairRun> {
  const out: string[] = [];
  const err: string[] = [];
  let claimed = false;
  const code = await pairCommand({
    projectDir: PROJECT_DIR,
    configDir: input.configDir,
    interfaces: LAN,
    ...(input.extraAddresses !== undefined ? { extraAddresses: input.extraAddresses } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.writes !== undefined ? { writes: input.writes } : {}),
    ...(input.timer !== undefined ? { timer: input.timer } : {}),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...(input.answer !== undefined
      ? {
          ask: async () => {
            if (input.lateAnswerMs !== undefined) {
              await Bun.sleep(input.lateAnswerMs);
            }
            return input.answer ?? "";
          },
        }
      : {}),
    ...(input.signalled !== undefined ? { exitHooks: input.signalled } : {}),
    pollMs: PAIR_POLL_MS,
    // The only fake: waiting. The first call is the phone's moment.
    sleep: async () => {
      if (!claimed) {
        claimed = true;
        input.phone?.(out[0] ?? "");
      }
    },
  });
  const payload = out[0] ?? "";
  return {
    code,
    out,
    err,
    payload,
    addresses: [...payload.matchAll(/[?&]a=([^&]*)/g)].map((m) =>
      decodeURIComponent((m[1] ?? "").trim()),
    ),
  };
}

/** The session file names left in the pairing dir (the window's own files). */
const pairingFiles = (configDir: string): string[] => {
  try {
    return readdirSync(join(configDir, "devices", "pairing")).sort();
  } catch {
    return [];
  }
};

describe("the code", () => {
  test("is 10 Crockford base32 characters", () => {
    expect(newPairingCode((n) => new Uint8Array(n).fill(0))).toBe("0000000000");
    expect(newPairingCode((n) => new Uint8Array(n).fill(31))).toBe("ZZZZZZZZZZ");
  });

  test("takes each byte's low five bits, so no modulo bias shrinks the space", () => {
    // 0xe1 & 31 = 1: the high bits are discarded, all 32 symbols stay reachable.
    expect(newPairingCode((n) => new Uint8Array(n).fill(0b11100001))).toBe("1111111111");
    expect(newPairingCode((n) => new Uint8Array(n).fill(0b10100011))).toBe("3333333333");
  });
});

describe("the prompt", () => {
  test("carries the name, the PROJECT and the grouped compare code", () => {
    expect(pairPrompt("iPhone", "123456", "assistant")).toBe(
      "Add 'iPhone' to project assistant? It must show 123 456. [y/N] ",
    );
  });

  test("a control character in the name cannot reach the terminal (mutation: raw print)", () => {
    const prompt = pairPrompt("evil\x1b[2Jname\x07", "123456", "pro\x1bject");
    expect(prompt).not.toContain("\x1b");
    expect(prompt).not.toContain("\x07");
    expect(prompt).toContain("evil");
  });
});

describe("nothing reachable", () => {
  test("no live serve in the target folder: exit 1 with the start hint, NO window (Owner Q6)", async () => {
    const configDir = newDir();
    const run = await runPair({ configDir });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain(
      `No \`tentacle serve\` is running in ${PROJECT_DIR} — start it there first`,
    );
    // A window left behind would be one a daemon could still find.
    expect(pairingFiles(configDir)).toEqual([]);
    expect(run.out).toEqual([]);
  });

  test("a serve of ANOTHER folder does not count (mutation: pick any live record)", async () => {
    const configDir = newDir();
    writeDaemonRecord(configDir, {
      pid: process.pid,
      host: "0.0.0.0",
      port: 4001,
      tls: false,
      cwd: "/u/assistant",
      startedAt: 1,
    });
    const run = await runPair({ configDir });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("No `tentacle serve` is running");
    expect(pairingFiles(configDir)).toEqual([]);
  });

  test("a STALE record of the folder (no heartbeat) is not offered (F6)", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(configDir, "daemons", `${process.pid}.json`), old, old);
    const run = await runPair({ configDir });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("No `tentacle serve` is running");
  });

  test("the folder's serve binds loopback with no address: exit 1 with the reachability hint", async () => {
    const configDir = newDir();
    writeDaemonRecord(configDir, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 4000,
      tls: false,
      cwd: PROJECT_DIR,
      startedAt: 1,
    });
    const run = await runPair({ configDir });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("serve --host 0.0.0.0");
    expect(pairingFiles(configDir)).toEqual([]);
  });
});

describe("one project per QR (docs/feat/mobile-projects.md §5 — the repro's (4), inverted)", () => {
  test("pair in P prints ONLY P's addresses, its `/s/<serveId>/e2e` form, and `p=<label>`", async () => {
    // Mutation: publish every live record → Q's addresses join the QR.
    const configDir = newDir();
    writeDaemonRecord(configDir, {
      pid: process.pid,
      host: "0.0.0.0",
      port: 4000,
      tls: false,
      cwd: PROJECT_DIR,
      startedAt: 1,
      serveId: "AAAAAAAAAAAAAAAAAAAAAA",
      addresses: ["wss://relay.example/d/AAAAAAAAAAAAAAAAAAAAAA/e2e"],
    });
    // A sibling serve of another project, same computer, same config dir.
    writeDaemonRecord(configDir, {
      pid: process.ppid,
      host: "0.0.0.0",
      port: 4001,
      tls: false,
      cwd: "/u/assistant",
      startedAt: 2,
      serveId: "BBBBBBBBBBBBBBBBBBBBBB",
      addresses: ["wss://relay.example/d/BBBBBBBBBBBBBBBBBBBBBB/e2e"],
    });
    const run = await runPair({ configDir, ttlMs: 0 });
    expect(run.addresses).toEqual([
      "ws://192.168.1.8:4000/s/AAAAAAAAAAAAAAAAAAAAAA/e2e",
      "wss://relay.example/d/AAAAAAAAAAAAAAAAAAAAAA/e2e",
    ]);
    expect(run.payload).toContain("&p=elsewhere");
  });

  test("the window is opened for THAT project: another project's serve cannot find it", async () => {
    const configDir = newDir();
    recordServing(configDir);
    let mine: string | undefined;
    let theirs: string | undefined;
    await runPair({
      configDir,
      ttlMs: 300,
      phone: (payload) => {
        mine = findPairing(configDir, { project: PROJECT_KEY, code: payloadCode(payload) })?.sid;
        theirs = findPairing(configDir, {
          project: projectKey("/u/assistant"),
          code: payloadCode(payload),
        })?.sid;
      },
    });
    expect(mine).toBeDefined();
    expect(theirs).toBeUndefined();
  });
});

describe("the payload", () => {
  test("names the computer, carries the key and every reachable address", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({ configDir, ttlMs: 0 });
    expect(run.addresses).toEqual(["ws://192.168.1.8:4000/e2e"]);
    expect(run.payload).toStartWith("tentacle://pair?v=2&k=");
    // No --name: the identity is created with this machine's hostname.
    expect(run.payload).toContain(`n=${encodeURIComponent(hostname())}`);
    expect(payloadCode(run.payload)).toMatch(/^[0-9A-Z]{10}$/);
  });

  test("--name names a new identity, and is NOT silently applied to an existing one", async () => {
    const created = newDir();
    recordServing(created);
    const first = await runPair({ configDir: created, name: "gabriel-laptop", ttlMs: 0 });
    expect(first.payload).toContain(`n=${encodeURIComponent("gabriel-laptop")}`);
    // A second pair with another name keeps the identity's (a phone that pinned
    // this computer's name must not see it change under it).
    const second = await runPair({ configDir: created, name: "renamed", ttlMs: 0 });
    expect(second.payload).toContain(`n=${encodeURIComponent("gabriel-laptop")}`);
    expect(second.err.join("")).toContain("already named");
  });

  test("--address is appended after the daemon's own", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({
      configDir,
      ttlMs: 0,
      extraAddresses: ["ws://relay.test:8443/e2e"],
    });
    expect(run.addresses).toEqual(["ws://192.168.1.8:4000/e2e", "ws://relay.test:8443/e2e"]);
  });

  test("an --address a phone cannot dial is refused before a window opens", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({ configDir, extraAddresses: ["https://example.test/"] });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("ending in /e2e");
    expect(pairingFiles(configDir)).toEqual([]);
  });
});

describe("the human's answer", () => {
  test("the prompt carries the CLAIM's name and the SAS from both keys", async () => {
    // The one check that defeats a photographed QR: the terminal must show the
    // compare code computed from THIS computer's key and the key the channel
    // authenticated — not one from the claim (mutation: print the claim's `sas`
    // field, or none → the human has nothing to compare).
    const configDir = newDir();
    recordServing(configDir);
    const deviceKey = key32(21);
    const identity = loadOrCreateIdentity(configDir, { name: "gabriel-laptop" });
    const expected = identity.ok ? pairingSas(identity.identity.publicKey, deviceKey) : "?";
    const prompts: string[] = [];
    const out: string[] = [];
    const code = await pairCommand({
      projectDir: PROJECT_DIR,
      configDir,
      interfaces: LAN,
      out: (text) => out.push(text),
      err: () => {},
      ask: async (prompt) => {
        prompts.push(prompt);
        return "y";
      },
      sleep: async () => {
        const pairingCode = /[?&]c=([A-Z0-9]{10})/.exec(out[0] ?? "")?.[1];
        if (pairingCode === undefined) return;
        const sid = findPairing(configDir, { project: PROJECT_KEY, code: pairingCode })?.sid;
        if (sid === undefined) return;
        claimPairing(configDir, {
          project: PROJECT_KEY,
          sid,
          deviceKey,
          name: "iPhone di Gabriel",
        });
      },
    });
    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("iPhone di Gabriel");
    // Grouped as the mockup shows it, and equal to the independent computation.
    expect(prompts[0]).toContain(`${expected.slice(0, 3)} ${expected.slice(3)}`);
  });

  test("y writes the registry entry, and the decision says accepted", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const deviceKey = key32(7);
    const run = await runPair({
      configDir,
      answer: "y",
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        const claimed = claimPairing(configDir, {
          project: PROJECT_KEY,
          sid,
          deviceKey,
          name: "iPhone di Gabriel",
        });
        if (!claimed.ok) throw new Error(claimed.reason);
      },
    });
    expect(run.code).toBe(0);
    const registry = readRegistry(configDir);
    expect(registry.ok).toBe(true);
    expect(registry.ok ? registry.registry.devices.map((d) => d.name) : []).toEqual([
      "iPhone di Gabriel",
    ]);
    expect(registry.ok ? registry.registry.devices[0]?.id : "").toBe(deviceIdOf(deviceKey));
    // The entry opens THIS project only (docs/feat/mobile-projects.md §1).
    expect(registry.ok ? registry.registry.devices[0]?.project : undefined).toEqual({
      key: PROJECT_KEY,
      cwd: PROJECT_DIR,
    });
    expect(run.out.join("")).toContain(deviceIdOf(deviceKey));
    expect(run.out.join("")).toContain("project elsewhere");
  });

  test("N writes NO entry (mutation: always accept)", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({
      configDir,
      answer: "n",
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, {
          project: PROJECT_KEY,
          sid,
          deviceKey: key32(9),
          name: "stranger",
        });
      },
    });
    expect(run.code).toBe(1);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
    expect(run.err.join("")).toContain("not added");
  });

  test("with no terminal the claim is DECLINED, never auto-accepted", async () => {
    const configDir = newDir();
    recordServing(configDir);
    // `answer` omitted ⇒ no `ask` seam ⇒ nobody can confirm (decision 2).
    const run = await runPair({
      configDir,
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { project: PROJECT_KEY, sid, deviceKey: key32(3), name: "phone" });
      },
    });
    expect(run.code).toBe(1);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
    expect(run.err.join("")).toContain("no terminal");
  });
});

describe("the window's files", () => {
  test("are gone when pair returns, whatever the answer (mutation: close only on success)", async () => {
    for (const answer of ["y", "n"]) {
      const configDir = newDir();
      recordServing(configDir);
      const run = await runPair({
        configDir,
        answer,
        phone: (payload) => {
          const sid = findPairing(configDir, {
            project: PROJECT_KEY,
            code: payloadCode(payload),
          })?.sid;
          if (sid === undefined) throw new Error("no window to claim");
          claimPairing(configDir, {
            project: PROJECT_KEY,
            sid,
            deviceKey: key32(4),
            name: "phone",
          });
        },
      });
      expect(run.code).toBe(answer === "y" ? 0 : 1);
      expect(pairingFiles(configDir)).toEqual([]);
    }
  });

  test("an interrupted pair closes its window (F2: the exit hook really fires)", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const hooks: (() => void)[] = [];
    const run = await runPair({
      configDir,
      ttlMs: 0,
      signalled: (cleanup) => {
        hooks.push(cleanup);
        return () => {};
      },
    });
    expect(run.code).toBe(1); // expired
    expect(hooks).toHaveLength(1);
    // An expiry already used the hook's effect; a second call is idempotent.
    hooks[0]?.();
    expect(pairingFiles(configDir)).toEqual([]);
  });

  test("expiry with no claim says so and pairs nobody", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({ configDir, ttlMs: 0 });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("expired");
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
  });
});

describe("a 'yes' that cannot be recorded", () => {
  test("pairs nobody, says why, and leaves the unreadable registry byte-for-byte alone", async () => {
    // The human said yes but the phone cannot be written down: it must not be
    // reported paired (mutation: ignore `addDevice`'s result → a phone the
    // registry never held is announced as paired, and F14's refusal is lost).
    const configDir = newDir();
    recordServing(configDir);
    mkdirSync(join(configDir, "devices"), { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, "devices", "registry.json"), "{ not json", { mode: 0o600 });
    const run = await runPair({
      configDir,
      answer: "y",
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { project: PROJECT_KEY, sid, deviceKey: key32(8), name: "phone" });
      },
    });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("device registry");
    expect(run.out.join("")).not.toContain("Paired");
    expect(readFileSync(join(configDir, "devices", "registry.json"), "utf8")).toBe("{ not json");
  });
});

describe("the addresses of THIS machine (review round 1, finding 1)", () => {
  test("a loopback serve with a relay address pairs at all — the zero-config case", async () => {
    // docs/feat/mobile-relay.md R5b, the gap the plan's Preconditions names: the
    // DEFAULT bind is `--host 127.0.0.1` (a loopback record contributes no
    // bind-derived address), so with the relay's `/d/<id>/e2e` sitting in the
    // record's `addresses` the QR must carry it. Red before R5b: `pair` refused
    // with REACHABLE_HINT, i.e. the relay existed and no phone could pair.
    const configDir = newDir();
    const relay = "wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e";
    writeDaemonRecord(configDir, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 4000,
      tls: false,
      cwd: PROJECT_DIR,
      startedAt: 1,
      addresses: [relay],
    });
    // `ttlMs: 0`: the window expires at once (no phone claims it here); the
    // payload is printed BEFORE that, which is where the addresses are.
    const run = await runPair({ configDir, ttlMs: 0 });
    expect(run.addresses).toEqual([relay]);
    expect(run.err.join("")).not.toContain("serve --host 0.0.0.0");
  });

  test("direct addresses come first, the relay LAST (the order the phone tries)", async () => {
    const configDir = newDir();
    const relay = "wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e";
    writeDaemonRecord(configDir, {
      pid: process.pid,
      host: "0.0.0.0",
      port: 4000,
      tls: false,
      cwd: PROJECT_DIR,
      startedAt: 1,
      addresses: [relay],
    });
    const run = await runPair({ configDir, ttlMs: 0 });
    // The LAN address this machine's injected `LAN` interface implies, then the
    // relay: R6's stagger prefers direct paths and falls back to the relay.
    expect(run.addresses).toEqual(["ws://192.168.1.8:4000/e2e", relay]);
  });

  test("a wildcard record expands to the real interfaces when none are injected", async () => {
    // `main` injects nothing, so the DEFAULT is what a user gets: a `0.0.0.0`
    // serve — the very configuration REACHABLE_HINT recommends — must yield
    // addresses. Read the machine's own IPv4 addresses straight from `os`, not
    // through the helper `pair` uses, so the two are independent (mutation:
    // default `interfaces` to `[]` → the payload carries only `--address`, or
    // `pair` refuses outright).
    const v4 = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry?.address ?? "");
    if (v4.length === 0) {
      // A machine with no LAN address has nothing to expand; the refusal is the
      // right answer there and `pair-addresses.test.ts` owns the rule itself.
      return;
    }
    const configDir = newDir();
    recordServing(configDir, 4321);
    const out: string[] = [];
    const code = await pairCommand({
      projectDir: PROJECT_DIR,
      configDir,
      ttlMs: 0,
      out: (text) => out.push(text),
      err: () => {},
      sleep: async () => {},
    });
    expect(code).toBe(1); // expired, no claim — but only AFTER printing a payload
    const printed = decodeURIComponent(out.join(""));
    for (const address of v4) {
      expect(printed).toContain(`ws://${address}:4321/e2e`);
    }
  });
});

describe("a 'y' that arrives after the window closed (review round 1, finding 2)", () => {
  test("pairs nobody, and tells the daemon the answer is DECLINED", async () => {
    // The daemon has already told the phone `timeout` at expiry; a `pair` that
    // still writes the registry leaves a device the phone thinks failed
    // (mutation: drop the expiry check at answer time → exit 0 and one device).
    const configDir = newDir();
    recordServing(configDir);
    const decisions: boolean[] = [];
    let adds = 0;
    const run = await runPair({
      configDir,
      ttlMs: 300,
      writes: {
        add: (device) => {
          adds++;
          return addDevice(configDir, device);
        },
        decide: (accepted) => {
          decisions.push(accepted);
          return { ok: true };
        },
      },
      answer: "y",
      lateAnswerMs: 450,
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { project: PROJECT_KEY, sid, deviceKey: key32(9), name: "late" });
      },
    });
    expect(run.code).toBe(1);
    expect(adds).toBe(0);
    expect(decisions).toEqual([false]);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
  });

  test("the CLOCK alone refuses a late 'y', with a timer that never fires", async () => {
    // The other guard, on its own: a `y` typed after `expiresAt` is refused even
    // when nothing interrupted the prompt (mutation: drop the `io.now() >=
    // expiresAt` check → exit 0, one device, and the phone was told `timeout`).
    const configDir = newDir();
    recordServing(configDir);
    const decisions: boolean[] = [];
    let adds = 0;
    const run = await runPair({
      configDir,
      // The window is real (the first poll finds the claim) and the human
      // answers well after it closes.
      ttlMs: 50,
      answer: "y",
      lateAnswerMs: 250,
      // A timer that never fires: only the clock check can stop this pair.
      timer: () => ({ elapsed: new Promise<void>(() => {}), cancel: () => {} }),
      writes: {
        add: (device) => {
          adds++;
          return addDevice(configDir, device);
        },
        decide: (accepted) => {
          decisions.push(accepted);
          return { ok: true };
        },
      },
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { project: PROJECT_KEY, sid, deviceKey: key32(17), name: "late" });
      },
    });
    expect(run.code).toBe(1);
    expect(adds).toBe(0);
    expect(decisions).toEqual([false]);
    expect(run.err.join("")).toContain("expired before you answered");
  });

  test("a prompt nobody answers does not hold pair past the window", async () => {
    // The same rule from the other side: the question is BOUNDED, so a claim
    // whose human walked away releases the terminal at the expiry instead of
    // blocking `pair` forever (mutation: await `ask` unbounded → this never
    // returns; the 5 s `Promise.race` is what keeps the suite from hanging).
    const configDir = newDir();
    recordServing(configDir);
    const out: string[] = [];
    let claimed = false;
    const code = await Promise.race([
      pairCommand({
        projectDir: PROJECT_DIR,
        configDir,
        interfaces: LAN,
        ttlMs: 300,
        out: (text) => out.push(text),
        err: () => {},
        ask: () => new Promise<string>(() => {}),
        sleep: async () => {
          if (claimed) return;
          const sid = findPairing(configDir, {
            project: PROJECT_KEY,
            code: payloadCode(out[0] ?? ""),
          })?.sid;
          if (sid === undefined) return;
          claimed = claimPairing(configDir, {
            project: PROJECT_KEY,
            sid,
            deviceKey: key32(6),
            name: "away",
          }).ok;
        },
      }),
      Bun.sleep(5_000).then(() => "hung" as const),
    ]);
    // A claim really was made, so the prompt really was reached.
    expect(claimed).toBe(true);
    expect(code).toBe(1);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
  });
});

describe("the write ORDER (F3; review round 1, finding 3)", () => {
  test("the registry holds the key BEFORE the decision is written", async () => {
    // F3's whole point: a `pair` that dies between the two writes must leave a
    // PAIRED phone (the daemon accepts a claim whose key the registry holds),
    // never a decision with no device behind it. Both writes are synchronous
    // and the window is deleted on the way out, so only the `writes` seam can
    // see the order (mutation: swap the two calls in `answerClaim` → the
    // decision is written for a registry that is still empty).
    const configDir = newDir();
    recordServing(configDir);
    const deviceKey = key32(31);
    const order: string[] = [];
    let registryAtDecision: readonly string[] | undefined;
    let claimSid = "";
    const run = await runPair({
      configDir,
      answer: "y",
      writes: {
        add: (device) => {
          order.push("add");
          return addDevice(configDir, device);
        },
        decide: (accepted) => {
          order.push("decide");
          const registry = readRegistry(configDir);
          registryAtDecision = registry.ok ? registry.registry.devices.map((d) => d.id) : [];
          return writePairingDecision(configDir, claimSid, accepted);
        },
      },
      phone: (payload) => {
        const sid = findPairing(configDir, {
          project: PROJECT_KEY,
          code: payloadCode(payload),
        })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimSid = sid;
        claimPairing(configDir, { project: PROJECT_KEY, sid, deviceKey, name: "iPhone" });
      },
    });
    expect(run.code).toBe(0);
    expect(order).toEqual(["add", "decide"]);
    // The property, not just the call order: at the moment the decision is
    // written, the key it accepts is already authorised.
    expect(registryAtDecision).toEqual([deviceIdOf(deviceKey)]);
  });
});
