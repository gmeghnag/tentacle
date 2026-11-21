/**
 * The date stamp in the agent loop (docs/fix/prompt-current-date.md): the model
 * reads `[Fri 2026-11-20 13:42 CET]` FIRST on the user message that carries it,
 * while the stored `content` stays clean — and the bytes never change after the
 * first request (the provider's prompt cache).
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { renderForModel } from "../src/context-awareness.ts";
import { Session } from "../src/session.ts";

const STAMP = { at: Date.UTC(2026, 10, 20, 12, 42), zone: "Europe/Rome" };
const LINE = "[Fri 2026-11-20 13:42 CET]";

class Capturing implements ModelProvider {
  readonly id = "capture";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

function sessionWith(stamp?: { at: number; zone: string }): {
  session: Session;
  model: Capturing;
} {
  const model = new Capturing();
  const agent = new Agent({
    model,
    tools: new ToolRegistry(),
    env,
    systemPrompt: "sys",
  });
  return { session: new Session(agent, "s"), model };
}

async function send(session: Session, text: string, stamp?: typeof STAMP): Promise<void> {
  for await (const _ of session.send(text, undefined, stamp ? { stamp } : {})) {
    // drain
  }
}

/** The last user message the model was sent, per request. */
const users = (request: ChatRequest): string[] =>
  request.messages.filter((m) => m.role === "user").map((m) => m.content);

describe("renderForModel: the stamp is the model's, not the history's", () => {
  test("the stamp is PREPENDED, on its own line, and the field is dropped", () => {
    const m: ChatMessage = { role: "user", content: "ciao", dateStamp: STAMP };
    const rendered = renderForModel(m);
    expect(rendered.content).toBe(`${LINE}\nciao`);
    expect(rendered.dateStamp).toBeUndefined();
    // The stored message is untouched.
    expect(m.content).toBe("ciao");
  });

  test("a message with no stamp renders EXACTLY as before (byte for byte)", () => {
    const m: ChatMessage = { role: "user", content: "ciao" };
    // Mutation: prepend unconditionally → the identity breaks.
    expect(renderForModel(m)).toBe(m);
  });

  test("with a context line the stamp comes first and the context line still last", () => {
    const m: ChatMessage = {
      role: "user",
      content: "ciao",
      dateStamp: STAMP,
      contextUsage: { used: 1000, window: 2000 },
    };
    const content = renderForModel(m).content;
    expect(content.startsWith(`${LINE}\n`)).toBe(true);
    expect(content).toBe(`${LINE}\nciao\n\n[context: 1k / 2k tokens (50%)]`);
  });

  test("the same message renders IDENTICAL bytes on every request (the prompt cache)", () => {
    const m: ChatMessage = { role: "user", content: "ciao", dateStamp: STAMP };
    expect(renderForModel(m).content).toBe(renderForModel(m).content);
  });
});

describe("Session.send: the stamp reaches the model and not the transcript", () => {
  test("a stamped turn: the model reads the line, `content` stays clean", async () => {
    const { session, model } = sessionWith();
    await send(session, "che giorno è?", STAMP);
    const request = model.requests[0];
    if (!request) throw new Error("no request");
    // Mutation: put the prefix in `content` itself → this stays "[…]\n…" for the
    // transcript too, which the next assertion catches.
    expect(users(request)).toEqual([`${LINE}\nche giorno è?`]);
    const stored = session.messages.filter((m) => m.role === "user");
    expect(stored.map((m) => m.content)).toEqual(["che giorno è?"]);
    expect(stored[0]?.dateStamp).toEqual(STAMP);
  });

  test("an unstamped turn carries no line", async () => {
    const { session, model } = sessionWith();
    await send(session, "ciao");
    const request = model.requests[0];
    if (!request) throw new Error("no request");
    expect(users(request)).toEqual(["ciao"]);
    expect(session.messages.filter((m) => m.role === "user")[0]?.dateStamp).toBeUndefined();
  });

  test("a continuation turn (empty text) pushes nothing, so nothing is stamped", async () => {
    const { session, model } = sessionWith();
    await send(session, "ciao", STAMP);
    await send(session, "", STAMP);
    // The second request re-sends the SAME history: one user message, one stamp.
    const second = model.requests[1];
    if (!second) throw new Error("no second request");
    expect(second.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      `${LINE}\nciao`,
    ]);
  });

  test("an earlier message's stamp is re-sent with the SAME bytes on a later turn", async () => {
    const { session, model } = sessionWith();
    await send(session, "uno", STAMP);
    await send(session, "due");
    const later = model.requests[1];
    if (!later) throw new Error("no later request");
    // Mutation: re-render at request time with `Date.now()` → the bytes drift.
    expect(users(later)[0]).toBe(`${LINE}\nuno`);
    expect(users(later).at(-1)).toBe("due");
  });
});
