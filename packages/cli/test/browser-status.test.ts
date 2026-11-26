/**
 * docs/feat/browser-inspect.md B5b: the laptop hosts' browser port
 * (`browser/status` + group titles), that a pod path gets none, and that the
 * AUTO answer of a browser action travels the worker's ONE session broker.
 * Each test names the mutation that turns it red (AGENTS §9).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubOp } from "@tentacle/browser";
import type { ModelProvider, StreamEvent } from "@tentacle/core";
import type { Attachment, BrowserHostPort } from "@tentacle/daemon";
import type { KnownSessionUpdateParams, SessionUpdate } from "@tentacle/protocol";
import { browserToolsetOf } from "../src/browser-link.ts";
import { type BrowserLinkProbes, createBrowserHostPort } from "../src/browser-status.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { podSessionHost } from "../src/serve.ts";
import { workerSessionHost } from "../src/worker.ts";

let dir: string;
let config: TentacleConfig;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "browser-status-"));
  config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const e of this.script[this.turn++] ?? [{ type: "text", delta: "ok" }]) yield e;
    yield { type: "done" };
  }
}

function client() {
  const frames: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => frames.push(u) };
  const of = <T extends SessionUpdate["type"]>(type: T) =>
    frames
      .map((u) => u.update)
      .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
  return { attachment, of };
}

function probes(over: Partial<BrowserLinkProbes> = {}, calls: string[] = []): BrowserLinkProbes {
  return {
    manifestOk: () => {
      calls.push("manifest");
      return true;
    },
    hubAnswers: async () => {
      calls.push("hub");
      return false;
    },
    chromeRunning: async () => {
      calls.push("chrome");
      return false;
    },
    managed: () => false,
    ...over,
  };
}

const noTabs = { status: async () => ({ tabs: [] }), retitle: () => {} };

describe("the host port", () => {
  test("a connected link is `connected` with no probe of the hub, the manifest or Chrome", async () => {
    // Mutation: probe before reading the link → the probes run.
    const calls: string[] = [];
    const port = createBrowserHostPort({
      link: { status: () => ({ state: "connected" }) },
      toolset: noTabs,
      probes: probes({}, calls),
    });
    expect(await port.status("s")).toEqual({
      available: true,
      link: { state: "connected", managed: false },
      tabs: [],
    });
    expect(calls).toEqual([]);
  });

  test.each([
    [{ hubAnswers: async () => true }, "connected"],
    [{ manifestOk: () => false }, "not_installed"],
    [{ chromeRunning: async () => true }, "extension_missing"],
    [{}, "not_running"],
  ] as const)("idle link + probes %# → %s", async (over, want) => {
    const port = createBrowserHostPort({
      link: { status: () => ({ state: "idle" }) },
      toolset: noTabs,
      probes: probes(over),
    });
    expect((await port.status("s")).link?.state).toBe(want);
  });

  test("a probe or the toolset throwing is no throw; heldElsewhere and managed are carried", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const port = createBrowserHostPort({
      link: { status: () => ({ state: "idle" }) },
      toolset: { status: async () => ({ tabs: [], heldElsewhere: true }), retitle: boom },
      probes: probes({ manifestOk: boom, hubAnswers: async () => boom(), managed: () => true }),
    });
    expect(await port.status("s")).toEqual({
      available: true,
      link: { state: "not_installed", managed: true },
      heldElsewhere: true,
      tabs: [],
    });
    expect(() => port.retitle("s", "t")).not.toThrow();
    const broken = createBrowserHostPort({
      link: { status: () => ({ state: "connected" }) },
      toolset: { status: async () => boom(), retitle: () => {} },
      probes: probes(),
    });
    expect((await broken.status("s")).tabs).toEqual([]);
  });
});

describe("where the port is", () => {
  test("a pod daemon's host has none: no `browser` on the wire, status unavailable, the op refused", async () => {
    // Mutation: pass a port in `podSessionHost` → `browser` appears for a pod.
    const host = podSessionHost(config, undefined, { createProvider: () => new Scripted([]) });
    const { hosted } = host.open({ create: true }, client().attachment);
    expect(hosted.capabilities().browser).toBeUndefined();
    expect(await hosted.browserStatus()).toEqual({ available: false, tabs: [] });
    expect(() => hosted.setCapability({ kind: "browser", name: "auto", enabled: true })).toThrow(
      /no browser/,
    );
  });

  test("single broker: the worker's auto answer reaches the click through the SESSION's broker", async () => {
    // Mutation: give the browser tools an `ask` other than `wired.permissions.request`
    // (or none) → no permission_request/resolved pair, no click.
    const ops: string[] = [];
    const set = browserToolsetOf(
      {
        call: async (op: HubOp) => {
          ops.push(op.op === "click" && op.probe === true ? "probe" : op.op);
          if (op.op === "click") return { facts: { tag: "button", name: "Send", submits: true } };
          return {};
        },
      },
      undefined,
    );
    const port: BrowserHostPort = createBrowserHostPort({
      link: { status: () => ({ state: "connected" }) },
      toolset: set,
      probes: probes(),
    });
    const click: StreamEvent = {
      type: "tool_call",
      toolCall: {
        id: "c1",
        name: "browser_click",
        arguments: JSON.stringify({ tab: 1, ref: "e1" }),
      },
    };
    const host = workerSessionHost(config, {
      version: "test",
      createProvider: () => new Scripted([[click]]),
      browser: set,
      browserPort: port,
    });
    const c = client();
    const { hosted } = host.open({ create: true }, c.attachment);
    expect(host.answersAutoAccept).toBe(false);
    hosted.setCapability({ kind: "tool", name: "browser", enabled: true });
    hosted.setCapability({ kind: "browser", name: "auto", enabled: true });
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => !hosted.running);
    expect(ops.filter((o) => o === "click")).toEqual(["click"]);
    const asked = c.of("permission_request");
    expect(asked.map((a) => a.tool)).toEqual(["browser_action"]);
    expect(c.of("permission_resolved")).toEqual([
      {
        type: "permission_resolved",
        requestId: asked[0]?.requestId ?? "",
        outcome: { outcome: "selected", optionId: "allow_once" },
      },
    ]);
  });
});
