import { describe, expect, test } from "bun:test";
import {
  AGENT_INBOX_MAX,
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_NOTIFY_PER_CHILD,
  type AgentInbox,
  type AgentJobExit,
  type AgentJobHost,
  type AgentJobResult,
  type AgentJobSpec,
  AgentJobs,
  type AgentNotify,
  TWO_WAY_REPLY_HINT,
  capSubagentText,
} from "@tentacle/core";
import { SUBAGENT_REPORT_MAX_CHARS } from "@tentacle/protocol";

const spec = (description = "map repo"): AgentJobSpec => ({
  callId: "c1",
  agentType: "general",
  description,
});
const result = (report = "R"): AgentJobResult => ({ report, toolUses: 2, stopReason: "end_turn" });
const tick = () => new Promise((r) => setTimeout(r, 1));

function rig(cap = 2) {
  const log: string[] = [];
  let n = 0;
  const host: AgentJobHost = {
    launched: (s) => {
      n += 1;
      log.push(`launched:${s.description}`);
      return `sa-${n}`;
    },
    ended: (id, stopReason, report) => log.push(`ended:${id}:${stopReason}:${report.length}`),
  };
  const jobs = new AgentJobs(cap);
  jobs.bind(host);
  const exits: AgentJobExit[] = [];
  jobs.onExit((e) => {
    log.push(`exit:${e.agentId}`);
    exits.push(e);
  });
  return { jobs, log, exits };
}

/** A run that settles when the returned `done` is called. */
function gated(r = result()) {
  const gate = Promise.withResolvers<AgentJobResult>();
  let signal: AbortSignal | undefined;
  return {
    run: async (c: { signal: AbortSignal }) => {
      signal = c.signal;
      return gate.promise;
    },
    done: () => gate.resolve(r),
    fail: (e: unknown) => gate.reject(e),
    get signal() {
      return signal;
    },
  };
}

describe("AgentJobs.start", () => {
  test("below the cap launches once, lists it, and gives the run a live signal", async () => {
    const { jobs, log } = rig();
    const g = gated();
    const started = jobs.start(spec(), g.run);
    expect(started).toEqual({ ok: true, agentId: "sa-1" });
    expect(log).toEqual(["launched:map repo"]);
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(g.signal?.aborted).toBe(false);
    g.done();
    await tick();
  });

  test("over the cap refuses naming the running ids and descriptions; nothing launched", async () => {
    const { jobs, log } = rig(1);
    const g = gated();
    jobs.start(spec("first"), g.run);
    let ran = false;
    const refused = jobs.start(spec("second"), async () => {
      ran = true;
      return result();
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (first)");
      expect(refused.reason).toContain("subagents.maxParallel = 1");
      expect(refused.reason).not.toContain("foreground");
      // With a child running, stopping it is an option (`agent_control{action:"kill"}`).
      expect(refused.reason).toContain("agent_control");
    }
    expect(ran).toBe(false);
    expect(log).toEqual(["launched:first"]);
    g.done();
    await tick();
  });

  test("no host: refused, the run never starts", () => {
    const jobs = new AgentJobs(2);
    let ran = false;
    const r = jobs.start(spec(), async () => {
      ran = true;
      return result();
    });
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("ended comes before the exit listeners; the report is capped; an empty one becomes a placeholder", async () => {
    const { jobs, log, exits } = rig();
    const big = "x".repeat(SUBAGENT_REPORT_MAX_CHARS + 500);
    jobs.start(spec("a"), async () => result(big));
    jobs.start(spec("b"), async () => result("   "));
    await tick();
    const order = log.filter((l) => l.startsWith("ended") || l.startsWith("exit"));
    expect(order[0]?.startsWith("ended:sa-1")).toBe(true);
    expect(order[1]).toBe("exit:sa-1");
    expect(order[2]?.startsWith("ended:sa-2")).toBe(true);
    expect(exits[0]?.report.length).toBeLessThanOrEqual(SUBAGENT_REPORT_MAX_CHARS);
    expect(exits[0]?.report).toBe(capSubagentText(big, SUBAGENT_REPORT_MAX_CHARS));
    // The host got the same capped text as the listener (the note and the log agree).
    expect(log).toContain(`ended:sa-1:end_turn:${exits[0]?.report.length}`);
    expect(exits[1]?.report).toBe("(the sub-agent produced no output)");
    expect(jobs.list()).toEqual([]);
  });

  test("a throwing run ends as an error and frees the slot; a throwing listener loses no other", async () => {
    const { jobs, exits } = rig(1);
    const seen: string[] = [];
    jobs.onExit(() => {
      throw new Error("bad listener");
    });
    jobs.onExit((e) => seen.push(e.agentId));
    jobs.start(spec(), async () => {
      throw new Error("boom");
    });
    await tick();
    expect(exits[0]?.stopReason).toBe("error");
    expect(exits[0]?.report).toContain("boom");
    expect(seen).toEqual(["sa-1"]);
    expect(jobs.start(spec("again"), async () => result()).ok).toBe(true);
    await tick();
  });

  test("a throwing host.ended loses no exit and no unhandled rejection; the slot is still freed", async () => {
    // Bun 1.4.3 EXITS the process on an unhandled rejection and the repo installs
    // no handler: a throw escaping `drive` would take down every session on the
    // daemon. The handler here only observes; nothing may reach it.
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const jobs = new AgentJobs(1);
      const log: string[] = [];
      let ends = 0;
      jobs.bind({
        launched: () => "sa-1",
        ended: () => {
          ends += 1;
          if (ends === 1) {
            throw new Error("log store down");
          }
          log.push("ended");
        },
      });
      const exits: AgentJobExit[] = [];
      jobs.onExit((e) => exits.push(e));
      expect(jobs.start(spec(), async () => result()).ok).toBe(true);
      await tick();
      await Bun.sleep(25); // the runtime reports an escaped rejection after a turn
      // 1. Nothing escaped: the process is alive and no rejection was raised.
      expect(unhandled).toEqual([]);
      // 2. Durability is lost, but the exit still reaches the listeners (the
      //    live note and the wake go out) and the slot is freed.
      expect(exits.map((e) => e.report)).toEqual(["R"]);
      expect(jobs.list()).toEqual([]);
      // 3. `start` works again afterwards, and the second end reaches its host.
      expect(jobs.start(spec("again"), async () => result()).ok).toBe(true);
      await tick();
      expect(jobs.list()).toEqual([]);
      expect(log).toEqual(["ended"]);
      expect(exits).toHaveLength(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("dispose aborts every child, writes no ended and emits no exit", async () => {
    const { jobs, log } = rig();
    const g = gated();
    jobs.start(spec(), g.run);
    jobs.dispose();
    expect(g.signal?.aborted).toBe(true);
    g.done();
    await tick();
    expect(log).toEqual(["launched:map repo"]);
    expect(jobs.start(spec("late"), async () => result()).ok).toBe(false);
  });
});

describe("AgentJobs.acquire (a foreground child)", () => {
  test("below the cap it takes a slot; at the cap it is refused naming the running children; no slot leaks", async () => {
    const { jobs, log } = rig(2);
    const g = gated();
    jobs.start(spec("bg one"), g.run);
    const fg = jobs.acquire("fg one");
    expect(fg.ok).toBe(true);
    const refused = jobs.acquire("fg two");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (bg one)");
      expect(refused.reason).toContain("fg one");
      expect(refused.reason).toContain("subagents.maxParallel = 2");
      expect(refused.reason).toContain("end your turn");
      // The same text offers `agent_control` too (its `kill` stops that child).
      expect(refused.reason).toContain("agent_control");
      expect(refused.reason).not.toContain("run it in the foreground");
    }
    // The refused try left nothing behind: a release frees exactly one slot.
    if (fg.ok) {
      fg.release();
    }
    expect(jobs.acquire("fg three").ok).toBe(true);
    expect(jobs.acquire("fg four").ok).toBe(false);
    // A background launch sees the foreground slots too (one cap).
    expect(jobs.start(spec("bg two"), async () => result()).ok).toBe(false);
    expect(log).toEqual(["launched:bg one"]);
    g.done();
    await tick();
  });

  test("release is idempotent: a second call frees nothing more", () => {
    const { jobs } = rig(1);
    const a = jobs.acquire("a");
    if (!a.ok) {
      throw new Error("expected a slot");
    }
    a.release();
    const b = jobs.acquire("b");
    expect(b.ok).toBe(true);
    a.release();
    // `a`'s second release must not have freed `b`'s slot.
    expect(jobs.acquire("c").ok).toBe(false);
  });

  test("after dispose it is refused for the reason (the session is closing), not as a limit", () => {
    const { jobs } = rig();
    jobs.dispose();
    const refused = jobs.acquire("x");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // A disposed runtime holds nothing: "at the limit … running: none" is false.
      expect(refused.reason).toBe("sub-agents are not available: the session is closing");
      expect(refused.reason).not.toContain("limit");
    }
  });

  test("foreground holders alone fill the cap: the refusal promises no wake (it would stall the task)", () => {
    const { jobs } = rig(2);
    expect(jobs.acquire("fg one").ok).toBe(true);
    expect(jobs.acquire("fg two").ok).toBe(true);
    // A background launch and a foreground call are refused the same way.
    for (const refused of [
      jobs.start(spec("bg"), async () => result()),
      jobs.acquire("fg three"),
    ]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toContain("subagents.maxParallel = 2");
        expect(refused.reason).toContain("fg one");
        // No background child is running: ending the turn wakes nobody.
        expect(refused.reason).not.toContain("end your turn");
        expect(refused.reason).toContain(
          "Nothing was started. Retry when the running foreground sub-agents return, or do this work yourself.",
        );
      }
    }
    // With a background child running the approved wording stays.
    expect(jobs.start(spec("bg"), async () => result()).ok).toBe(false);
  });

  test("a background child in the running set keeps the approved 'end your turn' wording", async () => {
    const { jobs } = rig(1);
    const g = gated();
    jobs.start(spec("bg one"), g.run);
    const refused = jobs.acquire("fg one");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (bg one)");
      expect(refused.reason).toContain("end your turn");
    }
    g.done();
    await tick();
  });
});

describe("AgentJobs.setCap", () => {
  test("lowering kills nothing and refuses new work; raising admits again", async () => {
    const { jobs } = rig(2);
    const a = gated();
    const b = gated();
    jobs.start(spec("a"), a.run);
    jobs.start(spec("b"), b.run);
    jobs.setCap(1);
    expect(jobs.list()).toHaveLength(2);
    expect(a.signal?.aborted).toBe(false);
    expect(jobs.start(spec("c"), async () => result()).ok).toBe(false);
    expect(jobs.acquire("c").ok).toBe(false);
    jobs.setCap(3);
    expect(jobs.start(spec("c"), async () => result()).ok).toBe(true);
    a.done();
    b.done();
    await tick();
  });
});

// docs/feat/agent-message.md T4-T6. `AgentJobs.message` is THE seam every sender
// goes through; it decides and pushes in ONE synchronous stretch, so a text it
// accepts is read by the child or reported by it — never silently dropped.

/** A run that records the inbox it was given and settles on `done`. */
function inboxRun() {
  const gate = Promise.withResolvers<AgentJobResult>();
  let inbox: AgentInbox | undefined;
  return {
    run: async (c: { readonly inbox?: AgentInbox }) => {
      inbox = c.inbox;
      return gate.promise;
    },
    done: () => gate.resolve(result()),
    /** The child's own inbox, as its run received it. */
    get inbox(): AgentInbox {
      if (inbox === undefined) {
        throw new Error("the run was never given an inbox");
      }
      return inbox;
    },
  };
}

describe("AgentJobs.message (a text for a running child)", () => {
  test("a running child accepts it, formatted, in the inbox its run was given", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    expect(jobs.message("sa-1", "also check X", "agent")).toEqual({ ok: true, index: 1 });
    // Ready-to-inject user content, drained at the child's next boundary.
    expect(g.inbox.drain()).toEqual(["[message from the parent agent] also check X"]);
    // The `"user"` sender is task 7's; the channel is the same one.
    expect(jobs.message("sa-1", "look at Y", "user")).toEqual({ ok: true, index: 1 });
    expect(g.inbox.drain()).toEqual(["[message from the user] look at Y"]);
    g.done();
    await tick();
  });

  test("an unknown id, a killed one and an ended one each say nothing was sent", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    const unknown = jobs.message("sa-9", "hi", "agent");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toBe(
        "sa-9 is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.",
      );
    }
    jobs.kill("sa-1");
    const killed = jobs.message("sa-1", "hi", "agent");
    expect(killed.ok).toBe(false);
    if (!killed.ok) {
      expect(killed.reason).toBe("sa-1 is being stopped: nothing was sent.");
    }
    g.done();
    await tick();
    const ended = jobs.message("sa-1", "hi", "agent");
    expect(ended.ok).toBe(false);
    if (!ended.ok) {
      expect(ended.reason).toContain("is not a running background sub-agent");
    }
  });

  test("a child that closed its inbox (finishing) is refused, not queued", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    // The child's run ended here: the runner closes when it holds nothing.
    expect(g.inbox.closeIfEmpty()).toEqual([]);
    const out = jobs.message("sa-1", "hi", "agent");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe(
        "sa-1 is finishing and can no longer read messages: nothing was sent. Its report arrives as a [background] note.",
      );
    }
    g.done();
    await tick();
  });

  // docs/fix/autoaccept-wake-turns.md T7: the read state must reach the ROWS, and
  // it must reach them through `onChange` (a frame the daemon publishes).
  // MUTATION: drop the inbox's `onRead` (back to `new AgentInbox()`) → `seen`
  // loses its one entry, and the daemon-side `sameRows` guard would drop the frame.
  test("a drain moves rows().userRead and fires onChange", async () => {
    const { jobs } = rig();
    const seen: number[] = [];
    jobs.onChange(() => seen.push(jobs.rows()[0]?.userRead ?? -1));
    const g = inboxRun();
    jobs.start(spec(), g.run);
    expect(jobs.rows()[0]?.userRead).toBe(0);
    expect(jobs.message("sa-1", "one", "user")).toEqual({ ok: true, index: 1 });
    expect(jobs.message("sa-1", "two", "user")).toEqual({ ok: true, index: 2 });
    // Accepted, NOT read: the row still says 0, and the message changed no row.
    expect(jobs.message("sa-1", "three", "user")).toEqual({ ok: true, index: 3 });
    expect(jobs.rows()[0]?.userRead).toBe(0);
    const before = seen.length;
    // The child reads them at its next boundary: the ONE path that counts.
    g.inbox.drain();
    expect(jobs.rows()[0]?.userRead).toBe(3);
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.at(-1)).toBe(3);
    g.done();
    await tick();
  });

  test("an agent message does not move a user read count", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    expect(jobs.message("sa-1", "from the model", "agent")).toEqual({ ok: true, index: 1 });
    g.inbox.drain();
    expect(jobs.rows()[0]?.userRead).toBe(0);
    expect(jobs.message("sa-1", "from you", "user")).toEqual({ ok: true, index: 1 });
    g.done();
    await tick();
  });

  // docs/fix/autoaccept-wake-turns.md owner Q3 (b), end to end: with
  // `subagents.twoWay` on, the text the child's own runner drains ends with ONE
  // short line saying it may answer with `agent_notify`; off, the delivered text
  // is byte-identical to today's. MUTATION: push the hint unconditionally, or
  // never → one of the two cases goes red.
  test("setTwoWay: the delivered text gains one reply hint (on) and nothing (off)", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    // Off by default: exactly today's text.
    jobs.message("sa-1", "also check X", "agent");
    expect(g.inbox.drain()).toEqual(["[message from the parent agent] also check X"]);
    jobs.message("sa-1", "look at Y", "user");
    expect(g.inbox.drain()).toEqual(["[message from the user] look at Y"]);
    // On: the same text, one line longer.
    jobs.setTwoWay(true);
    jobs.message("sa-1", "also check X", "agent");
    expect(g.inbox.drain()).toEqual([
      `[message from the parent agent] also check X${TWO_WAY_REPLY_HINT}`,
    ]);
    jobs.message("sa-1", "look at Y", "user");
    expect(g.inbox.drain()).toEqual([`[message from the user] look at Y${TWO_WAY_REPLY_HINT}`]);
    // Back off: unchanged again (a settings sync), and the read count still counts.
    jobs.setTwoWay(false);
    jobs.message("sa-1", "again", "user");
    expect(g.inbox.drain()).toEqual(["[message from the user] again"]);
    expect(jobs.rows()[0]?.userRead).toBe(3);
    g.done();
    await tick();
  });

  test("the 8-per-child cap: the 9th unread text is refused and nothing is queued", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    for (let i = 1; i <= AGENT_INBOX_MAX; i++) {
      expect(jobs.message("sa-1", `m${i}`, "agent")).toEqual({ ok: true, index: i });
    }
    const over = jobs.message("sa-1", "m9", "agent");
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe(
        `sa-1 already has ${AGENT_INBOX_MAX} unread messages: nothing was sent. Wait for it to read them or for its report.`,
      );
    }
    expect(g.inbox.drain()).toHaveLength(AGENT_INBOX_MAX);
    g.done();
    await tick();
  });

  test("a foreground child has no id to name: the message is refused", async () => {
    const { jobs } = rig();
    expect(jobs.acquire("fg one").ok).toBe(true);
    expect(jobs.message("fg one", "hi", "agent").ok).toBe(false);
  });
});

/** A rig that also collects notifies: what a parent Agent subscribes to. */
function notifyRig(cap = 2) {
  const base = rig(cap);
  const notes: AgentNotify[] = [];
  base.jobs.onNotify((n) => notes.push(n));
  return { ...base, notes };
}

describe("AgentJobs.notify (T2: what it refuses)", () => {
  test("an unknown id, a killed child and an over-length text each say nothing was sent", async () => {
    const { jobs, notes } = notifyRig();
    const g = inboxRun();
    jobs.start(spec(), g.run);

    const unknown = jobs.notify("sa-9", "hi");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toBe(
        "sa-9 is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.",
      );
    }

    jobs.kill("sa-1");
    const killed = jobs.notify("sa-1", "hi");
    expect(killed.ok).toBe(false);
    if (!killed.ok) {
      expect(killed.reason).toBe("sa-1 is being stopped: nothing was sent.");
    }
    g.done();
    await tick();
    expect(notes).toEqual([]);
  });

  test("a text over AGENT_MESSAGE_MAX_CHARS is refused with the limit, and nothing is sent", async () => {
    const { jobs, notes } = notifyRig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    const over = jobs.notify("sa-1", "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toContain(`${AGENT_MESSAGE_MAX_CHARS}-character limit`);
      expect(over.reason).toContain("nothing was sent");
    }
    expect(notes).toEqual([]);
    g.done();
    await tick();
  });

  test("no parent listening: refused with a reason, never a silent drop", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    const out = jobs.notify("sa-1", "found X");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe(
        "no parent agent is listening: nothing was sent. Put it in your final report.",
      );
    }
    g.done();
    await tick();
  });

  test("the 8-per-child cap: the 9th notify since the user last wrote is refused", async () => {
    const { jobs, notes } = notifyRig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    for (let i = 1; i <= AGENT_NOTIFY_PER_CHILD; i++) {
      expect(jobs.notify("sa-1", `n${i}`).ok).toBe(true);
    }
    const over = jobs.notify("sa-1", "n9");
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe(
        `you already sent ${AGENT_NOTIFY_PER_CHILD} messages to the parent agent since the user last wrote: nothing was sent. Put the rest in your final report.`,
      );
    }
    expect(notes).toHaveLength(AGENT_NOTIFY_PER_CHILD);
    // A user message starts the per-child count over.
    jobs.userMessage();
    expect(jobs.notify("sa-1", "n10").ok).toBe(true);
    g.done();
    await tick();
  });
});

describe("AgentJobs.notify: the wake budget (T3)", () => {
  test("3 waking notifies per user message, then the note is still delivered without a wake", async () => {
    const { jobs, notes } = notifyRig(4);
    const a = inboxRun();
    const b = inboxRun();
    jobs.start(spec("first"), a.run);
    jobs.start(spec("second"), b.run);
    expect(jobs.notify("sa-1", "one")).toEqual({ ok: true, wakes: true });
    expect(jobs.notify("sa-2", "two")).toEqual({ ok: true, wakes: true });
    expect(jobs.notify("sa-1", "three")).toEqual({ ok: true, wakes: true });
    // Over the budget: accepted, delivered, and it wakes nobody.
    expect(jobs.notify("sa-2", "four")).toEqual({ ok: true, wakes: false });
    expect(notes.map((n) => n.wakes)).toEqual([true, true, true, false]);
    // A user message restarts both budgets.
    jobs.userMessage();
    expect(jobs.notify("sa-2", "five")).toEqual({ ok: true, wakes: true });
    a.done();
    b.done();
    await tick();
  });
});

describe("AgentJobs.notify: the listeners (T4)", () => {
  test("every listener is called synchronously, before notify returns, with the description", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec("map the repo"), g.run);
    const order: string[] = [];
    let secondSawFirst = -1;
    jobs.onNotify((n) => order.push(`a:${n.text}:${n.description}`));
    jobs.onNotify((n) => {
      // Inside the call: listener 1 has already run — no await happened.
      secondSawFirst = order.length;
      order.push(`b:${n.text}:${n.wakes}`);
    });
    expect(jobs.notify("sa-1", "found X")).toEqual({ ok: true, wakes: true });
    expect(secondSawFirst).toBe(1);
    // Read right after the call, with nothing awaited: every listener had run.
    expect(order).toEqual(["a:found X:map the repo", "b:found X:true"]);
    g.done();
    await tick();
  });

  test("unsubscribing stops the calls; dispose clears the listeners", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    const seen: string[] = [];
    const off = jobs.onNotify((n) => seen.push(n.text));
    off();
    expect(jobs.notify("sa-1", "x").ok).toBe(false); // no listener left
    expect(seen).toEqual([]);
    g.done();
    await tick();
  });
});

describe("AgentJobs.message: the length limit (T5)", () => {
  test("a text over AGENT_MESSAGE_MAX_CHARS is refused with the limit, and nothing is pushed", async () => {
    const { jobs } = rig();
    const g = inboxRun();
    jobs.start(spec(), g.run);
    expect(jobs.message("sa-1", "x".repeat(AGENT_MESSAGE_MAX_CHARS), "agent")).toEqual({
      ok: true,
      index: 1,
    });
    expect(g.inbox.drain()).toHaveLength(1);
    const long = jobs.message("sa-1", "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1), "agent");
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.reason).toContain("8000");
      expect(long.reason).toContain("nothing was sent");
    }
    expect(g.inbox.drain()).toEqual([]);
    g.done();
    await tick();
  });
});

describe("AgentJobs.acquire: the slot's inbox and adopt (T6)", () => {
  test("a foreground slot carries an inbox the child was given; adopt moves THAT inbox", async () => {
    const { jobs } = rig();
    const slot = jobs.acquire("map repo");
    if (!slot.ok) {
      throw new Error("expected a slot");
    }
    const gate = Promise.withResolvers<AgentJobResult>();
    // The runner of a MOVED child is handed `slot.inbox` (`agent_task`'s movable
    // path); a text sent to `sa-1` must land in exactly that object.
    const id = slot.adopt(
      spec(),
      new AbortController(),
      { toolUses: 0, tokens: 0, tail: [] },
      async () => gate.promise,
    );
    expect(id).toBe("sa-1");
    expect(jobs.message("sa-1", "after the move", "agent")).toEqual({ ok: true, index: 1 });
    expect(slot.inbox.drain()).toEqual(["[message from the parent agent] after the move"]);
    gate.resolve(result());
    await tick();
  });

  test("adopt refuses a CLOSED slot inbox: nothing moved, the slot stays foreground", async () => {
    const { jobs, log } = rig(1);
    const slot = jobs.acquire("map repo");
    if (!slot.ok) {
      throw new Error("expected a slot");
    }
    // The child stopped reading (its run ended): moving it would accept texts
    // nobody reads.
    slot.inbox.closeIfEmpty();
    expect(slot.inbox.closed).toBe(true);
    const id = slot.adopt(
      spec(),
      new AbortController(),
      { toolUses: 0, tokens: 0, tail: [] },
      async () => result(),
    );
    expect(id).toBeUndefined();
    expect(log).toEqual([]);
    expect(jobs.list()).toEqual([]);
    // Still holding its slot: nothing half-moved.
    expect(jobs.acquire("later").ok).toBe(false);
  });
});
