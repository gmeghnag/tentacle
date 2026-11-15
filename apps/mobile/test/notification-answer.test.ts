/**
 * docs/feat/mobile-notifications.md Design 4 / slice N6: the answer coordinator.
 * Every test names the mutation that turns it red (AGENTS §9). The effects are
 * injected, so the whole background/foreground sequence runs without a phone.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type NotificationAnswerOutcome, RemoteClient } from "@tentacle/client";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionResponse,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import type { AuthResult } from "../src/app-lock.ts";
import {
  ANSWER_BUDGET_MAX_MS,
  ANSWER_BUDGET_MS,
  type AnswerClient,
  type AnswerDeps,
  type AppNotice,
  type FallbackNotice,
  NotificationAnswerer,
  answerDecision,
  approvePrompt,
} from "../src/notification-answer.ts";

const DECISION = {
  do: "deny" as const,
  computerId: "c1",
  sessionId: "s1",
  requestId: "req-1",
  tool: "shell",
  response: { allowed: false },
};
const APPROVE = {
  do: "approve" as const,
  computerId: "c1",
  sessionId: "s1",
  requestId: "req-1",
  tool: "shell",
  response: { allowed: true as const, scope: "once" as const },
};

/** The injected world: what happened, in order. */
function rig(
  over: Partial<AnswerDeps> & {
    answer?: NotificationAnswerOutcome;
    linkMissing?: boolean;
    attachThrows?: Error;
    attachedAlready?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const notices: AppNotice[] = [];
  const logs: string[] = [];
  const navigated: string[] = [];
  const fallbacks: { notice: FallbackNotice; ms: number; cancelled: boolean }[] = [];
  const gate = {
    released: 0,
    held: 0,
    hold(ms: number) {
      calls.push(`hold ${ms}`);
      gate.held += 1;
      return () => {
        gate.released += 1;
      };
    },
  };
  const client: AnswerClient = {
    isAttached: () => over.attachedAlready === true,
    attachSession: async () => {
      calls.push("attach");
      if (over.attachThrows) throw over.attachThrows;
      return "s1";
    },
    detachSession: async () => {
      calls.push("detach");
    },
    answerPermission: async (_sessionId, _requestId, response) => {
      calls.push(`answer ${response.allowed ? "allow" : "deny"}`);
      return over.answer ?? "sent";
    },
  };
  const deps: AnswerDeps = {
    links: {
      get: async (computerId) => {
        calls.push(`get ${computerId}`);
        return over.linkMissing ? undefined : { client, hold: gate.hold };
      },
    },
    authenticate: async (prompt) => {
      calls.push(`auth ${prompt}`);
      return (over.authenticate ? await over.authenticate(prompt) : "success") as AuthResult;
    },
    unlockApp: () => calls.push("unlock"),
    scheduleFallback: (notice, ms) => {
      const entry = { notice, ms, cancelled: false };
      fallbacks.push(entry);
      calls.push("schedule-fallback");
      return () => {
        entry.cancelled = true;
        calls.push("cancel-fallback");
      };
    },
    log: (line) => logs.push(line),
    notice: (notice) => notices.push(notice),
    openSession: (route) => navigated.push(JSON.stringify(route)),
    inForeground: () => over.inForeground?.() ?? false,
    computerName: () => "MacBook",
    ...over,
    // The overrides above must not silently replace the spies.
    ...(over.scheduleFallback ? {} : {}),
  };
  return { deps, calls, notices, logs, navigated, fallbacks, gate };
}

describe("Approve asks Face ID ALWAYS (decision 14)", () => {
  test("even when the app is unlocked and in the foreground", () => {
    // Mutation: `if (!unlocked) authenticate(...)` → a lock-screen tap would
    // approve a command with no person in the loop.
    const r = rig({ inForeground: () => true });
    return answerDecision(APPROVE, r.deps).then(() => {
      expect(r.calls).toContain(`auth ${approvePrompt("shell")}`);
    });
  });

  test("the system sheet NAMES the tool being approved (fix round 1, finding #5)", async () => {
    // Design 4 step 1: `authenticate("Approve <tool>?")`. Mutation: pass the
    // action kind (`approvePrompt(decision.do)`) → the sheet reads "Approve
    // approve?" and the person authenticates without being told what for.
    const r = rig({ inForeground: () => true });
    await answerDecision(APPROVE, r.deps);
    const prompt = r.calls.find((c) => c.startsWith("auth ")) ?? "";
    expect(prompt).toBe("auth Approve shell?");
    expect(prompt).not.toContain("approve?");
  });

  test("a cancel sends NOTHING and lands on the session's sheet", async () => {
    const r = rig({
      inForeground: () => true,
      authenticate: async () => "cancel" as AuthResult,
    });
    expect(await answerDecision(APPROVE, r.deps)).toEqual({ kind: "auth-cancelled" });
    expect(r.calls.some((c) => c.startsWith("answer"))).toBe(false);
    expect(r.calls).not.toContain("get c1");
    expect(r.navigated).toEqual([
      JSON.stringify({ computerId: "c1", sessionId: "s1", title: "", archived: false }),
    ]);
  });

  test("a lockout is not a cancel, and neither sends", async () => {
    const r = rig({ inForeground: () => true, authenticate: async () => "lockout" as AuthResult });
    expect(await answerDecision(APPROVE, r.deps)).toEqual({ kind: "auth-failed" });
    expect(r.calls.some((c) => c.startsWith("answer"))).toBe(false);
  });

  test("one Face ID success also clears the app lock (Owner Q2)", async () => {
    const r = rig({ inForeground: () => true });
    await answerDecision(APPROVE, r.deps);
    expect(r.calls).toContain("unlock");
  });

  test("Deny never asks for authentication (works from the lock screen)", async () => {
    const r = rig();
    await answerDecision(DECISION, r.deps);
    expect(r.calls.some((c) => c.startsWith("auth"))).toBe(false);
    expect(r.calls).not.toContain("unlock");
  });
});

describe("the fallback is scheduled BEFORE the dial (F13)", () => {
  test("it is scheduled first, and cancelled on `sent`", async () => {
    // Mutation: schedule it after the dial → a suspended run posts nothing, and
    // the person is never told the answer did not happen.
    const r = rig();
    await answerDecision(DECISION, r.deps);
    const scheduleAt = r.calls.indexOf("schedule-fallback");
    const dialAt = r.calls.indexOf("get c1");
    expect(scheduleAt).toBeGreaterThanOrEqual(0);
    expect(dialAt).toBeGreaterThan(scheduleAt);
    expect(r.calls).toContain("cancel-fallback");
    expect(r.fallbacks[0]?.cancelled).toBe(true);
    expect(r.fallbacks[0]?.ms).toBe(ANSWER_BUDGET_MS);
    expect(r.fallbacks[0]?.notice.text).toBe("Couldn't reach MacBook — tap to answer");
  });

  test("cancelled on `not-pending` too (the ask is settled)", async () => {
    const r = rig({ answer: "not-pending" });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "not-pending" });
    expect(r.fallbacks[0]?.cancelled).toBe(true);
  });

  test("NOT cancelled on a failure: it stands so the person can tap it", async () => {
    const r = rig({ answer: "failed" });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "failed" });
    expect(r.fallbacks[0]?.cancelled).toBe(false);
  });

  test("a reply's words ride the fallback so the sheet can restore them", async () => {
    const r = rig();
    await answerDecision(
      {
        do: "reply",
        computerId: "c1",
        sessionId: "s1",
        requestId: "req-1",
        tool: "shell",
        response: { allowed: false, message: "use bun" },
      },
      r.deps,
    );
    expect(r.fallbacks[0]?.notice.draft).toBe("use bun");
  });

  test("in the FOREGROUND nothing is scheduled and the gate is not held", async () => {
    const r = rig({ inForeground: () => true });
    await answerDecision(DECISION, r.deps);
    expect(r.calls).not.toContain("schedule-fallback");
    expect(r.gate.held).toBe(0);
  });
});

describe("the gate is held for a background action, and released on every outcome", () => {
  for (const [label, over] of [
    ["sent", { answer: "sent" as const }],
    ["not-pending", { answer: "not-pending" as const }],
    ["failed", { answer: "failed" as const }],
    ["session-lost", { answer: "session-lost" as const }],
    ["attach throws", { attachThrows: new Error("dial refused") }],
  ] as const) {
    test(`held once and released once (${label})`, async () => {
      const r = rig(over as unknown as Parameters<typeof rig>[0]);
      await answerDecision(DECISION, r.deps);
      expect(r.gate.held).toBe(1);
      expect(r.gate.released).toBe(1);
    });
  }

  test("no link: nothing is held, because there is no gate to hold (and nothing to dial)", async () => {
    // The gate belongs to the LINK (one per link, AGENTS §7): without a link no
    // dial can happen, so no hold is taken and none is owed back.
    const r = rig({ linkMissing: true });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "unreachable" });
    expect(r.gate.held).toBe(0);
    expect(r.gate.released).toBe(0);
  });

  test("the budget is clamped to the plan's ceiling (never above 25 s)", async () => {
    const r = rig({ budgetMs: 60_000 });
    await answerDecision(DECISION, r.deps);
    expect(r.calls).toContain(`hold ${ANSWER_BUDGET_MAX_MS}`);
    expect(r.fallbacks[0]?.ms).toBe(ANSWER_BUDGET_MAX_MS);
  });
});

describe("attachments: never detach what it did not attach (F19)", () => {
  test("it attaches and detaches when the session was not attached", async () => {
    const r = rig();
    await answerDecision(DECISION, r.deps);
    expect(r.calls.indexOf("attach")).toBeGreaterThan(r.calls.indexOf("get c1"));
    expect(r.calls).toContain("detach");
  });

  test("a session the screen already has is reused, never attached or detached", async () => {
    const r = rig({ attachedAlready: true });
    await answerDecision(DECISION, r.deps);
    expect(r.calls).not.toContain("attach");
    expect(r.calls).not.toContain("detach");
    expect(r.calls.some((c) => c.startsWith("answer"))).toBe(true);
  });

  test("an attach refusal is `unknown-session` (F20), and the gate is still released", async () => {
    const archived = new Error("the session is archived");
    archived.name = "SessionArchived";
    const r = rig({ attachThrows: archived });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "unknown-session" });
    expect(r.calls).not.toContain("detach");
    expect(r.gate.released).toBe(1);
    expect(r.fallbacks[0]?.cancelled).toBe(false);
  });
});

describe("outcomes the person is told (Design 4 step 5)", () => {
  test("foreground `sent`: a short notice, no coding of the command", async () => {
    const r = rig({ inForeground: () => true });
    await answerDecision(APPROVE, r.deps);
    expect(r.notices).toEqual([{ kind: "approved", text: "Approved" }]);
  });

  test("background `sent`: nothing on screen (nobody is there to read it)", async () => {
    const r = rig();
    await answerDecision(DECISION, r.deps);
    expect(r.notices).toEqual([]);
  });

  test("`not-pending` reads 'Already answered' (F17)", async () => {
    const r = rig({ inForeground: () => true, answer: "not-pending" });
    await answerDecision(DECISION, r.deps);
    expect(r.notices).toEqual([{ kind: "answered-elsewhere", text: "Already answered" }]);
  });

  test("`session-lost` is never phrased as success (F2)", async () => {
    const r = rig({ inForeground: () => true, answer: "session-lost" });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "session-lost" });
    expect(r.notices).toEqual([
      { kind: "unreachable", text: "May not have been sent — open the session" },
    ]);
  });

  test("no link is `unreachable` and the fallback stands (F1)", async () => {
    const r = rig({ linkMissing: true });
    expect(await answerDecision(DECISION, r.deps)).toEqual({ kind: "unreachable" });
    expect(r.fallbacks[0]?.cancelled).toBe(false);
  });

  test("a `failed` answer lands on the session's sheet", async () => {
    const r = rig({ answer: "failed" });
    await answerDecision(DECISION, r.deps);
    expect(r.navigated).toHaveLength(1);
  });
});

describe("logs carry ids and outcomes, never text (F23)", () => {
  test("no title, command or reply text appears in any line", async () => {
    const r = rig();
    await answerDecision(
      {
        do: "reply",
        computerId: "c1",
        sessionId: "s1",
        requestId: "req-1234567",
        tool: "shell",
        response: { allowed: false, message: "SECRET-REPLY-TEXT" },
      },
      r.deps,
    );
    const all = r.logs.join("\n");
    expect(all).not.toContain("SECRET-REPLY-TEXT");
    expect(all).not.toContain("rm -rf");
    expect(all).toContain("req-1234"); // 8 chars of the id, so a line is traceable
  });
});

describe("a background answer over a REAL RemoteClient (fix round 1, finding #1)", () => {
  /**
   * The fake client above cannot fail the way the real one does: `deliver` calls
   * `entry.listener?.output(out)` on the session's consumer, so a listener that
   * is `{}` — or any object without the three methods — throws a TypeError on
   * the REPLAY's first frame and the answer degrades to `unreachable`. So this
   * rig is the real stack: a real daemon (`SessionHost` + `Connection`), a real
   * `RemoteClient` on its own in-memory link, and the answer path attaching a
   * session the phone's screen is NOT on.
   */
  async function realRig() {
    const env = {
      id: "rec",
      async exec() {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    } as unknown as ExecutionEnvironment;
    const host = new SessionHost({
      defaultCwd: "/tmp/notification-answer-real",
      createAgent: () => {
        const permissions = new PermissionBroker();
        return {
          agent: new Agent({
            model: {
              id: "scripted",
              async *stream() {
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: "c1",
                    name: "shell",
                    arguments: JSON.stringify({ command: "rm -rf build" }),
                  },
                };
                yield { type: "done" };
              },
            } as ModelProvider,
            tools: new ToolRegistry().register(shellTool),
            env,
            requestPermission: (req, options) => permissions.request(req, options),
          }),
          permissions,
        };
      },
    });
    const [dch, cch] = createChannelPair();
    new Connection(dch, host);
    const peer = new RpcPeer(cch, {});
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await peer.request("session/open", { sessionId: "S", create: true });
    await peer.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    for (let i = 0; i < 400; i++) {
      await Promise.resolve();
    }
    const [dch2, cch2] = createChannelPair();
    new Connection(dch2, host);
    const errors: Error[] = [];
    const client = new RemoteClient(
      cch2,
      new PermissionBroker(
        (_req, opts) =>
          new Promise<PermissionResponse>((resolve) => {
            opts?.signal?.addEventListener(
              "abort",
              () => resolve({ allowed: false, dismissed: true }),
              { once: true },
            );
          }),
      ),
      undefined,
      { onError: (e) => errors.push(e) },
    );
    await client.initialize();
    return {
      client,
      errors,
      close: () => {
        peer.close();
        client.close();
      },
    };
  }

  test("attaching a session the screen is not on does not throw inside the client", async () => {
    // Mutation: pass `{}` as the attach listener (or drop any of the three
    // methods from `backgroundListener()`) → `deliver` throws
    // "entry.listener?.output is not a function", the run is `unreachable`, and
    // the person's Deny is never sent.
    const r = await realRig();
    const logs: string[] = [];
    const answerer = new NotificationAnswerer({
      links: { get: async () => ({ client: r.client, hold: () => () => {} }) },
      authenticate: async () => "success" as AuthResult,
      scheduleFallback: () => () => {},
      inForeground: () => true,
      computerName: () => "MacBook",
      log: (line) => logs.push(line),
    });
    // The ask's id is unknown to this client (it never saw the push): the answer
    // is `not-pending`, but only AFTER the attach succeeded. Before the fix the
    // attach throws and the outcome is `unreachable`.
    const outcome = await answerer.run({ ...DECISION, sessionId: "S" });
    expect(outcome).toEqual({ kind: "not-pending" });
    expect(r.errors).toEqual([]);
    r.close();
  });
});

describe("the in-flight join (F18)", () => {
  test("a second tap for the same request joins the running answer", async () => {
    // Mutation: drop the map → two answers are sent for one ask.
    let answers = 0;
    let release: () => void = () => {};
    const deps = rig().deps;
    const answerer = new NotificationAnswerer({
      ...deps,
      links: {
        get: async () => ({
          hold: () => () => {},
          client: {
            isAttached: () => false,
            attachSession: async () => "s1",
            detachSession: async () => {},
            answerPermission: async () => {
              answers += 1;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return "sent";
            },
          },
        }),
      },
    });
    const first = answerer.run(DECISION);
    const second = answerer.run(DECISION);
    expect(answerer.isRunning("c1", "req-1")).toBe(true);
    // Let the (injected, async) dial chain reach `answerPermission` before
    // releasing it: the two runs must have joined BEFORE the await.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(answers).toBe(1);
    expect(a).toEqual({ kind: "sent" });
    expect(b).toEqual({ kind: "sent" });
    expect(answerer.isRunning("c1", "req-1")).toBe(false);
    // A different request is its own run.
    release = () => {};
    const third = answerer.run({ ...DECISION, requestId: "req-2" });
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    release();
    expect((await third).kind).toBe("sent");
    expect(answers).toBe(2);
  });
});
