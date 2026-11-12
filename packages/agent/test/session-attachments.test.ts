/**
 * Images at the session entry point (docs/feat/attachments-core.md, D5, T10).
 *
 * Two properties, both about what a REFUSAL and an IMAGE-ONLY prompt do:
 *  - a ref that cannot be sent throws BEFORE anything is pushed, so the history
 *    is exactly as it was and the model is never called (a half-written turn is
 *    the bug this prevents);
 *  - `send("", …, {attachments})` STARTS a turn — before this change an empty
 *    text was a continuation (`session.ts:144`), so an image-only prompt was
 *    silently a no-prompt.
 */
import { describe, expect, test } from "bun:test";
import type {
  AttachmentRef,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import {
  InvalidAttachmentError,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentEvent, Session } from "../src/index.ts";

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

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

function newSession(): { session: Session; model: ScriptedProvider } {
  const model = new ScriptedProvider();
  const session = new Session(new Agent({ model, tools: new ToolRegistry(), env: noopEnv }));
  return { session, model };
}

describe("an image-only prompt is a prompt, not a continuation", () => {
  test('send("", …, {attachments}) pushes the message and runs a model round', async () => {
    const { session, model } = newSession();
    const one = ref();
    await drain(session.send("", undefined, { attachments: [one] }));

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: "",
      attachments: [one],
    });
    expect(session.messages[0]).toEqual({ role: "user", content: "", attachments: [one] });
  });

  test("text plus refs keeps both, refs on the same message", async () => {
    const { session } = newSession();
    const one = ref();
    await drain(session.send("what is this?", undefined, { attachments: [one] }));
    expect(session.messages[0]).toEqual({
      role: "user",
      content: "what is this?",
      attachments: [one],
    });
  });

  test("a message WITHOUT refs has no `attachments` key at all (never `[]`)", async () => {
    const { session } = newSession();
    await drain(session.send("hi"));
    expect(session.messages[0]).not.toHaveProperty("attachments");
    expect(Object.keys(session.messages[0] ?? {})).toEqual(["role", "content"]);
  });

  test("an empty send with NO refs is still a continuation (unchanged)", async () => {
    const { session } = newSession();
    await drain(session.send(""));
    // The continuation turn still runs and stores its reply, but adds NO user
    // message — exactly what it did before image refs existed.
    expect(session.messages.some((m) => m.role === "user")).toBe(false);
    expect(session.messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  test("a skill with empty text is still refused, refs or not", async () => {
    const { session } = newSession();
    await expect(
      drain(session.send("", undefined, { skill: "anything", attachments: [ref()] })),
    ).rejects.toThrow();
    expect(session.messages).toHaveLength(0);
  });
});

describe("a ref that cannot be sent is refused before anything happens", () => {
  const cases: Record<string, AttachmentRef | AttachmentRef[]> = {
    "an oversize image": { ...ref(), size: MAX_IMAGE_BYTES + 1 },
    "a type no provider takes": { ...ref(), mimeType: "image/heic" },
    "the same image twice": [ref(), ref()],
    "a malformed id": { ...ref(), id: "not-a-sha" },
    "more than the cap": Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, k) => ({
      ...ref(),
      id: k.toString(16).padStart(64, "0"),
    })),
  };

  for (const [why, value] of Object.entries(cases)) {
    test(`${why}: InvalidAttachmentError, history unchanged, model never called`, async () => {
      const { session, model } = newSession();
      await drain(session.send("first"));
      const before = session.messages.length;
      const refs = Array.isArray(value) ? value : [value];
      await expect(drain(session.send("second", undefined, { attachments: refs }))).rejects.toThrow(
        InvalidAttachmentError,
      );
      expect(session.messages).toHaveLength(before);
      expect(model.requests).toHaveLength(1);
    });
  }

  test("the error message names the image and the limit", async () => {
    const { session } = newSession();
    const huge = { ...ref({ name: "big.png" }), size: MAX_IMAGE_BYTES + 1 };
    await expect(drain(session.send("", undefined, { attachments: [huge] }))).rejects.toThrow(
      /big\.png sha256:aaaaaaaaaaaa: 15 MB is over the 15 MB limit/,
    );
  });
});
