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
 *   `pair` that dies in between leaves a phone that is not paired);
 * - the window's files are gone when `pair` returns, on every path (mutation:
 *   close only on the success path);
 * - nothing reachable → exit 1 with the hint, and NO window opened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimPairing,
  deviceIdOf,
  findPairing,
  loadOrCreateIdentity,
  readRegistry,
  writeDaemonRecord,
} from "@tentacle/daemon";
import { pairingSas } from "@tentacle/transport/noise";
import type { InterfaceEntry } from "../src/pair-addresses.ts";
import { PAIR_POLL_MS, newPairingCode, pairCommand, pairPrompt } from "../src/pair.ts";

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
    cwd: "/elsewhere",
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
  readonly phone?: (payload: string) => void;
  readonly signalled?: (cleanup: () => void) => void;
}): Promise<PairRun> {
  const out: string[] = [];
  const err: string[] = [];
  let claimed = false;
  const code = await pairCommand({
    configDir: input.configDir,
    interfaces: LAN,
    ...(input.extraAddresses !== undefined ? { extraAddresses: input.extraAddresses } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...(input.answer !== undefined ? { ask: async () => input.answer ?? "" } : {}),
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
  test("carries the name and the grouped compare code", () => {
    expect(pairPrompt("iPhone", "123456")).toBe("Add 'iPhone'? It must show 123 456. [y/N] ");
  });

  test("a control character in the name cannot reach the terminal (mutation: raw print)", () => {
    const prompt = pairPrompt("evil\x1b[2Jname\x07", "123456");
    expect(prompt).not.toContain("\x1b");
    expect(prompt).not.toContain("\x07");
    expect(prompt).toContain("evil");
  });
});

describe("nothing reachable", () => {
  test("exit 1 with the hint, and NO window is opened", async () => {
    const configDir = newDir();
    const run = await runPair({ configDir });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("serve --host 0.0.0.0");
    // A window left behind would be one a daemon could still find.
    expect(pairingFiles(configDir)).toEqual([]);
    expect(run.out).toEqual([]);
  });
});

describe("the payload", () => {
  test("names the computer, carries the key and every reachable address", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({ configDir, ttlMs: 0 });
    expect(run.addresses).toEqual(["ws://192.168.1.8:4000/e2e"]);
    expect(run.payload).toStartWith("tentacle://pair?v=1&k=");
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
        const sid = findPairing(configDir, { code: pairingCode })?.sid;
        if (sid === undefined) return;
        claimPairing(configDir, { sid, deviceKey, name: "iPhone di Gabriel" });
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
        const sid = findPairing(configDir, { code: payloadCode(payload) })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        const claimed = claimPairing(configDir, { sid, deviceKey, name: "iPhone di Gabriel" });
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
    expect(run.out.join("")).toContain(deviceIdOf(deviceKey));
  });

  test("N writes NO entry (mutation: always accept)", async () => {
    const configDir = newDir();
    recordServing(configDir);
    const run = await runPair({
      configDir,
      answer: "n",
      phone: (payload) => {
        const sid = findPairing(configDir, { code: payloadCode(payload) })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { sid, deviceKey: key32(9), name: "stranger" });
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
        const sid = findPairing(configDir, { code: payloadCode(payload) })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { sid, deviceKey: key32(3), name: "phone" });
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
          const sid = findPairing(configDir, { code: payloadCode(payload) })?.sid;
          if (sid === undefined) throw new Error("no window to claim");
          claimPairing(configDir, { sid, deviceKey: key32(4), name: "phone" });
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
      signalled: (cleanup) => hooks.push(cleanup),
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
        const sid = findPairing(configDir, { code: payloadCode(payload) })?.sid;
        if (sid === undefined) throw new Error("no window to claim");
        claimPairing(configDir, { sid, deviceKey: key32(8), name: "phone" });
      },
    });
    expect(run.code).toBe(1);
    expect(run.err.join("")).toContain("device registry");
    expect(run.out.join("")).not.toContain("Paired");
    expect(readFileSync(join(configDir, "devices", "registry.json"), "utf8")).toBe("{ not json");
  });
});
