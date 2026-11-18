/**
 * A child's and a shell job's detail (docs/feat/mobile-chrome.md Design 5, slice
 * S9): the steps window (5 of `tail`, "n earlier" from `toolUses`), read marks
 * from `userRead` vs a message's `n`, which actions each state allows, the typed
 * outcomes of message/Stop (F14, F15, F19), the focus resolution (a running
 * child that ends flips to Finished) and "Show in chat"'s row.
 */
import { describe, expect, test } from "bun:test";
import type { JobOutputResult, JobRow, SubagentRow } from "@tentacle/protocol";
import type { ChildReport, FinishedChild } from "../src/activity-memory.ts";
import {
  JOB_LINES,
  SENT_CAP,
  STEPS_SHOWN,
  type SentMemory,
  detailView,
  jobDetailView,
  killChildOutcome,
  killJobOutcome,
  messageOutcome,
  pruneSent,
  recordSent,
  resolveFocus,
  sentState,
  sheetDetail,
  showRow,
  stopConfirm,
} from "../src/subagent-detail.ts";

function child(id: string, over: Partial<SubagentRow> = {}): SubagentRow {
  return {
    id,
    callId: `call-${id}`,
    agentType: "explore",
    description: `task ${id}`,
    state: "running",
    toolUses: 9,
    tokens: 12_300,
    startedAt: 0,
    tail: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
    ...over,
  };
}

function job(id: string, over: Partial<JobRow> = {}): JobRow {
  return { id, command: "sleep 30", startedAt: 0, status: "running", ...over };
}

const report: ChildReport = { text: "Done.\nall green", lost: false, key: "n-7" };

describe("detailView — a running child", () => {
  test("shows the LAST 5 of tail, newest last and spinning, and 'n earlier' from toolUses", () => {
    const v = detailView({ kind: "live", row: child("sa-2") }, [], 65_000);
    expect(STEPS_SHOWN).toBe(5);
    expect(v.steps.map((s) => s.text)).toEqual(["s3", "s4", "s5", "s6", "s7"]);
    expect(v.steps.map((s) => s.latest)).toEqual([false, false, false, false, true]);
    // 9 tool uses, 5 shown → 4 earlier (not tail.length − 5).
    expect(v.earlier).toBe("… 4 earlier");
    expect(v.title).toBe("task sa-2");
    expect(v.meta).toBe("running · sa-2 · explore · 9 steps · 1m 05s · 12.3k tokens");
  });

  test("no 'earlier' when every step is shown; a short tail is shown whole", () => {
    const v = detailView({ kind: "live", row: child("sa-1", { tail: ["a"], toolUses: 1 }) }, [], 0);
    expect(v.steps.map((s) => s.text)).toEqual(["a"]);
    expect(v.earlier).toBeNull();
  });

  test("actions: message + stop, no copy/show; the field names the child", () => {
    const v = detailView({ kind: "live", row: child("sa-2") }, [], 0);
    expect(v.actions).toEqual({ message: true, stop: true, copy: false, show: false });
    expect(v.placeholder).toBe("Message sa-2…");
    expect(v.running).toBe(true);
  });

  test("a step label from a pod is flattened to one plain line (F16)", () => {
    const v = detailView(
      { kind: "live", row: child("sa-2", { tail: ["rm\n-rf\u001b[31m x"] }) },
      [],
      0,
    );
    expect(v.steps[0]?.text).toBe("rm -rf [31m x");
  });
});

describe("read marks (userRead vs n)", () => {
  test("the truth table", () => {
    expect(sentState(2, 2, false)).toBe("read");
    expect(sentState(3, 2, false)).toBe("unread");
    expect(sentState(3, 2, true)).toBe("unread_ended");
    expect(sentState(undefined, 2, false)).toBe("unknown");
    expect(sentState(1, undefined, false)).toBe("unknown");
    // Read wins over ended: it entered the context before the end.
    expect(sentState(1, 1, true)).toBe("read");
  });

  test("the detail lists the person's messages with their mark", () => {
    const v = detailView(
      { kind: "live", row: child("sa-2", { userRead: 1 }) },
      [
        { text: "salta i test", n: 1 },
        { text: "usa bun", n: 2 },
      ],
      0,
    );
    expect(v.sent.map((m) => [m.text, m.mark])).toEqual([
      ["salta i test", "read"],
      ["usa bun", "not read yet"],
    ]);
  });

  test("a finished child's unread message says it was never read", () => {
    const f: FinishedChild = { row: child("sa-2", { userRead: 0 }), endedAt: 5 };
    const v = detailView({ kind: "finished", child: f, report }, [{ text: "hey", n: 1 }], 0);
    expect(v.sent.map((m) => m.mark)).toEqual(["not read"]);
  });
});

describe("detailView — a finished child", () => {
  test("no message field and no Stop; Copy and Show only with a report", () => {
    const f: FinishedChild = { row: child("sa-2"), endedAt: 5 };
    const done = detailView({ kind: "finished", child: f, report }, [], 0);
    expect(done.running).toBe(false);
    expect(done.actions).toEqual({ message: false, stop: false, copy: true, show: true });
    expect(done.steps).toEqual([]);
    const pending = detailView({ kind: "finished", child: f, report: null }, [], 0);
    expect(pending.actions).toEqual({ message: false, stop: false, copy: false, show: false });
  });
});

describe("outcomes (F14, F15)", () => {
  test("a sent message clears the draft; a refusal keeps it and shows the reason", () => {
    expect(messageOutcome({ ok: true })).toEqual({ keepDraft: false, notice: null });
    expect(messageOutcome({ ok: false, reason: "sa-2 is not running" })).toEqual({
      keepDraft: true,
      notice: "sa-2 is not running",
    });
    expect(messageOutcome({ ok: false })).toEqual({ keepDraft: true, notice: "Not sent." });
  });

  test("a thrown send (a dropped link) keeps the draft and says so — never a throw at the UI", () => {
    expect(messageOutcome(new Error("socket closed"))).toEqual({
      keepDraft: true,
      notice: "Not sent: socket closed",
    });
  });

  test("Stop: killed → nothing to say; {killed:false} → already finished; a throw → its message", () => {
    expect(killChildOutcome("sa-2", { killed: true })).toBeNull();
    expect(killChildOutcome("sa-2", { killed: false })).toBe("sa-2 already finished");
    expect(killChildOutcome("sa-2", new Error("offline"))).toBe("Not stopped: offline");
    expect(killJobOutcome("bg-1", { killed: false })).toBe("bg-1 already exited");
    expect(killJobOutcome("bg-1", { killed: true })).toBeNull();
  });

  test("Stop's confirmation names what is lost (F17)", () => {
    expect(stopConfirm({ kind: "child", id: "sa-2" })).toEqual({
      title: "Stop sa-2?",
      message: "Its work so far is lost to the agent.",
      confirm: "Stop agent",
    });
    expect(stopConfirm({ kind: "job", id: "bg-1" })).toMatchObject({
      title: "Stop bg-1?",
      confirm: "Stop job",
    });
  });
});

describe("jobDetailView (F19)", () => {
  test("running: the command, the last JOB_LINES lines, Stop allowed", () => {
    const output = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const v = jobDetailView(
      "bg-1",
      job("bg-1"),
      { found: true, jobId: "bg-1", status: "running", output, truncated: true },
      9_000,
    );
    expect(JOB_LINES).toBe(200);
    expect(v.title).toBe("sleep 30");
    expect(v.meta).toBe("bg-1 · running · 9s");
    expect(v.lines.length).toBe(200);
    expect(v.lines.at(-1)).toBe("line 249");
    expect(v.truncated).toBe(true);
    expect(v.stop).toBe(true);
    expect(v.ended).toBeNull();
  });

  test("a job that just exited: the last output it has plus 'exited (code n)', no Stop", () => {
    const v = jobDetailView(
      "bg-1",
      null,
      { found: true, jobId: "bg-1", status: "exited", exitCode: 2, output: ["boom"] },
      0,
    );
    expect(v.lines).toEqual(["boom"]);
    expect(v.ended).toBe("exited (code 2)");
    expect(v.stop).toBe(false);
  });

  test("killed (no exit code) and found:false with a reason", () => {
    expect(
      jobDetailView("bg-1", null, { found: true, jobId: "bg-1", status: "killed" }, 0).ended,
    ).toBe("killed");
    const gone = jobDetailView(
      "bg-1",
      null,
      { found: false, jobId: "bg-1", reason: "no such job" },
      0,
    );
    expect(gone.notice).toBe("no such job");
    expect(gone.lines).toEqual([]);
    expect(gone.title).toBe("bg-1");
    expect(gone.stop).toBe(false);
  });

  test("the list still shows it but the read says it exited: ended, no Stop (the read is newer)", () => {
    const v = jobDetailView(
      "bg-1",
      job("bg-1"),
      { found: true, jobId: "bg-1", status: "exited", exitCode: 0 },
      0,
    );
    expect(v.stop).toBe(false);
    expect(v.ended).toBe("exited (code 0)");
  });

  test("still running per the list but no output read yet: Stop allowed, nothing ended", () => {
    const v = jobDetailView("bg-1", job("bg-1"), null, 0);
    expect(v.stop).toBe(true);
    expect(v.ended).toBeNull();
    expect(v.lines).toEqual([]);
  });

  test("output lines are flattened (F16)", () => {
    const v = jobDetailView(
      "bg-1",
      job("bg-1"),
      { found: true, jobId: "bg-1", output: ["\u001b[2Jok"] },
      0,
    );
    expect(v.lines).toEqual(["[2Jok"]);
  });
});

describe("resolveFocus", () => {
  const live = [child("sa-2")];
  const finished: FinishedChild[] = [{ row: child("sa-1"), endedAt: 1 }];
  const reports = new Map([["sa-1", report]]);

  test("a live child, a finished one with its report, a job (live or gone), nothing", () => {
    expect(resolveFocus({ kind: "child", id: "sa-2" }, live, finished, reports)).toEqual({
      kind: "live",
      row: live[0] as SubagentRow,
    });
    expect(resolveFocus({ kind: "child", id: "sa-1" }, live, finished, reports)).toEqual({
      kind: "finished",
      child: finished[0] as FinishedChild,
      report,
    });
    expect(resolveFocus({ kind: "child", id: "sa-9" }, live, finished, reports)).toBeNull();
    expect(resolveFocus(null, live, finished, reports)).toBeNull();
  });

  test("a running child that ends while open flips to Finished (F14)", () => {
    const before = resolveFocus({ kind: "child", id: "sa-2" }, live, [], reports);
    expect(before?.kind).toBe("live");
    const after = resolveFocus(
      { kind: "child", id: "sa-2" },
      [],
      [{ row: child("sa-2"), endedAt: 2 }],
      reports,
    );
    expect(after).toEqual({
      kind: "finished",
      child: { row: child("sa-2"), endedAt: 2 },
      report: null,
    });
  });

  test("the LIVE row wins over a stale Finished one with the same id", () => {
    const got = resolveFocus(
      { kind: "child", id: "sa-2" },
      live,
      [{ row: child("sa-2"), endedAt: 1 }],
      reports,
    );
    expect(got?.kind).toBe("live");
  });
});

describe("sheetDetail — what the sheet draws for a focus", () => {
  const base = {
    subagents: [child("sa-2")],
    jobs: [job("bg-1")],
    finished: [] as FinishedChild[],
    reports: new Map<string, ChildReport>(),
    sent: { "sa-2": [{ text: "hey", n: 1 }] },
    job: null,
  };

  test("a live child with its own messages; the list for no focus or an unknown child", () => {
    const d = sheetDetail({ kind: "child", id: "sa-2" }, base, 0);
    expect(d?.kind).toBe("child");
    if (d?.kind === "child") {
      expect(d.view.running).toBe(true);
      expect(d.view.sent.map((m) => m.text)).toEqual(["hey"]);
      expect(d.report).toBeNull();
    }
    expect(sheetDetail(null, base, 0)).toBeNull();
    expect(sheetDetail({ kind: "child", id: "sa-9" }, base, 0)).toBeNull();
  });

  test("a job keeps its detail after it left the list, with the output read for THAT job only", () => {
    const output: JobOutputResult = { found: true, jobId: "bg-1", status: "exited", exitCode: 0 };
    const gone = sheetDetail(
      { kind: "job", id: "bg-1" },
      { ...base, jobs: [], job: { id: "bg-1", output } },
      0,
    );
    expect(gone?.kind === "job" ? gone.view.ended : "no").toBe("exited (code 0)");
    const other = sheetDetail(
      { kind: "job", id: "bg-1" },
      { ...base, job: { id: "bg-2", output } },
      0,
    );
    expect(other?.kind === "job" ? other.view.ended : "no").toBeNull();
  });
});

describe("the person's messages, per child", () => {
  test("kept per child, newest last, capped at SENT_CAP", () => {
    let m: SentMemory = {};
    for (let n = 1; n <= SENT_CAP + 3; n += 1) {
      m = recordSent(m, "sa-2", { text: `m${n}`, n });
    }
    m = recordSent(m, "sa-3", { text: "other", n: 1 });
    expect(m["sa-2"]?.length).toBe(SENT_CAP);
    expect(m["sa-2"]?.[0]?.text).toBe("m4");
    expect(m["sa-2"]?.at(-1)?.text).toBe(`m${SENT_CAP + 3}`);
    expect(m["sa-3"]).toEqual([{ text: "other", n: 1 }]);
  });

  test("pruned to the children still live or Finished; unchanged memory is the same object", () => {
    const m: SentMemory = { "sa-1": [{ text: "a" }], "sa-2": [{ text: "b" }] };
    expect(pruneSent(m, new Set(["sa-2"]))).toEqual({ "sa-2": [{ text: "b" }] });
    expect(pruneSent(m, new Set(["sa-1", "sa-2"]))).toBe(m);
  });
});

describe("showRow — Show in chat", () => {
  test("the index of the report's own row; null when it is not in the list", () => {
    const rows = [{ key: "a" }, { key: "n-7" }, { key: "b" }];
    expect(showRow(rows, report)).toBe(1);
    expect(showRow(rows, { ...report, key: "zz" })).toBeNull();
    expect(showRow(rows, null)).toBeNull();
  });
});
