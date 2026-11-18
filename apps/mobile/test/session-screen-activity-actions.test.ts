/**
 * The Activity ACTIONS on the screen (docs/feat/mobile-chrome.md S9): the
 * controller keeps the person's messages to each child from the daemon's echo,
 * sends a message (a refusal or a throw keeps the draft — F14), stops a child
 * (`{killed:false}` → "already finished"), reads and stops a shell job (F19), and
 * a handle without these members refuses typed, never throws (F15). The fake
 * handle stands for `RemoteSession` (a seam, AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { JobOutputResult, JobRow, SubagentRow } from "@tentacle/protocol";
import { createSessionController } from "../src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";
import { JOB_LINES } from "../src/subagent-detail.ts";

function child(id: string): SubagentRow {
  return {
    id,
    callId: `call-${id}`,
    agentType: "general",
    description: `task ${id}`,
    state: "running",
    toolUses: 2,
    tokens: 10,
    startedAt: 0,
    tail: ["read x"],
  };
}

const job: JobRow = { id: "bg-1", command: "sleep 30", startedAt: 0, status: "running" };

interface Fakes {
  message?: (agentId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  kill?: (agentId: string) => Promise<{ killed: boolean }>;
  output?: (jobId: string, opts?: { lines?: number }) => Promise<JobOutputResult>;
  killJob?: (jobId: string) => Promise<{ killed: boolean }>;
}

type SubscriptionKind = "agents" | "jobs" | "sent";

function harness(fakes: Fakes | null) {
  // Every subscription is kept, with whether it is still live: the unreleased
  // one (a re-attach that forgets to unsubscribe) is only visible this way.
  const subs: { kind: SubscriptionKind; fn: (arg: never) => void; live: boolean }[] = [];
  function register(kind: SubscriptionKind, fn: (arg: never) => void): () => void {
    const sub = { kind, fn, live: true };
    subs.push(sub);
    return () => {
      sub.live = false;
    };
  }
  /** What a handle does on a push: every LIVE subscription hears it, dead ones never. */
  function deliver(kind: SubscriptionKind, arg: unknown): void {
    for (const sub of subs) {
      if (sub.live && sub.kind === kind) {
        (sub.fn as (a: unknown) => void)(arg);
      }
    }
  }
  const liveCount = (kind: SubscriptionKind) =>
    subs.filter((sub) => sub.live && sub.kind === kind).length;
  const calls: string[] = [];
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => {},
    async *send(): AsyncIterable<SessionEvent> {
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    ...(fakes === null
      ? {}
      : {
          onSubagents: (fn: (rows: readonly SubagentRow[]) => void) => {
            const off = register("agents", fn as (arg: never) => void);
            fn([child("sa-1"), child("sa-2")]);
            return off;
          },
          onJobs: (fn: (r: { rows: readonly JobRow[]; count: number }) => void) => {
            const off = register("jobs", fn as (arg: never) => void);
            fn({ rows: [job], count: 1 });
            return off;
          },
          onSubagentMessage: (fn: (n: { agentId: string; text: string; n?: number }) => void) =>
            register("sent", fn as (arg: never) => void),
          messageSubagent: (agentId: string, text: string) => {
            calls.push(`message ${agentId} ${text}`);
            return fakes.message?.(agentId, text) ?? Promise.resolve({ ok: true });
          },
          killSubagent: (agentId: string) => {
            calls.push(`kill ${agentId}`);
            return fakes.kill?.(agentId) ?? Promise.resolve({ killed: true });
          },
          jobOutput: (jobId: string, opts?: { lines?: number }) => {
            calls.push(`output ${jobId} ${opts?.lines}`);
            return (
              fakes.output?.(jobId, opts) ??
              Promise.resolve({ found: true, jobId, status: "running", output: ["tick"] })
            );
          },
          killJob: (jobId: string) => {
            calls.push(`killJob ${jobId}`);
            return fakes.killJob?.(jobId) ?? Promise.resolve({ killed: true });
          },
        }),
  };
  const screen = createSessionScreen({
    sessionId: "s1",
    archived: false,
    title: "Alpha",
    project: "e2e-mac",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => 100,
  });
  return {
    screen,
    calls,
    agents: (rows: SubagentRow[]) => deliver("agents", rows),
    echo: (n: { agentId: string; text: string; n?: number }) => deliver("sent", n),
    echoing: () => liveCount("sent") > 0,
    liveCount,
  };
}

async function attached(fakes: Fakes | null) {
  const h = harness(fakes);
  await h.screen.open();
  return h;
}

/** Let the attach's awaited continuations run (`reopen` is fire-and-forget). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe("the person's messages to a child", () => {
  test("kept per child from the daemon's echo; dropped from the subscription on leave", async () => {
    const h = await attached({});
    h.echo({ agentId: "sa-2", text: "salta i test", n: 1 });
    h.echo({ agentId: "sa-1", text: "other", n: 1 });
    expect(h.screen.state().activity.sent["sa-2"]).toEqual([{ text: "salta i test", n: 1 }]);
    expect(h.screen.state().activity.sent["sa-1"]).toEqual([{ text: "other", n: 1 }]);
    await h.screen.leave();
    expect(h.echoing()).toBe(false);
  });

  test("a child that leaves to Finished keeps its messages; one in neither list loses them", async () => {
    const h = await attached({});
    h.echo({ agentId: "sa-2", text: "hi", n: 1 });
    h.echo({ agentId: "sa-9", text: "stray", n: 1 });
    // sa-2 leaves → Finished: kept. sa-9 was never listed: pruned on the replace.
    h.agents([child("sa-1")]);
    expect(h.screen.state().activity.sent["sa-2"]).toEqual([{ text: "hi", n: 1 }]);
    expect(h.screen.state().activity.sent["sa-9"]).toBeUndefined();
  });
});

describe("a re-attach (review round 1, finding 1)", () => {
  test("the previous subscriptions are released, so one echo is recorded ONCE", async () => {
    const h = await attached({});
    expect(h.liveCount("agents")).toBe(1);
    expect(h.liveCount("jobs")).toBe(1);
    expect(h.liveCount("sent")).toBe(1);
    h.screen.reopen(); // the Reopen button: a second attach on the same screen
    await settle();
    expect(h.screen.state().status.phase).toBe("open");
    // One live subscription per stream: the old handle's were released.
    expect(h.liveCount("agents")).toBe(1);
    expect(h.liveCount("jobs")).toBe(1);
    expect(h.liveCount("sent")).toBe(1);
    // The failure the finding names: a still-live old handle doubles every echo.
    h.echo({ agentId: "sa-2", text: "salta i test", n: 1 });
    expect(h.screen.state().activity.sent["sa-2"]).toEqual([{ text: "salta i test", n: 1 }]);
  });
});

describe("Message (F14)", () => {
  test("sent: the trimmed draft goes to THAT child and the field clears", async () => {
    const h = await attached({});
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("  salta i test ");
    await h.screen.messageChild();
    expect(h.calls).toEqual(["message sa-2 salta i test"]);
    expect(h.screen.state().activity.child).toEqual({
      id: "sa-2",
      draft: "",
      busy: false,
      notice: null,
    });
  });

  test("a refusal keeps the draft and shows the daemon's reason", async () => {
    const h = await attached({
      message: () => Promise.resolve({ ok: false, reason: "sa-2 is finishing" }),
    });
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("wait");
    await h.screen.messageChild();
    expect(h.screen.state().activity.child).toMatchObject({
      draft: "wait",
      notice: "sa-2 is finishing",
      busy: false,
    });
  });

  test("a THROWN send (a dropped link) keeps the draft — never a throw at the UI", async () => {
    const h = await attached({ message: () => Promise.reject(new Error("socket closed")) });
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("wait");
    await h.screen.messageChild();
    expect(h.screen.state().activity.child).toMatchObject({
      draft: "wait",
      notice: "Not sent: socket closed",
    });
  });

  test("an empty draft sends nothing; a second press while one is in flight sends nothing", async () => {
    let release: (v: { ok: boolean }) => void = () => {};
    const h = await attached({
      message: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("   ");
    await h.screen.messageChild();
    expect(h.calls).toEqual([]);
    h.screen.setChildDraft("go");
    const first = h.screen.messageChild();
    expect(h.screen.state().activity.child?.busy).toBe(true);
    await h.screen.messageChild();
    release({ ok: true });
    await first;
    expect(h.calls).toEqual(["message sa-2 go"]);
  });

  test("an answer for a child the person already left does not land on the next one", async () => {
    let release: (v: { ok: boolean; reason?: string }) => void = () => {};
    const h = await attached({
      message: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("go");
    const sent = h.screen.messageChild();
    h.screen.openChild("sa-1");
    h.screen.setChildDraft("draft for sa-1");
    release({ ok: false, reason: "late" });
    await sent;
    expect(h.screen.state().activity.child).toEqual({
      id: "sa-1",
      draft: "draft for sa-1",
      busy: false,
      notice: null,
    });
  });
});

describe("Stop a child (F14, F17)", () => {
  test("killed: the kill reaches the daemon, nothing to say", async () => {
    const h = await attached({});
    h.screen.openChild("sa-2");
    await h.screen.stopChild();
    expect(h.calls).toEqual(["kill sa-2"]);
    expect(h.screen.state().activity.child?.notice).toBeNull();
  });

  test("{killed:false}: already finished", async () => {
    const h = await attached({ kill: () => Promise.resolve({ killed: false }) });
    h.screen.openChild("sa-2");
    await h.screen.stopChild();
    expect(h.screen.state().activity.child?.notice).toBe("sa-2 already finished");
  });

  test("a thrown kill is a notice", async () => {
    const h = await attached({ kill: () => Promise.reject(new Error("offline")) });
    h.screen.openChild("sa-2");
    await h.screen.stopChild();
    expect(h.screen.state().activity.child?.notice).toBe("Not stopped: offline");
  });

  test("a second Stop while the first is in flight sends no second kill (S9)", async () => {
    // The UI's `disabled={busy}` hides this today, but the controller is the
    // contract: one tap, one kill. A second one's `{killed:false}` would
    // overwrite a stop that just succeeded with "sa-2 already finished".
    let release: (v: { killed: boolean }) => void = () => {};
    let kills = 0;
    const h = await attached({
      kill: () => {
        kills += 1;
        return kills === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ killed: false });
      },
    });
    h.screen.openChild("sa-2");
    const first = h.screen.stopChild();
    expect(h.screen.state().activity.child?.busy).toBe(true);
    await h.screen.stopChild();
    expect(h.calls).toEqual(["kill sa-2"]);
    expect(h.screen.state().activity.child?.notice).toBeNull();
    release({ killed: true });
    await first;
    expect(h.screen.state().activity.child).toMatchObject({ busy: false, notice: null });
  });
});

describe("a shell job (F19)", () => {
  test("opening it reads its last JOB_LINES lines; refresh reads again", async () => {
    const h = await attached({});
    await h.screen.openJob("bg-1");
    expect(h.calls).toEqual([`output bg-1 ${JOB_LINES}`]);
    expect(h.screen.state().activity.job).toMatchObject({
      id: "bg-1",
      output: { found: true, output: ["tick"] },
      busy: false,
    });
    await h.screen.refreshJob();
    expect(h.calls.length).toBe(2);
  });

  test("Stop kills it and then re-reads, so the detail shows how it ended", async () => {
    let status = "running";
    const h = await attached({
      killJob: () => {
        status = "killed";
        return Promise.resolve({ killed: true });
      },
      output: (jobId) => Promise.resolve({ found: true, jobId, status, output: ["tick"] }),
    });
    await h.screen.openJob("bg-1");
    await h.screen.stopJob();
    expect(h.calls).toEqual([
      `output bg-1 ${JOB_LINES}`,
      "killJob bg-1",
      `output bg-1 ${JOB_LINES}`,
    ]);
    expect(h.screen.state().activity.job?.output?.status).toBe("killed");
    expect(h.screen.state().activity.job?.notice).toBeNull();
  });

  test("{killed:false}: already exited", async () => {
    const h = await attached({ killJob: () => Promise.resolve({ killed: false }) });
    await h.screen.openJob("bg-1");
    await h.screen.stopJob();
    expect(h.screen.state().activity.job?.notice).toBe("bg-1 already exited");
  });

  test("a second Stop while the first is in flight sends no second killJob (S9)", async () => {
    let release: (v: { killed: boolean }) => void = () => {};
    let kills = 0;
    const h = await attached({
      killJob: () => {
        kills += 1;
        return kills === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ killed: false });
      },
    });
    await h.screen.openJob("bg-1");
    const first = h.screen.stopJob();
    expect(h.screen.state().activity.job?.busy).toBe(true);
    await h.screen.stopJob();
    expect(h.calls.filter((c) => c.startsWith("killJob"))).toEqual(["killJob bg-1"]);
    expect(h.screen.state().activity.job?.notice).toBeNull();
    release({ killed: true });
    await first;
    expect(h.screen.state().activity.job).toMatchObject({ busy: false, notice: null });
  });

  test("a thrown read is a found:false notice, never a throw", async () => {
    const h = await attached({ output: () => Promise.reject(new Error("offline")) });
    await h.screen.openJob("bg-1");
    expect(h.screen.state().activity.job?.output).toEqual({
      found: false,
      jobId: "bg-1",
      reason: "Could not read the output: offline",
    });
  });

  test("closing the detail forgets it; a read that lands after does not reopen it", async () => {
    let release: (v: JobOutputResult) => void = () => {};
    const h = await attached({
      output: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const read = h.screen.openJob("bg-1");
    h.screen.closeDetail();
    release({ found: true, jobId: "bg-1", output: ["late"] });
    await read;
    expect(h.screen.state().activity.job).toBeNull();
  });

  test("a slow read of the job you LEFT never lands on the next one (S9)", async () => {
    // Open bg-1 (a slow read), go back, open bg-2; bg-1's read then lands. Its
    // output must not be shown as bg-2's, which is what `sheetDetail` would do
    // if it trusted a patch that skipped the identity guard.
    const releases = new Map<string, (v: JobOutputResult) => void>();
    const h = await attached({
      output: (jobId) =>
        new Promise((resolve) => {
          releases.set(jobId, resolve);
        }),
    });
    const first = h.screen.openJob("bg-1");
    h.screen.closeDetail();
    const second = h.screen.openJob("bg-2");
    releases.get("bg-2")?.({ found: true, jobId: "bg-2", output: ["bg-2 line"] });
    await second;
    expect(h.screen.state().activity.job).toEqual({
      id: "bg-2",
      output: { found: true, jobId: "bg-2", output: ["bg-2 line"] },
      busy: false,
      notice: null,
    });
    releases.get("bg-1")?.({ found: true, jobId: "bg-1", output: ["bg-1 line"] });
    await first;
    expect(h.screen.state().activity.job).toEqual({
      id: "bg-2",
      output: { found: true, jobId: "bg-2", output: ["bg-2 line"] },
      busy: false,
      notice: null,
    });
  });
});

describe("an older daemon / a handle without the members (F15)", () => {
  test("message, stop and output refuse typed, none throws", async () => {
    const h = await attached(null);
    h.screen.openChild("sa-2");
    h.screen.setChildDraft("hi");
    await h.screen.messageChild();
    expect(h.screen.state().activity.child).toMatchObject({
      draft: "hi",
      notice: "This computer's tentacle cannot do this.",
    });
    await h.screen.stopChild();
    expect(h.screen.state().activity.child?.notice).toBe(
      "This computer's tentacle cannot do this.",
    );
    await h.screen.openJob("bg-1");
    expect(h.screen.state().activity.job?.output).toEqual({
      found: false,
      jobId: "bg-1",
      reason: "This computer's tentacle cannot do this.",
    });
  });
});

describe("Stop from a ROW, without opening its detail (mobile-activity-panel Design 4)", () => {
  test("a child: the kill reaches the daemon and no detail opens", async () => {
    const h = await attached({});
    await h.screen.stopRow("child", "sa-2");
    // The two-tap arm IS the confirmation: no `openChild`, no detail state.
    expect(h.calls).toEqual(["kill sa-2"]);
    expect(h.screen.state().activity.child).toBeNull();
    expect(h.screen.state().activity.stopNotices).toEqual({});
  });

  test("a job: killed by id, and nothing is read for a detail nobody opened", async () => {
    const h = await attached({});
    await h.screen.stopRow("job", "bg-1");
    expect(h.calls).toEqual(["killJob bg-1"]);
    expect(h.screen.state().activity.job).toBeNull();
  });

  test("{killed:false} says why on the ROW, keyed by its id", async () => {
    const h = await attached({ kill: () => Promise.resolve({ killed: false }) });
    await h.screen.stopRow("child", "sa-2");
    expect(h.screen.state().activity.stopNotices).toEqual({ "sa-2": "sa-2 already finished" });
  });

  test("a thrown kill is the row's notice, never a throw at the UI", async () => {
    const h = await attached({ killJob: () => Promise.reject(new Error("offline")) });
    await h.screen.stopRow("job", "bg-1");
    expect(h.screen.state().activity.stopNotices).toEqual({ "bg-1": "Not stopped: offline" });
  });

  test("a handle without the members refuses typed (F15)", async () => {
    const h = await attached(null);
    await h.screen.stopRow("child", "sa-2");
    await h.screen.stopRow("job", "bg-1");
    expect(h.screen.state().activity.stopNotices).toEqual({
      "sa-2": "This computer's tentacle cannot do this.",
      "bg-1": "This computer's tentacle cannot do this.",
    });
  });

  test("a second Stop on a row already in flight sends no second kill", async () => {
    let release: (v: { killed: boolean }) => void = () => {};
    let kills = 0;
    const h = await attached({
      kill: () => {
        kills += 1;
        return kills === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ killed: false });
      },
    });
    const first = h.screen.stopRow("child", "sa-2");
    await h.screen.stopRow("child", "sa-2");
    expect(h.calls).toEqual(["kill sa-2"]);
    release({ killed: true });
    await first;
  });

  test("the next activity update clears the notices (the notice is not sticky)", async () => {
    const h = await attached({ kill: () => Promise.resolve({ killed: false }) });
    await h.screen.stopRow("child", "sa-2");
    expect(h.screen.state().activity.stopNotices["sa-2"]).toBeDefined();
    h.agents([child("sa-1")]);
    expect(h.screen.state().activity.stopNotices).toEqual({});
  });

  test("a row Stop leaves an OPEN detail alone", async () => {
    const h = await attached({});
    h.screen.openChild("sa-1");
    h.screen.setChildDraft("keep me");
    await h.screen.stopRow("child", "sa-2");
    expect(h.screen.state().activity.child).toMatchObject({ id: "sa-1", draft: "keep me" });
    expect(h.calls).toEqual(["kill sa-2"]);
  });
});
