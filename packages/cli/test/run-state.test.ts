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
import { keptDir, keptFileName, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { type ProcOf, acquireResidentLock, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  RELAY_LOG_CAP_BYTES,
  RUN_STATE_VERSION,
  type RelaySpec,
  attachers,
  createRelayLog,
  ensureRunDir,
  laptopProc,
  logTail,
  othersOnSession,
  ownerPath,
  ownerRemoves,
  parsePsStat,
  readOwner,
  readSpec,
  relayBlockingMessage,
  relayLogPath,
  removePresence,
  runDirFor,
  setPresenceSession,
  statusOf,
  writeOwner,
  writePresence,
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
  schemaVersion: RUN_STATE_VERSION,
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
  schemaVersion: RUN_STATE_VERSION,
  mode: "start",
  stem: "0123456789abcdef",
  sessionId: "11111111-1111-4111-8111-111111111111",
  prompt: "hello",
  autoAccept: true,
  rm: true,
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

  test("L23 `rm` round trip; absent reads as not removed", () => {
    // Mutation: `ownerRemoves` as `rm !== false` → a record without the field reads as one that removes.
    const dir = fresh();
    writeOwner(dir, { ...owner, rm: true });
    const read = readOwner(dir);
    expect(read).toEqual({ kind: "owner", owner: { ...owner, rm: true } });
    expect(read.kind === "owner" && ownerRemoves(read.owner)).toBe(true);
    expect(ownerRemoves(owner)).toBe(false);
    expect(ownerRemoves({ ...owner, rm: false })).toBe(false);
  });

  test("fix/run-rm-flag: a previous build's (v1) owner.json is `unknown`, byte-identical", () => {
    // The old shape exactly: version 1, `keep:false` (it removed), otherwise valid.
    // Mutation: RUN_STATE_VERSION left at 1 → it parses as an owner.
    const dir = fresh();
    const { rm: _rm, ...rest } = { ...owner, rm: true };
    const text = JSON.stringify({ ...rest, schemaVersion: 1, keep: false });
    writeFileSync(ownerPath(dir), text);
    expect(readOwner(dir)).toEqual({ kind: "unknown" });
    expect(readFileSync(ownerPath(dir), "utf8")).toBe(text);
  });
});

describe("L27 statusOf (DR-6)", () => {
  const NOW = 10_000_000;
  const of = (over: Partial<OwnerRecord>, alive: boolean): string | null =>
    statusOf(
      {
        kind: "owner",
        owner: {
          ...owner,
          state: "running",
          lastActivityAt: NOW,
          tool: undefined,
          ...over,
        } as OwnerRecord,
      },
      alive,
      NOW,
    );

  test("no owner.json, an unreadable one", () => {
    expect(statusOf({ kind: "none" }, true, NOW)).toBe("detached · starting");
    expect(statusOf({ kind: "none" }, false, NOW)).toBeNull();
    expect(statusOf({ kind: "unknown" }, true, NOW)).toBe("detached · unknown owner");
    expect(statusOf({ kind: "unknown" }, false, NOW)).toBe("unknown owner");
  });

  test("every state, relay alive and dead", () => {
    expect(of({ state: "starting" }, true)).toBe("detached · running 0m");
    expect(of({ state: "starting" }, false)).toBe("relay lost");
    expect(of({ lastActivityAt: NOW - 3 * 60_000 - 1 }, true)).toBe("detached · running 3m");
    expect(of({ detail: "2 background job(s) running" }, true)).toBe(
      "detached · running 0m (2 background job(s) running)",
    );
    expect(of({}, false)).toBe("relay lost");
    expect(of({ state: "waiting-permission", tool: "shell" }, true)).toBe(
      "detached · waiting: permission (shell)",
    );
    expect(of({ state: "waiting-permission" }, true)).toBe("detached · waiting: permission");
    expect(of({ state: "waiting-permission", tool: "shell" }, false)).toBe("relay lost");
    expect(of({ state: "idle" }, true)).toBe("detached · idle");
    expect(of({ state: "idle" }, false)).toBe("idle");
    // An `--rm` workload left behind carries why: `ps` must say it, not hide it.
    const left = "not removed: engine down — tentacle rm box";
    expect(of({ state: "idle", detail: left }, true)).toBe(`detached · idle (${left})`);
    expect(of({ state: "idle", detail: left }, false)).toBe(`idle (${left})`);
    expect(of({ state: "interrupted" }, true)).toBe("detached · interrupted");
    expect(of({ state: "interrupted" }, false)).toBe("interrupted");
    expect(of({ state: "failed", detail: "401" }, true)).toBe("detached · failed: 401");
    expect(of({ state: "failed", detail: "401" }, false)).toBe("failed: 401");
    expect(of({ state: "failed" }, false)).toBe("failed");
  });

  test("a clock that stepped back is 0m, never negative", () => {
    expect(of({ lastActivityAt: NOW + 600_000 }, true)).toBe("detached · running 0m");
  });

  test("` · auto` only with a live relay", () => {
    // Mutation (DR-3): drop it → an auto-accepting run looks like any other.
    expect(of({ autoAccept: true }, true)).toBe("detached · running 0m · auto");
    expect(of({ autoAccept: true, state: "idle" }, true)).toBe("detached · idle · auto");
    expect(of({ autoAccept: true, state: "idle" }, false)).toBe("idle");
  });

  test("an ESC in `tool` or `detail` never survives", () => {
    // Mutation: skip `untrustedText` → a hand-edited file reaches the terminal.
    for (const text of [
      of({ state: "waiting-permission", tool: "x\u001b[2J" }, true),
      of({ state: "failed", detail: "x\u001b[2J" }, false),
      of({ detail: "x\u001b[2J" }, true),
    ]) {
      expect(text).toContain("x [2J");
      expect(text).not.toContain("\u001b");
    }
  });
});

describe("H12 TUIs on a run (docs/feat/detached-handover.md)", () => {
  const NOW = 10_000_000;
  const tui = (over: Partial<OwnerRecord> = {}): OwnerRecord => ({
    ...owner,
    kind: "tui",
    state: "attached",
    tool: undefined,
    cwd: "/work",
    ...over,
  });

  test("a TUI record round-trips, `attached` and `cwd`/`control` included", () => {
    const dir = fresh();
    const { tool: _tool, ...rest } = tui();
    const record = { ...rest, control: "/x/control.sock" };
    writeOwner(dir, record);
    expect(readOwner(dir)).toEqual({ kind: "owner", owner: record });
  });

  test("D24 `runTurnId` round-trips (B2); a non-string one is dropped, never trusted", () => {
    // Mutation: `readOwner` drops `runTurnId` → a TUI never owns the run's turn.
    const dir = fresh();
    const { tool: _tool, ...rest } = tui({ autoAccept: true });
    const record = { ...rest, runTurnId: "77777777-7777-4777-8777-777777777777" };
    writeOwner(dir, record);
    expect(readOwner(dir)).toEqual({ kind: "owner", owner: record });
    writeFileSync(ownerPath(dir), JSON.stringify({ ...rest, runTurnId: 42 }));
    const read = readOwner(dir);
    expect(read.kind === "owner" && "runTurnId" in read.owner).toBe(false);
  });

  test("presence: listed while alive; a dead one and a reused pid (another start) are swept", () => {
    // Mutation: skip the start-time test → the reused pid counts as attached.
    const dir = fresh();
    const live = running("100");
    const [a, b] = [process.pid, process.ppid];
    const mine = writePresence(dir, a, live);
    expect(statSync(mine).mode & 0o777).toBe(0o600);
    writePresence(dir, b, live);
    expect(
      attachers(dir, live)
        .map((x) => x.pid)
        .sort(),
    ).toEqual([a, b].sort());
    // Same pids, another start time: another process.
    expect(attachers(dir, running("200"))).toEqual([]);
    expect(readdirSync(join(dir, "attach"))).toEqual([]);
    writePresence(dir, 2 ** 30, live); // no such process
    expect(attachers(dir, live)).toEqual([]);
    expect(readdirSync(join(dir, "attach"))).toEqual([]);
    // The real start time reads back as its own.
    writePresence(dir, a, laptopProc);
    expect(attachers(dir, laptopProc).map((x) => x.pid)).toEqual([a]);
    const gone = writePresence(dir, a, live);
    removePresence(gone);
    removePresence(gone); // idempotent
    expect(attachers(dir, live)).toEqual([]);
    expect(attachers(fresh(), live)).toEqual([]); // no attach dir at all
  });

  test("D10 presence by session: the body round-trips, `/clear` rewrites it, `othersOnSession` counts one session only", () => {
    // Mutation: count every presence → a `/clear`ed TUI gets the dialog (D1 scope lost).
    const dir = fresh();
    const live = running("100");
    const [me, other, cleared] = [process.pid, process.ppid, 1];
    const mine = writePresence(dir, me, live, "S");
    writePresence(dir, other, live, "S");
    const theirs = writePresence(dir, cleared, live, "S");
    expect(
      attachers(dir, live)
        .map((a) => `${a.pid}:${a.sessionId}`)
        .sort(),
    ).toEqual([`${me}:S`, `${other}:S`, `${cleared}:S`].sort());
    expect(othersOnSession(dir, live, me, "S")).toBe(2);
    setPresenceSession(theirs, "FRESH"); // that TUI `/clear`ed
    expect(attachers(dir, live).find((a) => a.pid === cleared)?.sessionId).toBe("FRESH");
    expect(othersOnSession(dir, live, me, "S")).toBe(1);
    expect(othersOnSession(dir, live, cleared, "FRESH")).toBe(0);
    // A body that is not a session id (an older build's empty file) is on no session.
    writeFileSync(mine, "");
    expect(attachers(dir, live).find((a) => a.pid === me)?.sessionId).toBeUndefined();
    expect(statSync(theirs).mode & 0o777).toBe(0o600);
  });

  test("statusOf with presences: `attached`, `attached (N)`; with none, a TUI record says `tui lost` or `idle`", () => {
    const owned = (o: OwnerRecord) => ({ kind: "owner" as const, owner: o });
    expect(statusOf(owned(tui()), false, NOW, 1)).toBe("attached");
    expect(statusOf(owned(tui()), false, NOW, 3)).toBe("attached (3)");
    expect(statusOf(owned(tui()), false, NOW, 0)).toBe("tui lost");
    expect(statusOf(owned(tui({ state: "idle" })), false, NOW, 0)).toBe("idle");
    const left = "not removed: engine down — tentacle rm box";
    expect(statusOf(owned(tui({ state: "idle", detail: left })), false, NOW, 0)).toBe(
      `idle (${left})`,
    );
    // Presence wins over a stale state, whoever wrote last.
    expect(statusOf(owned(tui({ state: "idle" })), false, NOW, 2)).toBe("attached (2)");
    expect(statusOf(owned({ ...owner, state: "idle" }), false, NOW, 1)).toBe("attached");
    // A live relay's row is its own (the hand-over has not happened).
    const relaying = { ...owner, state: "running" as const, tool: undefined, lastActivityAt: NOW };
    expect(statusOf(owned(relaying), true, NOW, 1)).toBe("detached · running 0m");
    const esc = statusOf(owned(tui({ state: "idle", detail: "x\u001b[2J" })), false, NOW, 0);
    expect(esc).not.toContain("\u001b");
  });

  test("R6 `rm: true`, its owner gone mid-run, the workload still there: `not saved` until `rm`", () => {
    // Owner, 2026-11-02: the exit net kept it (a save not confirmed, or a crash:
    // unknown = not saved). Mutation: drop the suffix → `ps` says only `lost`.
    const owned = (o: OwnerRecord) => ({ kind: "owner" as const, owner: o });
    const run = { ...owner, rm: true, tool: undefined, lastActivityAt: NOW };
    for (const state of ["starting", "running", "waiting-permission"] as const) {
      expect(statusOf(owned({ ...run, state }), false, NOW, 0)).toBe("relay lost · not saved");
    }
    expect(statusOf(owned(tui({ rm: true })), false, NOW, 0)).toBe("tui lost · not saved");
    // The relay's own veto (round 3): its note, never a bare `interrupted`.
    const kept =
      "the relay was stopped before the turn ended; not saved — workload kept: tentacle rm box";
    expect(statusOf(owned({ ...run, state: "interrupted", detail: kept }), false, NOW, 0)).toBe(
      `interrupted (${kept})`,
    );
    // `rm: false` (or absent) keeps anyway; a live owner is not lost.
    expect(statusOf(owned({ ...run, rm: false }), false, NOW, 0)).toBe("relay lost");
    expect(statusOf(owned({ ...run, state: "running" }), true, NOW, 0)).toBe(
      "detached · running 0m",
    );
  });
});

describe("spec.json", () => {
  test("round trip, 0600; the relay's read is strict", () => {
    const dir = fresh();
    const path = writeSpec(dir, spec);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSpec(path)).toEqual(spec);
  });

  test("L23 `rm` is required: a spec without it, or with the old `keep` instead, is refused", () => {
    const dir = fresh();
    const path = join(dir, "spec.json");
    const { rm: _dropped, ...old } = spec;
    writeFileSync(path, JSON.stringify(old));
    expect(() => readSpec(path)).toThrow(/spec/);
    writeFileSync(path, JSON.stringify({ ...old, keep: false }));
    expect(() => readSpec(path)).toThrow(/spec/);
  });

  test("fix/run-rm-flag: a previous build's (v1) spec is refused, naming both versions", () => {
    const dir = fresh();
    const path = join(dir, "spec.json");
    const { rm: _dropped, ...old } = spec;
    writeFileSync(path, JSON.stringify({ ...old, schemaVersion: 1, keep: false }));
    expect(() => readSpec(path)).toThrow(`schemaVersion 1 is not ${RUN_STATE_VERSION}`);
  });

  test("a stem that is not one path component is refused", () => {
    const dir = fresh();
    const path = writeSpec(dir, { ...spec, stem: "../../etc" });
    expect(() => readSpec(path)).toThrow(/spec/);
  });

  test("an unknown schema is refused", () => {
    const dir = fresh();
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify({ ...spec, schemaVersion: 99 }));
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

describe("relayBlockingMessage (R13)", () => {
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

  test("L23 `rm: true`: no `attach` promised, the removal said", () => {
    // Mutation: the kept-run wording → an `attach` that finds nothing.
    const text = relayBlockingMessage("box", {
      pid: 7,
      noun: "container",
      owner: { kind: "owner", owner: { ...owner, rm: true } },
    });
    expect(text).toContain("kill 7");
    expect(text).toContain("stopping it removes the container");
    expect(text).toContain(`tentacle --resume ${owner.sessionId}`);
    expect(text).not.toContain("tentacle attach");
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
