import { describe, expect, spyOn, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import * as format from "../src/format.ts";
import * as idleWarm from "../src/idle-warm.ts";
import { IDLE_WARM_DELAY_MS, type IdleWarmState } from "../src/idle-warm.ts";
import type { LinkStatusView } from "../src/link-status.ts";
import * as renderLines from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const SHIFT_UP = "\u001B[1;2A";
const SHIFT_DOWN = "\u001B[1;6B";
const SHIFT_RIGHT = "\u001B[1;1C"; // some terminals; see below for the xterm form
const XTERM_SHIFT_RIGHT = "\u001B[2C"; // xterm/VT200+ shift+right
const XTERM_CTRL_RIGHT = "\u001B[5C"; // ctrl+right
const XTERM_ALT_RIGHT = "\u001B[1;3C"; // alt+right
const PAGE_UP = "\u001B[5~";
const WHEEL_UP = "\u001B[<64;10;5M";
const WHEEL_DOWN = "\u001B[<65;10;5M";
// SGR mouse: left press / left drag / release at (col=x, row=y).
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const drag = (x: number, y: number): string => `\u001B[<32;${x};${y}M`;
const release = (x: number, y: number): string => `\u001B[<0;${x};${y}m`;

describe("App", () => {
  test("submitting a prompt streams the reply and counts tokens", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text", delta: "Hello world" },
        { type: "done", usage: { promptTokens: 5, completionTokens: 2 } },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });

    const { stdin, frames, unmount } = render(<App agent={agent} model="qwen3" cwd="/tmp/work" />);

    await delay(30);
    stdin.write("hi");
    await delay(30);
    stdin.write("\r");
    await delay(200);

    const all = frames.join("\n");
    expect(all).toContain("Hello world");
    expect(all).toContain("↑5");
    unmount();
  });

  test("Ctrl+O does not leak an 'o' into the input box", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("\u000F"); // Ctrl+O
    await delay(50);
    const frame = lastFrame() ?? "";
    // The placeholder is still shown (input stayed empty) and the status flips
    // to "expanded".
    expect(frame).toContain("Type a task");
    expect(frame).toContain("expanded");
    unmount();
  });

  test("scrolls up through history with PageUp / arrow keys", async () => {
    const longReply = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const model = new ScriptedProvider([[{ type: "text", delta: longReply }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );

    await delay(30);
    stdin.write("show me a lot");
    await delay(30);
    stdin.write("\r");
    await delay(200);

    // At the tail: the last line is visible, the first is not.
    const tail = lastFrame() ?? "";
    expect(tail).toContain("line-60");
    expect(tail).not.toContain("line-1\n");

    stdin.write(PAGE_UP);
    stdin.write(PAGE_UP);
    stdin.write(UP);
    await delay(80);

    const scrolled = lastFrame() ?? "";
    // Scrolled up: the status shows the "more above" indicator and earlier
    // lines are now on screen.
    expect(scrolled).toContain("more");
    expect(scrolled).toContain("line-1");
    unmount();
  });

  test("mouse wheel scrolls without leaking the escape sequence into the input", async () => {
    const longReply = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const model = new ScriptedProvider([[{ type: "text", delta: longReply }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );

    await delay(30);
    stdin.write("go");
    await delay(30);
    stdin.write("\r");
    await delay(200);

    // Wheel up a few notches → scrolled into history.
    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await delay(80);
    const up = lastFrame() ?? "";
    expect(up).toContain("more");
    // The raw SGR report never landed in the input box.
    expect(up).not.toContain("[<64");
    expect(up).toContain("Type a task");

    // Wheel back down → follow the tail again (indicator gone).
    stdin.write(WHEEL_DOWN);
    stdin.write(WHEEL_DOWN);
    stdin.write(WHEEL_DOWN);
    await delay(80);
    const down = lastFrame() ?? "";
    expect(down).toContain("line-60");
    unmount();
  });

  test("a host notice is shown live while idle, and the feed is unsubscribed on unmount", async () => {
    // Mutation: drop the `notices` subscription effect → the text never renders.
    const listeners = new Set<(text: string) => void>();
    const notices = {
      onNotice(listener: (text: string) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" notices={notices} />,
    );
    await delay(30);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener("⚠ Couldn't save session abcd1234: EACCES");
    }
    await delay(30);
    expect(lastFrame()).toContain("Couldn't save session abcd1234: EACCES");
    unmount();
    await delay(10); // passive-effect cleanup runs after the unmount commit
    expect(listeners.size).toBe(0);
  });

  test("the link status shows in the StatusBar while not up, and clears when it is back", async () => {
    // Mutation: drop `link={linkView}` from the StatusBar → "reconnecting" never renders.
    const listeners = new Set<(status: LinkStatusView) => void>();
    const link = {
      onLinkStatus(listener: (status: LinkStatusView) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (status: LinkStatusView): void => {
      for (const listener of listeners) listener(status);
    };
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" link={link} />,
    );
    await delay(30);
    expect(lastFrame()).not.toContain("reconnecting");
    emit({ state: "reconnecting", attempt: 3, nextAtMs: Date.now() + 4_500 });
    await delay(30);
    const bar = (lastFrame() ?? "").split("\n").at(-1) ?? "";
    expect(bar).toMatch(/^reconnecting… \(attempt 3, retry in [45]s\)/);
    emit({ state: "up" });
    await delay(30);
    expect(lastFrame()).not.toContain("reconnecting");
    emit({ state: "stopped", reason: "the daemon rejected the credentials: 401" });
    await delay(30);
    expect(lastFrame()).toContain("disconnected: the daemon rejected the credentials: 401");
    unmount();
    await delay(10);
    expect(listeners.size).toBe(0);
  });

  test("a stop with a long reason (a version skew) is shown whole in the transcript, once", async () => {
    // The StatusBar truncates its one row, cutting the advice at the end.
    // Mutation: `stoppedNotice` returns null → the advice never renders.
    const listeners = new Set<(status: LinkStatusView) => void>();
    const link = {
      onLinkStatus(listener: (status: LinkStatusView) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" link={link} />,
    );
    await delay(30);
    const reason =
      'incompatible daemon: protocol version mismatch: client 10 (tentacle 0.1.0), daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"';
    for (const listener of listeners) listener({ state: "stopped", reason });
    await delay(30);
    const flat = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(flat).toContain('— update this client: "tentacle update"');
    expect(flat.split("Link stopped:").length - 1).toBe(1);
    unmount();
  });

  test("the same stop reported twice is one transcript line", async () => {
    // Mutation: drop the `text === last` check in the App effect → two lines.
    const listeners = new Set<(status: LinkStatusView) => void>();
    const link = {
      onLinkStatus(listener: (status: LinkStatusView) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" link={link} />,
    );
    await delay(30);
    for (let i = 0; i < 2; i++) {
      for (const listener of listeners) listener({ state: "stopped", reason: "gone: 404" });
      await delay(20);
    }
    expect((lastFrame() ?? "").split("Link stopped: gone: 404").length - 1).toBe(1);
    unmount();
  });

  /** A session whose turn streams once, then runs until aborted (or forever, if `deaf`). */
  function slowTurnSession(log: string[], deaf = false) {
    return () => ({
      async *send(_prompt: string, signal?: AbortSignal) {
        try {
          yield { type: "text" as const, delta: "working…" };
          await new Promise<void>((resolve) => {
            if (!deaf) {
              signal?.addEventListener("abort", () => resolve());
            }
          });
        } finally {
          // Where a real session persists the turn (Session.persist / flush).
          log.push(signal?.aborted ? "turn settled (aborted)" : "turn settled");
        }
      },
    });
  }
  /** A NoticeFeed whose unsubscribe marks the App's unmount. */
  function unmountSpy(log: string[]) {
    return {
      onNotice: () => () => {
        log.push("unmounted");
      },
    };
  }

  test("/exit mid-turn stops the turn and exits only after it settled (so it is saved)", async () => {
    // Mutation: make /exit call `exit()` unconditionally → "unmounted" with no settle.
    const log: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App
        createSession={slowTurnSession(log)}
        notices={unmountSpy(log)}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    await delay(30);
    stdin.write("hi");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    expect(lastFrame()).toContain("working…");
    stdin.write("/exit");
    await delay(20);
    stdin.write("\r");
    await delay(80);
    expect(log).toEqual(["turn settled (aborted)", "unmounted"]);
    unmount();
  });

  test("a second /exit while the turn won't stop quits at once", async () => {
    const log: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App
        createSession={slowTurnSession(log, true)}
        notices={unmountSpy(log)}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    await delay(30);
    stdin.write("hi");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    stdin.write("/exit");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    expect(log).toEqual([]); // still waiting for the (deaf) turn
    expect(lastFrame()).toContain("again to quit now");
    stdin.write("/exit");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    expect(log).toEqual(["unmounted"]);
    unmount();
  });

  test("/clear closes the previous session BEFORE building the next one (decision D3)", async () => {
    // Mutation: drop the `close?.()` in the /clear handler → nothing closed.
    const log: string[] = [];
    let n = 0;
    const createSession = () => {
      const id = ++n;
      log.push(`create ${id}`);
      return {
        async *send() {
          // no model turn needed for this test
        },
        close() {
          log.push(`close ${id}`);
        },
      };
    };
    const { stdin, unmount } = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("/clear");
    await delay(30);
    stdin.write("\r");
    await delay(50);
    expect(log).toEqual(["create 1", "close 1", "create 2"]);
    unmount();
  });

  test("a remote session's history_reset mid-turn replaces the partial reply: shown once, never doubled", async () => {
    // A reconnect that had to resync: the snapshot holds "ab", the replay then
    // carries the rest. Mutation: ignore `history_reset` in the App loop → "abcc".
    const createSession = () => ({
      async *send() {
        yield { type: "text" as const, delta: "abc" };
        await delay(5);
        yield {
          type: "history_reset" as const,
          messages: [
            { role: "user" as const, content: "hi" },
            { role: "assistant" as const, content: "ab" },
          ],
        };
        yield { type: "text" as const, delta: "c" };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("hi");
    await delay(20);
    stdin.write("\r");
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("abc");
    expect(frame).toMatch(/⏺ abc\s*$/m); // exactly "abc": not "abcc", not "abc" + "abc"
    expect(frame.match(/abc/g)?.length).toBe(1);
    expect(frame.match(/› hi/g)?.length).toBe(1); // the user bubble once
    unmount();
  });

  test("/compact calls the session's compact and reports the result", async () => {
    let compacted = 0;
    const createSession = () => ({
      async *send() {
        // no model turn needed for this test
      },
      async compact() {
        compacted += 1;
        return { before: 8, after: 2 };
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("/compact");
    await delay(30);
    stdin.write("\r");
    await delay(80);
    expect(compacted).toBe(1);
    expect(lastFrame() ?? "").toContain("8 → 2 messages");
    unmount();
  });

  test("coalesced wheel reports in one chunk scroll without leaking into the input", async () => {
    const longReply = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const model = new ScriptedProvider([[{ type: "text", delta: longReply }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(30);
    stdin.write("\r");
    await delay(200);
    expect(lastFrame() ?? "").toContain("line-60");

    // A fast wheel coalesces several reports into a single data chunk — the
    // exact shape that used to fall through and print "[<65;16;20M…" into the
    // input box.
    stdin.write(`${WHEEL_UP}${WHEEL_UP}${WHEEL_UP}`);
    await delay(60);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("more"); // scrolled up
    expect(frame).not.toContain("[<64"); // no raw report leaked
    expect(frame).toContain("Type a task"); // input stayed empty
    unmount();
  });

  function shellSetup() {
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "fake",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls -la" }) },
        },
        { type: "done" },
      ],
    ]);
    const broker = new PermissionBroker();
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: (req) => broker.request(req),
    });
    return { agent, broker, execCalls };
  }

  test("prompts before a shell command and blocks it when denied", async () => {
    const { agent, broker, execCalls } = shellSetup();
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" permissions={broker} />,
    );
    await delay(40);
    stdin.write("run it");
    await delay(30);
    stdin.write("\r");
    await delay(150);

    const prompt = lastFrame() ?? "";
    expect(prompt).toContain("Run a shell command");
    expect(prompt).toContain("ls -la");
    // The "always" option is scoped to the command prefix, not the whole tool.
    expect(prompt).toContain("`ls` commands");

    stdin.write("n"); // deny
    await delay(150);

    expect(execCalls).toEqual([]);
    expect(lastFrame() ?? "").toContain("Permission denied");
    unmount();
  });

  describe("the permission dialog's lifecycle (a request withdrawn, the TUI gone, a person's no)", () => {
    const ask: PermissionRequest = {
      tool: "shell",
      level: "ask",
      title: "Run a shell command",
      detail: "make deploy",
      input: {},
    };
    async function mounted() {
      const broker = new PermissionBroker();
      const agent = new Agent({
        model: new ScriptedProvider([]),
        tools: new ToolRegistry(),
        env: noopEnv,
      });
      const app = render(<App agent={agent} model="qwen3" cwd="/tmp/work" permissions={broker} />);
      await delay(40);
      const controller = new AbortController();
      const answer = broker.request(ask, { signal: controller.signal });
      await delay(40);
      expect(app.lastFrame() ?? "").toContain("make deploy");
      return { app, controller, answer };
    }

    test("a request withdrawn by its signal (answered elsewhere) closes the dialog and resolves dismissed", async () => {
      // Mutation: ignore `options.signal` in the TUI requester → the dialog stays → red.
      const { app, controller, answer } = await mounted();
      controller.abort();
      expect(await answer).toEqual({ allowed: false, dismissed: true });
      await delay(40);
      expect(app.lastFrame() ?? "").not.toContain("make deploy");
      app.unmount();
    });

    test("unmounting with the dialog open is not a decision: dismissed, not a deny", async () => {
      const { app, answer } = await mounted();
      app.unmount();
      expect(await answer).toEqual({ allowed: false, dismissed: true });
    });

    test("Esc is a person's deny (a plain refusal, sent as such)", async () => {
      const { app, answer } = await mounted();
      app.stdin.write("\u001B");
      expect(await answer).toEqual({ allowed: false });
      app.unmount();
    });

    test("Ctrl+C in the dialog with no turn of ours to cancel keeps the dialog (no orphaned request)", async () => {
      // Review finding 3: dismissing here left the request suspended and unseen.
      const { app, answer } = await mounted();
      let settled = false;
      void answer.then(() => {
        settled = true;
      });
      app.stdin.write("\u0003");
      await delay(40);
      expect(settled).toBe(false);
      expect(app.lastFrame() ?? "").toContain("make deploy");
      app.stdin.write("\u001B");
      expect(await answer).toEqual({ allowed: false });
      app.unmount();
    });
  });

  test("Ctrl+C in the dialog during a turn stops everything: no deny is recorded, the tool is cancelled", async () => {
    const { agent, broker, execCalls } = shellSetup();
    const answers: unknown[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" permissions={broker} />,
    );
    await delay(40);
    const request = broker.request.bind(broker);
    broker.request = async (req, options) => {
      const r = await request(req, options);
      answers.push(r);
      return r;
    };
    stdin.write("run it");
    await delay(30);
    stdin.write("\r");
    await delay(150);
    expect(lastFrame() ?? "").toContain("ls -la");
    stdin.write("\u0003");
    await delay(150);
    expect(answers).toEqual([{ allowed: false, dismissed: true }]);
    expect(execCalls).toEqual([]);
    expect(lastFrame() ?? "").not.toContain("Permission denied");
    unmount();
  });

  test("drag-selecting the transcript copies the text to the clipboard", async () => {
    const copied: string[] = [];
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, unmount } = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        clipboard={async (t) => {
          copied.push(t);
        }}
      />,
    );
    await delay(40);
    // Row 1 is the welcome line, now "⏺ Tentacle ready. …" — the bullet
    // occupies columns 1–2, so "Tentacle" starts at column 3. Select 10 chars.
    stdin.write(press(3, 1));
    await delay(15);
    stdin.write(drag(13, 1));
    await delay(15);
    stdin.write(release(13, 1));
    await delay(60);

    expect(copied).toHaveLength(1);
    expect(copied[0]).toHaveLength(10);
    expect(copied[0]?.startsWith("Tentacle")).toBe(true);
    unmount();
  });

  test("selecting text does not shift the transcript or print a notice", async () => {
    const copied: string[] = [];
    const model = new ScriptedProvider([
      [{ type: "text", delta: "alpha-one\nalpha-two" }, { type: "done" }],
      [{ type: "text", delta: "bravo-one\nbravo-two" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        clipboard={async (t) => {
          copied.push(t);
        }}
      />,
    );
    await delay(40);
    stdin.write("uno");
    await delay(30);
    stdin.write("\r");
    await delay(150);
    stdin.write("due");
    await delay(30);
    stdin.write("\r");
    await delay(150);

    const rowOf = (frame: string): number =>
      frame.split("\n").findIndex((l) => l.includes("bravo-two"));
    const before = lastFrame() ?? "";
    expect(rowOf(before)).toBeGreaterThan(0);

    // Select across the blank separator rows (press on the welcome line,
    // drag down through the transcript).
    stdin.write(press(1, 1));
    await delay(50);
    stdin.write(drag(11, 8));
    await delay(50);

    // The transcript must not shift up while a selection is active: an
    // empty <Text> measures as 0x0 in Ink, so blank rows must stay height 1.
    const during = lastFrame() ?? "";
    expect(rowOf(during)).toBe(rowOf(before));

    stdin.write(release(11, 8));
    await delay(60);

    // The copy must not append a notice to the transcript (which also
    // forced the viewport back to the tail).
    const after = lastFrame() ?? "";
    expect(after).not.toContain("Copied");
    expect(rowOf(after)).toBe(rowOf(before));
    expect(copied).toHaveLength(1);
    unmount();
  });

  test("runs the shell command when approved", async () => {
    const { agent, broker, execCalls } = shellSetup();
    const { stdin, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" permissions={broker} />,
    );
    await delay(40);
    stdin.write("run it");
    await delay(30);
    stdin.write("\r");
    await delay(150);

    stdin.write("y"); // allow once
    await delay(150);

    expect(execCalls).toEqual(["ls -la"]);
    unmount();
  });

  test("Ctrl+V pastes the clipboard into the input at the cursor", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" paste={async () => "hello world"} />,
    );
    await delay(30);
    stdin.write("pre ");
    await delay(30);
    stdin.write("\u0016"); // Ctrl+V
    await delay(80);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("pre hello world");
    expect(frame).not.toContain("Clipboard unavailable");
    expect(frame).not.toContain("working…");
    unmount();
  });

  test("a multi-line clipboard keeps its newlines without submitting", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" paste={async () => "line one\nline two"} />,
    );
    await delay(30);
    stdin.write("\u0016"); // Ctrl+V
    await delay(80);

    const frame = lastFrame() ?? "";
    // Both lines render in the (now multi-line) input, newline preserved.
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).not.toContain("line one line two"); // no longer flattened
    expect(frame).not.toContain("working…"); // paste must not start a turn
    unmount();
  });

  test("a native multi-line paste chunk keeps its newlines (Cmd+V path)", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    // The terminal's own paste (Cmd+V on macOS) arrives as one data chunk.
    stdin.write("ab\ncd");
    await delay(80);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("ab");
    expect(frame).toContain("cd");
    expect(frame).not.toContain("ab cd"); // preserved, not flattened to one line
    expect(frame).not.toContain("working…");
    unmount();
  });

  test("a bracketed paste inserts its content without the markers", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("pre ");
    await delay(20);
    // A real terminal wraps a Cmd+V paste in bracketed-paste markers.
    stdin.write("\u001b[200~pasted text\u001b[201~");
    await delay(60);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("pre pasted text");
    expect(frame).not.toContain("200~");
    expect(frame).not.toContain("working…"); // a paste must not start a turn
    unmount();
  });

  test("a split SGR mouse report does not leak into the input", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    // Some terminals/ptys deliver an SGR report in two data chunks; Ink strips
    // the leading ESC, so the first half arrives as a bare "[".
    stdin.write("\u001B[");
    await delay(30);
    stdin.write("<64;2;10M");
    await delay(50);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("<64;2;10M");
    expect(frame).toContain("Type a task"); // input line stayed empty
    unmount();
  });

  test("a split SGR mouse report still scrolls the transcript", async () => {
    const longReply = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const model = new ScriptedProvider([[{ type: "text", delta: longReply }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("show me a lot");
    await delay(30);
    stdin.write("\r");
    await delay(200);
    expect(lastFrame() ?? "").toContain("line-60");

    // Wheel-up report split across two chunks (same as WHEEL_UP, halved).
    stdin.write("\u001B[");
    await delay(30);
    stdin.write("<64;10;5M");
    await delay(50);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("line-60"); // scrolled up three lines
    expect(frame).not.toContain("<64;10;5M");
    unmount();
  });

  test("a typed '[' is not swallowed by the mouse prefix buffer", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("[");
    await delay(30);
    stdin.write("x");
    await delay(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[x");
    unmount();
  });

  test("a lone typed '[' appears in the input after the mouse hold times out", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("[");
    await delay(150); // past the 100 ms mouse-hold timeout

    expect(lastFrame() ?? "").toContain("❯ [");
    unmount();
  });

  test("a typed '[' held for disambiguation is included in the submit", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("[");
    await delay(30);
    stdin.write("\r");
    await delay(200);

    // The turn ran (the reply is visible), so the submitted text was "[",
    // not an empty string.
    expect(lastFrame() ?? "").toContain("ok");
    unmount();
  });
});

/** Round 1 streams then pauses, so a turn stays "running" during the test. */
class PausingProvider implements ModelProvider {
  readonly id = "pausing";
  turn = 0;
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.turn++;
    if (this.turn === 1) {
      yield { type: "text", delta: "working" };
      await delay(250);
      yield { type: "done" };
    } else {
      yield { type: "text", delta: "retried" };
      yield { type: "done" };
    }
  }
}

describe("App robustness", () => {
  test("initialItems seeds the resumed transcript instead of the welcome line", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { lastFrame, unmount } = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        initialItems={[
          { kind: "user", text: "prior question" },
          { kind: "assistant", text: "prior answer" },
        ]}
      />,
    );
    await delay(30);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("prior question");
    expect(frame).toContain("prior answer");
    expect(frame).not.toContain("Tentacle ready");
    unmount();
  });

  test("/retry is rejected mid-turn (no second concurrent send)", async () => {
    const model = new PausingProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(60); // turn 1 is running (in its pause)

    stdin.write("/retry");
    await delay(20);
    stdin.write("\r");
    await delay(40);

    expect(lastFrame() ?? "").toContain("Can't run /retry while a turn is running");
    expect(model.turn).toBe(1); // the retry never started a second turn
    await delay(260); // let turn 1 finish cleanly
    unmount();
  });

  test("a trailing backslash + Enter inserts a newline instead of submitting", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("a\\"); // "a" then a backslash
    await delay(20);
    stdin.write("\r"); // continuation, not submit
    await delay(20);
    stdin.write("b");
    await delay(30);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("a"); // first line
    expect(frame).toContain("b"); // second line (after the inserted newline)
    expect(frame).not.toContain("working…"); // the turn did NOT start
    expect(frame).not.toContain("⏺ ok"); // and nothing was submitted
    unmount();
  });

  test("an unterminated bracketed paste recovers after the timeout (input not frozen)", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    // A paste that opens but whose closing marker never arrives.
    stdin.write("\u001b[200~hello");
    await delay(40);
    // Still buffered: not yet shown in the input.
    expect(lastFrame() ?? "").not.toContain("hello");

    await delay(300); // past PASTE_TIMEOUT_MS: the capture is flushed into the input
    expect(lastFrame() ?? "").toContain("hello");

    // And input is no longer frozen: ordinary typing is accepted again.
    stdin.write("x");
    await delay(40);
    expect(lastFrame() ?? "").toContain("hellox");
    unmount();
  });
});

describe("input editing: line start/end", () => {
  // Ink 5.0.1 does not surface Home/End through useInput (they arrive as
  // input="" with no flag), so line start/end is bound to Ctrl+A / Ctrl+E —
  // the readline convention. We observe the cursor position by where the next
  // inserted character lands (the harness strips SGR, so the block cursor and
  // any selection highlight are invisible in the frame).
  const mkApp = () => {
    const model = new ScriptedProvider([]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    return render(<App agent={agent} model="qwen3" cwd="/tmp/work" />);
  };
  // A pre-existing render quirk (in the unchanged LineInput cursor renderer)
  // can split a mid-line block cursor onto the separator row (e.g. "Xhell" +
  // "o"). It is out of scope here and does not affect the buffer, so we assert
  // on the character order with the rule/newlines removed.
  const unwrap = (f: string | undefined): string => (f ?? "").replace(/[─\n]/g, "");

  test("Ctrl+A jumps to the start of the line", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(20);
    stdin.write("hello");
    await delay(20);
    stdin.write("\u0001"); // Ctrl+A
    stdin.write("X");
    await delay(20);
    const frame = unwrap(lastFrame());
    expect(frame).toContain("Xhello");
    expect(frame).not.toContain("helloX");
    unmount();
  });

  test("Ctrl+E jumps to the end of the line", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(20);
    stdin.write("hello");
    await delay(20);
    stdin.write("\u0001"); // Ctrl+A → start
    stdin.write("X"); // "Xhello", cursor after X
    stdin.write("\u0005"); // Ctrl+E → end
    stdin.write("Y"); // appended → "XhelloY"
    await delay(20);
    expect(unwrap(lastFrame())).toContain("XhelloY");
    unmount();
  });

  test("a mid-line cursor reached by editing renders on one clean line", async () => {
    // Regression: an Ink 5.x reconciliation quirk made the block-cursor row
    // (a nested `<Text inverse>` inside a `<Text>`) mis-measure when the value
    // grew by a char with the cursor mid-line, wrapping the last char onto the
    // box's border row ("❯ Xhell" + "──o──"). Ink ≥6.6 fixes it, but that needs
    // React 19; LineInput renders the cursor as sibling Texts instead.
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(20);
    stdin.write("hello");
    await delay(20);
    stdin.write("\u0001"); // Ctrl+A → start
    stdin.write("X"); // "Xhello", cursor mid-line (col 1)
    await delay(20);
    const frame = lastFrame() ?? "";
    // The whole value stays on the input line …
    expect(frame).toContain("❯ Xhello");
    // … and no character bleeds onto a separator/border row.
    expect(frame).not.toMatch(/─[0-9A-Za-z]─/);
    unmount();
  });
});

describe("input soft-wrap", () => {
  test("a value wider than the terminal wraps into contiguous rows inside the input box", async () => {
    const model = new ScriptedProvider([]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(20);
    stdin.write("a".repeat(130)); // ink-testing-library's stdout is 100 columns wide
    await delay(40);
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.trimEnd());
    const first = lines.findIndex((l) => l.startsWith("❯ a"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(lines[first]).toBe(`❯ ${"a".repeat(98)}`);
    expect(lines[first + 1]).toBe(`  ${"a".repeat(32)}`);
    // The box grew by one row: the bottom border sits right under the wrapped row.
    expect(lines[first + 2]).toMatch(/^─+$/);
    unmount();
  });

  test("a value wrapping over several rows keeps the frame at the terminal height", async () => {
    // The layout budgets the input box from `inputRowCount`; counting logical
    // lines instead (one) under-budgets it and the frame outgrows the terminal.
    const model = new ScriptedProvider([]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(20);
    const terminalRows = (lastFrame() ?? "").split("\n").length;
    stdin.write("a".repeat(350)); // 98 + 98 + 98 + 56 cells at 100 columns → 4 visual rows
    await delay(40);
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.trimEnd());
    expect(lines).toHaveLength(terminalRows);
    // The input's last visual row (with the cursor) is still on screen.
    expect(lines).toContain(`  ${"a".repeat(56)}`);
    unmount();
  });
});

describe("input editing: word delete", () => {
  const mkApp = () => {
    const model = new ScriptedProvider([]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    return render(<App agent={agent} model="qwen3" cwd="/tmp/work" />);
  };

  test("Option+Backspace (ESC DEL) deletes the previous word; plain Backspace one char", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(20);
    stdin.write("hello world");
    await delay(20);
    stdin.write("\x1b\x7f"); // Option+Backspace
    await delay(40);
    expect(lastFrame() ?? "").toContain("❯ hello");
    expect(lastFrame() ?? "").not.toContain("world");
    stdin.write("X"); // the space was kept: "hello X"
    await delay(40);
    expect(lastFrame() ?? "").toContain("❯ hello X");
    stdin.write("\x7f"); // plain Backspace → exactly one char (the X)
    stdin.write("Y");
    await delay(40);
    expect(lastFrame() ?? "").toContain("❯ hello Y");
    unmount();
  });
});

describe("input editing: navigation, history & selection", () => {
  const mkApp = () => {
    const model = new ScriptedProvider([]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    return render(<App agent={agent} model="qwen3" cwd="/tmp/work" />);
  };

  test("Up on the only line recalls the previous prompt from history", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(30);
    stdin.write("first task");
    await delay(20);
    stdin.write("\r"); // submit → history gains "first task", the input clears
    await delay(60);
    stdin.write(UP);
    await delay(20);
    // The live input line (❯, not the transcript's ›) shows the recalled prompt.
    expect(lastFrame() ?? "").toContain("❯ first task");
    unmount();
  });

  test("Up inside a multi-line draft moves the cursor up, it does not recall history", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(30);
    stdin.write("earlier");
    await delay(20);
    stdin.write("\r"); // history = ["earlier"]
    await delay(60);
    // Build a two-line draft: "foo", then `\`+Enter (continuation), then "bar".
    stdin.write("foo\\"); // "foo" then a trailing backslash
    await delay(20);
    stdin.write("\r"); // continuation → newline, not submit
    await delay(20);
    stdin.write("bar");
    await delay(20);
    stdin.write(UP); // on line 2 → moveVertical up to line 1, no history
    await delay(20);
    stdin.write("X"); // inserted on line 1 (at the carried column, end of "foo")
    await delay(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fooX");
    expect(frame).toContain("bar");
    // History was not recalled: "earlier" lives only in the transcript (›).
    expect(frame).not.toContain("❯ earlier");
    unmount();
  });

  test("Down past the newest entry restores the live draft", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(30);
    stdin.write("aaa");
    await delay(20);
    stdin.write("\r"); // history = ["aaa"]
    await delay(60);
    stdin.write("mydraft"); // a live draft, not submitted
    await delay(20);
    stdin.write(UP); // recall "aaa" (the draft is saved)
    await delay(20);
    expect(lastFrame() ?? "").toContain("❯ aaa");
    stdin.write(DOWN); // past the newest → restore the saved draft
    await delay(20);
    expect(lastFrame() ?? "").toContain("❯ mydraft");
    unmount();
  });

  test("Shift+Right selects and Backspace deletes the selected range", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(30);
    stdin.write("abcdef");
    await delay(20);
    stdin.write("\u0001"); // Ctrl+A → start
    await delay(20);
    stdin.write(XTERM_SHIFT_RIGHT);
    stdin.write(XTERM_SHIFT_RIGHT);
    stdin.write(XTERM_SHIFT_RIGHT); // selection spans "abc"
    await delay(20);
    stdin.write("\u007F"); // Backspace → deletes the selection
    await delay(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯ def");
    expect(frame).not.toContain("abc");
    unmount();
  });

  test("Ctrl+Right jumps to the next word boundary", async () => {
    const { stdin, lastFrame, unmount } = mkApp();
    await delay(30);
    stdin.write("one two three");
    await delay(20);
    stdin.write("\u0001"); // Ctrl+A → start
    await delay(20);
    stdin.write(XTERM_CTRL_RIGHT); // → end of "one"
    await delay(20);
    stdin.write("X"); // inserted at the word boundary
    await delay(20);
    expect(lastFrame() ?? "").toContain("❯ oneX two three");
    unmount();
  });
});

describe("/mcp panel (docs/feat/mcp-tools-panel.md)", () => {
  const agent = new Agent({
    model: new ScriptedProvider([]),
    tools: new ToolRegistry(),
    env: noopEnv,
  });
  const SERVERS = [
    {
      name: "github",
      state: "connected" as const,
      tools: ["create_issue", "list_prs"],
      moreTools: 0,
      latencyMs: 4,
    },
    { name: "db", state: "failed" as const, tools: [], moreTools: 0, error: "spawn ENOENT" },
  ];
  /** 1-based terminal row of the first frame line containing `text`, or 0. */
  const rowOf = (frame: string, text: string): number =>
    frame.split("\n").findIndex((line) => line.includes(text)) + 1;

  async function openMcp(
    mcpStatus: () => Promise<typeof SERVERS>,
    a: Agent = agent,
  ): Promise<ReturnType<typeof render>> {
    const r = render(<App agent={a} model="qwen3" cwd="/tmp/work" mcpStatus={mcpStatus} />);
    await delay(30);
    r.stdin.write("/mcp");
    await delay(30);
    r.stdin.write("\r");
    await delay(30);
    return r;
  }

  test("opens at once with a probing placeholder, then lists the servers (asked once)", async () => {
    let asked = 0;
    const { lastFrame, unmount } = await openMcp(async () => {
      asked += 1;
      await delay(80);
      return SERVERS;
    });
    expect(lastFrame() ?? "").toContain("MCP servers · probing…");
    await delay(120);
    const frame = lastFrame() ?? "";
    expect(asked).toBe(1);
    expect(frame).toContain("MCP servers · 1 of 2 reachable");
    expect(frame).toContain("❯ ▸ github  ● connected · 2 tools · 4 ms");
    expect(frame).toContain("  ▸ db      ✗ failed");
    expect(frame).not.toContain("Type a task or /command"); // the panel replaces the input
    unmount();
  });

  test("enter expands the selected server to its tool names; esc closes and the input is back", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => SERVERS);
    stdin.write("\r");
    await delay(30);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▾ github");
    expect(frame).toContain("create_issue");
    expect(frame).toContain("list_prs");
    stdin.write("\u001B");
    await delay(60);
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("create_issue");
    expect(frame).not.toContain("MCP servers");
    expect(frame).toContain("Type a task or /command");
    // Typing works again (no key was swallowed by a closed panel).
    stdin.write("hi");
    await delay(30);
    expect(lastFrame() ?? "").toContain("hi");
    unmount();
  });

  test("a click on a server row expands it (and keys typed meanwhile never reach the input)", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => SERVERS);
    stdin.write("zz"); // swallowed while the panel is open
    await delay(20);
    const y = rowOf(lastFrame() ?? "", "▸ db");
    expect(y).toBeGreaterThan(0);
    stdin.write(press(5, y));
    stdin.write(release(5, y));
    await delay(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▾ db");
    expect(frame).toContain("spawn ENOENT");
    stdin.write("q");
    await delay(40);
    expect(lastFrame() ?? "").not.toContain("zz");
    unmount();
  });

  // Behind the panel nothing edits the hidden input — pasted text and a held
  // "[" included (each is inserted outside the key path, the last two by a timer).
  test("a paste while the panel is open never reaches the hidden input", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => SERVERS);
    stdin.write("\u001b[200~PASTED\u001b[201~");
    await delay(40);
    stdin.write("\u001B");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Type a task or /command");
    expect(frame).not.toContain("PASTED");
    unmount();
  });

  test("a truncated paste flushed by its timeout while the panel is open is dropped too", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => SERVERS);
    stdin.write("\u001b[200~CUTOFF");
    await delay(320); // past PASTE_TIMEOUT_MS
    stdin.write("\u001B");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Type a task or /command");
    expect(frame).not.toContain("CUTOFF");
    // Input is not frozen afterwards.
    stdin.write("ok");
    await delay(40);
    expect(lastFrame() ?? "").toContain("ok");
    unmount();
  });

  test("a clipboard read (Ctrl+V) that answers after the panel opened is dropped", async () => {
    const r = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        mcpStatus={async () => SERVERS}
        paste={async () => {
          await delay(150);
          return "CLIP";
        }}
      />,
    );
    await delay(30);
    r.stdin.write("\u0016"); // Ctrl+V
    await delay(20);
    r.stdin.write("/mcp");
    await delay(30);
    r.stdin.write("\r");
    await delay(200); // the clipboard answers with the panel open
    r.stdin.write("\u001B");
    await delay(60);
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("Type a task or /command");
    expect(frame).not.toContain("CLIP");
    r.unmount();
  });

  test("a lone '[' typed while the panel is open is not restored into the input", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => SERVERS);
    stdin.write("[");
    await delay(160); // past the mouse hold
    stdin.write("\u001B");
    await delay(60);
    stdin.write("z");
    await delay(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("z");
    expect(frame).not.toContain("[z");
    unmount();
  });

  test("an answer that lands after the panel closed is dropped", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => {
      await delay(80);
      return SERVERS;
    });
    stdin.write("\u001B");
    await delay(150);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("MCP servers");
    expect(frame).not.toContain("github");
    unmount();
  });

  test("a late failure after the panel closed is dropped too", async () => {
    const { stdin, lastFrame, unmount } = await openMcp(async () => {
      await delay(80);
      throw new Error("not connected to the daemon");
    });
    stdin.write("\u001B");
    await delay(150);
    expect(lastFrame() ?? "").not.toContain("MCP status unavailable");
    unmount();
  });

  test("a failed request closes the panel and says why", async () => {
    const { lastFrame, unmount } = await openMcp(() =>
      Promise.reject(new Error("not connected to the daemon")),
    );
    await delay(30);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MCP status unavailable: not connected to the daemon");
    expect(frame).not.toContain("MCP servers");
    expect(frame).toContain("Type a task or /command");
    unmount();
  });

  test("without a provider it says so instead of 'Unknown command'", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("/mcp");
    await delay(30);
    stdin.write("\r");
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MCP status isn't available on this runtime");
    expect(frame).not.toContain("Unknown command");
    expect(frame).not.toContain("MCP servers");
    unmount();
  });

  test("mid-turn: the panel sits under the working line; a click maps past it; esc closes the panel, not the turn", async () => {
    const slow: ModelProvider = {
      id: "slow",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "HEAD" };
        await delay(400);
        yield { type: "text", delta: "TAIL" };
        yield { type: "done" };
      },
    };
    const slowAgent = new Agent({ model: slow, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, lastFrame, unmount } = render(
      <App agent={slowAgent} model="qwen3" cwd="/tmp/work" mcpStatus={async () => SERVERS} />,
    );
    await delay(30);
    stdin.write("go");
    await delay(10);
    stdin.write("\r");
    await delay(40);
    stdin.write("/mcp");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("working…");
    expect(frame).toContain("▸ github");
    const y = rowOf(frame, "▸ db");
    stdin.write(press(5, y));
    stdin.write(release(5, y));
    await delay(40);
    expect(lastFrame() ?? "").toContain("❯ ▾ db");
    stdin.write("\u001B");
    await delay(500);
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("MCP servers");
    expect(frame).toContain("HEADTAIL"); // the turn ran to the end
    unmount();
  });

  test("a permission prompt takes over the keys; the panel is back after it", async () => {
    const broker = new PermissionBroker();
    const r = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        permissions={broker}
        mcpStatus={async () => SERVERS}
      />,
    );
    await delay(30);
    r.stdin.write("/mcp");
    await delay(30);
    r.stdin.write("\r");
    await delay(40);
    const decision = broker.request({
      tool: "shell",
      level: "ask",
      title: "Run command",
      detail: "ls",
      input: {},
    });
    await delay(40);
    expect(r.lastFrame() ?? "").toContain("Run command");
    r.stdin.write("n"); // the prompt's key, not the panel's
    expect((await decision).allowed).toBe(false);
    await delay(40);
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("❯ ▸ github");
    r.unmount();
  });
});

describe("/skills panel (docs/feat/skills-panel.md)", () => {
  const agent = new Agent({
    model: new ScriptedProvider([]),
    tools: new ToolRegistry(),
    env: noopEnv,
  });
  const LIST = {
    skills: [
      {
        name: "review",
        description: "review a diff",
        scope: "project" as const,
        user: true,
        model: true,
        location: "/w/.agents/skills/review/SKILL.md",
      },
      {
        name: "lint-fix",
        description: "fix lint",
        scope: "user" as const,
        user: false,
        model: true,
        location: "/h/.agents/skills/lint-fix/SKILL.md",
      },
    ],
    problems: ["skipped skill at /x/SKILL.md: no description"],
    moreProblems: 0,
  };

  async function openSkills(
    skillsList?: () => Promise<typeof LIST>,
    mcpStatus?: () => Promise<never[]>,
  ): Promise<ReturnType<typeof render>> {
    // The session's own skills (docs/feat/skills-hot-reload.md); without
    // `skills()` the plain local session of `agent`.
    const r = render(
      <App
        {...(skillsList
          ? {
              createSession: () => {
                const session = new Session(agent);
                return {
                  send: (prompt: string, signal?: AbortSignal) => session.send(prompt, signal),
                  skills: () => skillsList().then((list) => ({ slash: [], ...list })),
                };
              },
            }
          : { agent })}
        model="qwen3"
        cwd="/tmp/work"
        mcpStatus={mcpStatus}
      />,
    );
    await delay(30);
    r.stdin.write("/skills");
    await delay(30);
    r.stdin.write("\r");
    await delay(30);
    return r;
  }

  test("opens with a loading placeholder, then lists every skill, who may invoke it, and the problems", async () => {
    let asked = 0;
    // The session start's ask is still in flight when the panel opens: the
    // panel shares it; typing `/` while it flies adds ONE re-ask when it
    // lands, so the popup is not a scan behind (docs/feat/skills-hot-reload.md).
    const { lastFrame, unmount } = await openSkills(async () => {
      asked += 1;
      await delay(200);
      return LIST;
    });
    expect(lastFrame() ?? "").toContain("Skills · loading…");
    await delay(250);
    const frame = lastFrame() ?? "";
    expect(asked).toBe(2);
    expect(frame).toContain("Skills · 2 found · 1 problem");
    expect(frame).toContain("❯ ▸ review    you + model  review a diff");
    expect(frame).toContain("  ▸ lint-fix  model only   fix lint");
    expect(frame).toContain("  ▸ ! 1 discovery problem");
    expect(frame).not.toContain("Type a task or /command");
    unmount();
  });

  test("enter expands a skill; esc closes and the input is back", async () => {
    const { stdin, lastFrame, unmount } = await openSkills(async () => LIST);
    stdin.write("\r");
    await delay(30);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▾ review");
    expect(frame).toContain("/review · offered to the model");
    expect(frame).toContain("project · /w/.agents/skills/review/SKILL.md");
    stdin.write("\u001B");
    await delay(60);
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("Skills ·");
    expect(frame).toContain("Type a task or /command");
    unmount();
  });

  test("a click on the problems row lists them", async () => {
    const { stdin, lastFrame, unmount } = await openSkills(async () => LIST);
    const y =
      (lastFrame() ?? "").split("\n").findIndex((l) => l.includes("! 1 discovery problem")) + 1;
    expect(y).toBeGreaterThan(0);
    stdin.write(press(5, y));
    stdin.write(release(5, y));
    await delay(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▾ ! 1 discovery problem");
    expect(frame).toContain("skipped skill at /x/SKILL.md: no description");
    unmount();
  });

  test("a failed request closes the panel and says why", async () => {
    const { lastFrame, unmount } = await openSkills(() =>
      Promise.reject(new Error("not connected to the daemon")),
    );
    await delay(30);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Skill list unavailable: not connected to the daemon");
    expect(frame).not.toContain("Skills ·");
    expect(frame).toContain("Type a task or /command");
    unmount();
  });

  test("an older daemon (MethodNotFound) is named as such", async () => {
    const { lastFrame, unmount } = await openSkills(() =>
      Promise.reject(Object.assign(new Error("Method not found"), { code: -32601 })),
    );
    await delay(30);
    expect(lastFrame() ?? "").toContain("This daemon doesn't support /skills (it predates it).");
    unmount();
  });

  test("an answer after the panel closed is dropped", async () => {
    const { stdin, lastFrame, unmount } = await openSkills(async () => {
      await delay(80);
      return LIST;
    });
    stdin.write("\u001B");
    await delay(150);
    expect(lastFrame() ?? "").not.toContain("review a diff");
    unmount();
  });

  test("a session without skills(): no skills (never 'Unknown command')", async () => {
    const { lastFrame, unmount } = await openSkills();
    await delay(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No skills on this daemon.");
    expect(frame).not.toContain("Unknown command");
    unmount();
  });

  test("/mcp after /skills opens the MCP panel (one panel state, not two)", async () => {
    const { stdin, lastFrame, unmount } = await openSkills(
      async () => LIST,
      async () => [],
    );
    stdin.write("\u001B");
    await delay(40);
    stdin.write("/mcp");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No MCP servers on this daemon.");
    expect(frame).not.toContain("review a diff");
    unmount();
  });
});

// docs/feat/tui-spill-note.md: a resumed spilled result shows the note, the path only after ctrl+o.
describe("a spilled tool result in the App (the --resume path)", () => {
  const PATH = ".tentacle/tool-output/shell-c1.txt";
  const history: ChatMessage[] = [
    { role: "user", content: "list it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls -R" }) }],
    },
    {
      role: "tool",
      content: `[large shell output: full output (40800 chars) saved to ${PATH} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]\nhead-1\n…[39600 characters omitted]…\ntail-1`,
      toolCallId: "c1",
      spill: { chars: 40_800, path: PATH, head: "head-1", tail: "tail-1", omitted: 39_600 },
    },
  ];
  const mount = (daemonInPod?: true) =>
    render(
      <App
        agent={
          new Agent({ model: new ScriptedProvider([]), tools: new ToolRegistry(), env: noopEnv })
        }
        model="qwen3"
        cwd="/tmp/work"
        initialItems={messagesToItems(history)}
        {...(daemonInPod ? { daemonInPod } : {})}
      />,
    );

  test("the note, never the banner; ctrl+o adds `saved to <path>`", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await delay(30);
    const collapsed = lastFrame() ?? "";
    expect(collapsed).toContain("40.8k chars · too large, the model reads it in parts");
    expect(collapsed).toContain("head-1");
    expect(collapsed).toContain("… 39.6k chars omitted …");
    expect(collapsed).not.toContain("[large shell output");
    expect(collapsed).not.toContain(PATH);
    stdin.write("\u000F"); // Ctrl+O
    await delay(50);
    expect(lastFrame() ?? "").toContain(`saved to ${PATH}`);
    expect(lastFrame() ?? "").not.toContain("saved in the pod");
    unmount();
  });

  test("with the daemon in a pod (runPodTui): ctrl+o says `saved in the pod to <path>`", async () => {
    // Mutation (red, verified): drop `spillInPod` from the App's render options → fails.
    const { stdin, lastFrame, unmount } = mount(true);
    await delay(30);
    stdin.write("\u000F");
    await delay(50);
    expect(lastFrame() ?? "").toContain(`saved in the pod to ${PATH}`);
    unmount();
  });
});

// docs/fix/tui-expand-latency.md: once the transcript is quiet the other Ctrl+O view is warmed.
describe("idle warm of the other Ctrl+O view", () => {
  const history: ChatMessage[] = [{ role: "user", content: "list it" }];
  for (let i = 0; i < 6; i++) {
    history.push(
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "shell", arguments: JSON.stringify({ command: "ls" }) }],
      },
      {
        role: "tool",
        content: Array.from({ length: 20 }, (_, n) => `out ${i}.${n}`).join("\n"),
        toolCallId: `c${i}`,
        // Measured, so each header lays out a time: the `formatDurationMs` probe
        // below counts layouts (a replayed row without one shows no time,
        // docs/fix/tool-duration.md).
        durationMs: 100 * i,
      },
    );
  }

  test("the first Ctrl+O after the quiet delay lays out no item again", async () => {
    const spy = spyOn(format, "formatDurationMs");
    const { stdin, lastFrame, unmount } = render(
      <App
        agent={
          new Agent({ model: new ScriptedProvider([]), tools: new ToolRegistry(), env: noopEnv })
        }
        model="qwen3"
        cwd="/tmp/work"
        initialItems={messagesToItems(history)}
      />,
    );
    try {
      await delay(IDLE_WARM_DELAY_MS + 300);
      const settled = spy.mock.calls.length;
      expect(settled).toBeGreaterThanOrEqual(12); // 6 tools × (shown + warmed view)
      stdin.write("\u000F"); // Ctrl+O
      await delay(50);
      expect(lastFrame() ?? "").toContain("out 5.19"); // expanded: the last line is visible
      expect(spy.mock.calls.length).toBe(settled); // ...and nothing was laid out for it
    } finally {
      spy.mockRestore();
      unmount();
    }
  });

  // Review finding 2: the App's three wirings of the warm, observed through the
  // `startIdleWarm` seam (what the App schedules and cancels) — no timers involved.
  describe("what the App feeds the scheduler", () => {
    function spyScheduler() {
      const states: IdleWarmState[] = [];
      const cancels = { count: 0 };
      const spy = spyOn(idleWarm, "startIdleWarm").mockImplementation((state) => {
        states.push(state);
        return () => {
          cancels.count += 1;
        };
      });
      return { states, cancels, spy };
    }
    const idleAgent = () =>
      new Agent({ model: new ScriptedProvider([]), tools: new ToolRegistry(), env: noopEnv });

    test("a pending permission prompt counts as running: no idle warm", async () => {
      // Mutation: drop `permission.pending !== null` from `idleRunning` → red.
      const { states, spy } = spyScheduler();
      const broker = new PermissionBroker();
      const app = render(
        <App agent={idleAgent()} model="qwen3" cwd="/tmp/work" permissions={broker} />,
      );
      try {
        await delay(40);
        expect(states.at(-1)?.running).toBe(false); // idle: the warm may be scheduled
        const answer = broker.request({
          tool: "shell",
          level: "ask",
          title: "Run a shell command",
          detail: "make deploy",
          input: {},
        });
        await delay(40);
        expect(app.lastFrame() ?? "").toContain("make deploy");
        expect(states.at(-1)?.running).toBe(true);
        app.stdin.write("\u001B"); // deny
        await answer;
        await delay(40);
        expect(states.at(-1)?.running).toBe(false); // and it is allowed again after
      } finally {
        spy.mockRestore();
        app.unmount();
      }
    });

    test("a history warm in flight counts as busy: no idle warm", async () => {
      // Mutation: `idleBusy = false` (drop `loading` / `warmingRef`) → red.
      const { states, spy } = spyScheduler();
      // Hold the history warm in flight: no progress until the gate opens.
      let open = false;
      const real = renderLines.warmRowsChunk;
      const chunk = spyOn(renderLines, "warmRowsChunk").mockImplementation((...args) =>
        open ? real(...args) : args[2],
      );
      const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `message ${i}`,
      }));
      const createSession = () => ({
        async *send() {
          yield { type: "history_reset" as const, messages };
          yield { type: "turn_end" as const, reason: "end_turn" as const };
        },
      });
      const app = render(<App createSession={createSession} model="qwen3" cwd="/tmp/work" />);
      try {
        await delay(30);
        app.stdin.write("hi");
        await delay(20);
        app.stdin.write("\r");
        await delay(80);
        expect(states.at(-1)?.busy).toBe(true); // loading bar up, warm held in flight
        open = true;
        await delay(120);
        expect(states.at(-1)?.busy).toBe(false); // finished: the idle warm may run
      } finally {
        open = true;
        chunk.mockRestore();
        spy.mockRestore();
        app.unmount();
      }
    });

    test("a resize cancels the in-flight idle warm at once", async () => {
      // Mutation: drop `idleWarmCancelRef.current()` from `onResize` → red.
      const { cancels, spy } = spyScheduler();
      const app = render(
        <App
          agent={idleAgent()}
          model="qwen3"
          cwd="/tmp/work"
          initialItems={messagesToItems(history)}
        />,
      );
      try {
        await delay(40);
        const before = cancels.count;
        Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
        app.stdout.emit("resize");
        // Synchronously, before the new width commits (whose effect cleanup would
        // cancel anyway): only `onResize` itself can have done this.
        expect(cancels.count).toBe(before + 1);
      } finally {
        spy.mockRestore();
        app.unmount();
      }
    });
  });

  test("a running sub-agent row shows its own tokens (bare, session-total formatter); the status bar total is untouched", async () => {
    // docs/feat/subagent-progress-wire.md (owner 2026-10-26). Mutation: drop the
    // `subagent_usage` reducer case → no "12k" on the row.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agentTask = {
      ...shellTool,
      name: "agent_task",
      permission: "none" as const,
      async execute(_input: unknown, ctx: { emitProgress?: (e: never) => void }) {
        const emit = ctx.emitProgress as (e: unknown) => void;
        emit({ kind: "subagent_start", agentType: "explore", description: "find it" });
        emit({ kind: "subagent_tool", label: "Read a.ts" });
        emit({ kind: "subagent_usage", promptTokens: 11_000, completionTokens: 345 });
        await gate;
        return { content: "report" };
      },
    };
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "p1", name: "agent_task", arguments: '{"command":"x"}' },
        },
        { type: "done", usage: { promptTokens: 7, completionTokens: 3 } },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(agentTask as never),
      env: noopEnv,
    });
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(30);
    stdin.write("\r");
    await delay(200);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("explore · 1 tool use · 11k");
    expect(frame).toContain("↑7 ↓3"); // the parent's own usage only
    release();
    await delay(100);
    unmount();
  });
});
