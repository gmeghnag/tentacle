/**
 * C3, T7·tunnel (docs/feat/voice-conversation.md §4): a voice turn's
 * `reasoning:"off"` survives BOTH hops of the pod reverse-tunnel.
 *
 * `run`/`attach` run the agent loop in the pod but the model call itself comes
 * back to the laptop, so the daemon's `ChatRequest.reasoning` must be mapped
 * onto `WireChatRequest.reasoning` by `ProxyModelProvider` — and the laptop must
 * hand it to its local provider. `WireChatRequestSchema` is a STRIP schema, so a
 * field `toWireRequest` does not copy is simply gone by the time the laptop
 * parses the frame (the same failure the stop reason once had,
 * docs/fix/truncated-reply-silent.md).
 *
 * Mutations that must turn these red: drop `reasoning` in `toWireRequest` → the
 * daemon half red; drop it in `laptopRequest` (or the `stream()` spread) → the
 * laptop half red.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import type { ChatRequest } from "@tentacle/core";
import type { ModelStreamChunkedResult, WireChatRequest } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { ProxyModelProvider } from "../src/proxy-model.ts";

const emptyEnv = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

describe("T7 a voice turn's reasoning crosses the tunnel", () => {
  test("the pod maps ChatRequest.reasoning onto the wire request", async () => {
    const sent: WireChatRequest[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("batch path must not be used")),
      async (request) => {
        sent.push(request);
        return { chunks: 0 } satisfies ModelStreamChunkedResult;
      },
    );
    for await (const _ of provider.stream({
      messages: [{ role: "user", content: "ciao" }],
      reasoning: "off",
    })) {
      // drain
    }
    expect(sent[0]?.reasoning).toBe("off");
  });

  test("an ordinary turn sends no reasoning field at all", async () => {
    const sent: WireChatRequest[] = [];
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("batch path must not be used")),
      async (request) => {
        sent.push(request);
        return { chunks: 0 };
      },
    );
    for await (const _ of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    expect("reasoning" in (sent[0] ?? {})).toBe(false);
  });

  test("the pod's loop is what sets it: a voice turn's rounds carry it, a typed turn does not", async () => {
    // End-to-end inside the pod side: the Agent builds the request, the tunnel
    // maps it. This is the pair that proves §4 (a) reaches the LAPTOP's provider.
    const sent: WireChatRequest[] = [];
    const agent = new Agent({
      model: new ProxyModelProvider(
        () => Promise.reject(new Error("batch path must not be used")),
        async (request) => {
          sent.push(request);
          return { chunks: 0 };
        },
      ),
      tools: new ToolRegistry(),
      env: emptyEnv,
    });
    const session = new Session(agent, "s1");
    for await (const _ of session.send("ciao", undefined, { voice: { reasoning: "off" } })) {
      // drain
    }
    expect(sent[0]?.reasoning).toBe("off");
    expect(
      sent[0]?.messages.some((m) => m.role === "system" && m.content.includes("listening")),
    ).toBe(true);

    sent.length = 0;
    for await (const _ of session.send("typed")) {
      // drain
    }
    expect(sent[0]?.reasoning).toBeUndefined();
  });
});
