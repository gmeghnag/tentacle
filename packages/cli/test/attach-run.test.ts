import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import { type JoinDeps, type Joined, joinRun } from "../src/attach-run.ts";
import type { ControlConn, ControlReply, ControlRequest } from "../src/control-socket.ts";
import type { EngineHost } from "../src/engine-host.ts";
import { keptDir, keptFileName, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import type { LocalRuntime } from "../src/local-runtime.ts";
import { acquireResidentLock, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  RUN_STATE_VERSION,
  attachDirOf,
  attachers,
  ensureRunDir,
  laptopProc,
  ownerPath,
  readOwner,
  runDirFor,
  statusOf,
  writeAutoAccept,
  writeOwner,
  writePresence,
} from "../src/run-state.ts";
import { openTuiSessions } from "../src/tui-sessions.ts";

const UID = "66666666-6666-4666-8666-666666666666";
const entry: KeptEntry = {
  schemaVersion: 1,
  name: "box",
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
};
const KEPT = { "tentacle.managed": "true", "tentacle.kept": "true" };

/** A run dir with an ended relay's record, a kept entry, fakes that record every effect. */
async function rig(
  over: {
    rm?: boolean;
    owner?: Partial<OwnerRecord>;
    quit?: { sessionsKept: number; saved: boolean };
    drainLines?: string[];
    /** Runs inside the fake `quit` (another TUI reacting to the close). */
    onQuit?: () => void;
    /** The ids `createSession` hands out, in order. */
    sessionIds?: string[];
    /** Runs inside the saver's drain: between the quit's record and its leave. */
    onDrain?: () => Promise<void>;
    /** The runtime's `saveConfirmed` (R6), read live. */
    confirmed?: { value: boolean };
    /** The pod no longer has the session (`attachTo` false): the seeded path. */
    gone?: boolean;
    /** `openSeeded` rejects with this. */
    seedFails?: string;
    /** The laptop copy as `readRecord` finds it right before `openSeeded` (R8). */
    fresh?: SessionRecord;
    /** `readRecord` rejects with this. */
    readFails?: string;
  } = {},
) {
  const rm = over.rm ?? true;
  const config = mkdtempSync(join(tmpdir(), "attach-run-"));
  const index = keptDir(config);
  recordKept(index, entry);
  const dir = ensureRunDir(runDirFor(config, entry));
  const owner: OwnerRecord = {
    schemaVersion: RUN_STATE_VERSION,
    kind: "relay",
    pid: 2 ** 30,
    appVersion: "1",
    sessionId: UID,
    state: "idle",
    lastActivityAt: 1,
    autoAccept: false,
    rm,
    cwd: "/work",
    ...over.owner,
  };
  writeOwner(dir, owner);
  const calls: string[] = [];
  const out: string[] = [];
  /** What each `openSeeded` was given (R8). */
  const seededWith: unknown[] = [];
  /** What each `quit` was given (Q2's `ending`). */
  const quitOpts: unknown[] = [];
  const presence = () => {
    try {
      return readdirSync(attachDirOf(dir));
    } catch {
      return [];
    }
  };
  const held = () => lockHolder(dir, laptopProc) !== null;
  const facts = { value: { status: "running", labels: KEPT } as unknown };
  const host = {
    describe: async () => {
      calls.push("describe");
      return facts.value;
    },
    remove: async () => {
      calls.push(
        presence().length > 1
          ? `remove(lock=${held()},presence=${presence().length})`
          : `remove(lock=${held()})`,
      );
    },
    removeBestEffort: () => {},
  } as unknown as EngineHost;
  const runtime = {
    attachTo: async () => {
      calls.push("attachTo");
      return over.gone !== true;
    },
    openSeeded: async (record?: unknown) => {
      calls.push("openSeeded");
      seededWith.push(record);
      if (over.seedFails !== undefined) throw new Error(over.seedFails);
    },
    residentUse: async (id: string, opts?: { ownMayBeAbsent?: boolean }) => {
      calls.push(
        opts?.ownMayBeAbsent
          ? `use(${id === UID ? "run" : id},absent-ok,presence=${presence().length})`
          : `use(presence=${presence().length})`,
      );
      return { jobs: 1, running: true, others: 0 };
    },
    quit: async (opts?: { closeForAll?: boolean; ending?: boolean }) => {
      quitOpts.push(opts);
      calls.push(opts?.closeForAll ? `quit(forAll,presence=${presence().length})` : "quit");
      over.onQuit?.();
      return over.quit ?? { sessionsKept: 0, saved: true };
    },
    createSession: () => ({ sessionId: over.sessionIds?.shift() ?? UID }),
    release: async () => {
      calls.push("release");
    },
    saveConfirmed: () => over.confirmed?.value ?? true,
  } as unknown as LocalRuntime;
  const sessions = await openTuiSessions(
    { root: join(config, "sessions"), cwd: "/work" },
    { wanted: false },
    () => {},
  );
  if ("exit" in sessions) throw new Error("no sessions");
  const notices: string[] = [];
  sessions.notices.onNotice((text, hint) => notices.push(hint ? `${text} ${hint}` : text));
  const drain = sessions.saver.drain.bind(sessions.saver);
  sessions.saver.drain = async (options) => {
    const read = readOwner(dir);
    calls.push(`drain(owner=${read.kind === "owner" ? read.owner.state : read.kind})`);
    await over.onDrain?.();
    return [...(await drain(options)), ...(over.drainLines ?? [])];
  };
  const deps = (more: Partial<JoinDeps> = {}): JoinDeps => ({
    name: "box",
    noun: "container",
    entry,
    keptFile: join(index, keptFileName(entry)),
    dir,
    plan: { kind: "run", sessionId: UID, handover: false, rm },
    owner,
    cwd: "/work",
    write: (t) => out.push(t),
    procOf: laptopProc,
    openSessions: async () => sessions,
    readRecord: async () => {
      calls.push("readRecord");
      if (over.readFails !== undefined) throw new Error(over.readFails);
      return over.fresh ?? null;
    },
    host: () => host,
    attach: async () => {
      calls.push(`attach(presence=${presence().length})`);
      return runtime;
    },
    armNet: () => {
      const read = readOwner(dir);
      calls.push(
        `arm(owner=${read.kind === "owner" ? `${read.owner.kind}:${read.owner.state}` : read.kind})`,
      );
      return () => calls.push("disarm");
    },
    ...more,
  });
  const join_ = async (more: Partial<JoinDeps> = {}): Promise<Joined> => {
    const r = await joinRun(deps(more));
    if (r.kind !== "joined") throw new Error(`not joined: ${r.kind}`);
    return r;
  };
  return {
    config,
    index,
    dir,
    calls,
    out,
    notices,
    presence,
    facts,
    deps,
    join: join_,
    held,
    seededWith,
    quitOpts,
  };
}

describe("tui-target-badge round 3: a joined run's TUI carries the badge", () => {
  test("the badge of the attached runtime reaches `joined.runtime.target` (what `runEngineTui` hands to startTui)", async () => {
    // Mutation: build the joined runtime without the attach's `target` → undefined.
    const r = await rig();
    const target = { engine: "docker", name: "tentacle-ba89d072" } as const;
    const plain = r.deps().attach;
    const joined = await r.join({
      attach: async (host, sessions, permissions) => {
        const runtime = await plain(host, sessions, permissions);
        return Object.assign(runtime, { target });
      },
    });
    expect(joined.runtime.target).toEqual(target);
  });
});

describe("H13 joinRun → finish: one recorded order (docs/feat/detached-handover.md)", () => {
  test("rm=true, the only TUI: presence, runtime, attach, owner, net; quit: lock, use, quit, idle, drain, remove, disarm, purge; presence until the end", async () => {
    // Mutations: delete before `drain`; disarm before the delete; lock released
    // before the delete; presence removed first (docs/fix/detach-live.md A5).
    const r = await rig();
    const joined = await r.join();
    expect(r.calls).toEqual([
      "describe",
      "attach(presence=1)",
      "attachTo",
      "arm(owner=tui:attached)",
    ]);
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual([
      "use(run,absent-ok,presence=1)",
      "quit",
      "drain(owner=idle)",
      "describe",
      "remove(lock=true)",
      "disarm",
    ]);
    expect(existsSync(r.dir)).toBe(false); // the run dir, the lock with it
    expect(readKept(r.index).entries).toEqual([]);
    expect(r.out.join("")).toContain("removed box");
  });

  test("R6 the last TUI's net asks the runtime's save check (a SIGTERM / SIGHUP / crash mid-turn keeps it)", async () => {
    // Owner, 2026-11-02. Mutation: the TUI arms with `() => true` → its crash deletes the only copy.
    const confirmed = { value: false };
    const r = await rig({ confirmed });
    let saved: (() => boolean) | undefined;
    let kept: (() => void) | undefined;
    let alone: (() => boolean) | undefined;
    await r.join({
      armNet: (_host, othersAlive, check?: () => boolean, onKept?: () => void) => {
        alone = () => !othersAlive();
        saved = check;
        kept = onKept;
        return () => {};
      },
    });
    expect(alone?.()).toBe(true);
    expect(saved?.() ?? true).toBe(false); // what the net would delete on: nothing confirmed
    // What the net writes when it keeps it: `ps` says why, until `rm`.
    kept?.();
    expect(statusOf(readOwner(r.dir), false, Date.now(), 0)).toBe(
      "idle (not saved — workload kept: tentacle rm box)",
    );
    confirmed.value = true;
    expect(saved?.() ?? true).toBe(true); // confirmed: deletes, as before
  });

  test("KO4 the pod no longer has the session: the seeded session is opened at the join, before the record and the net", async () => {
    // docs/fix/detach-live.md fix round 6. Mutation: no `openSeeded` → each TUI
    // stays lazy on its own stale seed (two copies, the last save wins).
    const r = await rig({ gone: true });
    await r.join();
    expect(r.calls).toEqual([
      "describe",
      "attach(presence=1)",
      "attachTo",
      "readRecord",
      "openSeeded",
      "arm(owner=tui:attached)",
    ]);
  });

  test("R8 the seed is the laptop copy read right before `openSeeded`, never the one from before the dial", async () => {
    // docs/fix/detach-live.md fix round 7. Mutation: `openSeeded()` with no
    // record → the join seeds from the copy it read before a slow dial, and
    // drops what another TUI saved and closed meanwhile.
    const fresh: SessionRecord = {
      id: UID,
      cwd: "/work",
      model: "m",
      createdAt: 1,
      updatedAt: 2,
      title: "t",
      messages: [{ role: "user", content: "echo due" }],
    };
    const r = await rig({ gone: true, fresh });
    const joined = await r.join();
    expect(r.seededWith).toEqual([fresh]);
    expect(joined.sessions.resume).toEqual(fresh); // the screen draws the same copy
  });

  test("R8 an attached join (the pod has the session) reads no record at all", async () => {
    const r = await rig();
    await r.join();
    expect(r.calls).not.toContain("readRecord");
  });

  test("R8 a copy that cannot be read: no join seeds from a stale one — said, released", async () => {
    const r = await rig({ gone: true, readFails: "file unreadable" });
    const result = await joinRun(r.deps());
    expect(result.kind).toBe("exit");
    expect(r.out.join("")).toContain("failed: file unreadable");
    expect(r.calls).not.toContain("openSeeded");
    expect(r.calls.at(-1)).toBe("release");
  });

  test("KO4 the seeded open fails: said, nothing armed, released", async () => {
    const r = await rig({ gone: true, seedFails: "link down" });
    const result = await joinRun(r.deps());
    expect(result.kind).toBe("exit");
    expect(r.out.join("")).toContain("failed: link down");
    expect(r.calls).toEqual([
      "describe",
      "attach(presence=1)",
      "attachTo",
      "readRecord",
      "openSeeded",
      "release",
    ]);
    expect(r.presence()).toEqual([]);
  });

  test("rm=false: no lock, no read, no delete; the run's record says idle", async () => {
    const r = await rig({ rm: false });
    const joined = await r.join();
    expect(r.calls).not.toContain("arm(owner=tui:attached)");
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual(["quit", "drain(owner=idle)"]);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.held()).toBe(false);
    expect(r.presence()).toEqual([]);
  });

  test("fix/run-rm-flag: only an `rm` run warns that quitting removes the workload", async () => {
    // Mutation: invert the notice's test → a kept run is told its quit deletes it.
    const removing = await rig();
    await (await removing.join()).finish(true);
    expect(removing.notices.join("\n")).toContain("Quitting removes the container");
    const kept = await rig({ rm: false });
    await (await kept.join()).finish(true);
    expect(kept.notices.join("\n")).not.toContain("Quitting removes");
  });

  test("a delete that fails: said, kept in `detail`, net disarmed, the run dir and the lock released", async () => {
    const r = await rig();
    const joined = await r.join({
      host: () =>
        ({
          describe: async () => ({ status: "running", labels: KEPT }),
          remove: async () => {
            throw new Error("engine down");
          },
          removeBestEffort: () => {},
        }) as unknown as EngineHost,
    });
    await joined.finish(true);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.detail).toBe(
      "not removed: engine down — tentacle rm box",
    );
    expect(r.out.join("")).toContain("not removed: engine down — tentacle rm box");
    expect(r.calls.at(-1)).toBe("disarm");
    expect(r.held()).toBe(false);
    expect(existsSync(r.dir)).toBe(true);
  });
});

describe("D11/D12 a `/quit` that closes the session for all (docs/fix/detach-live.md A5)", () => {
  test("D11 rm=true, `y` with O on the session: lock, use, quit(forAll), wait for O, idle, drain, remove, disarm, purge; my presence until the end", async () => {
    // Mutations: presence removed first (`quit(forAll,presence=1)`); delete
    // before the wait (`remove(…,presence=2)`); `closeForAll` not passed.
    const o = { path: "" };
    const r = await rig({
      onQuit: () => {
        // O, on the same session, leaves once the close reaches it.
        setTimeout(() => rmSync(o.path, { force: true }), 30);
      },
    });
    const joined = await r.join();
    o.path = writePresence(r.dir, process.ppid, laptopProc, UID);
    expect(joined.runQuit.othersOnSession()).toBe(1);
    joined.runQuit.closeForAll();
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual([
      "use(run,absent-ok,presence=2)",
      "quit(forAll,presence=2)",
      "drain(owner=idle)",
      "describe",
      "remove(lock=true)",
      "disarm",
    ]);
    expect(existsSync(r.dir)).toBe(false);
    expect(r.out.join("")).toContain("removed box");
  });

  test("D10 `/clear` moves a TUI's presence: not counted on the run's session; the last quit, on the fresh one, removes", async () => {
    // Mutation: `createSession` not wrapped → the `/clear`ed TUI still counts (a dialog, D1 scope lost).
    const r = await rig({ sessionIds: ["FRESH-1"] });
    const mine = await r.join();
    const cleared = await r.join({ pid: process.ppid });
    expect(mine.runQuit.othersOnSession()).toBe(1);
    expect(cleared.createSession().sessionId).toBe("FRESH-1");
    expect(mine.runQuit.othersOnSession()).toBe(0);
    expect(cleared.runQuit.othersOnSession()).toBe(0);
    // Mine quits first: its quit ends its session, so it decides: stay, said why (D1).
    r.calls.length = 0;
    await mine.finish(true);
    expect(r.calls).toEqual([
      "use(run,absent-ok,presence=2)",
      "quit",
      "drain(owner=attached)",
      "disarm",
    ]);
    expect(r.out.join("")).toContain(
      "box not removed: another terminal is on another session — tentacle rm box",
    );
    expect(r.held()).toBe(false);
    // The `/clear`ed one, alone now: `use` read for ITS session, then the delete.
    r.calls.length = 0;
    await cleared.finish(true);
    expect(r.calls[0]).toBe("use(FRESH-1,absent-ok,presence=1)");
    expect(r.calls).toContain("remove(lock=true)");
    expect(existsSync(r.dir)).toBe(false);
  });

  test("D11 `y`, then the other TUI never leaves: the wait is bounded, the workload stays, said why", async () => {
    // Mutation: `othersAttached` hard-coded 0 → deleted under a live terminal.
    const r = await rig();
    const joined = await r.join({ othersWaitMs: 50 });
    writePresence(r.dir, process.ppid, laptopProc, UID); // hung: never leaves
    joined.runQuit.closeForAll();
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.out.join("")).toContain(
      "box not removed: another terminal did not leave the session — tentacle rm box",
    );
    expect(r.held()).toBe(false);
    expect(r.presence()).toHaveLength(1); // the hung one's; mine is gone
  });

  test("Q2 a quit alone on its session is `ending` (the ifLast close ends it); with another TUI on it, not", async () => {
    // Mutation: `ending` never set → a lone /quit leaves the bare prompt in the history.
    const alone = await rig({ rm: false });
    await (await alone.join()).finish(true);
    expect(alone.quitOpts).toEqual([{ closeForAll: false, ending: true }]);
    const shared = await rig({ rm: false });
    const joined = await shared.join();
    writePresence(shared.dir, process.ppid, laptopProc, UID); // another TUI, same session
    await joined.finish(true);
    expect(shared.quitOpts).toEqual([{ closeForAll: false, ending: false }]);
  });

  test("Q10 a session that vanished while the link was down (no terminal known to have closed it): says so, the same leave", async () => {
    // docs/fix/detach-live.md fix round 8. Mutation: `gone` worded as `closed`.
    const r = await rig();
    const joined = await r.join();
    joined.runQuit.closedElsewhere("gone");
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual(["disarm", "release"]);
    expect(r.out.join("")).toBe("[container] box: the session ended in the container\n");
  });

  test("D12 closed by another terminal: no quit, no record, no delete; disarmed, released, the line", async () => {
    // Mutation: the normal path (O takes the lock, reads, deletes).
    const r = await rig();
    const joined = await r.join();
    joined.runQuit.closedElsewhere("closed");
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual(["disarm", "release"]);
    expect(r.presence()).toEqual([]);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.held()).toBe(false);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.state).toBe("attached");
    expect(r.out.join("")).toBe("[container] box: session closed by another terminal\n");
  });

  test("D12 a `closed` that is this TUI's own close (it confirmed first): the closer's path, not O's", async () => {
    const r = await rig();
    const joined = await r.join();
    joined.runQuit.closeForAll();
    joined.runQuit.closedElsewhere("closed");
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toContain("quit(forAll,presence=1)");
    expect(r.calls).toContain("remove(lock=true)");
  });

  test("a session deleted, not closed: never blames another terminal", async () => {
    // Mutation: the one line for every reason.
    const r = await rig();
    const joined = await r.join();
    joined.runQuit.closedElsewhere("deleted");
    await joined.finish(true);
    expect(r.out.join("")).toBe("[container] box: session deleted\n");
  });

  /** What `tentacle ps` says of the run, nobody attached any more. */
  const ps = (r: Awaited<ReturnType<typeof rig>>) =>
    statusOf(readOwner(r.dir), false, Date.now(), attachers(r.dir, laptopProc).length);

  test("F1 rm=false, `y`, O leaves after Q: the last one out writes the run's state, `ps` says idle, never `tui lost`", async () => {
    // Mutation: O's write gone (`owner.state` stays `attached`).
    const r = await rig({ rm: false });
    const q = await r.join();
    const o = await r.join({ pid: process.ppid });
    q.runQuit.closeForAll();
    await q.finish(true);
    o.runQuit.closedElsewhere("closed");
    await o.finish(true);
    expect(r.presence()).toEqual([]);
    expect(ps(r)).toBe("idle");
  });

  test("F1 rm=false, `y`, Q and O each see the other, then both go: `ps` still says idle", async () => {
    // Mutation: Q's write after its leave gone. O runs inside Q's drain: past
    // the check of Q's first write, O's check still sees Q.
    const late: { o?: Joined } = {};
    const r = await rig({
      rm: false,
      onDrain: async () => {
        const o = late.o;
        late.o = undefined;
        await o?.finish(true);
      },
    });
    const q = await r.join();
    const o = await r.join({ pid: process.ppid });
    late.o = o;
    q.runQuit.closeForAll();
    o.runQuit.closedElsewhere("closed");
    await q.finish(true);
    expect(r.presence()).toEqual([]);
    expect(ps(r)).toBe("idle");
  });

  test("F1 rm=false, O leaves with a TUI left on another session: no last state yet, it stays `attached`", async () => {
    // Mutation: O writes with no look at who is left.
    const r = await rig({ rm: false });
    const o = await r.join();
    writePresence(r.dir, process.ppid, laptopProc, "FRESH-1");
    o.runQuit.closedElsewhere("closed");
    await o.finish(true);
    expect(ps(r)).toBe("attached");
  });

  test("R1 rm=false, `y`, Q's save not confirmed, O leaves after Q: Q's noted record stands, `ps -v` agrees with Q's line", async () => {
    // Mutation: O's last-out write over any record (a plain `idle` wipes the note).
    const r = await rig({ rm: false, quit: { sessionsKept: 0, saved: false } });
    const q = await r.join();
    const o = await r.join({ pid: process.ppid });
    q.runQuit.closeForAll();
    await q.finish(true);
    o.runQuit.closedElsewhere("closed");
    await o.finish(true);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.state).toBe("idle");
    expect(read.kind === "owner" && read.owner.detail).toBe("the last save was not confirmed");
  });

  test("F1 rm=true: O never writes after the close, the dir is the closer's to delete", async () => {
    // Mutation: O's write not gated on rm (a write racing the purge).
    const r = await rig();
    const o = await r.join();
    o.runQuit.closedElsewhere("closed");
    await o.finish(true);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.state).toBe("attached");
  });
});

describe("D23 auto-accept on attach: the bit is owner.json's only (docs/fix/detach-live.md B1/B3)", () => {
  const ON = "auto-accept on (Shift+Tab to turn it off)";
  const RUN_TURN = "77777777-7777-4777-8777-777777777777";

  test("who starts how: no file + the run's --auto-accept → ON and said; no file + off → OFF; the session's file wins", async () => {
    // Mutation: the TUI's record writes `autoAccept: false` → a later terminal starts OFF.
    const on = await rig({ owner: { autoAccept: true } });
    const joined = await on.join();
    expect(joined.autoAccept.current()).toBe(true);
    expect(on.notices).toContain(ON);
    const read = readOwner(on.dir);
    expect(read.kind === "owner" && read.owner.autoAccept).toBe(true); // copied, not `false`
    joined.autoAccept.stop();

    const off = await rig();
    const plain = await off.join();
    expect(plain.autoAccept.current()).toBe(false);
    expect(off.notices).not.toContain(ON);
    plain.autoAccept.stop();

    // Turned OFF by a TUI, everybody left: a later attach stays OFF (owner Q2 (a)).
    const turnedOff = await rig({ owner: { autoAccept: true } });
    writeAutoAccept(join(turnedOff.dir, "auto-accept", UID), false);
    const later = await turnedOff.join();
    expect(later.autoAccept.current()).toBe(false);
    expect(turnedOff.notices).not.toContain(ON);
    later.autoAccept.stop();
  });

  test("the pod cannot switch it on: a socket reply saying `autoAccept: true` under an OFF record → OFF, no notice", async () => {
    // Mutation: read the bit from the `prepare` reply.
    const r = await rig();
    const lock = acquireResidentLock(r.dir, laptopProc);
    const replies = [{ ok: true, appVersion: "1", autoAccept: true }, { ok: true }];
    const joined = await joinRun(
      r.deps({
        plan: { kind: "run", sessionId: UID, handover: true, rm: true },
        handoverTimes: { noSocketMs: 30, busyMs: 2000, pollMs: 5, busyPollMs: 5, ackMs: 200 },
        dial: async () => ({
          closed: new Promise(() => {}),
          close: () => {},
          send: async () => replies.shift() as ControlReply,
        }),
      }),
    );
    if (joined.kind !== "joined") throw new Error(joined.kind);
    expect(joined.autoAccept.current()).toBe(false);
    expect(r.notices.join("\n")).not.toContain("auto-accept");
    expect(r.notices.join("\n")).not.toContain("Auto-accept ended");
    joined.autoAccept.stop();
    lock.release();
  });

  test("the run's turn is adopted from the record; the record carries it on", async () => {
    // Mutation: no `adoptTurn` → the run's turn stays foreign, its asks prompt.
    const adopted: (string | undefined)[] = [];
    const r = await rig({ owner: { runTurnId: RUN_TURN } });
    const joined = await r.join({
      attach: async () =>
        ({
          attachTo: async (_id: string, _rec: unknown, opts?: { adoptTurn?: string }) => {
            adopted.push(opts?.adoptTurn);
            return true;
          },
          createSession: () => ({ sessionId: UID }),
          release: async () => {},
        }) as unknown as LocalRuntime,
    });
    expect(adopted).toEqual([RUN_TURN]);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.runTurnId).toBe(RUN_TURN);
    joined.autoAccept.stop();
  });

  test("the hand-over: the `prepare` ack's turn is adopted and recorded; the `commit` ack's wake is returned", async () => {
    // docs/fix/detached-autowake.md. Mutation: `joinRun` ignores `wakePending` → it is lost.
    const adopted: (string | undefined)[] = [];
    const r = await rig({ owner: { runTurnId: RUN_TURN } });
    const lock = acquireResidentLock(r.dir, laptopProc);
    const replies = [
      { ok: true, turnId: "WAKE-TURN" },
      { ok: true, wakePending: true },
    ];
    const joined = await r.join({
      plan: { kind: "run", sessionId: UID, handover: true, rm: false },
      dial: async () => ({
        closed: new Promise(() => {}),
        close: () => {},
        send: async () => replies.shift() as ControlReply,
      }),
      attach: async () =>
        ({
          attachTo: async (_id: string, _rec: unknown, opts?: { adoptTurn?: string }) => {
            adopted.push(opts?.adoptTurn);
            return true;
          },
          createSession: () => ({ sessionId: UID }),
          release: async () => {},
        }) as unknown as LocalRuntime,
    });
    expect(adopted).toEqual(["WAKE-TURN"]);
    expect(joined.wakePending).toBe(true);
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.runTurnId).toBe("WAKE-TURN");
    joined.autoAccept.stop();
    lock.release();
  });

  test("an older relay's acks say neither: the record's turn, nothing pending", async () => {
    const adopted: (string | undefined)[] = [];
    const r = await rig({ owner: { runTurnId: RUN_TURN } });
    const lock = acquireResidentLock(r.dir, laptopProc);
    const replies = [{ ok: true }, { ok: true }];
    const joined = await r.join({
      plan: { kind: "run", sessionId: UID, handover: true, rm: false },
      dial: async () => ({
        closed: new Promise(() => {}),
        close: () => {},
        send: async () => replies.shift() as ControlReply,
      }),
      attach: async () =>
        ({
          attachTo: async (_id: string, _rec: unknown, opts?: { adoptTurn?: string }) => {
            adopted.push(opts?.adoptTurn);
            return true;
          },
          createSession: () => ({ sessionId: UID }),
          release: async () => {},
        }) as unknown as LocalRuntime,
    });
    expect(adopted).toEqual([RUN_TURN]);
    expect(joined.wakePending).toBe(false);
    joined.autoAccept.stop();
    lock.release();
  });

  test("`/clear` moves the shared state's key: a flip there writes the fresh session's file, never the run's", async () => {
    const r = await rig({ owner: { autoAccept: true }, sessionIds: ["FRESH-2"] });
    const joined = await r.join();
    joined.createSession();
    joined.autoAccept.set(false);
    expect(existsSync(join(r.dir, "auto-accept", "FRESH-2"))).toBe(true);
    expect(existsSync(join(r.dir, "auto-accept", UID))).toBe(false);
    joined.autoAccept.stop();
  });
});

describe("H14 the last-quit race, deterministic", () => {
  test("an attacher registers just before the last quit's lock: it keeps the workload", async () => {
    // Mutation: the authoritative read of `others` before the lock → delete under it.
    const r = await rig();
    let armed = false;
    const joined = await r.join({
      lockOf: (dir) => {
        if (armed) {
          armed = false;
          // B (another live process) registers after A's advisory read, in
          // the instant before A takes the lock.
          writePresence(dir, process.ppid, laptopProc);
        }
        return lockHolder(dir, laptopProc);
      },
    });
    armed = true;
    r.calls.length = 0;
    await joined.finish(true);
    expect(armed).toBe(false); // the hook ran inside A's quit
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.held()).toBe(false);
  });

  test("an attacher that sees the lock waits, then plans again; its presence was written first", async () => {
    // Mutation: read the lock before writing presence → `presence=0` at the read.
    const r = await rig();
    const lock = acquireResidentLock(r.dir, laptopProc);
    const seen: number[] = [];
    setTimeout(() => lock.release(), 30);
    const result = await joinRun(
      r.deps({
        lockOf: (dir) => {
          seen.push(r.presence().length);
          return lockHolder(dir, laptopProc);
        },
      }),
    );
    expect(seen[0]).toBe(1);
    expect(result.kind).toBe("closing");
    expect(r.presence()).toEqual([]);
    expect(r.calls).toEqual([]); // nothing dialled
  });
});

describe("H15 rm=true, two TUIs", () => {
  test("the first quits: no delete, its net disarmed; the second: the delete", async () => {
    // Mutation: delete on any quit.
    const r = await rig();
    const first = await r.join({ pid: process.ppid });
    const second = await r.join();
    r.calls.length = 0;
    await first.finish(true);
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.calls).toContain("disarm");
    expect(r.calls).not.toContain("drain(owner=idle)"); // not the last: no idle
    expect(r.held()).toBe(false);
    r.calls.length = 0;
    await second.finish(true);
    expect(r.calls).toContain("remove(lock=true)");
    expect(existsSync(r.dir)).toBe(false);
  });
});

describe("H18 DR-8 and H20", () => {
  test("describe null: the exact line, no runtime built; a describe that throws goes on", async () => {
    // Mutation: fall through to the dial.
    const r = await rig();
    r.facts.value = null;
    const gone = await joinRun(r.deps());
    expect(gone).toEqual({ kind: "exit", code: 1 });
    expect(r.out.join("")).toContain(
      `box: the container no longer exists — session ${UID} cannot be re-attached; its transcript is kept on this laptop`,
    );
    expect(r.calls).toEqual(["describe"]);
    expect(r.presence()).toEqual([]);
    const thrown = await joinRun(
      r.deps({
        host: () =>
          ({
            describe: async () => {
              throw new Error("socket");
            },
          }) as unknown as EngineHost,
      }),
    );
    expect(thrown.kind).toBe("joined");
  });
});

describe("Phase B: the attacher's hand-over (steps 6 and 8)", () => {
  /** A live relay: its lock held (by this process), its record. */
  const live = async (over: Parameters<typeof rig>[0] = {}) => {
    const r = await rig(over);
    const lock = acquireResidentLock(r.dir, laptopProc);
    return { ...r, lock };
  };
  /** A dial whose connections answer from `script`, recording every frame. */
  const scripted = (calls: string[], script: ControlReply[]) => {
    const dial = async (): Promise<ControlConn | null> => ({
      closed: new Promise(() => {}),
      close: () => calls.push("close"),
      send: async (request) => {
        calls.push(request.op);
        const reply = script.shift();
        if (!reply) throw new Error("no reply");
        return reply;
      },
    });
    return dial;
  };
  const fast = { noSocketMs: 30, busyMs: 2000, pollMs: 5, busyPollMs: 5, ackMs: 200 };
  const handover = (r: Awaited<ReturnType<typeof live>>, more: Partial<JoinDeps> = {}) =>
    r.deps({
      plan: { kind: "run", sessionId: UID, handover: true, rm: true },
      handoverTimes: fast,
      ...more,
    });

  test("H33 one recorded order: prepare, attachTo, commit, owner, net", async () => {
    const r = await live();
    const joined = await joinRun(
      handover(r, {
        dial: scripted(r.calls, [{ ok: true, appVersion: "1" }, { ok: true }]),
      }),
    );
    expect(joined.kind).toBe("joined");
    expect(r.calls).toEqual([
      "describe",
      "attach(presence=1)",
      "prepare",
      "attachTo",
      "commit",
      "close",
      "arm(owner=tui:attached)",
    ]);
    r.lock.release();
  });

  test("H32 `busy`: wait, never open; then `handed_over`: a plain join, no commit", async () => {
    // Mutation: a joiner opens on `busy` → it and a thawed relay could both decide.
    const r = await live();
    const joined = await joinRun(
      handover(r, {
        dial: scripted(r.calls, [
          { ok: false, reason: "busy" },
          { ok: false, reason: "busy" },
          { ok: false, reason: "handed_over" },
        ]),
      }),
    );
    expect(joined.kind).toBe("joined");
    const ops = r.calls.filter((c) => c !== "close");
    expect(ops).toEqual([
      "describe",
      "attach(presence=1)",
      "prepare",
      "prepare",
      "prepare",
      "attachTo",
      "arm(owner=tui:attached)",
    ]);
    r.lock.release();
  });

  test("`busy` is said once, not a silent wait", async () => {
    const r = await live();
    await joinRun(
      handover(r, {
        dial: scripted(r.calls, [
          { ok: false, reason: "busy" },
          { ok: false, reason: "busy" },
          { ok: false, reason: "handed_over" },
        ]),
      }),
    );
    const said = r.out.join("").match(/another terminal is taking this run over/g);
    expect(said).toHaveLength(1);
    r.lock.release();
  });

  test("H36 a relay still draining after the hand-over: a later terminal JOINS at once (Q3), never `closing`", async () => {
    // Mutation: drop the probe → it waits `closingWaitMs` and exits "still closing".
    const r = await live({ owner: { kind: "tui", state: "attached" } });
    const joined = await joinRun(
      handover(r, {
        closingWaitMs: 20,
        dial: scripted(r.calls, [
          { ok: false, reason: "handed_over" },
          { ok: false, reason: "handed_over" },
        ]),
      }),
    );
    expect(joined.kind).toBe("joined");
    expect(r.out.join("")).not.toContain("closing");
    expect(r.calls).toContain("attachTo");
    expect(r.calls).not.toContain("commit");
    expect(r.presence()).toHaveLength(1);
    r.lock.release();
  });

  test("H36 the TUI's record keeps the relay's socket: a later terminal must find it off its usual path", async () => {
    // Mutation: drop `control` from the TUI's record → the drain cannot be found: "closing".
    const r = await rig({ owner: { control: "/short/c.sock" } });
    await r.join();
    const read = readOwner(r.dir);
    expect(read.kind === "owner" && read.owner.control).toBe("/short/c.sock");
  });

  test("H32 `busy`, then the other aborted: this attacher prepares itself", async () => {
    const r = await live();
    const joined = await joinRun(
      handover(r, {
        dial: scripted(r.calls, [{ ok: false, reason: "busy" }, { ok: true }, { ok: true }]),
      }),
    );
    expect(joined.kind).toBe("joined");
    expect(r.calls.filter((c) => c !== "close")).toEqual([
      "describe",
      "attach(presence=1)",
      "prepare",
      "prepare",
      "attachTo",
      "commit",
      "arm(owner=tui:attached)",
    ]);
    r.lock.release();
  });

  test("no ack and the relay lives: released, presence removed, exit 1; no ack and it died: carry on", async () => {
    const r = await live();
    const failed = await joinRun(
      handover(r, { dial: scripted(r.calls, [{ ok: true }]) }), // commit: no reply
    );
    expect(failed).toEqual({ kind: "exit", code: 1 });
    expect(r.calls).toContain("release");
    expect(r.presence()).toEqual([]);
    expect(r.out.join("")).toContain("the hand-over did not complete");
    r.lock.release();
    r.calls.length = 0;
    // The lock is free now: a relay that died mid-commit; the attacher is the owner.
    const relock = acquireResidentLock(r.dir, laptopProc);
    const dial = scripted(r.calls, [{ ok: true }]);
    const carried = await joinRun(
      handover(r, {
        dial: async () => {
          const conn = await dial();
          return (
            conn && {
              ...conn,
              send: async (request: ControlRequest) => {
                if (request.op === "commit") relock.release();
                return conn.send(request);
              },
            }
          );
        },
      }),
    );
    expect(carried.kind).toBe("joined");
  });

  test("`leaving`: closing; `version` or `session`: S2's refusal, nothing opened", async () => {
    const r = await live();
    const closing = await joinRun(
      handover(r, { dial: scripted(r.calls, [{ ok: false, reason: "leaving" }]) }),
    );
    expect(closing.kind).toBe("closing");
    for (const reason of ["version", "session", "stopped"] as const) {
      r.calls.length = 0;
      const refused = await joinRun(
        handover(r, {
          dial: scripted(r.calls, [{ ok: false, reason }]),
          relayRefusal: () => "a detached run owns it (S2)",
        }),
      );
      expect(refused).toEqual({ kind: "exit", code: 1 });
      expect(r.calls).not.toContain("attachTo");
      expect(r.out.join("")).toContain("a detached run owns it (S2)");
    }
    r.lock.release();
  });

  test("no socket within its wait: S2's refusal under a relay record; never a takeover", async () => {
    const r = await live();
    const refused = await joinRun(
      handover(r, { dial: async () => null, relayRefusal: () => "S2 refusal" }),
    );
    expect(refused).toEqual({ kind: "exit", code: 1 });
    expect(r.calls).not.toContain("attachTo");
    r.lock.release();
  });

  test("attachTo false mid hand-over: the socket closed (abort), released, `still starting`", async () => {
    const r = await live();
    const result = await joinRun(
      handover(r, {
        dial: scripted(r.calls, [{ ok: true }]),
        attach: async () =>
          ({
            attachTo: async () => {
              r.calls.push("attachTo");
              return false;
            },
            release: async () => {
              r.calls.push("release");
            },
          }) as unknown as LocalRuntime,
      }),
    );
    expect(result).toEqual({ kind: "exit", code: 1 });
    expect(r.calls).toEqual(["describe", "prepare", "attachTo", "close", "release"]);
    expect(r.out.join("")).toContain("still starting");
    r.lock.release();
  });
});

describe("H35 the rm=true delete depends on a CONFIRMED last save", () => {
  test("not confirmed by the quit: the workload stays and it is said; the net disarmed, the lock released", async () => {
    // Mutation: drop `saved` from `quitPlan` → deleted with the pod's only copy.
    const r = await rig({ quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.out.join("")).toContain(
      "not removed: the last save was not confirmed — tentacle rm box",
    );
    expect(r.calls.at(-1)).toBe("disarm");
    expect(r.held()).toBe(false);
    expect(existsSync(r.dir)).toBe(true);
  });

  test("the saver's drain reports a session not on disk: the same", async () => {
    // Mutation: ignore `drain`'s lines.
    const r = await rig({ drainLines: ["session 1234 not saved"] });
    const joined = await r.join();
    await joined.finish(true);
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.out.join("")).toContain("not removed: the last save was not confirmed");
  });

  test("rm=false: a save not confirmed changes nothing (no delete to hold)", async () => {
    const r = await rig({ rm: false, quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    expect(r.out.join("")).not.toContain("not removed");
  });

  test("R2 rm=false: a save not confirmed is NOT a silent detach — the session is still in the container, `attach` reopens it", async () => {
    // Mutation: only the `why` paths say anything → the user believes the run ended.
    // An unconfirmed save detaches: the daemon keeps the session (`sessionsKept` 1).
    const r = await rig({ rm: false, quit: { sessionsKept: 1, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    const text = r.out.join("");
    expect(text).toContain("the last save was not confirmed");
    expect(text).toContain("the session is still in the container");
    expect(text).toContain("`tentacle attach box` reopens it");
    // A rm=false detach deletes nothing: never the removal wording.
    expect(text).not.toContain("not removed");
    expect(text).not.toContain("tentacle rm");
    // The state file carries it too: `ps` agrees with what the terminal said.
    const read = readOwner(r.dir);
    expect(read.kind === "owner" ? (read.owner.detail ?? "") : "").toContain(
      "the last save was not confirmed",
    );
  });

  test("R2 rm=true: the same line, next to `not removed` (the session is live, not gone)", async () => {
    // Mutation: the `why` line alone → "not removed … tentacle rm box" reads as "the run ended".
    const r = await rig({ quit: { sessionsKept: 1, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    const text = r.out.join("");
    expect(text).toContain("not removed: the last save was not confirmed");
    expect(text).toContain("the session is still in the container");
    expect(text).toContain("`tentacle attach box` reopens it");
    expect(text).toContain("tentacle rm box");
  });

  test('A5 a save not confirmed of a session the daemon closed: never "still in the container" (FAIL 39\'s untrue line)', async () => {
    // Mutation: the "still in" wording whatever `sessionsKept` says.
    const r = await rig({ quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    const text = r.out.join("");
    expect(text).toContain(
      "box: the last save was not confirmed — the session ended, but its last save did not reach this laptop",
    );
    expect(text).not.toContain("still in the container");
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
  });
});

describe("H37 the last quit and a lock holder", () => {
  /** A `dial` that says what is behind the socket. */
  const relayBehind = async (): Promise<ControlConn> => ({
    closed: new Promise(() => {}),
    close: () => {},
    send: async () => ({ ok: false, reason: "handed_over" }),
  });

  test("a draining relay is stopped, then the lock and the delete (the failure-mode row)", async () => {
    // Mutation: no stop → the lock is lost and the delete skipped.
    const r = await rig();
    const relay: { lock?: { release(): void } } = {};
    const joined = await r.join({
      dial: relayBehind,
      stopHolder: async () => {
        r.calls.push("stop");
        relay.lock?.release();
      },
    });
    relay.lock = acquireResidentLock(r.dir, laptopProc);
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls.indexOf("stop")).toBeLessThan(r.calls.indexOf("remove(lock=true)"));
    expect(r.calls).toContain("remove(lock=true)");
    expect(existsSync(r.dir)).toBe(false);
  });

  test("F2 a quit next to a TUI on another session: the draining relay is NOT stopped; no lock, no delete, said why", async () => {
    // Mutation: stop on `othersOnSession()` alone (the review's P2: the relay
    // serves B's call, B gets the KO 5 RpcError). `spared` not fed to `quitPlan`:
    // the untrue "another terminal is closing the run".
    const r = await rig({ sessionIds: ["FRESH-1"] });
    const joined = await r.join({
      dial: relayBehind,
      stopHolder: async () => {
        r.calls.push("stop");
      },
    });
    joined.createSession(); // `/clear`: this TUI moved to a fresh session
    writePresence(r.dir, process.ppid, laptopProc, UID); // B, mid-turn on the run's
    const relay = acquireResidentLock(r.dir, laptopProc);
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).not.toContain("stop");
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.calls).toContain("disarm");
    expect(r.out.join("")).toContain(
      "box not removed: another terminal is on another session — tentacle rm box",
    );
    expect(r.out.join("")).not.toContain("closing the run");
    expect(lockHolder(r.dir, laptopProc)).not.toBeNull(); // still the relay's
    relay.release();
  });

  test("F2 `y` with O on the SAME session: the relay's call is the turn being stopped, it IS stopped, the delete goes on", async () => {
    // Mutation: the review's literal `others() === 0`: the lock is lost, no delete,
    // the untrue "another terminal is closing the run".
    const o = { path: "" };
    const r = await rig({
      onQuit: () => {
        setTimeout(() => rmSync(o.path, { force: true }), 30);
      },
    });
    const relay: { lock?: { release(): void } } = {};
    const joined = await r.join({
      dial: relayBehind,
      stopHolder: async () => {
        r.calls.push("stop");
        relay.lock?.release();
      },
    });
    o.path = writePresence(r.dir, process.ppid, laptopProc, UID);
    relay.lock = acquireResidentLock(r.dir, laptopProc);
    joined.runQuit.closeForAll();
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toContain("stop");
    expect(r.calls).toContain("remove(lock=true)");
    expect(existsSync(r.dir)).toBe(false);
  });

  test("R2 a Ctrl+C alone a moment ago, O joins the session during the relay probe: the relay is NOT stopped", async () => {
    // Mutation: the same-session exemption for a Ctrl+C too (`others() > onSession`):
    // the relay serving O's call is stopped under it, and the lock then goes to O anyway.
    const r = await rig();
    const armed = { on: false };
    const relay: { lock?: { release(): void } } = {};
    const joined = await r.join({
      dial: async () => ({
        closed: new Promise(() => {}),
        close: () => {},
        send: async () => {
          if (armed.on) writePresence(r.dir, process.ppid, laptopProc, UID);
          return { ok: false, reason: "handed_over" };
        },
      }),
      stopHolder: async () => {
        r.calls.push("stop");
        relay.lock?.release();
      },
    });
    relay.lock = acquireResidentLock(r.dir, laptopProc);
    armed.on = true;
    r.calls.length = 0;
    await joined.finish(true); // no closeForAll: a Ctrl+C
    expect(r.calls).not.toContain("stop");
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(lockHolder(r.dir, laptopProc)).not.toBeNull(); // still the relay's
    relay.lock.release();
  });

  test("R3 `y`, O on the session and B on another, relay draining: O is waited for, the line names B", async () => {
    // Mutation: the spared path skips the wait: "did not leave the session" for a healthy O.
    const o = { path: "" };
    const r = await rig({
      onQuit: () => {
        setTimeout(() => rmSync(o.path, { force: true }), 30);
      },
    });
    const joined = await r.join({
      dial: relayBehind,
      stopHolder: async () => {
        r.calls.push("stop");
      },
    });
    o.path = writePresence(r.dir, process.ppid, laptopProc, UID);
    const b = Bun.spawn(["sleep", "30"]);
    writePresence(r.dir, b.pid, laptopProc, "FRESH-1");
    const relay = acquireResidentLock(r.dir, laptopProc);
    joined.runQuit.closeForAll();
    r.calls.length = 0;
    await joined.finish(true);
    b.kill();
    relay.release();
    expect(r.calls).not.toContain("stop");
    expect(r.out.join("")).toContain(
      "box not removed: another terminal is on another session — tentacle rm box",
    );
    expect(r.out.join("")).not.toContain("did not leave the session");
  });

  test("another TUI closing it (no socket behind the lock): never stopped; no delete, and it says who", async () => {
    // Mutation: stop any holder → A's save and delete are cut short by B's SIGTERM.
    const r = await rig();
    const joined = await r.join({
      dial: async () => null,
      stopHolder: async () => {
        r.calls.push("stop");
      },
    });
    const other = acquireResidentLock(r.dir, laptopProc);
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).not.toContain("stop");
    expect(r.calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(r.calls).toContain("disarm");
    expect(r.out.join("")).toContain("another terminal is closing the run");
    expect(r.out.join("")).not.toContain("tentacle rm");
    other.release();
  });

  test("the run was removed under this TUI (`rm`): the quit says nothing untrue", async () => {
    const r = await rig();
    const joined = await r.join();
    rmSync(r.dir, { recursive: true, force: true });
    await joined.finish(true);
    expect(r.out.join("")).not.toContain("another");
    expect(r.out.join("")).not.toContain("not removed");
    expect(r.calls).toContain("disarm");
  });
});

describe("the rows with no test (review finding 7)", () => {
  test("the run is still closing past the wait: exit 1, presence gone, nothing dialled", async () => {
    // Mutation: return `closing` on the timeout too → a join under the deleter.
    const r = await rig();
    const lock = acquireResidentLock(r.dir, laptopProc);
    const result = await joinRun(r.deps({ closingWaitMs: 30 }));
    expect(result).toEqual({ kind: "exit", code: 1 });
    expect(r.out.join("")).toContain("box: the run is still closing; retry in a moment");
    expect(r.presence()).toEqual([]);
    expect(r.calls).toEqual([]);
    lock.release();
  });

  test("a presence that cannot be written: exit 1, said, nothing dialled (the net and the last quit would lie)", async () => {
    // Mutation: go on without presence.
    const r = await rig();
    writeFileSync(attachDirOf(r.dir), "in the way");
    const result = await joinRun(r.deps());
    expect(result).toEqual({ kind: "exit", code: 1 });
    expect(r.out.join("")).toContain("box: could not register this terminal on the run");
    expect(r.calls).toEqual([]);
  });

  test("the run's record cannot be written: a notice, the join goes on", async () => {
    // Mutation: drop the notice.
    const r = await rig();
    rmSync(ownerPath(r.dir));
    mkdirSync(ownerPath(r.dir));
    const joined = await r.join();
    expect(joined.kind).toBe("joined");
    expect(r.notices.join("")).toContain("state file could not be written");
  });
});

describe("H20", () => {
  test("H20 Ink never ran: release, no close, no delete; the session stays", async () => {
    // Mutation: run the quit path.
    const r = await rig();
    const joined = await r.join();
    r.calls.length = 0;
    await joined.finish(false);
    expect(r.calls).toEqual(["disarm", "release"]);
    expect(r.presence()).toEqual([]);
    expect(existsSync(r.dir)).toBe(true);
  });
});
