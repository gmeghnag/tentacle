import { describe, expect, test } from "bun:test";
import { type AttachInput, planAttach, quitPlan } from "../src/attach-plan.ts";
import type { OwnerRecord } from "../src/run-state.ts";

const UID = "11111111-1111-4111-8111-111111111111";
const CREATED = "2026-10-27T10:00:00.000Z";
const owner = (over: Partial<OwnerRecord> = {}): OwnerRecord => ({
  schemaVersion: 1,
  kind: "relay",
  pid: 42,
  appVersion: "1",
  sessionId: UID,
  state: "idle",
  lastActivityAt: 1,
  autoAccept: false,
  keep: true,
  cwd: "/work",
  created: CREATED,
  ...over,
});
const input = (over: Partial<AttachInput> = {}): AttachInput => ({
  owner: { kind: "owner", owner: owner() },
  relayAlive: false,
  entryCreated: CREATED,
  tty: true,
  ...over,
});

describe("H10 planAttach (docs/feat/detached-handover.md), first match wins", () => {
  test("no owner.json: plain without a relay, refused with one", () => {
    expect(planAttach(input({ owner: { kind: "none" } }))).toEqual({ kind: "plain" });
    expect(planAttach(input({ owner: { kind: "none" }, relayAlive: true }))).toEqual({
      kind: "refuse",
      why: "relay",
    });
  });

  test("an unreadable owner.json: the lock decides", () => {
    expect(planAttach(input({ owner: { kind: "unknown" }, relayAlive: true }))).toEqual({
      kind: "refuse",
      why: "relay",
    });
    expect(planAttach(input({ owner: { kind: "unknown" } }))).toEqual({ kind: "plain" });
  });

  test("attach-any-folder: no refusal on a folder; the plan carries the run's own", () => {
    // Mutation: refuse (or drop `cwd`) again -> no folder to attach from.
    expect(planAttach(input({ relayAlive: true }))).toMatchObject({ kind: "run", cwd: "/work" });
    // A record from before `cwd` was written: no folder to move to.
    const { cwd: _cwd, ...old } = owner();
    const plan = planAttach(input({ owner: { kind: "owner", owner: old } }));
    expect(plan.kind).toBe("run");
    expect("cwd" in plan).toBe(false);
  });

  test("H35 a record of an earlier workload of that name (a reused name): never the run's identity, nor its delete", () => {
    // Mutation: drop the `created` tie → the new workload gets `keep:false` and the old uid.
    const reused = { entryCreated: "2026-10-30T10:00:00.000Z" };
    const stale = { kind: "owner" as const, owner: owner({ keep: false, state: "failed" }) };
    expect(planAttach(input({ owner: stale, ...reused }))).toEqual({ kind: "plain" });
    // Not even its folder refuses: it says nothing about this workload.
    expect(planAttach(input({ owner: stale, tty: false, ...reused }))).toEqual({
      kind: "plain",
    });
    // A live lock still decides, as for a record it cannot read.
    expect(planAttach(input({ owner: stale, relayAlive: true, ...reused }))).toEqual({
      kind: "refuse",
      why: "relay",
    });
    // Tied to nothing (a record from before `created`): a doubt, so no delete.
    const { created: _created, ...old } = owner({ keep: false });
    expect(planAttach(input({ owner: { kind: "owner", owner: old } }))).toEqual({ kind: "plain" });
  });

  test("--resume of another session: refused under a live relay, else plain", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(planAttach(input({ resumeUid: other, relayAlive: true }))).toEqual({
      kind: "refuse",
      why: "relay",
    });
    expect(planAttach(input({ resumeUid: other }))).toEqual({ kind: "plain" });
    // A TUI-run's live lock holder is not a relay: a plain attach to another session.
    const tui = { kind: "owner" as const, owner: owner({ kind: "tui", state: "attached" }) };
    expect(planAttach(input({ owner: tui, resumeUid: other, relayAlive: true }))).toEqual({
      kind: "plain",
    });
    // Its own uid is the run's session.
    expect(planAttach(input({ resumeUid: UID })).kind).toBe("run");
  });

  test("not a terminal: refused (a TUI that cannot mount would end the run)", () => {
    // Mutation: drop the TTY row → `run` without a terminal.
    expect(planAttach(input({ tty: false }))).toEqual({ kind: "refuse", why: "tty" });
    expect(planAttach(input({ tty: false, relayAlive: true }))).toEqual({
      kind: "refuse",
      why: "tty",
    });
  });

  test("a live relay: the hand-over; otherwise the run's session (stale owner, ended run, join)", () => {
    // Mutations: a live relay reaches `plain`; `plain` for a run with TUIs (Q3 lost).
    expect(planAttach(input({ relayAlive: true }))).toEqual({
      cwd: "/work",
      kind: "run",
      sessionId: UID,
      handover: true,
      keep: true,
    });
    for (const o of [
      owner({ state: "running" }),
      owner({ state: "failed" }),
      owner({ kind: "tui", state: "attached", keep: false }),
      owner({ kind: "tui", state: "idle" }),
    ]) {
      expect(planAttach(input({ owner: { kind: "owner", owner: o } }))).toEqual({
        kind: "run",
        cwd: "/work",
        sessionId: UID,
        handover: false,
        keep: o.keep !== false,
      });
    }
  });
});

describe("H11 quitPlan: the only place a TUI's removal is decided", () => {
  const use = { jobs: 0, running: false, others: 0 };
  const base = {
    keep: false,
    othersAttached: 0,
    othersOnSession: 0,
    saved: true,
    sessionsKept: 0,
    use,
  };

  test("D9 every row, in order (docs/fix/detach-live.md A5)", () => {
    // Mutations: drop `othersAttached`; drop `use.others`; swap `saved` and
    // `othersAttached`; drop `sessionsKept`; count `running` as a hold.
    expect(quitPlan({ ...base, keep: true, othersAttached: 1, saved: false })).toEqual({
      kind: "stay",
    });
    expect(quitPlan({ ...base, saved: false, othersAttached: 1, sessionsKept: 1 })).toEqual({
      kind: "stay",
      why: "the last save was not confirmed",
    });
    // The confirmed `/quit` waited for its session's others: one left is on another session.
    expect(quitPlan({ ...base, othersAttached: 1, sessionsKept: 1, use: null })).toEqual({
      kind: "stay",
      why: "another terminal is on another session",
    });
    // One still on THIS session after the wait is hung: said as such.
    expect(quitPlan({ ...base, othersAttached: 1, othersOnSession: 1 })).toEqual({
      kind: "stay",
      why: "another terminal did not leave the session",
    });
    expect(quitPlan({ ...base, sessionsKept: 1, use: null })).toEqual({
      kind: "stay",
      why: "the daemon did not confirm the session closed",
    });
    expect(quitPlan({ ...base, use: null })).toEqual({
      kind: "stay",
      why: "could not tell whether it is in use",
    });
    expect(quitPlan({ ...base, use: { ...use, others: 1 } })).toEqual({
      kind: "stay",
      why: "another session is in use",
    });
    expect(quitPlan(base)).toEqual({ kind: "remove" });
  });

  test("its own running turn and jobs do not hold it: the quit is what ends them (Q6)", () => {
    expect(quitPlan({ ...base, use: { jobs: 3, running: true, others: 0 } })).toEqual({
      kind: "remove",
    });
  });

  test("keep wins over everything; an unconfirmed save is said before another terminal", () => {
    expect(quitPlan({ ...base, keep: true, saved: false })).toEqual({ kind: "stay" });
    expect(
      quitPlan({ ...base, othersAttached: 2, saved: false, sessionsKept: 1, use: null }),
    ).toEqual({ kind: "stay", why: "the last save was not confirmed" });
  });
});
