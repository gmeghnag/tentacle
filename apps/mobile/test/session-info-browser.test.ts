/**
 * `browser/status` on the phone (docs/feat/browser-inspect.md B6b): when the
 * Session info controller reads it, what a failed or late answer does, and the
 * screen controller's risk strip and "a browser tool finished" re-read.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { BrowserStatusResult, SessionCapabilitiesWire } from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { createSessionController } from "../src/session-controller.ts";
import {
  type InfoCapabilities,
  type InfoPort,
  type InfoSession,
  createSessionInfo,
} from "../src/session-info-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const wire = (
  over: { actions?: "ask" | "auto"; secrets?: "masked" | "clear" } = {},
): SessionCapabilitiesWire => ({
  disabledMcp: [],
  disabledSkills: [],
  disabledTools: [],
  browser: { enabled: true, actions: over.actions ?? "ask", secrets: over.secrets ?? "masked" },
});

const answer = (n: number): BrowserStatusResult => ({
  available: true,
  link: { state: "connected", managed: false },
  tabs: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `t${i + 1}`,
    where: "x.com",
    handedOver: false,
    traced: false,
  })),
});

/** The handle's switches: a flip happens only when a test says the daemon echoed. */
function fakeCaps(initial: SessionCapabilitiesWire | undefined) {
  let state = initial;
  const listeners = new Set<(s: SessionCapabilitiesWire | undefined, by?: string) => void>();
  const sets: [string, string, boolean][] = [];
  let refusal: Error | null = null;
  const caps: InfoCapabilities = {
    current: () => state,
    set: (kind, name, enabled) => {
      sets.push([kind, name, enabled]);
      return refusal === null ? Promise.resolve() : Promise.reject(refusal);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    caps,
    sets,
    refuse: (error: Error) => {
      refusal = error;
    },
    echo: (next: SessionCapabilitiesWire | undefined, by = "Mac") => {
      state = next;
      for (const listener of [...listeners]) {
        listener(next, by);
      }
    },
    watchers: () => listeners.size,
  };
}

function harness(options: { state?: SessionCapabilitiesWire | undefined; open?: boolean } = {}) {
  const caps = fakeCaps("state" in options ? options.state : wire());
  const reads: {
    resolve: (r: BrowserStatusResult) => void;
    reject: (e: Error) => void;
  }[] = [];
  let link: ((status: "up" | "down") => void) | null = null;
  const session: InfoSession = {
    skills: () => Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: () => Promise.resolve({ used: 0, exact: true }),
    capabilities: caps.caps,
    browserStatus: () =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
  };
  const port: InfoPort = {
    daemon: () => ({ version: "1" }),
    now: () => 1,
    computerName: () => "mac",
    title: () => "Alpha",
    phase: () => (options.open === false ? "failed" : "open"),
    sessionId: "s1",
    mcpStatus: () => Promise.resolve([]),
    sessionList: () => Promise.resolve({ sessions: [] }),
    session: () => (options.open === false ? null : session),
    onLink: (listener) => {
      link = listener;
      return () => {
        link = null;
      };
    },
  };
  return { caps, reads, port, session, link: (s: "up" | "down") => link?.(s) };
}

describe("the info controller's browser/status read", () => {
  test("read on open, painted when it lands", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    let painted: BrowserStatusResult | null = null;
    info.subscribe((state) => {
      painted = state.browserStatus;
    });
    const done = info.open();
    expect(h.reads.length).toBe(1);
    h.reads[0]?.resolve(answer(2));
    await done;
    await tick();
    expect(info.state().browserStatus).toEqual(answer(2));
    expect(painted as BrowserStatusResult | null).toEqual(answer(2));
  });

  test("never asked without the host's browser, or unattached", async () => {
    for (const h of [
      harness({ state: { disabledMcp: [], disabledSkills: [] } }),
      harness({ state: undefined }),
      harness({ open: false }),
    ]) {
      const info = createSessionInfo(h.port);
      await info.open();
      await info.refreshBrowser();
      expect(h.reads.length).toBe(0);
      expect(info.state().browserStatus).toBeNull();
    }
  });

  test("nothing is read while the sheet is closed", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    await info.refreshBrowser();
    await info.pullTools();
    expect(h.reads.length).toBe(0);
    void info.open();
    h.reads[0]?.resolve(answer(1));
    await tick();
    info.close();
    expect(info.state().browserStatus).toBeNull();
    await info.refreshBrowser();
    h.caps.echo(wire({ actions: "auto" }));
    expect(h.reads.length).toBe(1);
  });

  test("a capabilities report re-reads; the older answer landing late is dropped", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    h.caps.echo(wire({ actions: "auto" }));
    expect(h.reads.length).toBe(2);
    h.reads[1]?.resolve(answer(2));
    await tick();
    h.reads[0]?.resolve(answer(7));
    await tick();
    expect(info.state().browserStatus?.tabs.length).toBe(2);
  });

  test("a failed read clears the old answer (unknown, never a stale list)", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    h.reads[0]?.resolve(answer(1));
    await tick();
    void info.refreshBrowser();
    h.reads[1]?.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method"));
    await tick();
    expect(info.state().browserStatus).toBeNull();
  });

  test("an answer that lands after the close is dropped", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    info.close();
    h.reads[0]?.resolve(answer(3));
    await tick();
    expect(info.state().browserStatus).toBeNull();
  });

  test("link down clears it; link up reads again", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    h.reads[0]?.resolve(answer(1));
    await tick();
    h.link("down");
    expect(info.state().browserStatus).toBeNull();
    h.link("up");
    expect(h.reads.length).toBe(2);
  });

  test("a browser switch is SENT and shown only on the daemon's echo", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    await info.setCapability("browser", "auto", true);
    await info.setCapability("tool", "browser", false);
    expect(h.caps.sets).toEqual([
      ["browser", "auto", true],
      ["tool", "browser", false],
    ]);
    expect(info.state().tools.capabilities?.state?.browser?.actions).toBe("ask");
    h.caps.echo(wire({ actions: "auto" }));
    expect(info.state().tools.capabilities?.state?.browser?.actions).toBe("auto");
  });

  test("a refused set is kept for the page, and never reaches the server rows' notes", async () => {
    const h = harness();
    const info = createSessionInfo(h.port);
    void info.open();
    h.caps.refuse(new Error("this session has no browser"));
    await info.setCapability("browser", "clear", true);
    expect(info.state().tools.capabilities?.error).toEqual({
      kind: "browser",
      text: "this session has no browser",
    });
    for (const section of info.state().view.sections) {
      expect(section.switchNote ?? "").not.toContain("Couldn't switch");
    }
  });
});

describe("the screen: the risk strip and the finished-tool re-read", () => {
  function screen() {
    const h = harness();
    let watcher: ((activity: SessionActivity) => void) | null = null;
    let events: SessionEvent[] = [];
    const handle: SendableHandle = {
      open: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      watch: (fn) => {
        watcher = fn;
        return () => {
          watcher = null;
        };
      },
      async *send(): AsyncIterable<SessionEvent> {
        yield* events;
        yield { type: "turn_end", reason: "end_turn" } as never;
      },
    };
    const controller = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1,
      info: () => h.port,
    });
    return {
      h,
      controller,
      play: (next: SessionEvent[]) => {
        events = next;
      },
      watching: () => watcher !== null,
    };
  }

  test("null by default; another device's auto shows it with the sheet closed", async () => {
    const s = screen();
    await s.controller.open();
    expect(s.controller.state().riskStrip).toBeNull();
    const seen: (readonly string[] | null)[] = [];
    s.controller.subscribe((state) => seen.push(state.riskStrip));
    s.h.caps.echo(wire({ actions: "auto" }));
    expect(seen.at(-1)).toEqual(["Browser acts alone"]);
    s.h.caps.echo(wire());
    expect(seen.at(-1)).toBeNull();
  });

  test("leaving drops the switches' follow", async () => {
    const s = screen();
    await s.controller.open();
    expect(s.h.caps.watchers()).toBeGreaterThan(0);
    await s.controller.leave();
    expect(s.h.caps.watchers()).toBe(0);
  });

  test("dispose drops it too", async () => {
    const s = screen();
    await s.controller.open();
    s.controller.dispose();
    expect(s.h.caps.watchers()).toBe(0);
  });

  test("a finished browser tool re-reads once while the sheet is open, other tools never", async () => {
    const s = screen();
    await s.controller.open();
    void s.controller.openInfo();
    const before = s.h.reads.length;
    expect(before).toBe(1);
    const call = (id: string, name: string): SessionEvent[] => [
      { type: "tool_start", id, name, arguments: "{}" } as never,
      { type: "tool_result", id, name, result: { content: "ok" } } as never,
    ];
    s.play(call("c1", "shell"));
    s.controller.setDraft("go");
    s.controller.press();
    await until(() => s.controller.state().transcript.rows.some((row) => row.kind === "tool"));
    await tick();
    expect(s.h.reads.length).toBe(before);
    await until(() => !s.controller.state().view.composer.running);
    s.play(call("c2", "browser_open"));
    s.controller.setDraft("again");
    s.controller.press();
    await until(() => s.h.reads.length > before);
    await until(() => !s.controller.state().view.composer.running);
    expect(s.h.reads.length).toBe(before + 1);
  });
});

/** Poll the condition the next assertion reads; throws on a timeout. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await tick();
  }
}
