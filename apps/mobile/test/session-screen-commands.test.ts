/**
 * The session screen's commands engine (docs/feat/mobile-hub-commands.md C2
 * item 13): Compact, Stop during it, Clear with its inline confirm, Retry last
 * prompt. The fake handle raises `history{compact|clear}` BEFORE resolving, as
 * the client does for every replacement (own included) — so the transcript's
 * rows come from the history, and the controller adds only the outcome line.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import type { ChatMessage } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  CHAT_CLEARED_KEPT,
  COMPACTION_CANCELLED,
  COMPACT_LINK_DROPPED,
  NOTHING_TO_CLEAR,
} from "../src/compact-slot.ts";
import { createSessionController } from "../src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";
import type { Row } from "../src/transcript.ts";

type Result = { before: number; after: number };

interface Fake extends SendableHandle {
  emit(activity: SessionActivity): void;
  readonly sent: string[];
  readonly compactSignals: (AbortSignal | undefined)[];
  /** The compaction/clear the test settles by hand. */
  settleCompact: ((outcome: Result | Error) => void) | null;
  clearCalls: number;
  clearAnswer: (fake: Fake) => Promise<Result>;
}

const SUMMARY: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "[Conversation summary]\nwe mapped the repo" },
];

function fake(): Fake {
  let listener: ((activity: SessionActivity) => void) | null = null;
  const f: Fake = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    async *send(prompt) {
      f.sent.push(prompt);
      yield { type: "user_message", text: prompt } as SessionEvent;
      yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
    },
    compact(signal) {
      f.compactSignals.push(signal);
      return new Promise<Result>((resolve, reject) => {
        f.settleCompact = (outcome) => {
          if (outcome instanceof Error) {
            reject(outcome);
            return;
          }
          // The client raises the replacement BEFORE the call resolves.
          f.emit({ kind: "history", messages: SUMMARY, reason: "compact" });
          resolve(outcome);
        };
        signal?.addEventListener("abort", () =>
          f.settleCompact?.(new RpcError(DomainErrorCode.Cancelled, "compaction cancelled")),
        );
      });
    },
    clear() {
      f.clearCalls += 1;
      return f.clearAnswer(f);
    },
    clearAnswer: async (self) => {
      self.emit({
        kind: "history",
        messages: [{ role: "system", content: "sys" }],
        reason: "clear",
      });
      return { before: 5, after: 1 };
    },
    emit: (activity) => listener?.(activity),
    sent: [],
    compactSignals: [],
    settleCompact: null,
    clearCalls: 0,
  };
  return f;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function harness(history: readonly ChatMessage[] = []) {
  const clock = { at: 10_000 };
  const handle = fake();
  const screen = createSessionScreen({
    sessionId: "s1",
    archived: false,
    title: "Alpha",
    project: "p",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => clock.at,
  });
  await screen.open();
  if (history.length > 0) {
    handle.emit({ kind: "history", messages: history, reason: null });
  }
  return { screen, handle, clock };
}

const CHAT: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "map the repo" },
  { role: "assistant", content: "done" },
];

const notices = (rows: readonly Row[]) =>
  rows.flatMap((r) =>
    r.kind === "notice"
      ? [r.separator === true ? "<separator>" : `${r.level === "warn" ? "▲" : "◇"} ${r.text}`]
      : [],
  );

const row = (
  screen: { state(): { commands: readonly { id: string; state: unknown }[] } },
  id: string,
) => screen.state().commands.find((r) => r.id === id)?.state;

describe("Clear (the load-bearing check: the daemon's history IS the transcript)", () => {
  test("history{clear} then resolve → an empty transcript + ONE ◇ chat cleared line", async () => {
    const { screen, handle } = await harness(CHAT);
    expect(screen.state().transcript.rows.length).toBeGreaterThan(0);
    screen.armClear();
    expect(row(screen, "clear")).toEqual({ kind: "confirming" });
    await screen.clear();
    expect(handle.clearCalls).toBe(1);
    expect(screen.state().transcript.rows.map((r) => r.kind)).toEqual(["notice"]);
    expect(notices(screen.state().transcript.rows)).toEqual([`◇ ${CHAT_CLEARED_KEPT}`]);
    expect(row(screen, "clear")).toEqual({ kind: "ready" });
  });

  test("a clear never armed sends nothing; Cancel disarms", async () => {
    const { screen, handle } = await harness(CHAT);
    await screen.clear();
    screen.armClear();
    screen.cancelClear();
    await screen.clear();
    expect(handle.clearCalls).toBe(0);
  });

  test("a turn starting disarms the confirm (the question changed)", async () => {
    const { screen, handle } = await harness(CHAT);
    screen.armClear();
    handle.emit({
      kind: "turn",
      turnId: "t-other",
      events: (async function* () {
        await new Promise(() => {});
      })() as AsyncIterable<SessionEvent>,
      cancel: () => {},
    });
    await settle();
    expect(row(screen, "clear")).toEqual({ kind: "dimmed", reason: "Waits for the turn to end" });
    await screen.clear();
    expect(handle.clearCalls).toBe(0);
  });

  test("a link drop disarms the confirm", async () => {
    const { screen, handle } = await harness(CHAT);
    screen.armClear();
    screen.link(false);
    screen.link(true);
    await screen.clear();
    expect(handle.clearCalls).toBe(0);
  });

  test("a no-op clear says nothing to clear; a refusal is ▲ Couldn't clear", async () => {
    const { screen, handle } = await harness(CHAT);
    handle.clearAnswer = async () => ({ before: 1, after: 1 });
    screen.armClear();
    await screen.clear();
    handle.clearAnswer = async () => {
      throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    };
    screen.armClear();
    await screen.clear();
    expect(notices(screen.state().transcript.rows).slice(-2)).toEqual([
      `◇ ${NOTHING_TO_CLEAR}`,
      "▲ Couldn't clear: a turn is already running",
    ]);
  });
});

describe("Compact", () => {
  test("history{compact} then resolve → ONE separator, no line, slot Compacted ✓ for 3 s", async () => {
    const { screen, handle, clock } = await harness(CHAT);
    const run = screen.compact();
    expect(screen.state().slot).toEqual({ kind: "compacting", since: 10_000 });
    expect(row(screen, "compact")).toEqual({ kind: "running" });
    expect(row(screen, "clear")).toEqual({ kind: "dimmed", reason: "Compacting…" });
    handle.settleCompact?.({ before: 3, after: 2 });
    await run;
    expect(notices(screen.state().transcript.rows)).toEqual(["<separator>"]);
    expect(screen.state().slot).toEqual({ kind: "compacted" });
    expect(row(screen, "compact")).toEqual({ kind: "done", text: "Compacted ✓" });
    clock.at += 2_999;
    expect(screen.state().slot).toEqual({ kind: "compacted" });
    clock.at += 1;
    expect(screen.state().slot).toBeNull();
    screen.dispose();
  });

  test("Stop during it aborts the signal → ◇ compaction cancelled, slot gone", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    expect(handle.compactSignals[0]?.aborted).toBe(false);
    screen.stopTurn();
    await run;
    expect(handle.compactSignals[0]?.aborted).toBe(true);
    expect(notices(screen.state().transcript.rows)).toEqual([`◇ ${COMPACTION_CANCELLED}`]);
    expect(screen.state().slot).toBeNull();
    expect(row(screen, "compact")).toEqual({ kind: "ready" });
  });

  test("a transport loss is the UNKNOWN line, never a ▲", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    handle.settleCompact?.(new RpcError(JsonRpcErrorCode.InternalError, "connection closed"));
    await run;
    expect(notices(screen.state().transcript.rows)).toEqual([`◇ ${COMPACT_LINK_DROPPED}`]);
    expect(screen.state().slot).toBeNull();
  });

  test("a refusal is ▲ and the row shows it with Retry until the next try", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    handle.settleCompact?.(
      new RpcError(DomainErrorCode.CompactInProgress, "a compaction is running"),
    );
    await run;
    const failed = "Compact failed: another device is compacting";
    expect(notices(screen.state().transcript.rows)).toEqual([`▲ ${failed}`]);
    expect(row(screen, "compact")).toEqual({ kind: "failed", text: failed });
    void screen.compact();
    expect(row(screen, "compact")).toEqual({ kind: "running" });
    screen.dispose();
  });

  test("a daemon-side failure (opaque InternalError, link up) is ▲ with Retry, not the unknown line", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    handle.settleCompact?.(new RpcError(JsonRpcErrorCode.InternalError, "internal error"));
    await run;
    const failed = "Compact failed: internal error";
    expect(notices(screen.state().transcript.rows)).toEqual([`▲ ${failed}`]);
    expect(row(screen, "compact")).toEqual({ kind: "failed", text: failed });
    screen.dispose();
  });

  test("refused locally while a turn runs, on a dead link, or twice at once", async () => {
    const { screen, handle } = await harness(CHAT);
    screen.link(false);
    await screen.compact();
    expect(handle.compactSignals.length).toBe(0);
    screen.link(true);
    void screen.compact();
    void screen.compact();
    expect(handle.compactSignals.length).toBe(1);
    screen.dispose();
  });

  test("a resolution after dispose is ignored (no line, no throw)", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    const before = screen.state().transcript.rows.length;
    screen.dispose();
    handle.settleCompact?.(new RpcError(DomainErrorCode.TurnInProgress, "x"));
    await run;
    expect(notices(screen.state().transcript.rows).filter((n) => n.startsWith("▲"))).toEqual([]);
    expect(screen.state().transcript.rows.length).toBe(before);
  });

  test("a turn starting drops a lingering Compacted ✓ (it must not come back after)", async () => {
    const { screen, handle } = await harness(CHAT);
    const run = screen.compact();
    handle.settleCompact?.({ before: 3, after: 2 });
    await run;
    expect(screen.state().slot).toEqual({ kind: "compacted" });
    screen.setDraft("next");
    screen.press();
    await settle();
    expect(screen.state().transcript.turn).toBeNull();
    expect(screen.state().slot).toBeNull();
    screen.dispose();
  });
});

describe("Retry last prompt", () => {
  test("re-sends the last user text through the composer's send path", async () => {
    const { screen, handle } = await harness(CHAT);
    expect(row(screen, "retry")).toEqual({ kind: "ready" });
    screen.retryLast();
    await settle();
    expect(handle.sent).toEqual(["map the repo"]);
  });

  test("a busy field dims it and retryLast sends nothing", async () => {
    const { screen, handle } = await harness(CHAT);
    screen.setDraft("typing");
    expect(row(screen, "retry")).toEqual({
      kind: "dimmed",
      reason: "The message field is not empty",
    });
    screen.retryLast();
    await settle();
    expect(handle.sent).toEqual([]);
    expect(screen.state().draft).toBe("typing");
  });

  test("the photos of the last prompt are not re-sent, and a ◇ line says so", async () => {
    const { screen, handle } = await harness([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "what is this",
        attachments: [{ id: "img1", mimeType: "image/png", size: 10 }],
      },
      { role: "assistant", content: "a cat" },
    ]);
    screen.retryLast();
    await settle();
    expect(handle.sent).toEqual(["what is this"]);
    expect(notices(screen.state().transcript.rows)).toContain("◇ the photos were not re-sent");
  });

  test("no earlier prompt: dimmed, nothing sent", async () => {
    const { screen, handle } = await harness();
    expect(row(screen, "retry")).toEqual({ kind: "dimmed", reason: "Nothing to retry" });
    screen.retryLast();
    await settle();
    expect(handle.sent).toEqual([]);
  });
});
