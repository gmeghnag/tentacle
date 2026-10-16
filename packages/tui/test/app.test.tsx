import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";

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
