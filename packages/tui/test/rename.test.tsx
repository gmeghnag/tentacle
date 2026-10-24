import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import * as commands from "../src/commands.ts";

// `/rename` (docs/feat/session-titles.md): a protocol method the daemon
// answers with the stored title; the TUI only parses and shows the answer.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseRename = (commands as unknown as Record<string, unknown>).parseRename as
  | ((raw: string) => unknown)
  | undefined;

describe("parseRename", () => {
  test("T1 the rest of the line is the title; nothing → usage", () => {
    expect(typeof parseRename).toBe("function");
    expect(parseRename?.("/rename Fix the login")).toEqual({ title: "Fix the login" });
    expect(parseRename?.("/rename   spaced   out  ")).toEqual({ title: "spaced   out" });
    expect(parseRename?.("/rename")).toEqual({ usage: "_Usage: `/rename <title>`_" });
    expect(parseRename?.("/rename    ")).toEqual({ usage: "_Usage: `/rename <title>`_" });
  });

  test("T1 /rename is a built-in (in the palette and /help) and not session-mutating", () => {
    expect(commands.SLASH_COMMANDS.map((c) => c.name)).toContain("/rename");
    expect(commands.isSessionMutating("/rename")).toBe(false);
  });
});

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await delay(30);
  stdin.write("\r");
  await delay(60);
}

describe("App /rename", () => {
  test("T2 shows the title the controller (the daemon) returned", async () => {
    const asked: string[] = [];
    const createSession = () => ({
      async *send() {},
      async rename(title: string) {
        asked.push(title);
        return "Fix login";
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="m" cwd="/w" />,
    );
    await delay(30);
    await type(stdin, "/rename   fix   login ");
    expect(asked).toEqual(["fix   login"]);
    expect(lastFrame() ?? "").toContain("Renamed: Fix login");
    unmount();
  });

  test("T2 no rename on this runtime → says so; a refusal → the reason; no title → usage", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App createSession={() => ({ async *send() {} })} model="m" cwd="/w" />,
    );
    await delay(30);
    await type(stdin, "/rename x");
    expect(lastFrame() ?? "").toContain("Renaming isn't available on this runtime.");
    unmount();

    const failing = render(
      <App
        createSession={() => ({
          async *send() {},
          rename: () => Promise.reject(new Error("nothing to rename yet — send a first message")),
        })}
        model="m"
        cwd="/w"
      />,
    );
    await delay(30);
    await type(failing.stdin, "/rename x");
    expect(failing.lastFrame() ?? "").toContain(
      "Rename failed: nothing to rename yet — send a first message",
    );
    await type(failing.stdin, "/rename");
    expect(failing.lastFrame() ?? "").toContain("Usage: /rename <title>");
    failing.unmount();
  });

  test("T2 allowed mid-turn (it touches neither the history nor the turn)", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const renamed: string[] = [];
    const createSession = () => ({
      // biome-ignore lint/correctness/useYield: a turn that runs until released, yielding nothing
      async *send() {
        await gate;
      },
      async rename(title: string) {
        renamed.push(title);
        return title;
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="m" cwd="/w" />,
    );
    await delay(30);
    await type(stdin, "work");
    await type(stdin, "/rename During");
    expect(renamed).toEqual(["During"]);
    expect(lastFrame() ?? "").toContain("Renamed: During");
    release();
    await delay(30);
    unmount();
  });
});
