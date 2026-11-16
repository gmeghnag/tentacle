/**
 * The worker's `daemonWakes` trust bit (docs/feat/cron-tool.md D1, slice S4).
 * The worker now fires the session's scheduled wakes as daemon-minted `wake-`
 * turns; it is THIS laptop's own code, so its TUI's auto-accept must treat them
 * as the session's own (`autoAcceptsTurn`, docs/fix/autoaccept-wake-turns.md A4).
 * Two links make that true, and each is pinned here:
 *   1. the worker call site passes `daemonWakes` (`WORKER_TRUST`), and
 *   2. `createLocalRuntime` forwards it, and the TUI-facing controller answers
 *      `autoAcceptsTurn` from the session (before S4 it exposed `ownsTurn` only,
 *      so the TUI fell back to it and a wake stayed foreign).
 * Without the bit — every pod `run`/`attach` and the relay — a `wake-` id stays
 * foreign: a pod can never dress a turn up as the session's own (AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { WORKER_TRUST, createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

async function runtimeWith(daemonWakes: boolean | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "worker-daemon-wakes-"));
  const host = new SessionHost({
    defaultCwd: dir,
    createAgent: () => ({
      agent: new Agent({
        model: new Quiet(),
        tools: new ToolRegistry(),
        env: {
          id: "noop",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
      }),
      permissions: new PermissionBroker(),
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const saver = new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {});
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver,
    cwd: dir,
    model: "m",
    resume: null,
    ...(daemonWakes === undefined ? {} : { daemonWakes }),
  });
  const controller = runtime.createSession();
  for await (const _ of controller.send("hi", undefined, { turnId: "own-turn" })) {
    // drain
  }
  return {
    controller,
    close: async () => {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("cron-tool D1: the worker's fired wakes are the session's own", () => {
  test("the worker call site's trust bits include daemonWakes (and still sharedAutoAccept)", () => {
    // Mutation: drop `daemonWakes` from WORKER_TRUST → red.
    expect(WORKER_TRUST).toEqual({ sharedAutoAccept: true, daemonWakes: true });
  });

  test("with daemonWakes: the controller auto-accepts a `wake-` turn and its own; not a foreign id", async () => {
    // Mutation: drop the forward in `createLocalRuntime`, or the controller's
    // `autoAcceptsTurn` → red.
    const r = await runtimeWith(true);
    try {
      expect(r.controller.autoAcceptsTurn("wake-7a202134-1ef8-48e0-8271-18fb79bdafd8")).toBe(true);
      expect(r.controller.autoAcceptsTurn("own-turn")).toBe(true);
      expect(r.controller.autoAcceptsTurn("c3eed5d4-0f20-48bd-89d0-cfb09522fddd")).toBe(false);
      // A wake stays FOREIGN for quit/cancel semantics.
      expect(r.controller.ownsTurn("wake-7a202134")).toBe(false);
    } finally {
      await r.close();
    }
  });

  test("without it (pods, the relay): a `wake-` turn is foreign; own turns still accepted", async () => {
    for (const bit of [undefined, false]) {
      const r = await runtimeWith(bit);
      try {
        expect(r.controller.autoAcceptsTurn("wake-7a202134")).toBe(false);
        expect(r.controller.autoAcceptsTurn("own-turn")).toBe(true);
      } finally {
        await r.close();
      }
    }
  });
});
