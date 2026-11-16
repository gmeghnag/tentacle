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

function harness(fakes: Fakes | null) {
  let agents: ((rows: readonly SubagentRow[]) => void) | null = null;
  let echo: ((n: { agentId: string; text: string; n?: number }) => void) | null = null;
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
            agents = fn;
            fn([child("sa-1"), child("sa-2")]);
            return () => {
              agents = null;
            };
          },
          onJobs: (fn: (r: { rows: readonly JobRow[]; count: number }) => void) => {
            fn({ rows: [job], count: 1 });
            return () => {};
          },
          onSubagentMessage: (fn: (n: { agentId: string; text: string; n?: number }) => void) => {
            echo = fn;
            return () => {
              echo = null;
            };
          },
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
    agents: (rows: SubagentRow[]) => agents?.(rows),
    echo: (n: { agentId: string; text: string; n?: number }) => echo?.(n),
    echoing: () => echo !== null,
  };
}

async function attached(fakes: Fakes | null) {
  const h = harness(fakes);
  await h.screen.open();
  return h;
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
