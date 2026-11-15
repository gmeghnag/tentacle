import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import { VOICE_DEFAULTS, type VoiceConfig } from "../src/voice-session.ts";
import type { VoiceChild, VoiceSpawnSpec } from "../src/voice-spawn.ts";

/** A provider that never answers: a dictation must not start a turn. */
class SilentProvider implements ModelProvider {
  readonly id = "silent";
  turns = 0;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    this.turns++;
    yield { type: "done" };
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

/**
 * T7 — the whole dictation path through the App, with a FAKE helper
 * (docs/feat/voice-dictation.md T7): no child process, no microphone.
 *
 * This is the end-to-end proof of the promises that only exist at App level:
 *  - Ctrl+R starts a dictation and the helper receives `start`;
 *  - the transcript lands IN THE FIELD and the strip clears;
 *  - nothing is sent (the turn does not start);
 *  - unmount ends the child (F13: no orphan holding the mic).
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake helper: records what the App sent, and replies on demand. */
function fakeHelper() {
  const sent: unknown[] = [];
  let push: (line: string) => void = () => {};
  let markEnded: () => void = () => {};
  let ended = false;
  const specs: VoiceSpawnSpec[] = [];
  const child: VoiceChild = {
    stdin: {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.split("\n")) {
          if (line.trim() !== "") sent.push(JSON.parse(line));
        }
      },
      end: () => {
        ended = true;
        markEnded();
      },
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line: string) => controller.enqueue(new TextEncoder().encode(line));
      },
    }),
    stderr: null,
    exited: new Promise<number>((resolve) => {
      markEnded = () => resolve(0);
    }),
    kill: () => {
      ended = true;
      markEnded();
    },
  };
  const spawner = (spec: VoiceSpawnSpec): VoiceChild => {
    specs.push(spec);
    // The handshake is the first thing a real helper says.
    queueMicrotask(() =>
      push(`${JSON.stringify({ t: "ready", v: 1, engine: "apple", device: "fake" })}\n`),
    );
    return child;
  };
  return {
    sent,
    spawner,
    specs,
    say: (msg: unknown) => push(`${JSON.stringify(msg)}\n`),
    wasEnded: () => ended,
  };
}

function renderApp(voice: ReturnType<typeof fakeHelper>, config: VoiceConfig = VOICE_DEFAULTS) {
  const provider = new SilentProvider();
  const agent = new Agent({ model: provider, tools: new ToolRegistry(), env: noopEnv });
  const rendered = render(
    <App agent={agent} model="qwen3" cwd="/tmp/work" voice={config} voiceSpawner={voice.spawner} />,
  );
  return { ...rendered, provider };
}

describe("T7: Ctrl+R dictates, and the transcript lands in the field", () => {
  test("Ctrl+R sends `start`; `final` puts the text in the field and clears the strip", async () => {
    const helper = fakeHelper();
    const { stdin, frames, unmount } = renderApp(helper);
    await delay(40);

    stdin.write("r"); // Ink reports a Ctrl chord as the letter + key.ctrl
    await delay(60);
    // Ink strips the ctrl modifier into `key.ctrl`, so drive the layer the way a
    // real terminal does: send the control character and let Ink decode it.
    stdin.write("\u0012");
    await delay(80);

    expect(helper.sent).toContainEqual({ t: "start", id: 1, lang: "auto" });
    // `starting` until the helper says the engine is running.
    helper.say({ t: "listening", id: 1, device: "fake" });
    await delay(60);
    expect(frames.at(-1) ?? "").toContain("listening");
    helper.say({ t: "final", id: 1, text: "ciao dal microfono" });
    await delay(80);

    const all = frames.join("\n");
    expect(all).toContain("ciao dal microfono");
    // The strip is gone: idle again.
    expect(frames.at(-1) ?? "").not.toContain("listening");
    unmount();
  });

  test("nothing is sent: the turn never starts from a dictation", async () => {
    const helper = fakeHelper();
    const { stdin, provider, unmount } = renderApp(helper);
    await delay(40);
    stdin.write("\u0012");
    await delay(60);
    helper.say({ t: "listening", id: 1, device: "fake" });
    await delay(40);
    stdin.write("\r"); // Enter while listening = finish, never send
    await delay(60);
    helper.say({ t: "final", id: 1, text: "just text" });
    await delay(80);
    expect(provider.turns).toBe(0);
    unmount();
  });

  test("unmount ends the helper (F13: no orphan holds the mic)", async () => {
    const helper = fakeHelper();
    const { stdin, unmount } = renderApp(helper);
    await delay(40);
    stdin.write("\u0012");
    await delay(80);
    expect(helper.specs.length).toBe(1);
    // The child counts its own ending: unmount must have asked it to stop.
    unmount();
    await delay(120);
    expect(helper.wasEnded()).toBe(true);
  });
});
