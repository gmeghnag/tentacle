import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import { VOICE_DEFAULTS, type VoiceConfig } from "../src/voice-session.ts";
import { openVoiceLog } from "../src/voice-spawn.ts";
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

/**
 * Voice ON, explicitly (feat/voice-off-by-default): the feature ships OFF, so
 * every test that actually dictates opts in here instead of relying on the
 * default. A test that wants the shipped default passes `VOICE_DEFAULTS`.
 */
const ON: VoiceConfig = { ...VOICE_DEFAULTS, enabled: true };

function renderApp(
  voice: ReturnType<typeof fakeHelper>,
  config: VoiceConfig = ON,
  extra: { voiceHost?: { platform: string; env: Record<string, string | undefined> } } = {},
) {
  const provider = new SilentProvider();
  const agent = new Agent({ model: provider, tools: new ToolRegistry(), env: noopEnv });
  const rendered = render(
    <App
      agent={agent}
      model="qwen3"
      cwd="/tmp/work"
      voice={config}
      voiceSpawner={voice.spawner}
      // The host the availability check reads, PINNED: without it this suite
      // fails over SSH and on Linux CI (Review round 1, MEDIUM 6).
      voiceHost={extra.voiceHost ?? { platform: "darwin", env: {} }}
    />,
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

  test("the transcript APPENDS: text already in the field is never repeated", async () => {
    // Review round 1, HIGH 1 (dup.ts): field `hello`, dictation `world` →
    // `hellohello world`, because `field.insert` got the WHOLE joined field back.
    // Mutation: `insert: (t) => field.insert(joinDictation(field.value, t))` → red.
    const helper = fakeHelper();
    const { stdin, frames, unmount } = renderApp(helper);
    await delay(40);
    stdin.write("hello");
    await delay(60);
    stdin.write("\u0012");
    await delay(80);
    helper.say({ t: "listening", id: 1, device: "fake" });
    await delay(60);
    helper.say({ t: "final", id: 1, text: "world" });
    await delay(120);
    const last = frames.at(-1) ?? "";
    expect(last).toContain("hello world");
    expect(last).not.toContain("hellohello");
    unmount();
  });

  test("over SSH no helper is spawned and the notice says why (the host is read, not assumed)", async () => {
    // Review round 1, MEDIUM 6: T7 used to depend on the RUNNER's env.
    const helper = fakeHelper();
    const { stdin, frames, unmount } = renderApp(helper, ON, {
      voiceHost: { platform: "darwin", env: { SSH_TTY: "/dev/ttys001" } },
    });
    await delay(40);
    stdin.write("\u0012");
    await delay(80);
    expect(helper.specs).toEqual([]);
    expect(frames.join("\n")).toContain("off over SSH");
    unmount();
  });

  test("`voice.enabled: false` really disables the mic (the config reaches the hook)", async () => {
    const helper = fakeHelper();
    const { stdin, frames, unmount } = renderApp(helper, {
      ...VOICE_DEFAULTS,
      enabled: false,
    });
    await delay(40);
    stdin.write("\u0012");
    await delay(80);
    expect(helper.specs).toEqual([]);
    expect(frames.join("\n")).toContain("off — set");
    unmount();
  });

  test("with NO config, Ctrl+R is a notice that says how to turn voice on — no spawn", async () => {
    // feat/voice-off-by-default, end to end through the App: the shipped default
    // is what a user gets with no `voice` block at all. Mutation: `enabled: true`
    // in VOICE_DEFAULTS, or dropping `enabled` from the hook's availability → red
    // (the helper is spawned, i.e. the mic opens without being asked for).
    const helper = fakeHelper();
    const { stdin, frames, unmount } = renderApp(helper, VOICE_DEFAULTS);
    await delay(40);
    stdin.write("\u0012");
    await delay(80);
    expect(helper.specs).toEqual([]);
    const all = frames.join("\n");
    expect(all).toContain('set "voice": { "enabled": true }');
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

/**
 * Fix round 2 (NEW-2): a spawn that cannot start used to be a bare notice, so the
 * reducer was never told — the strip sat on `● starting` for ever, with no child
 * and no mic, and the message blamed a missing binary even when the real failure
 * was an unopenable log file. It now goes through the reducer (`spawnFailed`).
 */
describe("Fix round 2 (NEW-2): a spawn that fails leaves the TUI idle, with the real reason", () => {
  test("the strip does not stay on `starting` and the notice names the cause", async () => {
    const agent = new Agent({
      model: new SilentProvider(),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const dir = `${tmpdir()}/tentacle-voice-new2-${String(Date.now())}`;
    mkdirSync(dir, { recursive: true });
    try {
      const { stdin, frames, unmount } = render(
        <App
          agent={agent}
          model="qwen3"
          cwd="/tmp/work"
          voice={{ ...ON, helperPath: `${dir}/nope/tentacle-voice` }}
          voiceConfigDir={dir}
          // The spawner fails the way a real one does when the log cannot be
          // opened: `spawnVoiceHelper` propagates it.
          voiceSpawner={() => {
            throw new Error("ENOENT: no such file or directory, open '.../voice/helper.log'");
          }}
          voiceHost={{ platform: "darwin", env: {} }}
        />,
      );
      await delay(40);
      stdin.write("\u0012");
      await delay(120);
      const last = frames.at(-1) ?? "";
      // Mutation: `options.notice(...)` beside the catch (no `spawnFailed` event)
      // → the strip is still `● starting` and this fails.
      expect(last).not.toContain("starting");
      expect(frames.join("\n")).toContain("could not start");
      // The cause is the spawn's, not a canned "not found".
      expect(frames.join("\n")).toContain("ENOENT");
      unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real spawner creates `<configDir>/voice/` before opening the log", async () => {
    // The other half of NEW-2: `openSync` on a missing directory was the whole
    // failure. Mutation: drop the `mkdir` in `realLogFs` → this throws.
    const dir = `${tmpdir()}/tentacle-voice-log-${String(Date.now())}`;
    mkdirSync(dir, { recursive: true });
    try {
      const fd = openVoiceLog(`${dir}/voice/helper.log`);
      expect(typeof fd).toBe("number");
      if (fd !== null) closeSync(fd);
      expect(existsSync(`${dir}/voice/helper.log`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fix round 1 (MEDIUM 8): the spawn used `candidates[0]` blindly, so the
 * `<configDir>/voice/bin` fallback was never reached, and `voice.input` /
 * `voice.voiceProcessing` were hardcoded in the helper, so both settings were
 * dead. Driven through the App so the REAL argument list is what is asserted.
 */
describe("Fix 8 (MEDIUM 8): the helper is spawned from a path that exists, with the settings as flags", () => {
  test("a helper that only exists in <configDir>/voice/bin is the one spawned", async () => {
    const helper = fakeHelper();
    const provider = new SilentProvider();
    const agent = new Agent({ model: provider, tools: new ToolRegistry(), env: noopEnv });
    const dir = `${tmpdir()}/tentacle-voice-fix1-${String(Date.now())}`;
    const bin = `${dir}/voice/bin`;
    mkdirSync(bin, { recursive: true });
    const path = `${bin}/tentacle-voice`;
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    try {
      const { stdin, unmount } = render(
        <App
          agent={agent}
          model="qwen3"
          cwd="/tmp/work"
          voice={{ ...ON, input: "builtin", voiceProcessing: false }}
          voiceSpawner={helper.spawner}
          voiceConfigDir={dir}
          voiceHost={{ platform: "darwin", env: {} }}
        />,
      );
      await delay(40);
      stdin.write("\u0012");
      await delay(80);
      expect(helper.specs).toHaveLength(1);
      // Mutation: `candidates[0]` → the sibling path, which does not exist.
      expect(helper.specs[0]?.cmd[0]).toBe(path);
      // Mutation: drop the arg building → both settings are dead again.
      expect(helper.specs[0]?.cmd).toContain("--input");
      expect(helper.specs[0]?.cmd).toContain("builtin");
      expect(helper.specs[0]?.cmd).toContain("--no-voice-processing");
      // The log lands under the config dir, not at `/voice/helper.log`.
      expect(helper.specs[0]?.logPath).toBe(`${dir}/voice/helper.log`);
      unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fix round 1 (MEDIUM 9). `childRef` was nulled on EVERY exit, so a killed
 * child's late exit nulled the NEW child's ref: that child then held the mic,
 * untracked, until the TUI exited (nothing ended it).
 */
describe("Fix 9 (MEDIUM 9): a killed child's late exit never orphans its successor", () => {
  test("unmount still ends the SECOND child after the first one's exit lands", async () => {
    const specs: VoiceSpawnSpec[] = [];
    const ended: number[] = [];
    // One line sink per child, bound when its stream is created.
    const sinks: ((line: string) => void)[] = [];
    const resolveExit: (() => void)[] = [];
    const spawner = (spec: VoiceSpawnSpec): VoiceChild => {
      specs.push(spec);
      const index = specs.length - 1;
      return {
        stdin: {
          write: () => {},
          // A real child's exit is OBSERVED later (the 500 ms grace, then
          // SIGTERM): the test resolves it by hand, at the moment the race the
          // review describes actually happens.
          end: () => {
            ended.push(index + 1);
          },
        },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            sinks[index] = (line: string) => controller.enqueue(new TextEncoder().encode(line));
          },
        }),
        stderr: null,
        exited: new Promise<number>((resolve) => {
          resolveExit[index] = () => resolve(0);
        }),
        kill: () => {
          ended.push(index + 1);
        },
      };
    };
    const agent = new Agent({
      model: new SilentProvider(),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const { stdin, unmount } = render(
      <App
        agent={agent}
        model="qwen3"
        cwd="/tmp/work"
        voice={ON}
        voiceSpawner={spawner}
        voiceHost={{ platform: "darwin", env: {} }}
      />,
    );
    await delay(40);
    // Dictation 1, then a protocol error kills it (the `kill` command).
    stdin.write("\u0012");
    await delay(60);
    sinks[0]?.('{"not":"a message"}\n');
    await delay(80);
    // The next dictation spawns child 2 while child 1's exit is still pending.
    stdin.write("\u0012");
    await delay(60);
    expect(specs).toHaveLength(2);
    // NOW child 1's exit lands: with an unconditional `childRef.current = null`
    // it clears child 2's ref, and child 2 is never ended again.
    resolveExit[0]?.();
    await delay(60);
    // Now unmount: child 2 must be ended. Mutation: unconditional
    // `childRef.current = null` on exit → child 2 is untracked and never ended.
    unmount();
    await delay(150);
    expect(ended).toContain(2);
  });
});
