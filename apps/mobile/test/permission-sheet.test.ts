/**
 * The permission sheet (docs/feat/mobile-session-view.md 12c). The plan's own
 * mutation is the age guard (`ARM_MS = 0` → red); the rest pin the failure
 * modes F4–F7 and the owner's "options exactly as offered" rule.
 *
 * Every case drives the module's PUBLIC surface (the `PermissionRequester` it
 * hands the broker, `view`, `answer`), because that is what the screen and the
 * client's router actually call.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import {
  ARM_MS,
  createPermissionSheet,
  labelRuns,
  optionStyle,
  responseFor,
  returnedNotice,
  sheetOptions,
} from "../src/permission-sheet.ts";

/** The daemon's own ask for an `fs_write` (`packages/daemon/src/permission-map.ts`). */
function ask(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "fs_write",
    level: "ask",
    title: "Write a file",
    detail: "a.txt",
    input: {},
    reply: { maxChars: 2000 },
    ...over,
  };
}

/** A sheet with a controllable clock. */
function sheetAt(clock = { at: 1000 }, armMs?: number) {
  const seen: string[] = [];
  const sheet = createPermissionSheet({
    now: () => clock.at,
    ...(armMs === undefined ? {} : { armMs }),
    onChange: (state) => seen.push(state.kind),
  });
  return { sheet, clock, seen };
}

/**
 * Ask through the requester, as the client's broker does: its own signal (the
 * one the router's `AbortController` would own) unless the case supplies one.
 */
function request(
  sheet: ReturnType<typeof sheetAt>["sheet"],
  req: PermissionRequest = ask(),
  options: { signal?: AbortSignal; agent?: { type: string; description: string } } = {},
): { answer: Promise<PermissionResponse>; signal: AbortSignal } {
  const own = new AbortController();
  const signal = options.signal ?? own.signal;
  const answer = sheet.requester(req, {
    signal,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  return { answer, signal };
}

describe("the age guard (plan P10; mutation: ARM_MS = 0 → red)", () => {
  test("a tap inside ARM_MS of the ask appearing is IGNORED, and the ask stays", async () => {
    const { sheet, clock } = sheetAt();
    const { answer } = request(sheet);
    await Promise.resolve();
    expect(sheet.view().kind).toBe("asking");
    // 399 ms: inside the window.
    clock.at += ARM_MS - 1;
    expect(sheet.answer("allow_once")).toBe("ignored");
    expect(sheet.view().kind).toBe("asking"); // still there: nothing was decided
    // ARM_MS later the same tap works.
    clock.at += 1;
    expect(sheet.answer("allow_once")).toBe("sent");
    expect(await answer).toEqual({ allowed: true, scope: "once" });
  });

  test("the window re-arms for the NEXT ask (a sheet that swaps is a new decision)", async () => {
    const { sheet, clock } = sheetAt();
    const first = request(sheet);
    await Promise.resolve();
    clock.at += ARM_MS;
    expect(sheet.answer("allow_once")).toBe("sent");
    first.answer.catch(() => {});

    // The next ask appears at `clock.at`: its taps are guarded again, even though
    // the previous one had been on screen for ages.
    const second = request(sheet);
    await Promise.resolve();
    expect(sheet.view().kind).toBe("asking");
    expect(sheet.answer("allow_once")).toBe("ignored");
    clock.at += ARM_MS;
    expect(sheet.answer("reject_once")).toBe("sent");
    expect(await second.answer).toEqual({ allowed: false });
  });

  test("view() reports `armed` by the clock, so the screen can dim the options", async () => {
    const { sheet, clock } = sheetAt();
    request(sheet);
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ kind: "asking", armed: false });
    clock.at += ARM_MS;
    expect(sheet.view()).toMatchObject({ kind: "asking", armed: true });
  });

  test("the release is EMITTED as a state change, so the screen never polls a clock", async () => {
    // The bug flow 08 found on the simulator: `armed` was computed from the clock
    // at render time, so nothing woke the sheet up when the window ended and the
    // options stayed dimmed and `disabled` for ever. The module now SCHEDULES the
    // release and emits it through `onChange`, like every other change.
    // Mutation: drop the `schedule(...)` call in `present` → `seen` never gets an
    // armed:true state and this test is red.
    const pending: (() => void)[] = [];
    const seen: { readonly armed?: boolean }[] = [];
    const clock = { at: 1000 };
    const sheet = createPermissionSheet({
      now: () => clock.at,
      onChange: (state) => seen.push(state as { readonly armed?: boolean }),
      schedule: (fn) => {
        pending.push(fn);
        return { cancel: () => undefined };
      },
    });
    request(sheet);
    await Promise.resolve();
    expect(seen.at(-1)).toMatchObject({ kind: "asking", armed: false });
    expect(pending).toHaveLength(1); // one scheduled release, not none
    clock.at += ARM_MS;
    for (const release of pending.splice(0)) {
      release();
    }
    expect(seen.at(-1)).toMatchObject({ kind: "asking", armed: true, armedInMs: 0 });
    // And the tap the person then makes lands.
    expect(sheet.answer("allow_once")).toBe("sent");
  });

  test("a withdrawn ask CANCELS its scheduled release (no armed state for a gone ask)", async () => {
    const pending: (() => void)[] = [];
    let cancelled = 0;
    const clock = { at: 1000 };
    const sheet = createPermissionSheet({
      now: () => clock.at,
      schedule: (fn) => {
        pending.push(fn);
        return {
          cancel: () => {
            cancelled += 1;
          },
        };
      },
    });
    const controller = new AbortController();
    request(sheet, ask(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(cancelled).toBe(1);
    clock.at += ARM_MS;
    for (const release of pending) {
      release();
    }
    // The ask was withdrawn, so no "armed" state was ever presented for it.
    expect(sheet.view().kind).toBe("idle");
  });

  test("`armedInMs` counts down to the release, so the SCREEN knows when to re-render", async () => {
    // Without this the sheet has no clock event to wake on: the options stayed
    // dimmed and `disabled` for ever on the simulator (found by flow 08).
    const { sheet, clock } = sheetAt();
    request(sheet);
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ armed: false, armedInMs: ARM_MS });
    clock.at += ARM_MS - 100;
    expect(sheet.view()).toMatchObject({ armed: false, armedInMs: 100 });
    clock.at += 100;
    expect(sheet.view()).toMatchObject({ armed: true, armedInMs: 0 });
    // The next ask counts down again from its own arrival.
    clock.at += 5000;
    const second = request(sheet, ask({ title: "Next" }));
    await Promise.resolve();
    clock.at += ARM_MS;
    sheet.answer("allow_once");
    void second;
  });

  test("an injected armMs of 0 arms at once (the plan's own mutation, as a contract)", async () => {
    // Keeping this case makes ARM_MS = 0 a RED mutation rather than a silent
    // behaviour change: with 0 the first two cases above fail.
    const { sheet } = sheetAt(undefined, 0);
    request(sheet);
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ armed: true });
    expect(sheet.answer("allow_once")).toBe("sent");
  });
});

describe("the presented ask carries the daemon's id (S5 route param)", () => {
  test("asking carries requestId, and null when the requester had none", async () => {
    // Mutation: `requestId: entry.options?.requestId ?? null` → hardcoded null → red.
    const { sheet, clock } = sheetAt();
    const answer = sheet.requester(ask(), { requestId: "ask-7" });
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ kind: "asking", requestId: "ask-7" });
    clock.at += ARM_MS;
    expect(sheet.answer("allow_once")).toBe("sent");
    await answer;

    const local = sheetAt();
    const plain = local.sheet.requester(ask());
    await Promise.resolve();
    expect(local.sheet.view()).toMatchObject({ kind: "asking", requestId: null });
    local.clock.at += ARM_MS;
    expect(local.sheet.answer("allow_once")).toBe("sent");
    await plain;
  });
});

describe("the options are exactly what the daemon offered", () => {
  test("all three wherever a reply is offered", () => {
    expect(sheetOptions(ask()).map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reply",
    ]);
  });

  test("no reply option when the asker takes no reply (an older daemon)", () => {
    expect(sheetOptions(ask({ reply: undefined })).map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
  });

  test("the suggestion names the narrower rule (the daemon's own wording)", () => {
    const options = sheetOptions(ask({ suggestion: { prefix: "git commit" } }));
    expect(options.find((o) => o.optionId === "allow_always")?.label).toBe(
      "Allow `git commit` commands for this session",
    );
  });

  test("an answer maps onto the daemon's option ids, never a guessed one", () => {
    // The bridge's vocabulary (`permission-map.ts`'s allow_once/allow_always/reject_once).
    expect(responseFor("allow_once", "")).toEqual({ allowed: true, scope: "once" });
    expect(responseFor("allow_always", "")).toEqual({ allowed: true, scope: "session" });
    expect(responseFor("reject_once", "")).toEqual({ allowed: false });
  });

  test("reply needs words: an empty field sends nothing (a bare No would be a lie)", () => {
    expect(responseFor("reply", "   ")).toBeNull();
    expect(responseFor("reply", "do it another way")).toEqual({
      allowed: false,
      message: "do it another way",
    });
  });
});

describe("the reply path (F7)", () => {
  test("the reply option opens the field and answers NOTHING yet", async () => {
    const { sheet, clock } = sheetAt();
    const { answer } = request(sheet);
    await Promise.resolve();
    clock.at += ARM_MS;
    expect(sheet.answer("reply")).toBe("typing");
    expect(sheet.view()).toMatchObject({ kind: "asking" });
    sheet.setReplyText("use a different path");
    expect(sheet.sendReply()).toBe("sent");
    expect(await answer).toMatchObject({ allowed: false, message: "use a different path" });
  });

  test("the words come back when the answer never reached the agent (onAnswerLost)", async () => {
    // The client's router calls this when the daemon says settled/failed.
    const { sheet, clock } = sheetAt();
    const { answer } = request(sheet);
    await Promise.resolve();
    clock.at += ARM_MS;
    sheet.answer("reply");
    sheet.setReplyText("please use /tmp instead");
    sheet.sendReply();
    const response = await answer;
    expect(response.onAnswerLost).toBeDefined();
    response.onAnswerLost?.("settled");
    expect(sheet.view()).toMatchObject({
      kind: "returned",
      text: "please use /tmp instead",
      cause: "settled",
    });
    // The notice says WHICH cause, in the TUI's words (`permission-reply.ts`).
    expect(returnedNotice("settled")).toContain("already settled");
    expect(returnedNotice("unreplyable")).toContain("does not take a reply");
    sheet.clearReturned();
    expect(sheet.view().kind).toBe("idle");
  });

  test("the field is only writable while the reply option is open", async () => {
    const { sheet, clock } = sheetAt();
    request(sheet);
    await Promise.resolve();
    clock.at += ARM_MS;
    sheet.setReplyText("ignored: not opened yet");
    expect(sheet.view()).toMatchObject({ kind: "asking", replyText: "" });
    expect(sheet.sendReply()).toBe("ignored");
  });
});

describe("a withdrawn ask sends nothing (F4, P3)", () => {
  test("its signal → DISMISSED, the sheet closes, and no option is ever answered", async () => {
    const { sheet, clock } = sheetAt();
    const controller = new AbortController();
    const { answer } = request(sheet, ask(), { signal: controller.signal });
    await Promise.resolve();
    clock.at += ARM_MS;
    expect(sheet.view().kind).toBe("asking");
    controller.abort(); // answered on another device
    expect(await answer).toEqual({ allowed: false, dismissed: true });
    expect(sheet.view().kind).toBe("idle");
    // A tap that arrives after the withdrawal decides nothing.
    expect(sheet.answer("allow_once")).toBe("ignored");
  });

  test("a signal already aborted before the ask shows it at all", async () => {
    const { sheet } = sheetAt();
    const controller = new AbortController();
    controller.abort();
    const response = await sheet.requester(ask(), { signal: controller.signal });
    expect(response).toEqual({ allowed: false, dismissed: true });
    expect(sheet.view().kind).toBe("idle");
  });

  test("dismiss (the screen unmounted) withdraws the ask and every queued one", async () => {
    const { sheet } = sheetAt();
    const first = request(sheet);
    const second = request(sheet, ask({ title: "Second" }));
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ kind: "asking" });
    sheet.dismiss();
    expect(await first.answer).toEqual({ allowed: false, dismissed: true });
    expect(await second.answer).toEqual({ allowed: false, dismissed: true });
    expect(sheet.view().kind).toBe("idle");
  });
});

describe("one ask at a time, FIFO", () => {
  test("a second ask waits; answering the first presents it, armed again", async () => {
    const { sheet, clock } = sheetAt();
    const first = request(sheet, ask({ title: "First", detail: "a.txt" }));
    const second = request(sheet, ask({ title: "Second", detail: "b.txt" }));
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({ kind: "asking", request: { title: "First" } });
    clock.at += ARM_MS;
    sheet.answer("allow_once");
    expect((await first.answer).allowed).toBe(true);
    expect(sheet.view()).toMatchObject({ kind: "asking", request: { title: "Second" } });
    // The next ask is a new decision: its sim window applies again.
    expect(sheet.answer("allow_once")).toBe("ignored");
    clock.at += ARM_MS;
    sheet.answer("reject_once");
    expect((await second.answer).allowed).toBe(false);
  });

  test("withdrawing the ask on screen lets the queued one through", async () => {
    const { sheet, clock } = sheetAt();
    const controller = new AbortController();
    const first = request(sheet, ask({ title: "First" }), { signal: controller.signal });
    const second = request(sheet, ask({ title: "Second" }));
    await Promise.resolve();
    controller.abort();
    expect(await first.answer).toEqual({ allowed: false, dismissed: true });
    expect(sheet.view()).toMatchObject({ kind: "asking", request: { title: "Second" } });
    clock.at += ARM_MS;
    sheet.answer("allow_once");
    expect((await second.answer).allowed).toBe(true);
  });

  test("a sub-agent's ask carries its label for the sheet (display only)", async () => {
    const { sheet } = sheetAt();
    request(sheet, ask(), { agent: { type: "explore", description: "look around" } });
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({
      kind: "asking",
      agent: { type: "explore", description: "look around" },
    });
  });
});

describe("optionStyle: each answer's pill (mockup `Approval`, Slice 4)", () => {
  test("allow once is the primary pill, allow always the tinted one, deny destructive", () => {
    expect(optionStyle("allow_once")).toEqual({ pill: "primary", icon: null });
    expect(optionStyle("allow_always")).toEqual({ pill: "secondary", icon: null });
    expect(optionStyle("reject_once")).toEqual({ pill: "destructive", icon: null });
  });

  test("reply is neutral with the speech-bubble icon", () => {
    expect(optionStyle("reply")).toEqual({ pill: "neutral", icon: "bubble.left" });
  });

  test("an id this build does not know is drawn neutral — shown, never dropped", () => {
    expect(optionStyle("allow_forever_v9")).toEqual({ pill: "neutral", icon: null });
  });

  test("every option sheetOptions can produce has a non-neutral or reply style", () => {
    for (const option of sheetOptions(ask())) {
      const style = optionStyle(option.optionId);
      expect(style.pill !== "neutral" || style.icon !== null).toBe(true);
    }
  });
});

describe("labelRuns: a label's `code` spans (no literal backticks on screen, B3)", () => {
  test("the suggested-rule label shows the prefix as code, without its backticks", () => {
    expect(labelRuns("Allow `bun test` commands for this session")).toEqual([
      { text: "Allow ", code: false },
      { text: "bun test", code: true },
      { text: " commands for this session", code: false },
    ]);
  });

  test("a label without backticks is one plain run", () => {
    expect(labelRuns("Allow once")).toEqual([{ text: "Allow once", code: false }]);
  });

  test("an unpaired backtick is kept as text (never a half-open code run)", () => {
    expect(labelRuns("it`s fine")).toEqual([{ text: "it`s fine", code: false }]);
  });
});

describe("answerFor: a workflow card answers ONE named ask (docs/feat/workflows-ui.md D4)", () => {
  test("the ask on screen carries its agent id, for the step pairing (`askForStep`)", async () => {
    const { sheet } = sheetAt();
    void sheet.requester(ask({ kind: "workflow_approve" }), {
      requestId: "ask-1",
      agent: { type: "workflow", description: "merge", id: "wf-1.merge" },
    });
    await Promise.resolve();
    expect(sheet.view()).toMatchObject({
      kind: "asking",
      requestId: "ask-1",
      agentId: "wf-1.merge",
    });
    const plain = sheetAt();
    void plain.sheet.requester(ask(), { requestId: "ask-2" });
    await Promise.resolve();
    expect(plain.sheet.view()).toMatchObject({ kind: "asking", agentId: null });
  });

  test("the named ask is settled through the SAME path as a tap on the sheet", async () => {
    const { sheet, clock } = sheetAt();
    const answer = sheet.requester(ask({ kind: "workflow_approve" }), { requestId: "ask-1" });
    await Promise.resolve();
    clock.at += ARM_MS;
    expect(sheet.answerFor("ask-1", "allow_once")).toBe("sent");
    expect(await answer).toEqual({ allowed: true, scope: "once" });
    expect(sheet.view().kind).toBe("idle");
  });

  test("a card for an ask that is no longer on screen answers NOTHING (stale card)", async () => {
    // Mutation: answerFor ignores the id (calls `answer`) → the OTHER ask is allowed → red.
    const { sheet, clock } = sheetAt();
    let settled = false;
    void sheet.requester(ask({ title: "other" }), { requestId: "ask-2" }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    clock.at += ARM_MS;
    expect(sheet.answerFor("ask-1", "allow_once")).toBe("ignored");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sheet.view()).toMatchObject({ kind: "asking", requestId: "ask-2" });
  });

  test("the age guard holds for a card too; opening the field is not an answer", async () => {
    const { sheet, clock } = sheetAt();
    void sheet.requester(ask(), { requestId: "ask-1" });
    await Promise.resolve();
    expect(sheet.answerFor("ask-1", "reject_once")).toBe("ignored");
    // docs/fix/a2a-question-workflow-label.md D5 (it supersedes this case's old
    // "reply is not a card answer"): opening the refusal field sends nothing, so
    // the guard — which protects a DECISION — does not apply; `sendReply` does.
    expect(sheet.answerFor("ask-1", "reply")).toBe("typing");
    expect(sheet.view()).toMatchObject({ kind: "asking", replyOpen: true });
    expect(sheet.answerFor("ask-1", "reject_once")).toBe("ignored");
    clock.at += ARM_MS;
    expect(sheet.answerFor("ask-1", "reject_once")).toBe("sent");
  });
});

describe("`reviewed`: the person brought the ask up from a banner (mobile-workflows-landing-v2 D1)", () => {
  /** A sheet whose broker answers are observable (a tap on a banner sends nothing). */
  function watched() {
    const h = sheetAt();
    const answers: PermissionResponse[] = [];
    const raise = (requestId?: string) => {
      void h.sheet
        .requester(ask(), requestId === undefined ? undefined : { requestId })
        .then((r) => answers.push(r));
    };
    return { ...h, answers, raise };
  }

  test("a new ask is born unreviewed, with the daemon's id or without one", () => {
    const named = watched();
    named.raise("ask-1");
    expect(named.sheet.view()).toMatchObject({ kind: "asking", reviewed: false });
    const local = watched();
    local.raise();
    expect(local.sheet.view()).toMatchObject({ kind: "asking", reviewed: false });
  });

  test("unpark() on an unparked, unreviewed ask marks it reviewed and sends NOTHING", async () => {
    const h = watched();
    h.raise("ask-1");
    h.sheet.unpark();
    expect(h.sheet.view()).toMatchObject({ kind: "asking", parked: false, reviewed: true });
    await Promise.resolve();
    expect(h.answers).toEqual([]);
    expect(h.sheet.asking).toBe(true);
  });

  test("unpark() on a parked ask sets both; a swipe keeps `reviewed`", async () => {
    const h = watched();
    h.raise("ask-1");
    h.sheet.park();
    expect(h.sheet.view()).toMatchObject({ parked: true, reviewed: false });
    h.sheet.unpark();
    expect(h.sheet.view()).toMatchObject({ parked: false, reviewed: true });
    h.sheet.park();
    expect(h.sheet.view()).toMatchObject({ parked: true, reviewed: true });
    h.sheet.unpark();
    expect(h.sheet.view()).toMatchObject({ parked: false, reviewed: true });
    await Promise.resolve();
    expect(h.answers).toEqual([]);
  });

  test("the NEXT ask after an answer is born unreviewed", () => {
    const h = watched();
    h.raise("ask-1");
    h.raise("ask-2");
    h.sheet.unpark();
    h.clock.at += ARM_MS;
    expect(h.sheet.answer("allow_once")).toBe("sent");
    expect(h.sheet.view()).toMatchObject({ requestId: "ask-2", reviewed: false });
  });

  test("unpark() changes nothing on idle, or on an ask already up and reviewed", () => {
    const { sheet, seen } = sheetAt();
    sheet.unpark();
    expect(seen).toEqual([]);
    request(sheet);
    sheet.unpark();
    const changes = seen.length;
    sheet.unpark();
    expect(seen.length).toBe(changes);
  });

  test("unpark() leaves a returned reply alone", async () => {
    const { sheet, clock, seen } = sheetAt();
    const { answer } = request(sheet);
    clock.at += ARM_MS;
    sheet.answer("reply");
    sheet.setReplyText("not that");
    sheet.sendReply();
    (await answer).onAnswerLost?.("settled");
    const changes = seen.length;
    sheet.unpark();
    expect(seen.length).toBe(changes);
    expect(sheet.view().kind).toBe("returned");
  });
});
