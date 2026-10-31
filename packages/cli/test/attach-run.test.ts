import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JoinDeps, type Joined, joinRun } from "../src/attach-run.ts";
import type { ControlConn, ControlReply, ControlRequest } from "../src/control-socket.ts";
import type { EngineHost } from "../src/engine-host.ts";
import { keptDir, keptFileName, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import type { LocalRuntime } from "../src/local-runtime.ts";
import { acquireResidentLock, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  attachDirOf,
  ensureRunDir,
  laptopProc,
  ownerPath,
  readOwner,
  runDirFor,
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
    keep?: boolean;
    owner?: Partial<OwnerRecord>;
    quit?: { sessionsKept: number; saved: boolean };
    drainLines?: string[];
  } = {},
) {
  const keep = over.keep ?? false;
  const config = mkdtempSync(join(tmpdir(), "attach-run-"));
  const index = keptDir(config);
  recordKept(index, entry);
  const dir = ensureRunDir(runDirFor(config, entry));
  const owner: OwnerRecord = {
    schemaVersion: 1,
    kind: "relay",
    pid: 2 ** 30,
    appVersion: "1",
    sessionId: UID,
    state: "idle",
    lastActivityAt: 1,
    autoAccept: false,
    keep,
    cwd: "/work",
    ...over.owner,
  };
  writeOwner(dir, owner);
  const calls: string[] = [];
  const out: string[] = [];
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
      calls.push(`remove(lock=${held()})`);
    },
    removeBestEffort: () => {},
  } as unknown as EngineHost;
  const runtime = {
    attachTo: async () => {
      calls.push("attachTo");
      return true;
    },
    residentUse: async () => {
      calls.push(`use(presence=${presence().length})`);
      return { jobs: 1, running: true, others: 0 };
    },
    quit: async () => {
      calls.push("quit");
      return over.quit ?? { sessionsKept: 0, saved: true };
    },
    release: async () => {
      calls.push("release");
    },
  } as unknown as LocalRuntime;
  const sessions = await openTuiSessions(
    { root: join(config, "sessions"), cwd: "/work" },
    { wanted: false },
    () => {},
  );
  if ("exit" in sessions) throw new Error("no sessions");
  const notices: string[] = [];
  sessions.notices.onNotice((text) => notices.push(text));
  const drain = sessions.saver.drain.bind(sessions.saver);
  sessions.saver.drain = async (options) => {
    const read = readOwner(dir);
    calls.push(`drain(owner=${read.kind === "owner" ? read.owner.state : read.kind})`);
    return [...(await drain(options)), ...(over.drainLines ?? [])];
  };
  const deps = (more: Partial<JoinDeps> = {}): JoinDeps => ({
    name: "box",
    noun: "container",
    entry,
    keptFile: join(index, keptFileName(entry)),
    dir,
    plan: { kind: "run", sessionId: UID, handover: false, keep },
    owner,
    cwd: "/work",
    write: (t) => out.push(t),
    procOf: laptopProc,
    openSessions: async () => sessions,
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
  return { config, index, dir, calls, out, notices, presence, facts, deps, join: join_, held };
}

describe("H13 joinRun → finish: one recorded order (docs/feat/detached-handover.md)", () => {
  test("keep=false, the only TUI: presence, runtime, attach, owner, net; quit: presence gone, lock, use, quit, idle, drain, remove, disarm, purge", async () => {
    // Mutations: delete before `drain`; disarm before the delete; lock released before the delete.
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
      "use(presence=0)",
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

  test("keep: no lock, no read, no delete; the run's record says idle", async () => {
    const r = await rig({ keep: true });
    const joined = await r.join();
    expect(r.calls).not.toContain("arm(owner=tui:attached)");
    r.calls.length = 0;
    await joined.finish(true);
    expect(r.calls).toEqual(["quit", "drain(owner=idle)"]);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.held()).toBe(false);
    expect(r.presence()).toEqual([]);
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

describe("H15 keep=false, two TUIs", () => {
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
      plan: { kind: "run", sessionId: UID, handover: true, keep: false },
      handoverTimes: fast,
      ...more,
    });

  test("H33 one recorded order: prepare, attachTo, commit, owner, net; the relay's auto-accept said ended", async () => {
    const r = await live();
    const joined = await joinRun(
      handover(r, {
        dial: scripted(r.calls, [{ ok: true, appVersion: "1", autoAccept: true }, { ok: true }]),
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

describe("H35 the keep=false delete depends on a CONFIRMED last save", () => {
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

  test("keep: a save not confirmed changes nothing (no delete to hold)", async () => {
    const r = await rig({ keep: true, quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    expect(r.out.join("")).not.toContain("not removed");
  });

  test("R2 keep=true: a save not confirmed is NOT a silent detach — the session is still in the container, `attach` reopens it", async () => {
    // Mutation: only the `why` paths say anything → the user believes the run ended.
    const r = await rig({ keep: true, quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    const text = r.out.join("");
    expect(text).toContain("the last save was not confirmed");
    expect(text).toContain("the session is still in the container");
    expect(text).toContain("`tentacle attach box` reopens it");
    // A keep=true detach deletes nothing: never the removal wording.
    expect(text).not.toContain("not removed");
    expect(text).not.toContain("tentacle rm");
    // The state file carries it too: `ps` agrees with what the terminal said.
    const read = readOwner(r.dir);
    expect(read.kind === "owner" ? (read.owner.detail ?? "") : "").toContain(
      "the last save was not confirmed",
    );
  });

  test("R2 keep=false: the same line, next to `not removed` (the session is live, not gone)", async () => {
    // Mutation: the `why` line alone → "not removed … tentacle rm box" reads as "the run ended".
    const r = await rig({ quit: { sessionsKept: 0, saved: false } });
    const joined = await r.join();
    await joined.finish(true);
    const text = r.out.join("");
    expect(text).toContain("not removed: the last save was not confirmed");
    expect(text).toContain("the session is still in the container");
    expect(text).toContain("`tentacle attach box` reopens it");
    expect(text).toContain("tentacle rm box");
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
