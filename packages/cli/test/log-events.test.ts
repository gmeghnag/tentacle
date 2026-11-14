import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { headerLine } from "@tentacle/daemon";
import type { KnownLogEntry } from "@tentacle/protocol";
import {
  LOG_CATEGORIES,
  LOG_EVENT_VERSION,
  LOG_TEXT_MAX,
  categoriesOf,
  eventsOf,
  filesTouched,
  filterEvents,
  formatEvent,
  jsonLine,
  parseOnly,
  summarize,
  takeLast,
} from "../src/log-events.ts";

// docs/feat/logs-cmd.md sub-task 1 (`logs-tail`): the ONE output vocabulary the
// file reader and (sub-task 2) the live watcher both map to. Every test names
// the mutation that turns it red (AGENTS §9).

const UID = "025e6a9d-d332-4a45-9051-8a957fa31811";
const HEADER = headerLine({ id: UID, cwd: "/w/app", model: "m1", createdAt: 1 });

/** One incarnation's chain: each call mints the next envelope (seq/id/prev/ts). */
function chain(inc: string, ts = 1000) {
  let seq = 0;
  let prev: string | undefined;
  return (body: Record<string, unknown>, at = ts): KnownLogEntry => {
    seq++;
    const id = `${inc}/${seq}`;
    const entry = { ...body, seq, id, ...(prev ? { prev } : {}), ts: at } as KnownLogEntry;
    prev = id;
    return entry;
  };
}

const user = (content: string): ChatMessage => ({ role: "user", content });
const asst = (content: string, calls: { id: string; name: string; arguments: string }[] = []) => ({
  role: "assistant" as const,
  content,
  ...(calls.length > 0 ? { toolCalls: calls } : {}),
});
const tool = (callId: string, content: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: callId,
});

describe("eventsOf: one event per entry, in log order", () => {
  test("a whole turn: segment, messages, tool call, result, turn end", () => {
    // Mutation: drop the assistant's toolCalls loop → the tool_call event is gone
    // (§7: a tool call is a fact of the log, not of the rendering).
    const next = chain("a");
    const entries = [
      next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
      next({ type: "turn_start", turnId: "t1" }),
      next({ type: "message", critical: true, message: user("read it") }),
      next({
        type: "message",
        critical: true,
        message: asst("", [{ id: "c1", name: "fs_read", arguments: '{"path":"/w/a.ts"}' }]),
      }),
      next({ type: "call_started", callId: "c1" }),
      next({ type: "message", critical: true, message: tool("c1", "contents") }),
      next({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
    ];
    const events = eventsOf(entries, UID);
    expect(events.map((event) => event.type)).toEqual([
      "segment",
      "turn_start",
      "user",
      "tool_call",
      "call_started",
      "tool_result",
      "turn_end",
    ]);
    expect(events[3]).toMatchObject({ callId: "c1", name: "fs_read", args: '{"path":"/w/a.ts"}' });
    // A summary is ONE line, by construction (design: "a one-line argument
    // summary"): a pretty-printed argument must not break the line.
    // Mutation: keep the raw arguments → the event carries newlines and the
    // human line is three.
    const pretty = eventsOf(
      [
        next({ type: "base", critical: true, inc: "b", reason: "create", count: 0 }),
        next({
          type: "message",
          critical: true,
          message: asst("", [{ id: "c9", name: "fs_edit", arguments: '{\n  "path": "a.ts"\n}' }]),
        }),
      ],
      UID,
    );
    const call = pretty.find((event) => event.type === "tool_call");
    expect(call?.type === "tool_call" && call.args).toBe('{ "path": "a.ts" }');
    expect(events[5]).toMatchObject({
      type: "tool_result",
      callId: "c1",
      chars: 8,
      head: "contents",
    });
    expect(events[6]).toMatchObject({ turnId: "t1", stopReason: "end_turn" });
  });

  test("title, segment reasons, sub-agent markers and a notice become their events", () => {
    const next = chain("a");
    const entries = [
      next({ type: "base", critical: true, inc: "a", reason: "reload", count: 0, turn: "t9" }),
      next({ type: "title", title: { text: "a session", source: "model" } }),
      next({
        type: "subagent_background",
        agentId: "sa-1",
        callId: "c1",
        agentType: "explore",
        description: "map it",
      }),
      next({ type: "subagent_end", agentId: "sa-1", stopReason: "end_turn" }),
      next({ type: "message", critical: true, message: { role: "system", content: "note" } }),
      next({ type: "checkpoint", count: 0, digest: "0".repeat(64) }),
    ];
    const events = eventsOf(entries, UID);
    expect(events.map((event) => event.type)).toEqual([
      "segment",
      "title",
      "subagent_start",
      "subagent_end",
      "notice",
    ]);
    expect(events[0]).toMatchObject({ type: "segment", reason: "reload", turn: "t9" });
    // A checkpoint is a derivation fact, not something that happened to the chat.
    expect(events.some((event) => event.type === "notice" && event.text === "0".repeat(64))).toBe(
      false,
    );
  });

  test("a `replace` keeps the message's place and time; a `truncate` shortens the tail", () => {
    // Mutation: emit `replace` as an append → the edited message appears twice.
    const next = chain("a");
    const replaced = [
      next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
      next({ type: "message", critical: true, message: user("first") }, 1000),
      next({ type: "message", critical: true, message: user("second") }, 2000),
      next({ type: "replace", index: 1, message: user("SECOND") }, 3000),
    ];
    const edited = eventsOf(replaced, UID).filter((event) => event.type === "user");
    expect(edited.map((event) => event.text)).toEqual(["first", "SECOND"]);
    expect(edited[1]?.ts).toBe(3000);
    // Mutation: ignore `truncate` → the dropped message is still printed.
    const truncated = eventsOf(
      [...replaced, next({ type: "truncate", length: 1 }, 4000)],
      UID,
    ).filter((event) => event.type === "user");
    expect(truncated.map((event) => event.text)).toEqual(["first"]);
  });

  test("a message that carries image refs (media_message/media_replace) is the same event", () => {
    // Mutation: only handle `message`/`replace` → a session with an image loses
    // its prompts (the media types are the SAME fold, docs/feat/attachments-core.md).
    const next = chain("a");
    const ref = { id: "blob1", mimeType: "image/png", size: 12 };
    const events = eventsOf(
      [
        next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
        next({
          type: "media_message",
          critical: true,
          message: { role: "user", content: "look", attachments: [ref] },
        }),
        next({
          type: "media_replace",
          critical: true,
          index: 0,
          message: { role: "user", content: "LOOK", attachments: [ref] },
        }),
      ],
      UID,
    );
    expect(events.filter((event) => event.type === "user").map((event) => event.text)).toEqual([
      "LOOK",
    ]);
  });

  test("every event carries the three envelope fields (the NDJSON contract)", () => {
    // Mutation: drop `v`, or emit a bare `{type}` → a script cannot tell a shape
    // version apart (the doc: "`v` bumped on a breaking change").
    const next = chain("a");
    const events = eventsOf(
      [
        next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
        next({ type: "message", critical: true, message: user("hi") }),
      ],
      UID,
    );
    for (const event of events) {
      expect(Object.keys(event).slice(0, 3).sort()).toEqual(["session", "ts", "v"]);
      expect(event.v).toBe(LOG_EVENT_VERSION);
      expect(event.session).toBe(UID);
      expect(typeof event.ts).toBe("number");
    }
  });
});

describe("categoriesOf / --only", () => {
  test("each event's category, and a failed turn is both turn and error", () => {
    const next = chain("a");
    const events = eventsOf(
      [
        next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
        next({ type: "turn_start", turnId: "t1" }),
        next({ type: "turn_end", turnId: "t1", stopReason: "error" }),
      ],
      UID,
    );
    expect(categoriesOf(events[1] as never)).toEqual(["turn"]);
    expect(categoriesOf(events[2] as never)).toEqual(["turn", "error"]);
    const only = parseOnly("error");
    expect(only.ok).toBe(true);
    const kept = filterEvents(events, only.ok ? only.categories : []);
    expect(kept.map((event) => event.type)).toEqual(["turn_end"]);
  });

  test("an unknown name is refused, naming it and the choices", () => {
    // Mutation: filter silently on an unknown name → `--only asq` prints nothing
    // and looks like "no such event" instead of a typo.
    const bad = parseOnly("turn,asq");
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toContain('"asq"');
    expect(bad.ok ? "" : bad.error).toContain("turn");
    for (const name of LOG_CATEGORIES) {
      expect(parseOnly(name).ok).toBe(true);
    }
    expect(parseOnly(" , ").ok).toBe(false);
  });
});

describe("takeLast", () => {
  test("the last N, and none for 0", () => {
    expect(takeLast([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(takeLast([1, 2], 5)).toEqual([1, 2]);
    expect(takeLast([1, 2], 0)).toEqual([]);
  });
});

describe("untrusted text", () => {
  test("text mode strips ESC and C1; JSON escapes DEL and C1", () => {
    // Mutation: print the raw text (or JSON.stringify alone) → a model's escape
    // sequence reaches the terminal, and C1 is valid raw in JSON (AGENTS §7).
    const next = chain("a");
    const events = eventsOf(
      [
        next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
        next({
          type: "message",
          critical: true,
          message: asst("\u001b[31mred\u001b[0m\u009b2J"),
        }),
      ],
      UID,
    );
    const line = formatEvent(events[1] as never);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u009b");
    expect(line).toContain("red");
    const json = jsonLine(events[1]);
    expect(json).not.toContain("\u009b");
    expect(json).toContain("\\u009b");
    expect(json).not.toContain("\u001b");
  });

  test("a very long message is capped, and one line", () => {
    const next = chain("a");
    const events = eventsOf(
      [
        next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
        next({ type: "message", critical: true, message: user("x".repeat(LOG_TEXT_MAX + 500)) }),
      ],
      UID,
    );
    const event = events[1];
    expect(event?.type === "user" && event.text.length).toBeLessThanOrEqual(LOG_TEXT_MAX);
    expect(formatEvent(event as never)).not.toContain("\n");
  });
});

describe("filesTouched / summarize", () => {
  test("the paths of fs_write/fs_edit/fs_multi_edit, once each, in first-seen order", () => {
    // Mutation: count every tool's `path` (e.g. `fs_read`'s) → files lists what
    // was merely READ (the summary says "files touched").
    const next = chain("a");
    const entries = [
      next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
      next({
        type: "message",
        critical: true,
        message: asst("", [
          { id: "c1", name: "fs_read", arguments: '{"path":"/read/only.ts"}' },
          { id: "c2", name: "fs_edit", arguments: '{"path":"/w/a.ts"}' },
        ]),
      }),
      next({
        type: "message",
        critical: true,
        message: asst("", [{ id: "c3", name: "fs_write", arguments: '{"path":"/w/b.ts"}' }]),
      }),
      next({
        type: "message",
        critical: true,
        message: asst("", [{ id: "c4", name: "fs_multi_edit", arguments: '{"path":"/w/a.ts"}' }]),
      }),
      next({
        type: "message",
        critical: true,
        message: asst("", [{ id: "c5", name: "fs_write", arguments: "not json" }]),
      }),
    ];
    expect(filesTouched(entries)).toEqual(["/w/a.ts", "/w/b.ts"]);
  });

  test("counts tools, turns and the last outcome, and names an open turn", () => {
    const next = chain("a");
    const entries = [
      next({ type: "base", critical: true, inc: "a", reason: "create", count: 0 }),
      next({ type: "turn_start", turnId: "t1" }),
      next({
        type: "message",
        critical: true,
        message: asst("", [
          { id: "c1", name: "shell", arguments: '{"command":"ls"}' },
          { id: "c2", name: "shell", arguments: '{"command":"pwd"}' },
        ]),
      }),
      next({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
      next({ type: "turn_start", turnId: "t2" }),
    ];
    const summary = summarize(entries, eventsOf(entries, UID), {
      session: UID,
      file: "/w/app/x.jsonl",
      project: "/w/app",
      model: "m1",
      olderSegments: 1,
    });
    expect(summary).toMatchObject({
      session: UID,
      messages: 1,
      turns: 2,
      lastStopReason: "end_turn",
      openTurn: "t2",
      tools: [{ name: "shell", count: 2 }],
      files: [],
      olderSegments: 1,
    });
  });
});
