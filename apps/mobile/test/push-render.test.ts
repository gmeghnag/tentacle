/**
 * docs/feat/mobile-notifications.md Design 1 / slice N2. Each test names the
 * mutation that turns it red (AGENTS §9). The vectors
 * (`test/fixtures/push-render-v1.json`) are the ONE spec the Swift NSE's tests
 * also read (decision 20): the TS assertions below and the Swift suite prove the
 * same table.
 */
import { describe, expect, test } from "bun:test";
import type { PushAsk, PushMessage } from "@tentacle/protocol";
import { PUSH_KINDS } from "@tentacle/protocol";
import {
  ACTION_APPROVE,
  ACTION_DENY,
  ACTION_OPEN,
  ACTION_REPLY,
  NOTIFICATION_CATEGORIES,
  categorySpec,
} from "../src/notification-categories.ts";
import {
  CATEGORY_ASK,
  CATEGORY_ASK_REPLY,
  CATEGORY_OPEN,
  PLACEHOLDER_TEXT,
  type Rendered,
  categoryFor,
  placeholder,
  projectName,
  render,
} from "../src/push-render.ts";

const NOW = 1_800_000_000_000;

const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" as const },
];

const ask = (over: Partial<PushAsk> = {}): PushAsk => ({
  requestId: "req-1",
  tool: "shell",
  title: "Run a shell command",
  preview: "rm -rf build",
  options: [...OPTIONS],
  ...over,
});

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  v: 1,
  id: "0123456789abcdef0123456789abcdef",
  at: NOW,
  kind: "ask",
  computer: "computer-1",
  cwd: "/home/me/tentacle",
  sessionId: "sess-1",
  title: "Fix the failing test",
  ask: ask(),
  ...over,
});

const peer = { computerName: "MacBook" };

describe("render: the banner's words (decision 17: one session title)", () => {
  test("an ask names the computer and the project, the session as subtitle, the command as body", () => {
    const r = render(message(), peer, NOW);
    expect(r.title).toBe("MacBook · tentacle");
    expect(r.subtitle).toBe("Fix the failing test");
    expect(r.body).toBe("Run a shell command: rm -rf build");
    expect(r.interruptionLevel).toBe("timeSensitive");
    expect(r.sound).toBe(true);
    expect(r.threadIdentifier).toBe("s:sess-1");
    expect(r.placeholder).toBe(false);
    expect(r.category).toBe(CATEGORY_ASK);
  });

  test("more waiting is folded in: ' · +N more waiting'", () => {
    const r = render(message({ ask: ask({ more: 2 }) }), peer, NOW);
    expect(r.body).toBe("Run a shell command: rm -rf build · +2 more waiting");
  });

  test("ask_resolved replaces the banner: passive, quiet, same thread, one action (Open)", () => {
    const r = render(message({ kind: "ask_resolved", ask: undefined }), peer, NOW);
    expect(r.body).toBe("Answered on another device");
    expect(r.category).toBe(CATEGORY_OPEN);
    expect(r.interruptionLevel).toBe("passive");
    expect(r.sound).toBe(false);
    expect(r.threadIdentifier).toBe("s:sess-1");
    // No requestId: this ask is settled everywhere, nothing to route to.
    expect(r.hints).toEqual({
      v: 1,
      kind: "ask_resolved",
      computerId: "computer-1",
      sessionId: "sess-1",
    });
  });

  test("turn_done: quiet, grouped per session; turn_failed says why", () => {
    const done = render(message({ kind: "turn_done", ask: undefined }), peer, NOW);
    expect(done.body).toBe("Turn finished");
    expect(done.interruptionLevel).toBe("passive");
    expect(done.sound).toBe(false);
    expect(done.threadIdentifier).toBe("s:sess-1");
    expect(done.category).toBe(CATEGORY_OPEN);
    const failed = render(
      message({ kind: "turn_failed", ask: undefined, turn: { turnId: "t1", error: "model 500" } }),
      peer,
      NOW,
    );
    expect(failed.body).toBe("Turn failed: model 500");
    const bare = render(
      message({ kind: "turn_failed", ask: undefined, turn: { turnId: "t1" } }),
      peer,
      NOW,
    );
    expect(bare.body).toBe("Turn failed");
  });

  test("the routing hints carry the ask's requestId, and only an ask's", () => {
    expect(render(message(), peer, NOW).hints).toEqual({
      v: 1,
      kind: "ask",
      computerId: "computer-1",
      sessionId: "sess-1",
      requestId: "req-1",
    });
    const done = render(message({ kind: "turn_done", ask: undefined }), peer, NOW);
    expect(done.hints !== undefined && "requestId" in done.hints).toBe(false);
  });
});

describe("render: Approve is only ever allow_once (decision 8)", () => {
  test("allow_once + reject_once → tentacle.ask (Approve/Deny/Open)", () => {
    expect(render(message(), peer, NOW).category).toBe(CATEGORY_ASK);
  });

  test("an ask that offers only allow_always gets NO Approve (mutation: map Approve to allow_always → this fails)", () => {
    // A lasting rule is a decision that needs the sheet's full context; a
    // notification must never create one. With no allow_once offered there is
    // nothing a notification can safely approve — so only Open.
    const r = render(
      message({
        ask: ask({
          options: [{ optionId: "allow_always", name: "Allow always", kind: "allow_always" }],
        }),
      }),
      peer,
      NOW,
    );
    expect(r.category).toBe(CATEGORY_OPEN);
    expect(r.hints?.requestId).toBe("req-1");
    // …and the category it names really has no Approve action.
    const spec = categorySpec(r.category);
    expect(spec?.actions.map((a) => a.identifier)).toEqual([ACTION_OPEN]);
  });

  test("allow_always + reject_once is still Open only: a lasting rule needs the sheet", () => {
    // The case that distinguishes "an approval is offered" from "a LASTING rule is
    // offered" — which no vector covers, so it is asserted here and in the Swift
    // suite (`testAllowAlwaysPlusRejectStillHasNoApprove`).
    // Mutation: treat allow_always as approvable → red.
    const r = render(
      message({
        ask: ask({
          options: [
            { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
        }),
      }),
      peer,
      NOW,
    );
    expect(r.category).toBe(CATEGORY_OPEN);
  });

  test("an ask with no reject_once is Open only too (a Deny nobody offered is not invented)", () => {
    const r = render(
      message({
        ask: ask({ options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }] }),
      }),
      peer,
      NOW,
    );
    expect(r.category).toBe(CATEGORY_OPEN);
  });

  test("a reply is offered only where the daemon takes one", () => {
    expect(categoryFor(ask({ reply: { maxChars: 500 } }))).toBe(CATEGORY_ASK_REPLY);
    expect(categoryFor(ask({ reply: undefined }))).toBe(CATEGORY_ASK);
  });
});

describe("render: the placeholder is the safe default", () => {
  test("a future plaintext version → placeholder, with NO category and NO hints", () => {
    // Mutation: render `v: 2` with this build's rules → red (a newer daemon's
    // content half-rendered, F11).
    const r = render({ ...message(), v: 2 } as unknown as PushMessage, peer, NOW);
    expect(r).toEqual(placeholder());
    expect(r.category).toBe("");
    expect(r.hints).toBeUndefined();
    expect(r.body).toBe(PLACEHOLDER_TEXT);
  });

  test("an ask kind with no ask body → placeholder (never half-built)", () => {
    const r = render(message({ ask: undefined }), peer, NOW);
    expect(r).toEqual(placeholder());
  });

  test("the placeholder adds nothing a hostile relay could act on", () => {
    const p = placeholder();
    expect(p.category).toBe("");
    expect(p.hints).toBeUndefined();
    expect(p.sound).toBe(false);
    expect(p.placeholder).toBe(true);
  });
});

describe("render: display integrity (a pod's text is untrusted)", () => {
  test("ANSI and control characters are stripped from every shown string", () => {
    const r = render(
      message({
        title: "Fix\u001b[2Jit",
        cwd: "/home/me/\u0007repo",
        ask: ask({ title: "Run\u001b[31m", preview: "ls\u0007 -la" }),
      }),
      { computerName: "Mac\u001b[0mBook" },
      NOW,
    );
    expect(r.title).toBe("MacBook · repo");
    expect(r.subtitle).toBe("Fixit");
    expect(r.body).toBe("Run: ls -la");
  });

  test("projectName takes the last non-empty segment", () => {
    expect(projectName("/home/me/repo")).toBe("repo");
    expect(projectName("/home/me/repo/")).toBe("repo");
    expect(projectName("repo")).toBe("repo");
  });
});

describe("categories: the registered actions", () => {
  test("Approve is a foreground action; Deny is not and is destructive; Reply asks the device", () => {
    const spec = categorySpec(CATEGORY_ASK_REPLY);
    expect(spec?.actions.map((a) => a.identifier)).toEqual([
      ACTION_APPROVE,
      ACTION_DENY,
      ACTION_REPLY,
      ACTION_OPEN,
    ]);
    const approve = spec?.actions.find((a) => a.identifier === ACTION_APPROVE);
    const deny = spec?.actions.find((a) => a.identifier === ACTION_DENY);
    const reply = spec?.actions.find((a) => a.identifier === ACTION_REPLY);
    // Mutation: `opensAppToForeground: false` on Approve → red: biometrics need
    // the app in front (decision 14).
    expect(approve?.opensAppToForeground).toBe(true);
    expect(deny?.opensAppToForeground).toBe(false);
    expect(deny?.destructive).toBe(true);
    expect(deny?.authenticationRequired).toBeUndefined();
    // Owner Q3: the person's words reach the model, so the DEVICE is unlocked first.
    expect(reply?.authenticationRequired).toBe(true);
    expect(reply?.textInput).toEqual({
      buttonTitle: "Send",
      placeholder: "Tell the agent what to do instead",
    });
  });

  test("every category these modules can name is registered", () => {
    expect(NOTIFICATION_CATEGORIES.map((c) => c.identifier)).toEqual([
      CATEGORY_ASK,
      CATEGORY_ASK_REPLY,
      CATEGORY_OPEN,
    ]);
    const named = new Set<string>([CATEGORY_ASK, CATEGORY_ASK_REPLY, CATEGORY_OPEN]);
    for (const kind of PUSH_KINDS) {
      const rendered = render(
        message({ kind, ask: kind.startsWith("ask") ? ask() : undefined }),
        peer,
        NOW,
      );
      expect(rendered.placeholder || named.has(rendered.category)).toBe(true);
    }
  });
});

describe("vectors: one spec, two implementations (decision 20)", () => {
  test("the committed table is what this build renders", async () => {
    const file = await Bun.file(new URL("./fixtures/push-render-v1.json", import.meta.url)).json();
    const cases = file.cases as {
      name: string;
      message: PushMessage;
      peer: { computerName: string };
      now: number;
      expected: Rendered;
    }[];
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) {
      expect({ name: c.name, rendered: render(c.message, c.peer, c.now) }).toEqual({
        name: c.name,
        rendered: c.expected,
      });
    }
  });
});
