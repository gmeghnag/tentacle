import { describe, expect, test } from "bun:test";
import {
  PermissionBroker,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
} from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";

// docs/feat/permission-reply.md: "No, let's talk about it" in the real App —
// frames via ink-testing-library (AGENTS §6). A session that tells own turns
// (`own-*`) from another device's.

const ESC = "\x1b";
const SHIFT_TAB = "\x1b[Z";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const session = (): SessionController => ({
  async *send(prompt) {
    yield { type: "text", delta: `reply to ${prompt}` };
    yield { type: "turn_end", reason: "end_turn" };
  },
  ownsTurn: (id) => id.startsWith("own"),
});

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "rm -rf build",
  input: {},
  reply: { maxChars: 2000 },
};

async function mount() {
  const permissions = new PermissionBroker();
  const app = render(
    <App createSession={session} permissions={permissions} model="m" cwd="/tmp/work" />,
  );
  await delay(30);
  const answers: PermissionResponse[] = [];
  const ask = async (req: PermissionRequest = REQ, options: PermissionRequestOptions = {}) => {
    void permissions.request(req, { turnId: "own-1", ...options }).then((r) => answers.push(r));
    await delay(40);
  };
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(15);
    }
    await delay(25);
  };
  const frame = () => app.lastFrame() ?? "";
  return { app, answers, ask, keys, frame };
}

/** The main input's row (its draft), below the dialog once it closed. */
const inputRow = (frame: string) => frame.split("\n").find((l) => l.includes("❯ ")) ?? "";
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("the reply field in the App", () => {
  test("the fourth choice only when the asker takes a reply", async () => {
    const t = await mount();
    await t.ask({ ...REQ, reply: undefined } as PermissionRequest);
    expect(t.frame()).not.toContain("No, let's talk about it");
    expect(t.frame()).toContain("y/a/n · esc deny");
    await t.keys("n");
    await t.ask();
    expect(t.frame()).toContain("No, let's talk about it");
    expect(t.frame()).toContain("y/a/n/t · esc deny");
    t.app.unmount();
  });

  test("t opens the field; typed text + Enter → a refusal with the message", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t");
    expect(t.frame()).toContain("Tell the agent why, or what to do instead:");
    expect(t.frame()).toContain("enter send · esc back · empty = No");
    expect(t.frame()).not.toContain("No, let's talk about it");
    await t.keys("try bun run build", "\r");
    expect(t.answers).toHaveLength(1);
    expect(t.answers[0]?.allowed).toBe(false);
    expect(t.answers[0]?.message).toBe("try bun run build");
    expect(t.frame()).not.toContain("Tell the agent why");
    t.app.unmount();
  });

  test("empty Enter is a plain No; Esc goes back to the menu with the draft kept", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t", "why", ESC);
    expect(t.frame()).toContain("No, let's talk about it");
    expect(t.answers).toEqual([]);
    await t.keys("t");
    expect(t.frame()).toContain("why");
    await t.keys("\x7f", "\x7f", "\x7f", "\r");
    expect(t.answers).toEqual([{ allowed: false }]);
    t.app.unmount();
  });

  test("a bracketed paste lands in the field — a pasted `y` never approves", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t", "\x1b[200~y\x1b[201~");
    expect(t.answers).toEqual([]);
    await t.keys("\r");
    expect(t.answers[0]?.message).toBe("y");
    t.app.unmount();
  });

  test("Shift+Tab on my own request: approved, the draft back in the input with the notice", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t", "maybe later", SHIFT_TAB);
    expect(t.answers).toEqual([{ allowed: true, scope: "once" }]);
    expect(count(t.frame(), "maybe later")).toBe(1);
    expect(inputRow(t.frame())).toContain("maybe later");
    expect(t.frame()).toContain("the request was approved; your reply is back in the input");
    t.app.unmount();
  });

  test("Shift+Tab on another device's request: nothing answered, the field stays open", async () => {
    // Mutation (f): grant regardless of `own` → answered → red.
    const t = await mount();
    await t.ask(REQ, { turnId: "F1" });
    await t.keys("t", "hm", SHIFT_TAB);
    expect(t.answers).toEqual([]);
    expect(t.frame()).toContain("Tell the agent why");
    expect(t.frame()).toContain("hm");
    t.app.unmount();
  });

  test("withdrawn while typing: the draft goes back to the input with the notice", async () => {
    const t = await mount();
    const withdraw = new AbortController();
    await t.ask(REQ, { signal: withdraw.signal });
    await t.keys("t", "not this one");
    withdraw.abort();
    await delay(40);
    expect(t.frame()).not.toContain("Tell the agent why");
    expect(count(t.frame(), "not this one")).toBe(1);
    expect(inputRow(t.frame())).toContain("not this one");
    expect(t.frame()).toContain("your reply was not sent (the request was withdrawn)");
    t.app.unmount();
  });

  test("a sent reply that never reached the agent comes back (onAnswerLost), with its cause", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t", "lost words", "\r");
    expect(inputRow(t.frame())).not.toContain("lost words");
    t.answers[0]?.onAnswerLost?.("settled");
    await delay(40);
    expect(count(t.frame(), "lost words")).toBe(1);
    expect(inputRow(t.frame())).toContain("lost words");
    expect(t.frame()).toContain(
      "your reply did not reach the agent (the request was already settled)",
    );
    t.app.unmount();
  });

  test("a lost session is told as such, never as 'already settled' (fix round 1 F2)", async () => {
    const t = await mount();
    await t.ask();
    await t.keys("t", "lost words", "\r");
    t.answers[0]?.onAnswerLost?.("session-lost");
    await delay(40);
    expect(inputRow(t.frame())).toContain("lost words");
    expect(t.frame()).toContain("your reply may not have reached the agent (the session was lost)");
    expect(t.frame()).not.toContain("already settled");
    t.app.unmount();
  });

  test("withdrawn while the sent reply is in flight: the words come back exactly once (fix round 1 F3)", async () => {
    // The order the runtime produces: the dialog's signal aborts (the request
    // is withdrawn) AND the answer it already sent is handed back.
    const t = await mount();
    const withdraw = new AbortController();
    await t.ask(REQ, { signal: withdraw.signal });
    await t.keys("t", "in flight", "\r");
    expect(t.answers[0]?.message).toBe("in flight");
    withdraw.abort();
    await delay(40);
    t.answers[0]?.onAnswerLost?.("settled");
    await delay(40);
    expect(count(t.frame(), "in flight")).toBe(1);
    expect(inputRow(t.frame())).toContain("in flight");
    expect(count(t.frame(), "back in the input")).toBe(1);
    t.app.unmount();
  });
});
