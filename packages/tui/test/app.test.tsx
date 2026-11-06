import { describe, expect, jest, spyOn, test } from "bun:test";
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
import chalk from "chalk";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { App } from "../src/App.tsx";
import { BLINK_HALF_MS } from "../src/blink.ts";
import * as format from "../src/format.ts";
import * as idleWarm from "../src/idle-warm.ts";
import { IDLE_WARM_DELAY_MS, type IdleWarmState } from "../src/idle-warm.ts";
import type { LinkStatusView } from "../src/link-status.ts";
import * as renderLines from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";
import * as turnFeed from "../src/turn-feed.ts";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
/**
 * The OFF half of the blink is the ON glyph wrapped in the SGR conceal attribute
 * (`ESC[8m … ESC[28m`, `fix/tui-blink-off-width`). It is detected from the
 * CONCEAL code, not from "the bullet is missing": with the same character in
 * both phases the plain text of the two rows is identical by design, and with
 * colour off the OFF row is an ordinary `⏺`.
 */
const concealed = (row: string): boolean => row.includes("\x1b[8m");
/**
 * Bun's fake timers. The pinned `bun-types` predates their typings, so the API
 * is declared here (it exists at runtime — verified: `advanceTimersByTime(600)`
 * moves `Date.now` by 600 ms).
 */
const clock = jest as unknown as {
  useFakeTimers(): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
  /** Armed timers right now: the tool that pins "a timer exists / does not". */
  getTimerCount(): number;
};

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

  test("F2 (owner OQ5): a failed first turn shows tokens and ctx as unknown, never a fake 0; a measured turn shows them", async () => {
    // docs/fix/detach-live-followups.md F2. The agent reports usage only on a
    // stream's `done`, so a failed turn measured nothing. Mutation: render the
    // unmeasured totals as numbers → `↑0 ↓0` and `0%`.
    let fail = true;
    const createSession = () => ({
      async *send() {
        if (fail) {
          yield { type: "text" as const, delta: "partial" };
          throw new Error("model connection lost mid-stream (ECONNRESET)");
        }
        yield { type: "text" as const, delta: "fine" };
        yield { type: "usage" as const, usage: { promptTokens: 64000, completionTokens: 2 } };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    const app = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" contextWindow={128000} />,
    );
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(150);
      const failed = app.lastFrame() ?? "";
      expect(failed).toContain("ECONNRESET");
      // tui-target-badge: ↑↓ are HIDDEN until measured; ctx always carries its max.
      expect(failed).not.toContain("↑");
      expect(failed).toContain("ctx –/128k");
      expect(failed).not.toContain("↑0 ↓0");
      expect(failed).not.toContain("0%");
      fail = false;
      app.stdin.write("again");
      await delay(20);
      app.stdin.write("\r");
      await delay(150);
      const measured = app.lastFrame() ?? "";
      expect(measured).toContain("↑64k ↓2");
      expect(measured).toContain("50%");
    } finally {
      app.unmount();
    }
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

  test("/settings shows the host's lines; /settings apply applies and shows its outcome (docs/feat/session-settings-apply.md)", async () => {
    // Mutation: remove the App's `/settings` case → nothing is shown, nothing applied.
    let applied = 0;
    const createSession = () => ({
      async *send() {
        // no model turn needed for this test
      },
      settings: () => [
        { text: 'Session settings: { "maxIterations": 5 }' },
        { text: 'This terminal differs: { "maxIterations": 3 }', hint: "(/settings apply)" },
      ],
      async updateSettings() {
        applied += 1;
        return [{ text: "Session settings applied." }];
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("/settings");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    const shown = stripAnsi(lastFrame() ?? "");
    expect(shown).toContain('⏺ Session settings: { "maxIterations": 5 }');
    expect(shown).toContain('⏺ This terminal differs: { "maxIterations": 3 } (/settings apply)');
    expect(applied).toBe(0);
    stdin.write("/settings apply");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    expect(applied).toBe(1);
    expect(stripAnsi(lastFrame() ?? "")).toContain("⏺ Session settings applied.");
    unmount();
  });

  test("/settings on a session that carries nothing: not available, nothing called", async () => {
    const createSession = () => ({
      async *send() {
        // no model turn needed for this test
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={createSession} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("/settings apply");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    expect(stripAnsi(lastFrame() ?? "")).toContain("/settings isn't available for this session.");
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

  test("with the daemon in a pod (runEngineTui): ctrl+o says `saved in the pod to <path>`", async () => {
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

  // docs/feat/tui-run-chunked.md, Review F1/F3: the two call sites driven through
  // a real App, so the schedule (not just the helper) is pinned.
  describe("the warmed call sites in the App", () => {
    const history: ChatMessage[] = [{ role: "user", content: "list it" }];
    for (let i = 0; i < 5; i++) {
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    /** Longer than the 50-item warm threshold, so a history open warms in chunks. */
    const manyMessages = (): ChatMessage[] =>
      Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `message ${i}`,
      }));
    /** The frame's widest line: the input box's border is exactly `columns` wide. */
    const longestLine = (frame: string): number =>
      Math.max(0, ...frame.split("\n").map((line) => line.trimEnd().length));

    /**
     * The frame's widest line once it reaches `width` (the warm's 0 ms hops and the
     * commit need a turn or two on a loaded machine), or whatever it still shows
     * after 1 s — so the caller's assertion reports the real value, never a timeout.
     */
    const waitForLineWidth = async (
      app: { lastFrame: () => string | undefined },
      width: number,
    ) => {
      const start = Date.now();
      let widest = longestLine(app.lastFrame() ?? "");
      while (widest !== width && Date.now() - start < 1000) {
        await delay(10);
        widest = longestLine(app.lastFrame() ?? "");
      }
      return widest;
    };

    /** `warmRowsChunk` that advances exactly one item per chunk and records the width. */
    function spyOneItemChunks() {
      const widths: number[] = [];
      const spy = spyOn(renderLines, "warmRowsChunk").mockImplementation((_items, opts, from) => {
        widths.push(opts.width ?? 0);
        return from + 1;
      });
      return { widths, spy };
    }

    test("a stale resize does not go on warming the old width (M4)", async () => {
      // Mutation: `isStale: () => false` at App.tsx:613 → red.
      const { widths, spy } = spyOneItemChunks();
      const app = render(
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
        await delay(30); // the mount's effects (incl. the resize listener) ran
        Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
        app.stdout.emit("resize"); // one chunk of the 120 warm runs synchronously
        Object.defineProperty(app.stdout, "columns", { value: 130, configurable: true });
        app.stdout.emit("resize");
        // The 130 warm lays its 6 items out in 0 ms hops; wait for them (a loaded
        // machine needs more than one turn) — the assertion then reads the order.
        const start = Date.now();
        while (widths.length < 7 && Date.now() - start < 1000) {
          await delay(10);
        }
        // 6 items: the 120 warm stops after its first chunk once superseded; the
        // 130 warm lays all 6 out. Without the stale check the 120 warm ran on.
        expect(widths.slice(0, 7)).toEqual([120, 130, 130, 130, 130, 130, 130]);
      } finally {
        spy.mockRestore();
        app.unmount();
      }
    });

    test("a resize commits the new width (M5)", async () => {
      // Mutation: `onDone: () => {}` at App.tsx:614 → red (the frame stays 100 wide).
      const { spy } = spyOneItemChunks();
      const app = render(
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
        await delay(40);
        expect(longestLine(app.lastFrame() ?? "")).toBe(100); // the committing render, 100 wide
        Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
        app.stdout.emit("resize");
        // The commit is `setSize`: the whole frame re-lays out at 120 columns, so
        // the widest line becomes the 120-column input box's border. Give the
        // warm's 0 ms hops room on a loaded machine, then assert the value.
        expect(await waitForLineWidth(app, 120)).toBe(120);
      } finally {
        spy.mockRestore();
        app.unmount();
      }
    });

    test("an unmount cancels an in-flight resize warm (R2)", async () => {
      // The resize effect's cleanup bumps the generation token, on top of the
      // new-resize bump — so a warm still in flight at unmount does no further
      // work. Mutation: drop `warmGenRef.current += 1` from that cleanup
      // (App.tsx, the resize effect's return) → red (all 6 items are laid out).
      const { widths, spy } = spyOneItemChunks();
      const app = render(
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
        await delay(30); // the mount's effects (incl. the resize listener) ran
        Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
        app.stdout.emit("resize"); // one chunk of the 120 warm runs synchronously
        app.unmount();
        await delay(40); // its queued 0 ms hops: the bump stops it at the first
        expect(widths).toEqual([120]); // nothing laid out after the unmount
      } finally {
        spy.mockRestore();
        app.unmount();
      }
    });

    test("a chunk that throws in the resize warm surfaces a notice, not an unhandled rejection (R1)", async () => {
      // Nobody awaits the resize warm's `done`, so the chunk-2 throw used to be
      // an UNHANDLED rejection (and `bun test` reports one as an error, failing
      // the file). The site now hands it to `onError` → a visible notice.
      // Mutation: drop `onError` from the resize call site in App.tsx → red: no
      // notice, plus the unhandled-rejection report below.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      let calls = 0;
      const chunk = spyOn(renderLines, "warmRowsChunk").mockImplementation((_items, opts, from) => {
        if (opts.width === 120) {
          calls += 1;
          if (calls === 2) {
            throw new Error("boom-resize-chunk-2");
          }
        }
        return from + 1; // one item per chunk: the throw lands in a timer
      });
      const app = render(
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
        await delay(30);
        Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
        app.stdout.emit("resize"); // chunk 1 here; chunk 2 (the throw) in a timer
        const frame = () => app.lastFrame() ?? "";
        const start = Date.now();
        while (!frame().includes("a background layout failed") && Date.now() - start < 1000) {
          await delay(10); // the throw, the notice and a frame, one or two ticks later
        }
        expect(frame()).toContain("a background layout failed");
        expect(frame()).toContain("boom-resize-chunk-2"); // the real error, not a generic one
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        chunk.mockRestore();
        app.unmount();
      }
    });

    test("the long-history commit still waits one macrotask after its last chunk (F2)", async () => {
      // `main` awaited `setTimeout(0)` after every chunk, the last one included;
      // the commit therefore always landed one macrotask after the last chunk, so
      // a pending input/timer ran first. Pins that hop (Review F2).
      const order: string[] = [];
      const real = renderLines.warmRowsChunk;
      let warmed = false;
      const chunk = spyOn(renderLines, "warmRowsChunk").mockImplementation(
        (items, opts, from, b) => {
          if (!warmed) {
            warmed = true;
            order.push("chunk"); // the only chunk: it warms the whole history
            setTimeout(() => order.push("timer"), 0); // a hop already queued when it ended
            return items.length;
          }
          return real(items, opts, from, b); // the REAL one, not the spy (Review R4)
        },
      );
      const realCommit = turnFeed.commitWarmed;
      const commit = spyOn(turnFeed, "commitWarmed").mockImplementation((...args) => {
        if (order.at(-1) !== "commit") {
          order.push("commit");
        }
        return realCommit(...args);
      });
      const messages = manyMessages();
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
        await delay(120);
        expect(order.slice(0, 3)).toEqual(["chunk", "timer", "commit"]);
      } finally {
        commit.mockRestore();
        chunk.mockRestore();
        app.unmount();
      }
    });

    test("a chunk that throws mid-warm fails the turn instead of hanging it (F1)", async () => {
      // Mutation: no `catch` in `runChunked`'s `step` → red (the throw escapes the
      // timer, `App.tsx`'s catch at `:1014` never runs, so no ⚠ row).
      // No wall-clock gate: the FIRST call runs synchronously in `commitHistory`'s
      // own stack and the second is one `setTimeout(0)` later, so throwing on the
      // second call IS "a throw in a timer" by construction (Review R4: the old
      // 40 ms gate fired before `\r` at ≥50 ms, so it never acted).
      const boom = "boom-chunk-2";
      let calls = 0;
      const chunk = spyOn(renderLines, "warmRowsChunk").mockImplementation(
        (_items, _opts, from) => {
          calls += 1;
          if (calls === 2) {
            throw new Error(boom);
          }
          return from + 1; // one item per chunk: the throw lands in a *timer*, not the turn
        },
      );
      const messages = manyMessages();
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
        await delay(150);
        // `streamTurn`'s catch (App.tsx:1014, `main:1012`) failed the turn, as on `main`
        // and with `main`'s exact text (`String(error)` of an Error).
        expect(app.lastFrame() ?? "").toContain(`⚠ Error: ${boom}`);
      } finally {
        chunk.mockRestore();
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

describe("a running tool call's bullet blinks (docs/feat/tui-tool-blink.md)", () => {
  /** A session whose single turn runs one `shell` call for `holdMs`. */
  function slowToolSession(holdMs: number) {
    return () => ({
      async *send() {
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: "cp a b" }),
        };
        await delay(holdMs);
        yield {
          type: "tool_result" as const,
          id: "c1",
          name: "shell",
          result: { content: "done", isError: false },
          durationMs: holdMs,
        };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
  }
  const toolRows = (frame: string): string[] =>
    frame.split("\n").filter((l) => l.includes("Bash") || l.includes("running…"));

  test("the bullet alternates while the call runs, and the label never moves column", async () => {
    // Mutation (red, verified): a static running bullet → one distinct row; an
    // OFF glyph narrower than `⏺` → `positions` gets 2 entries and the row count
    // changes at 1 Hz (round-1 finding 1).
    //
    // The whole test runs on fake timers: a timer armed under real timers would
    // not be reachable by `advanceTimersByTime` (AGENTS §9: drive async
    // deterministically). Ink's own stdin plumbing is macrotask-based, so each
    // step flushes with a real `setImmediate`.
    clock.useFakeTimers();
    const level = chalk.level;
    chalk.level = 3; // the conceal code IS the phase (see `concealed`).
    try {
      const app = render(<App createSession={slowToolSession(5000)} model="m" cwd="/tmp/work" />);
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rowNow = (): string =>
        toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash")) ?? "";
      expect(rowNow()).toContain("Bash");
      const seen = new Set<string>();
      const positions = new Set<number>();
      let rawOn = "";
      let rawOff = "";
      for (let i = 0; i < 6; i++) {
        const row = rowNow();
        if (concealed(row)) {
          seen.add("off");
          if (rawOff === "") {
            rawOff = row;
          }
        } else {
          seen.add("on");
          if (rawOn === "") {
            rawOn = row;
          }
        }
        // The DISPLAY COLUMN of the label, not the string index: `⏺` is 2 wide
        // in one phase and the raw index would differ by one even when the
        // visible row has not moved (the round-1 test's weak correlate).
        positions.add(stringWidth(stripAnsi(row).slice(0, stripAnsi(row).indexOf("Bash"))));
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
      }
      expect([...seen].sort()).toEqual(["off", "on"]); // it really blinks
      expect(positions.size).toBe(1); // the label never moves column
      const plainOn = stripAnsi(rawOn).trimEnd();
      const plainOff = stripAnsi(rawOff).trimEnd();
      // THE property that kills the bug (fix/tui-blink-off-width): strip the
      // SGR off both phases and the rows are IDENTICAL — the same glyph in the
      // same cells — so the owner's terminal cannot draw them one column apart
      // whichever width IT assigns to `⏺`. `seen`/`positions` above are the
      // weaker correlates; this is the exact one.
      expect(plainOff).toBe(plainOn);
      expect(plainOff).toContain("⏺ Bash");
      // The conceal code survives Ink's output pipeline into the FRAME — the
      // load-bearing assumption, at the boundary the user actually sees — and it
      // is closed before the label, so nothing after the bullet is hidden.
      expect(rawOff.indexOf("\x1b[8m⏺")).toBeGreaterThanOrEqual(0);
      const close = rawOff.indexOf("\x1b[28m");
      expect(close).toBeGreaterThan(rawOff.indexOf("⏺"));
      expect(close).toBeLessThan(rawOff.indexOf("Bash"));
      // The call ends: the bullet is the ok one again, at whatever phase.
      clock.advanceTimersByTime(6000);
      await settle();
      // Asserted on the SGR-stripped row: the test forces truecolour, so `⏺`
      // carries an SGR code and a raw `toMatch` would never match.
      expect(stripAnsi(rowNow())).toMatch(/^⏺ Bash cp a b 5\.0s/);
      expect(concealed(rowNow())).toBe(false); // a settled row is never hidden
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("the conceal codes survive into the Ink FRAME with colours forced (load-bearing)", async () => {
    // The one assumption the fix stands on: Ink's ANSI pipeline (its tokenizer,
    // its width slicing and the output grid's `trimEnd`) PRESERVES `ESC[8m …
    // ESC[28m` around the glyph. Proven in `.tentacle/tmp/tui-blink-off-width/`
    // and pinned here at FRAME level, because a fix that only holds in
    // `toolLines` arrives at the terminal as a solid bullet or a literal `[8m`.
    // Mutation (red, verified): make the OFF glyph `"  "` → no `\x1b[8m` in the
    // frame; drop the `\x1b[28m` close → the index ordering fails.
    clock.useFakeTimers();
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={slowToolSession(5000)} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rowNow = (): string =>
        toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash")) ?? "";
      // Find the OFF half of the cycle in the real frame.
      let raw = "";
      for (let i = 0; i < 6 && raw === ""; i++) {
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
        if (concealed(rowNow())) {
          raw = rowNow();
        }
      }
      expect(raw).not.toBe(""); // non-vacuity: we really captured an OFF frame
      // The conceal pair, in the frame, hugging the glyph…
      expect(raw).toContain("\x1b[8m⏺");
      expect(raw).toContain("\x1b[28m");
      // …closed before the label, so only the bullet is hidden…
      expect(raw.indexOf("\x1b[28m")).toBeLessThan(raw.indexOf("Bash"));
      // …and the plain row is the visible ON row byte for byte.
      expect(stripAnsi(raw).trimEnd()).toBe("⏺ Bash cp a b");
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("a call joining mid-cycle blinks in step with the one already running (one clock)", async () => {
    // The exact property of ONE shared clock: the second call starts 750 ms in
    // (mid-OFF-phase) and must still show the SAME glyph as the first. With a
    // per-row clock (each row counting from its own start) the two disagree —
    // mutation D, verified red.
    const createSession = () => ({
      async *send() {
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: "cp a b" }),
        };
        await delay(750); // 1.5 half-periods: the shared clock is mid-OFF
        yield {
          type: "tool_start" as const,
          id: "c2",
          name: "shell",
          arguments: JSON.stringify({ command: "cp c d" }),
        };
        await delay(5000);
        for (const id of ["c1", "c2"]) {
          yield {
            type: "tool_result" as const,
            id,
            name: "shell",
            result: { content: "done", isError: false },
            durationMs: 5000,
          };
        }
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    clock.useFakeTimers();
    // The OFF half is now a VISIBILITY effect (the same glyph concealed), so the
    // phase is only observable with colour on (`concealed`).
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={createSession} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      // Let the mid-cycle join happen.
      clock.advanceTimersByTime(750);
      await settle();
      const phases: string[] = [];
      for (let i = 0; i < 6; i++) {
        const rows = toolRows(app.lastFrame() ?? "").filter((l) => l.includes("Bash"));
        expect(rows).toHaveLength(2);
        const glyphs = rows.map((r) => (concealed(r) ? "off" : "on"));
        // Same phase for both rows: one clock, not one per row.
        expect(new Set(glyphs).size).toBe(1);
        phases.push(glyphs[0] ?? "?");
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
      }
      // Non-vacuous: the pair did go through both phases, together.
      expect(new Set(phases)).toEqual(new Set(["on", "off"]));
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("a dead call left by a failed turn does not blink, and no timer is left (finding 2)", async () => {
    // The HIGH finding: the reducer leaves the `running` tool item behind when a
    // stream throws (`failTurn`, state.ts:170) or a turn ends `cancelled` with no
    // result, so a status-only gate blinked forever with the turn over. The gate
    // is now the TURN running too (`blink.ts: blinkState`).
    // Mutation (red, verified): drop `turnRunning &&` from `blinkState` → the
    // row keeps alternating and `getTimerCount()` stays > 0.
    const createSession = () => ({
      async *send() {
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: "cp a b" }),
        };
        await delay(5000);
        throw new Error("link lost");
      },
    });
    clock.useFakeTimers();
    // The OFF half is a visibility effect: assert the VISIBLE row, which needs
    // colour on (colour-off degrades to a steady bullet, by design).
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={createSession} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rowNow = (): string =>
        toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash")) ?? "";
      /** The row as the user SEES it: SGR stripped (the glyph is always there now). */
      const shown = (): string => stripAnsi(rowNow());
      // The call is alive, ON: the bullet is visible, and the timer exists.
      expect(shown().startsWith("⏺ Bash")).toBe(true);
      const live = clock.getTimerCount();
      clock.advanceTimersByTime(BLINK_HALF_MS);
      await settle();
      expect(concealed(rowNow())).toBe(true); // OFF: it was blinking
      // The stream throws: the turn is over, the running item stays (stale row).
      clock.advanceTimersByTime(6000);
      await settle();
      expect(app.lastFrame() ?? "").toContain("link lost");
      // The stale row is still there — that is the separate reducer task — but it
      // is SOLID now, and nothing re-arms it.
      const solid = rowNow();
      // Solid AND visible: the stale row is no longer concealed either.
      expect(shown().startsWith("⏺ Bash")).toBe(true);
      expect(concealed(solid)).toBe(false);
      for (let i = 0; i < 4; i++) {
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
        expect(rowNow()).toBe(solid);
      }
      expect(clock.getTimerCount()).toBeLessThan(live); // the interval is gone
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("a call joining an OFF-phase cycle starts ON: the clock restarts (owner decision 1)", async () => {
    // Finding 3: with a clock that only counted half-periods, a short call
    // joining at t=600 ms was blank for its whole life. The clock now restarts ON
    // when a NEW call starts (`advanceBlink`/`blinkPhase` keyed on the call
    // count). Mutation (red, verified): drop the call-count key from
    // `blinkPhase` → the second call is `off` in its first frames.
    const createSession = () => ({
      async *send() {
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: "cp a b" }),
        };
        await delay(550); // the shared clock is in its OFF half (500–999 ms)
        yield {
          type: "tool_start" as const,
          id: "c2",
          name: "shell",
          arguments: JSON.stringify({ command: "cp c d" }),
        };
        await delay(200); // the short call: shorter than one half-period
        yield {
          type: "tool_result" as const,
          id: "c2",
          name: "shell",
          result: { content: "done", isError: false },
          durationMs: 200,
        };
        yield {
          type: "tool_result" as const,
          id: "c1",
          name: "shell",
          result: { content: "done", isError: false },
          durationMs: 800,
        };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    clock.useFakeTimers();
    // Every assertion here is on the VISIBLE row, so the conceal must be real:
    // colour on (colour-off degrades to a steady bullet, by design).
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={createSession} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rows = (): string[] =>
        (app.lastFrame() ?? "").split("\n").filter((l) => l.includes("Bash"));
      // The first call is in its OFF half (500–999 ms)...
      clock.advanceTimersByTime(BLINK_HALF_MS);
      await settle();
      expect(rows()).toHaveLength(1);
      expect(concealed(rows()[0] ?? "")).toBe(true);
      // ...and the second call joins at 550 ms, mid-OFF.
      clock.advanceTimersByTime(50);
      await settle();
      // ...and the second call joining then is ON at once, and stays ON for its
      // whole 200 ms life (never blank), in step with the first (one clock).
      for (let i = 0; i < 4; i++) {
        const pair = rows();
        expect(pair).toHaveLength(2);
        for (const row of pair) {
          expect(stripAnsi(row).startsWith("⏺ Bash")).toBe(true);
        }
        clock.advanceTimersByTime(50);
        await settle();
      }
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("at 79 columns no row moves between phases: the frame does not jump (finding 1)", async () => {
    // The HIGH width finding, at FRAME level: `⏺` is 2 columns, the old OFF
    // glyph was 1, so at 79 columns a long command's row re-wrapped and every
    // row below it moved one line at 1 Hz. The review's captured symptom was
    // `bashRow=14 replyRow=10` ↔ `bashRow=15 replyRow=11`.
    // The command below is 85 columns, so at 79 columns the fitted header is CUT
    // (71 columns of room) and the ellipsis makes it fill the row EXACTLY: the
    // wrap sits on the boundary, and any phase whose glyph is not 2 columns
    // either overflows (a wider OFF glyph) or leaves a column unused (a narrower
    // one) — both are caught by the width assertion below.
    // Mutation (red, verified, on the STACKED tree): swap the OFF glyph for
    // `"   "` (3 columns) → 80, or for `" "` (1 column) → 78. The OFF phase now
    // emits the SAME glyph, concealed (`fix/tui-blink-off-width`), so no count of
    // spaces — and no terminal's opinion about U+23FA's width — is involved.
    const createSession = () => ({
      async *send() {
        yield { type: "text" as const, delta: "Running the loop now." };
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({
            command:
              "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo item-$i; done > out.txt && echo finished",
          }),
        };
        // A row BELOW the tool: it is what moves when the header re-wraps.
        yield { type: "text" as const, delta: "AFTER-TOOL marker line." };
        await delay(5000);
        yield {
          type: "tool_result" as const,
          id: "c1",
          name: "shell",
          result: { content: "done", isError: false },
          durationMs: 5000,
        };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    clock.useFakeTimers();
    // The phase signal is the CONCEAL code on the same glyph, so colour must be
    // on for the phase to be observable at all (`concealed`).
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={createSession} model="m" cwd="/tmp/work" />);
      // 79 columns: the width the review found the re-wrap at.
      Object.defineProperty(app.stdout, "columns", { value: 79, configurable: true });
      app.stdout.emit("resize");
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const frame = (): string[] => (app.lastFrame() ?? "").split("\n").map(stripAnsi);
      /** The same rows WITH their SGR codes: the OFF phase lives in them. */
      const rawFrame = (): string[] => (app.lastFrame() ?? "").split("\n");
      const bashRow = (rows: string[]): number =>
        rows.findIndex((r) => r.includes("Bash") && r.includes("for i in"));
      const replyRow = (rows: string[]): number =>
        rows.findIndex((r) => r.includes("AFTER-TOOL marker"));
      const views: { phase: string; rows: number; bash: number; reply: number; width: number }[] =
        [];
      for (let i = 0; i < 4; i++) {
        const rows = frame();
        const bash = bashRow(rows);
        expect(bash).toBeGreaterThanOrEqual(0);
        views.push({
          phase: concealed(rawFrame()[bash] ?? "") ? "off" : "on",
          rows: rows.length,
          bash,
          reply: replyRow(rows),
          // The header's DISPLAY width: 79 = exactly full, so neither phase has
          // a column to spare or to overflow.
          width: stringWidth((rows[bash] ?? "").trimEnd()),
        });
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
      }
      // Both phases really were shown (non-vacuity)…
      expect(new Set(views.map((v) => v.phase))).toEqual(new Set(["on", "off"]));
      // …and NOTHING ELSE moved: same total rows, same tool row, same reply row.
      expect(new Set(views.map((v) => v.rows)).size).toBe(1);
      expect(new Set(views.map((v) => v.bash)).size).toBe(1);
      expect(new Set(views.map((v) => v.reply)).size).toBe(1);
      // Every phase's header fills the row exactly: a differently-widthed OFF
      // glyph re-wraps it (the round-1 jump) and shows up here as 78 or 80.
      expect(new Set(views.map((v) => v.width))).toEqual(new Set([79]));
      // The labelled property, at the width the review named.
      const first = views[0] as { rows: number; bash: number; reply: number };
      for (const v of views) {
        expect(v.rows).toBe(first.rows);
        expect(v.bash).toBe(first.bash);
        expect(v.reply).toBe(first.reply);
      }
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });

  test("the interval exists only while a call runs, and is cleared (F, G)", async () => {
    // Findings 4/E/F/G: no owner-facing clock property was pinned. These are
    // measured against `getTimerCount()` on the App's OWN timers, with an idle
    // App mounted alongside as the baseline (Ink and the loading bar arm timers
    // of their own, so an absolute count would be a lie).
    // Mutations (red, verified): drop the `!blinkRuns` early return (F: an idle
    // App arms an interval and keeps ticking) → the idle assertion fails; drop
    // the `clearInterval` cleanup (G) → the count after the turn does not fall.
    clock.useFakeTimers();
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const idle = render(
        <App model="m" cwd="/tmp/work" createSession={() => ({ async *send() {} })} />,
      );
      await settle();
      expect(clock.getTimerCount()).toBe(0); // nothing running: no timer at all
      const app = render(<App createSession={slowToolSession(300)} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      // The call is running: exactly ONE interval belongs to the blink clock
      // (the others are Ink's spinner and the loading bar, present without it).
      const running = clock.getTimerCount();
      // End the call: the interval is cleared, and the App is back to the idle
      // baseline (0 timers) once the turn's own spinner/loading timers finish.
      clock.advanceTimersByTime(400);
      await settle();
      clock.advanceTimersByTime(1000);
      await settle();
      expect(clock.getTimerCount()).toBe(0); // G: a leaked interval pads this to 1
      const row = toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash")) ?? "";
      expect(row).toMatch(/^⏺ Bash cp a b 0\.3s/);
      for (let i = 0; i < 3; i++) {
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
        expect(toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash"))).toBe(row);
      }
      // Unmounting mid-call leaves no interval behind either.
      app.unmount();
      idle.unmount();
    } finally {
      clock.useRealTimers();
    }
  });

  test("a short call (200 ms) shows a steady bullet: never an off flash", async () => {
    // The owner's decision: the clock starts ON when the call starts, so a call
    // shorter than one half-period is stock-solid. Mutation: start the phase at
    // the OFF half (or seed it from a wall clock) → the row blanks here.
    clock.useFakeTimers();
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={slowToolSession(200)} model="m" cwd="/tmp/work" />);
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rowNow = (): string =>
        toolRows(app.lastFrame() ?? "").find((l) => l.includes("Bash")) ?? "";
      // Sample inside the call's 200 ms: never off.
      for (let i = 0; i < 4; i++) {
        expect(rowNow().startsWith("⏺ Bash")).toBe(true);
        clock.advanceTimersByTime(50);
        await settle();
      }
      // It ends well inside the first half-period: solid ok bullet, no blink.
      clock.advanceTimersByTime(100);
      await settle();
      expect(rowNow()).toMatch(/^⏺ Bash cp a b 0\.2s/);
      app.unmount();
    } finally {
      clock.useRealTimers();
    }
  });
});

describe("clicking a tool call expands its command (docs/feat/tui-tool-expand.md)", () => {
  const COMMAND =
    "cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v -timeout 120s 2>&1 | tail -50";
  /** A session that runs ONE long-command `shell` call (ok, 1.7 s) and settles. */
  const longCallSession = () => ({
    async *send() {
      yield {
        type: "tool_start" as const,
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({ command: COMMAND }),
      };
      await delay(10);
      yield {
        type: "tool_result" as const,
        id: "c1",
        name: "shell",
        result: { content: "ok", isError: false },
        durationMs: 1700,
      };
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  });
  const twoCallSession = () => ({
    async *send() {
      // A long reply first, so at 40 columns the transcript is taller than the
      // viewport and a scroll-up leaves BOTH calls visible at a known row.
      yield {
        type: "text" as const,
        delta: Array.from({ length: 30 }, (_, i) => `pad ${i}`).join("\n"),
      };
      // `cmdA` / `cmdB` lead the command, so the header row (which keeps the
      // command's START, cut to the width) distinguishes the two calls at any
      // width.
      for (const [id, tag] of [
        ["c1", "cmdA"],
        ["c2", "cmdB"],
      ] as const) {
        yield {
          type: "tool_start" as const,
          id,
          name: "shell",
          arguments: JSON.stringify({ command: `${tag} ${COMMAND}` }),
        };
        yield {
          type: "tool_result" as const,
          id,
          name: "shell",
          result: { content: "ok", isError: false },
          durationMs: 100,
        };
      }
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  });
  /**
   * Review finding 1's setup: 40 pad lines and 12 settled calls with long
   * commands, so at 100 columns the transcript is much taller than the viewport
   * and its last rows are dense with tool headers. One wheel notch scrolls up 3
   * rows, which puts several headers BELOW the window's end.
   */
  const manyCallsSession = () => ({
    async *send() {
      yield {
        type: "text" as const,
        delta: Array.from({ length: 40 }, (_, i) => `pad ${i}`).join("\n"),
      };
      for (let i = 1; i <= 12; i++) {
        const id = `c${String(i).padStart(2, "0")}`;
        yield {
          type: "tool_start" as const,
          id,
          name: "shell",
          arguments: JSON.stringify({ command: `cmd${i} ${COMMAND}` }),
        };
        yield {
          type: "tool_result" as const,
          id,
          name: "shell",
          result: { content: "ok", isError: false },
          durationMs: 100,
        };
      }
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  });
  const rowsOf = (frame: string): string[] => frame.split("\n").map(stripAnsi);
  const headerRowOf = (frame: string, tail = ""): number =>
    rowsOf(frame).findIndex((r) => r.includes("Bash") && r.includes(tail)) + 1;
  const cont = (frame: string): string[] => rowsOf(frame).filter((r) => r.startsWith("  │ "));

  async function runLong(): Promise<{
    app: ReturnType<typeof render>;
    frame: () => string;
    y: number;
  }> {
    const app = render(<App createSession={longCallSession} model="m" cwd="/tmp/work" />);
    // Commit the width AFTER the App's effects subscribed to `resize`.
    await delay(40);
    Object.defineProperty(app.stdout, "columns", { value: 160, configurable: true });
    app.stdout.emit("resize");
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    const frame = (): string => app.lastFrame() ?? "";
    return { app, frame, y: headerRowOf(frame()) };
  }

  test("the whole command is on the header row at 160 columns (was cut at 72)", async () => {
    const { app, frame } = await runLong();
    const header = rowsOf(frame())[headerRowOf(frame()) - 1] ?? "";
    expect(header).toContain(COMMAND);
    expect(header).toContain("1.7s");
    expect(stringWidth(header.trimEnd())).toBeLessThanOrEqual(160);
    app.unmount();
  });

  test("a click on the header row expands that call; a second click collapses it", async () => {
    // RED before the change: `click changed the frame? false` (the Context
    // repro) — a click did nothing at all.
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    expect(y).toBeGreaterThan(0);
    expect(cont(frame())).toHaveLength(0); // nothing expanded yet
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    const expanded = frame();
    // 160 columns: the whole command fits one `  │ ` row (the width-derived
    // wrap is the render-lines tests' job). It is the FULL command, not the
    // 72-char cut.
    expect(cont(expanded)).toHaveLength(1);
    expect(cont(expanded).join(" ")).toContain(COMMAND);
    // The header keeps bullet + label + elapsed.
    const header = rowsOf(expanded)[headerRowOf(expanded) - 1] ?? "";
    expect(header.startsWith("⏺ Bash")).toBe(true);
    expect(header).toContain("1.7s");
    // A second click collapses it again.
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    expect(cont(frame())).toHaveLength(0);
    app.unmount();
  });

  test("a click only toggles ONE call, and its expansion survives new messages", async () => {
    const app = render(<App createSession={twoCallSession} model="m" cwd="/tmp/work" />);
    // Commit the width AFTER the App's effects subscribed to `resize`.
    await delay(40);
    Object.defineProperty(app.stdout, "columns", { value: 160, configurable: true });
    app.stdout.emit("resize");
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    const frame = (): string => app.lastFrame() ?? "";
    // Only the SECOND call's command is expanded.
    const y = headerRowOf(frame(), "cmdB");
    expect(y).toBeGreaterThan(0);
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    expect(cont(frame()).join(" ")).toContain("cmdB");
    expect(cont(frame()).join(" ")).not.toContain("cmdA");
    // A new prompt re-renders the transcript: the call stays expanded (keyed by
    // its stable id) and the NEW call is collapsed.
    app.stdin.write("again");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    expect(cont(frame()).join(" ")).toContain("cmdB");
    app.unmount();
  });

  test("a coalesced press+release in ONE chunk is still a click", async () => {
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    app.stdin.write(`\u001B[<0;3;${y}M\u001B[<0;3;${y}m`);
    await delay(80);
    expect(cont(frame()).length).toBeGreaterThan(0);
    app.unmount();
  });

  test("a drag from a tool row still selects text and does NOT toggle", async () => {
    const copied: string[] = [];
    const app = render(
      <App
        createSession={longCallSession}
        model="m"
        cwd="/tmp/work"
        clipboard={async (t) => {
          copied.push(t);
        }}
      />,
    );
    // Commit the width AFTER the App's effects subscribed to `resize`.
    await delay(40);
    Object.defineProperty(app.stdout, "columns", { value: 160, configurable: true });
    app.stdout.emit("resize");
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    const frame = (): string => app.lastFrame() ?? "";
    const y = headerRowOf(frame());
    app.stdin.write(press(3, y));
    await delay(20);
    app.stdin.write(drag(20, y)); // motion: this is a selection, not a click
    await delay(20);
    app.stdin.write(release(20, y));
    await delay(80);
    expect(cont(frame())).toHaveLength(0); // nothing expanded
    expect(copied).toHaveLength(1); // the drag selected
    expect(copied[0]?.length).toBeGreaterThan(0);
    app.unmount();
  });

  test("a press on a tool row released on ANOTHER row does not toggle", async () => {
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y + 3)); // same button, different cell
    await delay(80);
    expect(cont(frame())).toHaveLength(0);
    app.unmount();
  });

  test("a click on a wrapped continuation row does not collapse the call", async () => {
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    const first = cont(frame())[0] ?? "";
    expect(first).not.toBe("");
    const contY = rowsOf(frame()).findIndex((r) => r.startsWith("  │ ")) + 1;
    app.stdin.write(press(6, contY)); // a cell INSIDE the command text
    app.stdin.write(release(6, contY));
    await delay(80);
    expect(cont(frame()).length).toBeGreaterThan(0); // still expanded
    app.unmount();
  });

  test("a click while scrolled up toggles the call under the CURSOR, not the tail", async () => {
    // The hit-test takes the ABSOLUTE row (`win.start + r.y - 1`), so a click at
    // a given screen row after scrolling reaches the call that is THERE.
    // Mutation (red, verified): hit-test on `r.y - 1` alone (ignoring the window
    // start) resolves a pad row → nothing expands.
    const app = render(<App createSession={twoCallSession} model="m" cwd="/tmp/work" />);
    // Commit the width AFTER the App's effects subscribed to `resize`.
    await delay(40);
    Object.defineProperty(app.stdout, "columns", { value: 40, configurable: true }); // wraps
    app.stdout.emit("resize");
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    const frame = (): string => app.lastFrame() ?? "";
    // The tail: the calls are at the BOTTOM of the screenshot.
    const tailRow = headerRowOf(frame(), "cmdA");
    expect(tailRow).toBeGreaterThan(0);
    // Scroll up one notch (3 rows): the transcript shifts down, so the call is
    // now at a LOWER screen row and `win.start` is no longer the tail's.
    app.stdin.write(WHEEL_UP);
    await delay(100);
    const y = headerRowOf(frame(), "cmdA");
    expect(y).toBeGreaterThan(tailRow); // it really moved down
    const before = cont(frame()).length;
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(100);
    const text = cont(frame()).join(" ");
    expect(cont(frame()).length).toBeGreaterThan(before);
    expect(text).toContain("cmdA"); // the call at the cursor
    expect(text).not.toContain("cmdB");
    app.unmount();
  });

  test("a click BELOW the viewport, scrolled up, toggles nothing (review finding 1)", async () => {
    // The review's scenario: scrolled up, the rows below the transcript viewport
    // — the two prompt rules, the input box, the status bar — map to
    // `win.start + y - 1`, which are real transcript rows the user cannot see
    // (tool headers, at the tail). A click there used to toggle a HIDDEN call.
    // Mutation (red, verified): drop the viewport bound
    // (`toolCallAtViewport` → `toolCallAt(laid, win.start + y - 1)`) → the click
    // on row 20 / row 23 expands `cmd12`, as the review's repro shows.
    const app = render(<App createSession={manyCallsSession} model="m" cwd="/tmp/work" />);
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(300);
    const frame = (): string => app.lastFrame() ?? "";
    // Where the bottom area starts: the first rule row (`───`) is the viewport's
    // last transcript row + 1 — everything from it down is NOT transcript.
    const ruleRow = (): number => rowsOf(frame()).findIndex((r) => /^─+$/.test(r)) + 1;
    expect(ruleRow()).toBeGreaterThan(1);
    for (const notches of [1, 2, 3]) {
      // Scroll up one notch at a time; the transcript's last visible row is
      // still the row above the rule.
      app.stdin.write(WHEEL_UP);
      await delay(100);
      const top = ruleRow();
      expect(cont(frame())).toHaveLength(0); // nothing expanded yet
      // Click EVERY row of the bottom area: the rule, the input, the rule, the
      // status bar.
      for (let y = top; y <= rowsOf(frame()).length; y++) {
        app.stdin.write(press(3, y));
        app.stdin.write(release(3, y));
        await delay(20);
      }
      await delay(60);
      // Scroll back to the tail: none of those clicks may have expanded a call.
      for (let i = 0; i < 80; i++) app.stdin.write(WHEEL_DOWN);
      await delay(250);
      expect({ notches, conts: cont(frame()).length }).toEqual({ notches, conts: 0 });
      for (let i = 0; i < 80; i++) app.stdin.write(WHEEL_UP); // back up for the next round
      await delay(150);
      for (let i = 0; i < 80; i++) app.stdin.write(WHEEL_DOWN);
      await delay(150);
    }
    // Non-vacuity: a click on a VISIBLE header still expands, at the same width
    // and after the same scrolling — so the assertions above are about the
    // viewport bound, not about clicks having stopped working.
    app.stdin.write(WHEEL_UP);
    await delay(100);
    const visibleY = rowsOf(frame()).findIndex((r) => r.includes("Bash")) + 1;
    expect(visibleY).toBeGreaterThan(0);
    expect(visibleY).toBeLessThan(ruleRow());
    app.stdin.write(press(3, visibleY));
    app.stdin.write(release(3, visibleY));
    await delay(100);
    expect(cont(frame()).length).toBeGreaterThan(0);
    app.unmount();
  });

  test("a click while Ctrl+O is on changes no hidden per-call state (review finding 3)", async () => {
    // With `expandAll` every call's command already shows, so a header click has
    // nothing to reveal. It must not silently toggle `expandedIds`: turning
    // Ctrl+O off would then show a call — or hide one — the user never clicked a
    // visible change for.
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    expect(cont(frame())).toHaveLength(0);
    app.stdin.write("\u000F"); // Ctrl+O: every command shows
    await delay(80);
    expect(cont(frame()).join(" ")).toContain(COMMAND);
    // Click the header of the (now expanded-looking) call, then Ctrl+O off.
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    app.stdin.write("\u000F"); // Ctrl+O off
    await delay(80);
    // It is still COLLAPSED: the click under Ctrl+O recorded nothing.
    expect(cont(frame())).toHaveLength(0);
    // Non-vacuity: with Ctrl+O off, a real click does expand it.
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    expect(cont(frame()).join(" ")).toContain(COMMAND);
    app.unmount();
  });

  test("the resize warm lays the clicked call out ONCE: the commit render is a cache hit (review finding 2)", async () => {
    // Drift 7's whole point: the warm must fill the slot the COMMITTING render
    // will ask for — a clicked call's `command` slot, not the collapsed one.
    // Without `expandedIds` in the App's `onResize` options literal the warm
    // fills `collapsed`, and the committing render then re-lays-out the call on
    // the render thread — the freeze the warm exists to avoid.
    // Measured on `formatDurationMs`, which `toolLines` calls on every layout of
    // a tool item, so the count IS the number of layouts of this one call.
    // Mutation (red, verified): drop `expandedIds` from the literal
    // (`App.tsx:644`) → 2 instead of 1.
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    expect(cont(frame())).toHaveLength(1); // the call is clicked
    const spy = spyOn(format, "formatDurationMs");
    try {
      Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true });
      app.stdout.emit("resize");
      await delay(150); // the warm's chunks, then the commit render
      // Non-vacuity: the width really changed and the command re-wrapped.
      expect(cont(frame()).length).toBeGreaterThan(1);
      // ONE layout: the warm's, for the slot the commit asks for. The mutation
      // makes it 2 (the warm's collapsed view, then the commit's command view).
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
    app.unmount();
  });

  test("a terminal RESIZE while expanded keeps the call expanded at the new width", async () => {
    // The failure mode the plan names: a width change drops every item's cached
    // slots and re-wraps. The expansion is keyed by id, so it must survive, and
    // the resize warm must warm THAT view (App includes `expandedIds` in both).
    const { app, frame } = await runLong();
    const y = headerRowOf(frame());
    app.stdin.write(press(3, y));
    app.stdin.write(release(3, y));
    await delay(80);
    expect(cont(frame())).toHaveLength(1); // 160 columns: one row
    expect(cont(frame()).join(" ")).toContain(COMMAND);
    // Narrow to 60 columns: the command must re-wrap onto more `  │ ` rows, and
    // the call must still be expanded (its id never changed).
    Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true });
    app.stdout.emit("resize");
    await delay(120);
    const narrow = cont(frame());
    expect(narrow.length).toBeGreaterThan(1);
    const joined = narrow
      .map((r) => r.slice("  │ ".length))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(joined).toBe(COMMAND);
    for (const row of narrow) {
      expect(stringWidth(row)).toBeLessThanOrEqual(60);
    }
    app.unmount();
  });

  test("Ctrl+O shows the full command too", async () => {
    const { app, frame } = await runLong();
    expect(cont(frame())).toHaveLength(0);
    app.stdin.write("\u000F"); // Ctrl+O
    await delay(80);
    expect(cont(frame()).length).toBeGreaterThan(0);
    expect(cont(frame()).join(" ")).toContain(COMMAND);
    app.unmount();
  });

  test("an expanded RUNNING call still blinks, and no row moves", async () => {
    const createSession = () => ({
      async *send() {
        yield {
          type: "tool_start" as const,
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: COMMAND }),
        };
        await delay(5000);
        yield {
          type: "tool_result" as const,
          id: "c1",
          name: "shell",
          result: { content: "done", isError: false },
          durationMs: 5000,
        };
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    });
    clock.useFakeTimers();
    // The phase signal is the CONCEAL code on the same glyph, so colour must be
    // on for the blink to be observable at all (`concealed`).
    const level = chalk.level;
    chalk.level = 3;
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const app = render(<App createSession={createSession} model="m" cwd="/tmp/work" />);
      await settle(); // the App's resize subscription is an effect: run it first
      Object.defineProperty(app.stdout, "columns", { value: 40, configurable: true });
      app.stdout.emit("resize");
      await settle();
      app.stdin.write("go");
      await settle();
      app.stdin.write("\r");
      await settle();
      const rows = (): string[] => rowsOf(app.lastFrame() ?? "");
      const y = rows().findIndex((r) => r.includes("Bash")) + 1;
      app.stdin.write(press(3, y));
      app.stdin.write(release(3, y));
      await settle();
      const expanded = rows();
      expect(expanded.filter((r) => r.startsWith("  │ ")).length).toBeGreaterThan(1);
      /** The same rows WITH their SGR codes: the OFF phase lives in them. */
      const rawRows = (): string[] => (app.lastFrame() ?? "").split("\n");
      const views: { phase: string; count: number; conts: string[] }[] = [];
      for (let i = 0; i < 4; i++) {
        const r = rows();
        const head = r.findIndex((row) => row.includes("Bash"));
        views.push({
          phase: concealed(rawRows()[head] ?? "") ? "off" : "on",
          count: r.length,
          conts: r.filter((row) => row.startsWith("  │ ")),
        });
        clock.advanceTimersByTime(BLINK_HALF_MS);
        await settle();
      }
      expect(new Set(views.map((v) => v.phase))).toEqual(new Set(["on", "off"])); // it blinks
      expect(new Set(views.map((v) => v.count)).size).toBe(1); // no row appears/disappears
      const conts = views[0]?.conts ?? [];
      for (const v of views) {
        expect(v.conts).toEqual(conts); // the expanded block never moves
      }
      app.unmount();
    } finally {
      chalk.level = level;
      clock.useRealTimers();
    }
  });
});
