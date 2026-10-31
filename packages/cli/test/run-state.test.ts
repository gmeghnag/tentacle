import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptFile } from "../src/kept-index.ts";
import { keptDir, keptFileName, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { type ProcOf, acquireResidentLock, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  RELAY_LOG_CAP_BYTES,
  type RelaySpec,
  createRelayLog,
  ensureRunDir,
  laptopProc,
  logTail,
  ownerPath,
  parsePsStat,
  readOwner,
  readSpec,
  relayBlocking,
  relayBlockingMessage,
  relayLogPath,
  runDirFor,
  writeOwner,
  writeSpec,
} from "../src/run-state.ts";

const fresh = (): string => mkdtempSync(join(tmpdir(), "run-state-"));
const entry = (name: string, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name,
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
  ...over,
});
const owner: OwnerRecord = {
  schemaVersion: 1,
  kind: "relay",
  pid: 42,
  appVersion: "1.2.3",
  sessionId: "11111111-1111-4111-8111-111111111111",
  state: "waiting-permission",
  tool: "shell",
  lastActivityAt: 7,
  autoAccept: false,
};
const spec: RelaySpec = {
  schemaVersion: 1,
  mode: "start",
  stem: "0123456789abcdef",
  sessionId: "11111111-1111-4111-8111-111111111111",
  prompt: "hello",
  autoAccept: true,
  cwd: "/work",
};
/** `pid` runs, started at `start`. */
const running =
  (start: string): ProcOf =>
  () => ({ state: "S", start });

describe("run dir (docs/feat/detached-relay.md)", () => {
  test("lives under kept/runs/<stem>, private, invisible to the kept index", () => {
    const config = fresh();
    const e = entry("box");
    recordKept(keptDir(config), e);
    const dir = ensureRunDir(runDirFor(config, e));
    expect(dir).toBe(join(keptDir(config), "runs", keptFileName(e).replace(/\.json$/, "")));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeOwner(dir, owner);
    expect(statSync(ownerPath(dir)).mode & 0o777).toBe(0o600);
    const index = readKept(keptDir(config));
    expect(index.entries).toHaveLength(1);
    expect(index.problems).toEqual([]);
  });
});

describe("owner.json (R5)", () => {
  test("round trip; a write leaves no temp file", () => {
    const dir = fresh();
    expect(readOwner(dir)).toEqual({ kind: "none" });
    writeOwner(dir, owner);
    expect(readOwner(dir)).toEqual({ kind: "owner", owner });
    expect(readdirSync(dir)).toEqual(["owner.json"]);
  });

  test("an unknown schema or a corrupt file is refused, byte-identical, and never rewritten by a read", () => {
    const dir = fresh();
    for (const text of ['{"schemaVersion":99,"kind":"relay"}', "{not json"]) {
      writeFileSync(ownerPath(dir), text);
      expect(readOwner(dir)).toEqual({ kind: "unknown" });
      expect(readFileSync(ownerPath(dir), "utf8")).toBe(text);
    }
  });

  test("a state outside the enum is refused, not half-loaded", () => {
    const dir = fresh();
    writeFileSync(ownerPath(dir), JSON.stringify({ ...owner, state: "weird" }));
    expect(readOwner(dir)).toEqual({ kind: "unknown" });
  });
});

describe("spec.json", () => {
  test("round trip, 0600; the relay's read is strict", () => {
    const dir = fresh();
    const path = writeSpec(dir, spec);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSpec(path)).toEqual(spec);
  });

  test("a stem that is not one path component is refused", () => {
    const dir = fresh();
    const path = writeSpec(dir, { ...spec, stem: "../../etc" });
    expect(() => readSpec(path)).toThrow(/spec/);
  });

  test("an unknown schema is refused", () => {
    const dir = fresh();
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify({ ...spec, schemaVersion: 2 }));
    expect(() => readSpec(path)).toThrow(/schemaVersion/);
  });
});

describe("laptopProc (R5)", () => {
  // Captured on the owner's Mac: `LC_ALL=C ps -o stat=,lstart= -p 1`.
  const LINE = "Ss   Mon Oct 26 00:15:29 2026\n";

  test("the start time is ONE token that survives the lock's split on spaces", () => {
    // Mutation: keep the raw `lstart` → `start` has spaces, the lock keeps "Mon":
    // a reused pid that started on another Monday reads alive.
    const stat = parsePsStat(LINE);
    expect(stat?.state).toBe("S");
    expect(stat?.start).toBe(String(new Date(2026, 9, 26, 0, 15, 29).getTime()));
    expect(stat?.start).not.toContain(" ");
  });

  test("a single-digit day (padded) parses too", () => {
    expect(parsePsStat("S    Mon Oct  5 00:15:29 2026\n")?.start).toBe(
      String(new Date(2026, 9, 5, 0, 15, 29).getTime()),
    );
  });

  test("zombie, gone, unreadable", () => {
    expect(parsePsStat("Z+   Mon Oct 26 00:15:29 2026\n")?.state).toBe("Z");
    expect(parsePsStat("")).toBeUndefined();
    expect(parsePsStat("S    not a date")).toEqual({ state: "S", start: undefined });
  });

  test("laptopProc reads this very process, stable between two reads", () => {
    const first = laptopProc(process.pid);
    expect(first?.start).toBeDefined();
    expect(laptopProc(process.pid)?.start).toBe(first?.start as string);
  });

  test("a dead pid has no entry", () => {
    expect(laptopProc(2 ** 30)).toBeUndefined();
  });
});

describe("the relay's lock (R5)", () => {
  test("a live holder is seen; a released one, a dead one and a reused pid are not", () => {
    const dir = fresh();
    expect(lockHolder(dir, running("100"))).toBeNull();
    const lock = acquireResidentLock(dir, running("100"));
    expect(lockHolder(dir, running("100"))?.pid).toBe(process.pid);
    // The same pid, another start time: reused.
    expect(lockHolder(dir, running("200"))).toBeNull();
    lock.release();
    expect(lockHolder(dir, running("100"))).toBeNull();

    const dead = fresh();
    writeFileSync(join(dead, ".lock.1"), `${2 ** 30} 100`);
    expect(lockHolder(dead, running("100"))).toBeNull();
  });

  test("with `laptopProc`: the start time written reads back as the holder's own", () => {
    const dir = fresh();
    const lock = acquireResidentLock(dir, laptopProc);
    expect(lockHolder(dir, laptopProc)?.pid).toBe(process.pid);
    lock.release();
  });

  test("two takers, one winner", () => {
    const dir = fresh();
    const lock = acquireResidentLock(dir, running("100"));
    expect(() => acquireResidentLock(dir, running("100"))).toThrow(/owns/);
    lock.release();
  });
});

describe("relayBlocking (R13)", () => {
  const file = (e: KeptEntry): KeptFile => ({ file: `/k/${e.name}.json`, entry: e });

  test("a live holder of a same-named entry blocks; others do not", () => {
    const entries = [file(entry("a")), file(entry("b"))];
    const holderOf = (e: KeptEntry) => (e.name === "a" ? { pid: 7 } : null);
    expect(relayBlocking("a", entries, holderOf, undefined)?.pid).toBe(7);
    expect(relayBlocking("b", entries, holderOf, undefined)).toBeNull();
    expect(relayBlocking("c", entries, holderOf, undefined)).toBeNull();
  });

  test("--engine filters the entries", () => {
    const entries = [file(entry("a", { engine: "podman" }))];
    const holderOf = () => ({ pid: 7 });
    expect(relayBlocking("a", entries, holderOf, "docker")).toBeNull();
    expect(relayBlocking("a", entries, holderOf, "podman")?.pid).toBe(7);
  });

  test("the message says who, how to stop it, and how to get the session back", () => {
    const text = relayBlockingMessage("box", {
      pid: 7,
      owner: { kind: "owner", owner },
    });
    expect(text).toContain("pid 7");
    expect(text).toContain("waiting-permission");
    expect(text).toContain("kill 7");
    expect(text).toContain(`tentacle attach box --resume ${owner.sessionId}`);
  });

  test("an unknown owner file is said as such, never read", () => {
    const text = relayBlockingMessage("box", { pid: 7, owner: { kind: "unknown" } });
    expect(text).toContain("unknown owner");
    expect(text).not.toContain("--resume");
  });
});

describe("relay.log (R14)", () => {
  test("every line is sanitised: no ESC, one line per line of text", () => {
    // Mutation: skip `untrustedText` → the ESC lands in the file.
    const dir = fresh();
    const log = createRelayLog(dir, () => 0);
    log("a\u001b[31mb\nsecond\n");
    const text = readFileSync(relayLogPath(dir), "utf8");
    expect(text).not.toContain("\u001b");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(statSync(relayLogPath(dir)).mode & 0o777).toBe(0o600);
  });

  test("a log that cannot be written never throws: the relay's failure paths call it", () => {
    // Mutation: drop the guard → ENOENT out of `log`.
    const dir = fresh();
    const log = createRelayLog(dir, () => 0);
    log("first\n");
    rmSync(dir, { recursive: true });
    expect(() => log("second\n")).not.toThrow();
  });

  test("rotates at the cap, one rotation: the disk stays bounded", () => {
    const dir = fresh();
    const log = createRelayLog(dir, () => 0, 100);
    for (let i = 0; i < 50; i++) {
      log(`line ${i}\n`);
    }
    expect(readdirSync(dir).sort()).toEqual(["relay.log", "relay.log.1"]);
    expect(statSync(relayLogPath(dir)).size).toBeLessThanOrEqual(100);
    expect(statSync(`${relayLogPath(dir)}.1`).size).toBeLessThanOrEqual(200);
    expect(RELAY_LOG_CAP_BYTES).toBe(1024 * 1024);
  });

  test("the tail shown on a terminal is sanitised, whoever wrote the file", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(relayLogPath(dir), "old\ncrash \u001b]52;c;AAAA\u0007trace\n");
    const tail = logTail(dir, 1);
    expect(tail).toEqual(["crash ]52;c;AAAA trace"]);
    expect(logTail(fresh())).toEqual([]);
  });
});
