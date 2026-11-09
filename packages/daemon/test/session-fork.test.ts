import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { forkWrite, forkableMessages } from "../src/session-fork.ts";
import { META } from "./support/log-fixture.ts";

// docs/feat/clear-fork-history.md T1, T2: the pure half of a fork.

const sys: ChatMessage = { role: "system", content: "sys" };
const still: ChatMessage = {
  role: "user",
  content: "Background sub-agents still running",
  note: { kind: "still_running" },
};
const lost: ChatMessage = {
  role: "user",
  content: "[background] sub-agent sa-1 was lost",
  note: { kind: "subagent_lost", id: "sa-1" },
};
const hi: ChatMessage = { role: "user", content: "hi" };
const hello: ChatMessage = { role: "assistant", content: "hello" };

describe("forkableMessages", () => {
  test("T1 null when only the system prompt and notes remain; drops still_running, keeps the rest", () => {
    expect(forkableMessages([sys])).toBeNull();
    expect(forkableMessages([sys, still])).toBeNull();
    expect(forkableMessages([sys, lost])).toBeNull();
    expect(forkableMessages([sys, hi, still, hello])).toEqual([sys, hi, hello]);
    expect(forkableMessages([sys, hi, lost])).toEqual([sys, hi, lost]);
  });
});

describe("forkWrite", () => {
  test("T2 base{create}, one message each, a title only when chosen, head = last entry, nothing else", () => {
    const messages = [sys, hi, hello];
    const auto = forkWrite({ id: "f1", meta: META, messages, title: { source: "auto" }, ts: 7 });
    expect(auto.id).toBe("f1");
    expect(auto.meta).toEqual(META);
    expect(auto.messages).toEqual(messages);
    expect(auto.entries.map((e) => e.type)).toEqual(["base", "message", "message", "message"]);
    expect(auto.entries[0]).toMatchObject({ type: "base", reason: "create", count: 3 });
    expect(auto.read.outcome).toBe("cold");
    const last = auto.entries.at(-1);
    expect(auto.read.head).toEqual({ seq: last?.seq ?? -1, id: last?.id ?? "" });

    const chosen = forkWrite({
      id: "f2",
      meta: META,
      messages,
      title: { source: "model", text: "T" },
      ts: 7,
    });
    expect(chosen.entries.map((e) => e.type)).toEqual([
      "base",
      "message",
      "message",
      "message",
      "title",
    ]);
    expect(chosen.entries.at(-1)).toMatchObject({ title: { text: "T", source: "model" } });
    // Minted once per call: two writes of the same chat have different incarnations.
    const again = forkWrite({ id: "f1", meta: META, messages, title: { source: "auto" }, ts: 7 });
    expect(again.entries[0]?.id).not.toBe(auto.entries[0]?.id);
  });
});
