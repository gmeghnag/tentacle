/**
 * The image source rides EVERY request the loop builds (docs/feat/attachments-core.md,
 * D5, T11).
 *
 * There are three: the run's own request, the step-limit final request, and the
 * context count. One that lacks it inlines nothing, so the same history would
 * send an image on one round and a placeholder on the next — silently. This
 * proves all three carry the SAME source, and that a message keeps its refs
 * after the loop stamps a context line onto it (the stamp SPREADS, never rebuilds).
 */
import { describe, expect, test } from "bun:test";
import type {
  AttachmentRef,
  AttachmentSource,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentConfig } from "../src/agent.ts";
import { Session } from "../src/session.ts";

const env: ExecutionEnvironment = {
  id: "stub",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** Collects every request, and every request the COUNT path was given. */
class Spy implements ModelProvider {
  readonly id = "spy";
  readonly requests: ChatRequest[] = [];
  readonly counted: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request });
    for (const e of this.script[this.turn++] ?? [
      { type: "text", delta: "end" },
      { type: "done" },
    ]) {
      yield e;
    }
  }
  async countTokens(request: ChatRequest): Promise<number | undefined> {
    this.counted.push({ ...request });
    return 500;
  }
}

const src: AttachmentSource = { read: async () => null };
const ref: AttachmentRef = { id: "a".repeat(64), mimeType: "image/png", size: 10 };

function agentWith(model: ModelProvider, extra: Partial<AgentConfig> = {}): Agent {
  return new Agent({
    model,
    tools: new ToolRegistry(),
    env,
    systemPrompt: "sys",
    contextAwareness: { window: 1000, stepPercent: 1 },
    attachments: src,
    ...extra,
  });
}

async function send(
  session: Session,
  text: string,
  refs?: readonly AttachmentRef[],
): Promise<void> {
  for await (const _ of session.send(text, undefined, refs ? { attachments: refs } : {})) {
    // drain
  }
}

describe("every ChatRequest the loop builds carries the image source", () => {
  test("the run request and the context count", async () => {
    const model = new Spy([
      [
        { type: "text", delta: "ok" },
        { type: "done", usage: { promptTokens: 500, completionTokens: 1 } },
      ],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "look", [ref]);
    expect(model.requests[0]?.attachments).toBe(src);
    // The count is its own call (the daemon's badge asks for it), and it must
    // inline the same images: a count that ignored them would under-report.
    await session.contextUsage();
    expect(model.counted.length).toBe(1);
    expect(model.counted[0]?.attachments).toBe(src);
  });

  test("the step-limit final request", async () => {
    const model = new Spy([
      [{ type: "done", usage: { promptTokens: 500, completionTokens: 1 } }],
      [{ type: "text", delta: "report" }, { type: "done" }],
    ]);
    const session = new Session(agentWith(model, { maxIterations: 1 }), "s1");
    await send(session, "go", [ref]);
    // The final request is the one with no tools offered.
    const final = model.requests.find((r) => r.tools === undefined);
    expect(final).toBeDefined();
    expect(final?.attachments).toBe(src);
  });

  test("with NO source configured, no request gains the field (nothing changes for text-only)", async () => {
    const model = new Spy([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const session = new Session(agentWith(model, { attachments: undefined }), "s1");
    await send(session, "hi");
    expect(model.requests[0]).not.toHaveProperty("attachments");
    for (const counted of model.counted) {
      expect(counted).not.toHaveProperty("attachments");
    }
  });
});

describe("the stored message keeps its refs through the loop", () => {
  test("a context-usage stamp SPREADS the message, so the refs survive", async () => {
    const model = new Spy([
      [
        { type: "text", delta: "ok" },
        { type: "done", usage: { promptTokens: 900, completionTokens: 1 } },
      ],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "look", [ref]);
    const stored = session.messages.find((m) => m.role === "user");
    expect(stored?.attachments).toEqual([ref]);
    // The stamp happened (a context line rode on the user message), and it did
    // not rebuild that message field by field: the refs are still there.
    expect(stored?.contextUsage).toBeDefined();
    expect(stored?.attachments).toEqual([ref]);
  });
});
