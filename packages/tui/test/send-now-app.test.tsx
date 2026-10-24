import { describe, expect, test } from "bun:test";
import { DISMISSED, PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { ARC } from "../src/spinner.ts";
import type { SessionEvent } from "../src/state.ts";

// The `Ctrl+X Ctrl+S` chord over a fake controller (docs/feat/send-now-c.md).
const CTRL_X = "\x18";
const CTRL_S = "\x13";
const ESC = "\x1b";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const queuedRow = (text: string) => new RegExp(`[${ARC.frames.join("")}] ${text}`);
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const METHOD_NOT_FOUND = -32601;
const NO_TURN_RUNNING = -32008;
const CANCELLED = -32010;

interface SendNowCall {
  readonly messages: readonly { readonly id: string; readonly text: string }[];
  readonly target: string;
  readonly signal?: AbortSignal;
}

/** Ends a held turn; `steers`: texts it injects first, `reset`: a resync before its end. */
type Release = (opts?: { steers?: readonly string[]; reset?: boolean }) => void;

/**
 * A remote-like session. A prompt starting with "go" holds its turn open until
 * released (the fake daemon's cancel, or the test) or aborted; any other
 * prompt answers at once. `sendNow` is the test's script.
 */
function fakeSession(script: {
  readonly sendNow?: (call: SendNowCall, release: Release) => Promise<AsyncIterable<SessionEvent>>;
  readonly enqueue?: () => Promise<void>;
}) {
  const log = {
    sends: [] as string[],
    enqueues: [] as { text: string; id: string | undefined }[],
    sendNows: [] as SendNowCall[],
    aborted: [] as string[],
  };
  let release: Release = () => {};
  const ctrl: SessionController = {
    async *send(prompt, signal) {
      log.sends.push(prompt);
      yield { type: "text", delta: `reply to ${prompt}` };
      let opts: { steers?: readonly string[]; reset?: boolean } = {};
      if (prompt.startsWith("go")) {
        await new Promise<void>((resolve) => {
          release = (o = {}) => {
            opts = o;
            resolve();
          };
          signal?.addEventListener("abort", () => {
            log.aborted.push(prompt);
            resolve();
          });
        });
      }
      for (const text of opts.steers ?? []) {
        yield { type: "steer", text };
      }
      if (opts.reset) {
        yield { type: "history_reset", messages: [{ role: "user", content: prompt }] };
      }
      yield { type: "turn_end", reason: signal?.aborted ? "cancelled" : "end_turn" };
    },
    enqueue(text, id) {
      log.enqueues.push({ text, id });
      return script.enqueue ? script.enqueue() : Promise.resolve();
    },
  };
  const { sendNow } = script;
  if (sendNow) {
    ctrl.sendNow = (messages, target, signal) => {
      const call = { messages, target, ...(signal ? { signal } : {}) };
      log.sendNows.push(call);
      return sendNow(call, (o) => release(o));
    };
  }
  return {
    ctrl,
    log,
    release: (o?: { steers?: readonly string[]; reset?: boolean }) => release(o),
  };
}

/** The successor the fake daemon starts: its prompt, an answer, its end. */
async function* successor(prompt: string): AsyncGenerator<SessionEvent> {
  yield { type: "user_message", text: prompt };
  yield { type: "text", delta: "answered now" };
  yield { type: "turn_end", reason: "end_turn" };
}

/** An iterable whose first step rejects (a successor cancelled before it started). */
const rejecting = (error: Error): AsyncIterable<SessionEvent> => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
});

/** Start a held turn ("go"), queue `rows`, return the app. */
async function startWithRows(ctrl: SessionController, rows: readonly string[], extra = {}) {
  const app = render(<App createSession={() => ctrl} model="m" cwd="/tmp/work" {...extra} />);
  await delay(30);
  app.stdin.write("go");
  await delay(20);
  app.stdin.write("\r");
  await delay(60);
  for (const row of rows) {
    app.stdin.write(row);
    await delay(20);
    app.stdin.write("\r");
    await delay(30);
  }
  return app;
}

async function chord(stdin: { write(data: string): void }) {
  stdin.write(CTRL_X);
  await delay(20);
  stdin.write(CTRL_S);
  await delay(60);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("Ctrl+X Ctrl+S — send the queued messages now", () => {
  test("T-C2: sendNow names exactly my rows, with the ids enqueue got", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async (call, release) => {
        release();
        return successor(call.messages.map((m) => m.text).join("\n\n"));
      },
    });
    const { stdin, unmount } = await startWithRows(ctrl, ["alpha", "bravo"]);
    expect(log.enqueues.map((e) => e.text)).toEqual(["alpha", "bravo"]);
    await chord(stdin);
    expect(log.sendNows).toHaveLength(1);
    const ids = log.enqueues.map((e) => e.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(log.sendNows[0]?.messages).toEqual([
      { id: ids[0] ?? "?", text: "alpha" },
      { id: ids[1] ?? "?", text: "bravo" },
    ]);
    expect(log.sendNows[0]?.target).toBe("turn");
    unmount();
  });

  test("T-C3: with no queued row the chord does nothing (D2)", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async () => {
        throw new Error("must not be called");
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, []);
    await chord(stdin);
    expect(log.sendNows).toHaveLength(0);
    expect(log.aborted).toEqual([]);
    expect(lastFrame() ?? "").not.toContain("send-now");
    expect(lastFrame() ?? "").toContain("working…"); // the turn still runs
    unmount();
  });

  // Follow-up 2 (review finding 4): the chord no longer dismisses the dialog
  // itself. An accepted send-now aborts the turn daemon-side, which withdraws
  // the ask (its signal aborts → DISMISSED, nothing sent); a refused one leaves
  // the turn running and the dialog answerable — never an orphaned ask.
  const ask = (permissions: PermissionBroker, signal?: AbortSignal) => {
    const answered: { response?: PermissionResponse } = {};
    void permissions
      .request(
        { tool: "shell", level: "ask", title: "Run a shell command", detail: "ls", input: {} },
        signal ? { signal } : undefined,
      )
      .then((r) => {
        answered.response = r;
      });
    return answered;
  };

  test("T-C4: with the permission dialog up, the chord sends; the daemon's withdrawal closes the dialog (no deny)", async () => {
    const permissions = new PermissionBroker();
    const withdraw = new AbortController(); // the daemon settling the ask `cancelled`
    const { ctrl, log } = fakeSession({
      sendNow: async (call, release) => {
        withdraw.abort();
        release();
        return successor(call.messages.map((m) => m.text).join("\n\n"));
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"], { permissions });
    const answered = ask(permissions, withdraw.signal);
    await delay(40);
    expect(lastFrame() ?? "").toContain("Run a shell command");
    await chord(stdin);
    expect(log.sendNows).toHaveLength(1);
    expect(answered.response).toBe(DISMISSED);
    expect(lastFrame() ?? "").not.toContain("Run a shell command");
    unmount();
  });

  test("T-C4d (review R2-3): MethodNotFound with the dialog up → the fallback stops the turn and dismisses the dialog (no deny)", async () => {
    const permissions = new PermissionBroker();
    const { ctrl, log } = fakeSession({
      sendNow: async () => {
        throw rpcError(METHOD_NOT_FOUND, "method not found");
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"], { permissions });
    const answered = ask(permissions); // an older daemon may never withdraw it
    await delay(40);
    await chord(stdin);
    await delay(40);
    expect(log.aborted).toEqual(["go"]);
    expect(answered.response).toBe(DISMISSED);
    expect(lastFrame() ?? "").not.toContain("Run a shell command");
    unmount();
  });

  test("T-C4c: the send-now is refused with the dialog up → the dialog stays answerable (no orphaned ask)", async () => {
    const permissions = new PermissionBroker();
    const { ctrl, log } = fakeSession({
      sendNow: async () => {
        throw rpcError(-32003, "this session was closed");
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"], { permissions });
    const answered = ask(permissions);
    await delay(40);
    await chord(stdin);
    expect(log.sendNows).toHaveLength(1);
    expect(answered.response).toBeUndefined();
    expect(lastFrame() ?? "").toContain("Run a shell command");
    stdin.write("y");
    await delay(30);
    expect(answered.response).toEqual({ allowed: true, scope: "once" });
    unmount();
  });

  test("T-C4b: dialog up and no queued row → the dialog stays", async () => {
    const permissions = new PermissionBroker();
    const { ctrl, log } = fakeSession({ sendNow: async () => successor("x") });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, [], { permissions });
    let answered = false;
    const ask = { tool: "shell", level: "ask", title: "Run a shell command", input: {} } as const;
    void permissions.request(ask).then(() => {
      answered = true;
    });
    await delay(40);
    await chord(stdin);
    expect(answered).toBe(false);
    expect(log.sendNows).toHaveLength(0);
    expect(lastFrame() ?? "").toContain("Run a shell command");
    unmount();
  });

  test("T-C5: MethodNotFound → one notice, abort, then send the joined texts; later chords skip the request", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async () => {
        throw rpcError(METHOD_NOT_FOUND, "method not found");
      },
    });
    const saved: string[] = [];
    const saveFile = async (_path: string, content: string) => {
      saved.push(content);
    };
    const { stdin, frames, lastFrame, unmount } = await startWithRows(ctrl, ["alpha", "bravo"], {
      saveFile,
    });
    await chord(stdin);
    await delay(60);
    expect(log.aborted).toEqual(["go"]);
    expect(log.sends).toEqual(["go", "alpha\n\nbravo"]);
    expect(lastFrame() ?? "").toContain("this daemon can't send-now atomically");
    // A later turn: straight to the fallback, no request, no second notice.
    stdin.write("go2");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    stdin.write("charlie");
    await delay(20);
    stdin.write("\r");
    await delay(30);
    await chord(stdin);
    await delay(60);
    expect(log.sendNows).toHaveLength(1);
    expect(log.aborted).toEqual(["go", "go2"]);
    expect(log.sends).toEqual(["go", "alpha\n\nbravo", "go2", "charlie"]);
    expect(frames.join("\n")).toContain("reply to charlie");
    // The whole transcript (the first notice may have scrolled off screen).
    stdin.write("/save");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    expect(saved).toHaveLength(1);
    expect(count(saved[0] ?? "", "can't send-now atomically")).toBe(1);
    unmount();
  });

  test("T-C5b: a controller with no sendNow (in-process session) takes the fallback", async () => {
    const { ctrl, log } = fakeSession({});
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin);
    await delay(60);
    expect(log.aborted).toEqual(["go"]);
    expect(log.sends).toEqual(["go", "alpha"]);
    expect(lastFrame() ?? "").toContain("this session can't send-now atomically");
    unmount();
  });

  test("T-C5c: the fallback notice is once per SESSION — a /clear's new session says it again", async () => {
    const { ctrl, log } = fakeSession({});
    const saved: string[] = [];
    const saveFile = async (_path: string, content: string) => {
      saved.push(content);
    };
    const { stdin, unmount } = await startWithRows(ctrl, ["alpha"], { saveFile });
    await chord(stdin);
    await delay(60);
    for (const keys of ["/clear", "go2"]) {
      stdin.write(keys);
      await delay(20);
      stdin.write("\r");
      await delay(60);
    }
    stdin.write("charlie");
    await delay(20);
    stdin.write("\r");
    await delay(30);
    await chord(stdin);
    await delay(60);
    expect(log.sends).toEqual(["go", "alpha", "go2", "charlie"]);
    stdin.write("/save");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    // The transcript after /clear: the new session's own notice.
    expect(count(saved[0] ?? "", "can't send-now atomically")).toBe(1);
    unmount();
  });

  test("T-C5d: the MethodNotFound latch is per session — a /clear's new session asks the daemon again", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async () => {
        throw rpcError(METHOD_NOT_FOUND, "method not found");
      },
    });
    const { stdin, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin);
    await delay(60);
    for (const keys of ["/clear", "go2", "charlie"]) {
      stdin.write(keys);
      await delay(20);
      stdin.write("\r");
      await delay(60);
    }
    await chord(stdin);
    await delay(60);
    expect(log.sendNows).toHaveLength(2);
    expect(log.sends).toEqual(["go", "alpha", "go2", "charlie"]);
    unmount();
  });

  test("T-C6: the successor is cancelled before it started → the texts are back in the input", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async (_call, release) => {
        release();
        return rejecting(rpcError(CANCELLED, "send-now cancelled before it started"));
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha", "bravo"]);
    await chord(stdin);
    await delay(40);
    expect(lastFrame() ?? "").not.toMatch(queuedRow("alpha"));
    // The input holds exactly "alpha\n\nbravo": Enter sends it as one prompt.
    stdin.write("\r");
    await delay(60);
    expect(log.sends).toEqual(["go", "alpha\n\nbravo"]);
    unmount();
  });

  test("T-C6b: Esc while the request is in flight cancels through the new turn's signal", async () => {
    let call: SendNowCall | null = null;
    const { ctrl, log } = fakeSession({
      sendNow: (c) => {
        call = c;
        return new Promise(() => {}); // the ack never comes
      },
    });
    const { stdin, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin);
    stdin.write(ESC);
    await delay(60);
    expect((call as SendNowCall | null)?.signal?.aborted).toBe(true);
    // The old turn's own signal was not used: the daemon already cancelled it.
    expect(log.aborted).toEqual([]);
    unmount();
  });

  test("T-C7: the successor streams → one user bubble with the daemon's prompt, rows gone", async () => {
    const { ctrl, unmount, stdin, lastFrame } = await (async () => {
      const s = fakeSession({
        sendNow: async (call, release) => {
          release();
          return successor(call.messages.map((m) => m.text).join("\n\n"));
        },
      });
      const app = await startWithRows(s.ctrl, ["alpha", "bravo"]);
      return { ctrl: s.ctrl, ...app };
    })();
    void ctrl;
    await chord(stdin);
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("answered now");
    expect(frame).not.toMatch(queuedRow("alpha"));
    expect(count(frame, "alpha")).toBe(1);
    expect(count(frame, "bravo")).toBe(1);
    unmount();
  });

  test("T-C7b: rows stay up until the new turn starts; then only the ones typed after the chord", async () => {
    let ack: () => void = () => {};
    const { ctrl, log } = fakeSession({
      sendNow: (call, release) => {
        release(); // the daemon cancels the old turn at once; its ack is slow
        return new Promise((resolve) => {
          ack = () =>
            resolve(
              (async function* (): AsyncGenerator<SessionEvent> {
                yield { type: "user_message", text: call.messages.map((m) => m.text).join("\n\n") };
                await delay(5000); // the new turn keeps running
              })(),
            );
        });
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin);
    // The old turn is over, the ack is not here: still shown running, the row up.
    expect(lastFrame() ?? "").toContain("working…");
    expect(lastFrame() ?? "").toMatch(queuedRow("alpha"));
    stdin.write("charlie");
    await delay(20);
    stdin.write("\r");
    await delay(30);
    expect(log.enqueues.map((e) => e.text)).toEqual(["alpha", "charlie"]);
    ack();
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(queuedRow("alpha"));
    expect(frame).toMatch(queuedRow("charlie"));
    expect(log.sends).toEqual(["go"]);
    unmount();
  });

  test("T-C11: an enqueue refused after the chord took its row says nothing (the text went with the send-now)", async () => {
    const { ctrl } = fakeSession({
      enqueue: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(rpcError(NO_TURN_RUNNING, "no turn is running")), 120);
        }),
      sendNow: async (call, release) => {
        release();
        return (async function* (): AsyncGenerator<SessionEvent> {
          yield { type: "user_message", text: call.messages.map((m) => m.text).join("\n\n") };
          await delay(5000);
        })();
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin); // before the refusal (120 ms after the enqueue)
    await delay(120);
    expect(lastFrame() ?? "").toContain("alpha"); // the new turn's bubble
    expect(lastFrame() ?? "").not.toContain("not queued");
    unmount();
  });

  // Follow-up 1: `NoTurnRunning` is the DAEMON's fact (the client no longer
  // refuses locally): every text was delivered and nothing awaits an answer.
  // The TUI sends nothing and restores nothing — it only says so.
  test("T-C8: the daemon's NoTurnRunning → nothing re-sent, nothing restored; rows go with the old turn", async () => {
    const { ctrl, log, release } = fakeSession({
      sendNow: async () => {
        throw rpcError(NO_TURN_RUNNING, "no turn is running");
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha", "bravo"]);
    await chord(stdin);
    expect(lastFrame() ?? "").toContain("nothing to send");
    release({ steers: ["alpha"] });
    await delay(80);
    expect(log.sends).toEqual(["go"]);
    expect(lastFrame() ?? "").not.toMatch(queuedRow("bravo"));
    stdin.write("\r"); // the input is empty: nothing was restored into it
    await delay(60);
    expect(log.sends).toEqual(["go"]);
    unmount();
  });

  test("T-C9: NoTurnRunning after the old turn already ended on screen → idle, rows gone, nothing sent", async () => {
    const { ctrl, log } = fakeSession({
      sendNow: async (_call, release) => {
        release();
        await delay(60); // the old turn's end is shown before the answer
        throw rpcError(NO_TURN_RUNNING, "no turn is running");
      },
    });
    const { stdin, lastFrame, unmount } = await startWithRows(ctrl, ["alpha"]);
    await chord(stdin);
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("working…");
    expect(frame).not.toMatch(queuedRow("alpha"));
    expect(frame).toContain("nothing to send");
    stdin.write("\r");
    await delay(60);
    expect(log.sends).toEqual(["go"]);
    unmount();
  });

  /**
   * Rows alpha, bravo; chord; "charlie" typed while the request is out; then
   * the refusal `refuse(call)` builds (the old turn keeps running).
   */
  async function refusedWhileRunning(refuse: (call: SendNowCall) => Error) {
    let reject: (call: SendNowCall) => void = () => {};
    const s = fakeSession({
      sendNow: (call) =>
        new Promise((_resolve, rej) => {
          reject = (c) => rej(refuse(c));
        }),
    });
    const app = await startWithRows(s.ctrl, ["alpha", "bravo"]);
    await chord(app.stdin);
    app.stdin.write("charlie");
    await delay(20);
    app.stdin.write("\r");
    await delay(30);
    const call = s.log.sendNows[0];
    if (!call) throw new Error("no send-now");
    reject(call);
    await delay(40);
    return { ...s, ...app };
  }

  // Follow-up 2 (review finding 1): a refusal reports which texts the daemon
  // holds (`error.data.held`); only the others come back to the input.
  test("T-C10: TurnInProgress with `held` → only the unheld text is restored; held and later rows stay queued", async () => {
    const t = await refusedWhileRunning((call) =>
      Object.assign(rpcError(-32004, "a send-now is already waiting"), {
        data: { held: [call.messages[0]?.id] },
      }),
    );
    const frame = t.lastFrame() ?? "";
    expect(frame).toContain("send-now failed: a send-now is already waiting");
    expect(frame).toMatch(queuedRow("alpha")); // held by the daemon: still queued
    expect(frame).not.toMatch(queuedRow("bravo")); // not held: back in the input
    expect(frame).toMatch(queuedRow("charlie")); // typed after the chord: still the turn's
    expect(t.log.aborted).toEqual([]);
    t.release();
    await delay(60);
    t.stdin.write("\r");
    await delay(60);
    expect(t.log.sends).toEqual(["go", "bravo"]);
    t.unmount();
  });

  test("T-C10b: no `held` (an older daemon) → every sent text is restored (the documented fallback)", async () => {
    const t = await refusedWhileRunning(() => rpcError(-32004, "a send-now is already waiting"));
    expect(t.lastFrame() ?? "").toMatch(queuedRow("charlie"));
    t.release();
    await delay(60);
    t.stdin.write("\r");
    await delay(60);
    expect(t.log.sends).toEqual(["go", "alpha\n\nbravo"]);
    t.unmount();
  });
});
