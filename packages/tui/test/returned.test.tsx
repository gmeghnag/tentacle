import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { SessionEvent } from "../src/state.ts";
import { queuedRow } from "./queued-row.ts";

// The PC half of "a queued message goes back to whoever wrote it"
// (docs/feat/queued-broadcast.md): the TUI puts MY returned rows in the input
// field with a notice, and never sends them by itself.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What `onReturned` hands its listener. */
type Back = Parameters<Parameters<NonNullable<SessionController["onReturned"]>>[0]>[0];

/** A session whose first turn runs until `end()`; records every `send` and the `onReturned` listener. */
function stub() {
  const sent: string[] = [];
  let end = (): void => {};
  let give: ((rows: Back) => void) | null = null;
  const controller: SessionController = {
    async *send(prompt: string, signal?: AbortSignal) {
      sent.push(prompt);
      if (sent.length > 1) {
        yield { type: "turn_end", reason: "end_turn" } as const;
        return;
      }
      yield { type: "tool_start", id: "c1", name: "shell", arguments: "" } as const;
      await new Promise<void>((r) => {
        end = r;
        signal?.addEventListener("abort", () => r(), { once: true });
      });
      yield { type: "turn_end", reason: "cancelled" } as const;
    },
    enqueue: () => Promise.resolve(),
    onReturned(listener) {
      give = listener;
      return () => {
        give = null;
      };
    },
  };
  return {
    controller,
    sent,
    end: () => end(),
    give: (rows: Back) => give?.(rows),
    subscribed: () => give !== null,
  };
}

const back: Back = [
  { id: "a", text: "fix x", cause: "cancelled" },
  { id: "b", text: "and y", cause: "cancelled" },
];

describe("returned rows → the input field (never re-sent)", () => {
  test("another device stopped the turn: my rows come back joined, with the owner's notice", async () => {
    const s = stub();
    const { stdin, lastFrame, unmount } = render(
      <App createSession={() => s.controller} model="m" cwd="/tmp/work" />,
    );
    await delay(30);
    expect(s.subscribed()).toBe(true);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    s.end(); // the daemon ended it (another device's Esc)
    await delay(40);
    s.give(back);
    await delay(40);
    expect(lastFrame() ?? "").toContain(
      "Turn stopped from another device: your 2 queued messages are back in the input",
    );
    // Nothing went out by itself.
    expect(s.sent).toEqual(["go"]);
    // The user decides: Enter sends the restored text, joined.
    stdin.write("\r");
    await delay(40);
    expect(s.sent).toEqual(["go", "fix x\n\nand y"]);
    unmount();
  });

  test("this TUI pressed Esc on that turn: the plain notice", async () => {
    const s = stub();
    const { stdin, lastFrame, unmount } = render(
      <App createSession={() => s.controller} model="m" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    stdin.write("\u001b"); // Esc
    await delay(80);
    s.give(back);
    await delay(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Your 2 queued messages are back in the input");
    expect(frame).not.toContain("another device");
    expect(s.sent).toEqual(["go"]);
    unmount();
  });
});

const CANCELLED = -32010;

/**
 * A session whose "go" turn yields what the test pushes (`push`) until
 * `end()`; `sendNow` waits for `settle()`, then ends the old turn and rejects
 * its events `Cancelled` (cancelled before it started). Logs every enqueue.
 */
function chordStub() {
  const sent: string[] = [];
  const enqueues: { text: string; id: string | undefined }[] = [];
  const pending: SessionEvent[] = [];
  let wake = (): void => {};
  let ended = false;
  let settle = (): void => {};
  let give: ((rows: Back) => void) | null = null;
  const controller: SessionController = {
    async *send(prompt: string) {
      sent.push(prompt);
      if (prompt !== "go") {
        yield { type: "turn_end", reason: "end_turn" } as const;
        return;
      }
      yield { type: "tool_start", id: "c1", name: "shell", arguments: "" } as const;
      for (;;) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      yield { type: "turn_end", reason: "cancelled" } as const;
    },
    enqueue(text, id) {
      enqueues.push({ text, id });
      return Promise.resolve();
    },
    async sendNow() {
      await new Promise<void>((r) => {
        settle = r;
      });
      ended = true;
      wake();
      const error = Object.assign(new Error("send-now cancelled before it started"), {
        code: CANCELLED,
      });
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
    },
    onReturned(listener) {
      give = listener;
      return () => {
        give = null;
      };
    },
  };
  return {
    controller,
    sent,
    enqueues,
    push: (event: SessionEvent) => {
      pending.push(event);
      wake();
    },
    settle: () => settle(),
    give: (rows: Back) => give?.(rows),
  };
}

async function type(stdin: { write(data: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(40);
}

describe("review F1: the TUI restores each of my rows once, and only mine leave on a steer", () => {
  test("a row typed after the chord, restored with the cancelled send-now, then returned by the daemon: once", async () => {
    // Mutation: the hand-back ignores what the TUI restored itself → "bravo" twice.
    const s = chordStub();
    const { stdin, unmount } = render(
      <App createSession={() => s.controller} model="m" cwd="/tmp/work" />,
    );
    await delay(30);
    await type(stdin, "go");
    await type(stdin, "alpha");
    stdin.write("\x18");
    await delay(20);
    stdin.write("\x13"); // the send-now chord: it takes "alpha"
    await delay(60);
    await type(stdin, "bravo"); // typed after the chord: bound to the old turn
    const bravo = s.enqueues.find((e) => e.text === "bravo")?.id;
    expect(bravo).toBeDefined();
    s.settle(); // another device's Esc: the send-now never started
    await delay(80);
    s.give([{ id: bravo ?? "", text: "bravo", cause: "cancelled" }]); // the daemon's fact
    await delay(40);
    stdin.write("\r");
    await delay(60);
    expect(s.sent).toEqual(["go", "alpha\n\nbravo"]);
    unmount();
  });

  test("another writer's steer leaves my queued row in place", async () => {
    // Mutation: drop the front row on any steer → "alpha" vanishes from the list.
    const s = chordStub();
    const { stdin, lastFrame, unmount } = render(
      <App createSession={() => s.controller} model="m" cwd="/tmp/work" />,
    );
    await delay(30);
    await type(stdin, "go");
    await type(stdin, "alpha");
    expect(lastFrame() ?? "").toContain("alpha");
    s.push({ type: "steer", text: "B's text", id: "someone-else" });
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(queuedRow("alpha"));
    // Its own steer (the daemon names it) takes it off the list.
    const alpha = s.enqueues.find((e) => e.text === "alpha")?.id ?? "";
    s.push({ type: "steer", text: "alpha", id: alpha });
    await delay(60);
    expect(lastFrame() ?? "").not.toMatch(queuedRow("alpha"));
    unmount();
  });
});
