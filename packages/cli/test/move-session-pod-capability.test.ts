/**
 * `move_session` on a POD daemon (docs/feat/session-hop.md D8/D9, H5 review
 * finding 1): the tool is offered per SESSION, to a client that can actually put
 * the proposal to its owner — never to every session of a pod daemon.
 *
 * The failure this pins is silent and lies to the model: `podSessionHost` serves
 * `run`, `attach` and a HOP target alike, but D8 gives a `run`/`attach` TUI no
 * `hop` feed. Registered for every session (the bug), the model calls
 * `move_session`, gets "Proposed; the user will be asked when this turn ends",
 * and nobody is ever asked.
 *
 * Driven through the REAL stack — `podSessionHost` → `Connection` → `RemoteClient`
 * → a turn — because the property is "what the model is OFFERED", i.e. the tool
 * list on the request the provider receives. A client that declares the
 * capability (as a hop target's spawn does) is the only one that gets it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, type SessionHost } from "@tentacle/daemon";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { podSessionHost } from "../src/serve.ts";

let dir: string;
let config: TentacleConfig;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hop-pod-capability-"));
  config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    // OD8 (fix round 1): the tool is OFF by default, so this rig OPT IN — the
    // two rows below are about the CLIENT CAPABILITY, not the setting, and with
    // the setting off both would pass for the wrong reason (non-vacuity).
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k", TENTACLE_SESSION_HOP_TOOL: "true" },
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A provider that records every request: the tool list is on it. */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One session on a REAL pod daemon host, its first turn run, and the tool names
 * the provider was handed. `hop` is the capability the CLIENT declares.
 */
async function offeredTools(hop: boolean): Promise<string[]> {
  const model = new Recorder();
  // The non-proxy pod branch: it runs its own model, so an injected recorder is
  // the provider a turn really reaches (the `image-hosts.test.ts` rig).
  const host: SessionHost = podSessionHost(config, undefined, { createProvider: () => model });
  const [daemonSide, clientSide]: [DuplexChannel, DuplexChannel] = createChannelPair();
  new Connection(daemonSide, host);
  const client = new RemoteClient(clientSide, new PermissionBroker(), undefined, {
    ...(hop ? { hop: true as const } : {}),
  });
  await client.initialize();
  await client.openSession(dir, undefined, "S");
  await client.prompt("S", "t1", "hello");
  const deadline = Date.now() + 3000;
  while (model.requests.length === 0 && Date.now() < deadline) {
    await tick();
  }
  const seen = model.requests[0];
  if (seen === undefined) {
    throw new Error("the provider was never called");
  }
  return (seen.tools ?? []).map((tool) => tool.name);
}

describe("H5 review 1: a pod session is offered `move_session` only where a hop can be asked", () => {
  test("a client that declares NO hop capability (`run`/`attach`) is never offered it", async () => {
    // Mutation: `moveSession: true` unconditionally in `podSessionHost` (the
    // pre-fix shape) → this row fails: the model is told to propose a move for a
    // TUI that has no prompt to raise it.
    const names = await offeredTools(false);
    expect(names).not.toContain("move_session");
    // Non-vacuity: the registry really is populated (other tools are offered).
    expect(names.length).toBeGreaterThan(0);
    // …and the SETTING is on in this rig (OD8), so the absence above is the
    // capability's doing, not the default's.
    expect(config.sessionHop.tool).toBe(true);
  });

  test("a hop-capable client (a hop target's own spawn) IS offered it", async () => {
    const names = await offeredTools(true);
    expect(names).toContain("move_session");
  });
});
