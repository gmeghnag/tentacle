import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";

// `run "<prompt>"` (docs/feat/run-prompt.md): the App sends `initialPrompt` once,
// through the same path as a typed message.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSession(fail = false) {
  const sends: string[] = [];
  const ctrl: SessionController = {
    async *send(prompt) {
      sends.push(prompt);
      if (fail) {
        throw new Error("link down");
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
  };
  return { ctrl, sends };
}

describe("initialPrompt", () => {
  test("is sent once at mount, as the first message, and drawn as a user message", async () => {
    const { ctrl, sends } = fakeSession();
    const { lastFrame, unmount } = render(
      <App createSession={() => ctrl} model="m" cwd="/tmp/work" initialPrompt="fix the bug" />,
    );
    await delay(80);
    expect(sends).toEqual(["fix the bug"]);
    expect(lastFrame() ?? "").toContain("fix the bug");
    expect(lastFrame() ?? "").toContain("reply to fix the bug");
    unmount();
  });

  test("no initialPrompt: nothing is sent", async () => {
    const { ctrl, sends } = fakeSession();
    const { unmount } = render(<App createSession={() => ctrl} model="m" cwd="/tmp/work" />);
    await delay(80);
    expect(sends).toEqual([]);
    unmount();
  });

  test("is raw text: a leading / is sent to the session, never run as a command", async () => {
    const { ctrl, sends } = fakeSession();
    const { unmount } = render(
      <App createSession={() => ctrl} model="m" cwd="/tmp/work" initialPrompt="/clear" />,
    );
    await delay(80);
    expect(sends).toEqual(["/clear"]);
    unmount();
  });

  test("a /clear (a new session) and a re-render never send it again", async () => {
    const first = fakeSession();
    const second = fakeSession();
    let n = 0;
    const createSession = () => (++n === 1 ? first.ctrl : second.ctrl);
    const element = (
      <App createSession={createSession} model="m" cwd="/tmp/work" initialPrompt="once" />
    );
    const { stdin, rerender, unmount } = render(element);
    await delay(80);
    stdin.write("/clear");
    await delay(30);
    stdin.write("\r");
    await delay(80);
    rerender(element);
    await delay(60);
    expect(first.sends).toEqual(["once"]);
    expect(second.sends).toEqual([]);
    unmount();
  });

  test("a failed first send behaves like a typed one: it stays as the user's message with the error under it, the input stays empty, nothing is resent", async () => {
    // Mutation: restore the text into the input on a plain failure → "retry me"
    // appears twice (the message AND the input box).
    const { ctrl, sends } = fakeSession(true);
    const { lastFrame, unmount } = render(
      <App createSession={() => ctrl} model="m" cwd="/tmp/work" initialPrompt="retry me" />,
    );
    await delay(150);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("link down");
    expect(frame.split("retry me").length - 1).toBe(1); // the user's message only
    expect(frame.indexOf("retry me")).toBeLessThan(frame.indexOf("link down")); // error under it
    expect(sends).toEqual(["retry me"]); // never resent by itself
    unmount();
  });

  test("sent exactly once even if the prop changes on a re-render (the guard)", async () => {
    // Mutation: drop `sentFirstRef` → the changed prop sends "b" as well.
    const { ctrl, sends } = fakeSession();
    const { rerender, unmount } = render(
      <App createSession={() => ctrl} model="m" cwd="/tmp/work" initialPrompt="a" />,
    );
    await delay(80);
    rerender(<App createSession={() => ctrl} model="m" cwd="/tmp/work" initialPrompt="b" />);
    await delay(80);
    expect(sends).toEqual(["a"]);
    unmount();
  });
});
