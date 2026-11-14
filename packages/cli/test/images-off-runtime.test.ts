/**
 * The `createLocalRuntime` half of "images are off — here is why"
 * (docs/feat/images-off-reason.md, fix round 1 findings 1 and 2): the client
 * keeps the handshake facts and takes a display-only `modelName`/`modelScope`,
 * and THIS module is what decides what a real runtime passes. The reviewer's
 * mutation — drop the option at the call site — left every suite green.
 *
 * The load-bearing distinction is about where the advice points, not the
 * wording: a daemon running THIS laptop's model (the in-process worker) sends
 * the user to their own config; a daemon running its OWN model (a `serve` host,
 * a pod daemon without `--model-proxy`) must never do that — `tentacle config
 * set model.images true` on the laptop would change nothing there, which is the
 * defect class this task exists to remove.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { LogSessionStore } from "@tentacle/daemon";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

/** A fake daemon advertising NO image input (the reported case). */
async function runtimeWith(
  init: { readonly model?: string },
  deps: { readonly modelScope?: "laptop" | "daemon"; readonly modelName?: string } = {},
) {
  const [daemonCh, clientCh] = createChannelPair();
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method) => {
      if (method !== Method.Initialize) {
        return {};
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { tools: true, permissions: true },
        ...(init.model !== undefined ? { agentInfo: { version: "1.2.3", model: init.model } } : {}),
      };
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "images-off-rt-"));
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => peer.close(),
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(dir), () => {}),
    cwd: "/tmp/work",
    model: "laptop-model",
    resume: null,
    ...(deps.modelScope !== undefined ? { modelScope: deps.modelScope } : {}),
  });
  return { runtime, peer };
}

describe("createLocalRuntime: whose config an images-off reason names", () => {
  // The worker's own wiring (`startWorkerRuntime`) passes `modelScope: "laptop"`.
  // Mutation: drop it → this goes red (the reason would send a user whose config
  // IS the worker's to a daemon's config instead).
  test("a LAPTOP-scoped runtime names this laptop's model and points at your config", async () => {
    const { runtime, peer } = await runtimeWith({}, { modelScope: "laptop" });
    const mode = runtime.createSession().imageInput();
    expect(mode.kind).toBe("off");
    if (mode.kind === "off") {
      expect(mode.reason).toContain("laptop-model");
      expect(mode.reason).toContain("your config");
      // The whole sentence bound still holds through the plumbing.
      expect(mode.reason.length).toBeLessThanOrEqual(220);
    }
    peer.close();
  });

  // The default (a `serve` host, `connect`, and `run`/`attach`'s pod):
  // mutation: pass `modelScope: "laptop"` here → red, and that is exactly the
  // wrong advice finding 1 reported (a pod on its own model).
  test("the DEFAULT scope never names the laptop's model as the one to fix", async () => {
    const { runtime, peer } = await runtimeWith({});
    const mode = runtime.createSession().imageInput();
    expect(mode.kind).toBe("off");
    if (mode.kind === "off") {
      expect(mode.reason).not.toContain("laptop-model");
      expect(mode.reason).toContain("the daemon's config");
    }
    peer.close();
  });

  // Finding 2's other half: the handshake's OWN model reaches the reason through
  // the runtime (mutation: drop `daemonModel` in `remote-client.ts` → red).
  test("a daemon that reports its model is named through the runtime", async () => {
    const { runtime, peer } = await runtimeWith({ model: "serve-model" });
    const mode = runtime.createSession().imageInput();
    expect(mode.kind).toBe("off");
    if (mode.kind === "off") expect(mode.reason).toContain("serve-model");
    peer.close();
  });
});
