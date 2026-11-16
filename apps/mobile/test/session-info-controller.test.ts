/**
 * The Session info controller (docs/feat/mobile-session-info.md): the four pulls
 * started in PARALLEL, each settling its own section, a generation counter that
 * drops a stale answer, and the link's `up` re-running one refresh.
 *
 * The failure modes here are the plan's F1–F5: they are asserted with deferred
 * promises (never a clock), because "the slow pull did not delay the fast one" is
 * a claim about ORDER, not about time.
 */
import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import type {
  McpServerStatus,
  ScheduleDeleteResult,
  ScheduleRow,
  SessionContextResult,
  SessionSkillsResult,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type InfoPort,
  type InfoSchedules,
  type SessionInfoState,
  createSessionInfo,
} from "../src/session-info-controller.ts";

const emptySkills: SessionSkillsResult = { slash: [], skills: [], problems: [], moreProblems: 0 };

/** The one clock every test in this file hands the controller (17 Nov 2026, 12:00 local). */
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();

/** A promise plus its settlers: the only way to assert an ORDER deterministically. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  // An unhandled rejection would fail the whole file; every test settles what it makes.
  return { promise, resolve, reject };
}

/** Let every already-resolved promise's `then` run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

interface Port extends InfoPort {
  readonly calls: { readonly mcp: number; readonly skills: number; readonly context: number };
}

function port(over: Partial<InfoPort> = {}): {
  readonly port: InfoPort;
  readonly calls: { mcp: number; skills: number; context: number };
} {
  const calls = { mcp: 0, skills: 0, context: 0 };
  const base: InfoPort = {
    daemon: () => ({ version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 }),
    now: () => NOW,
    computerName: () => "MacBook Pro",
    title: () => "Fix the flaky test",
    phase: () => "open",
    sessionId: "s-1",
    mcpStatus: () => {
      calls.mcp += 1;
      return Promise.resolve([] satisfies readonly McpServerStatus[]);
    },
    sessionList: () =>
      Promise.resolve({
        sessions: [
          {
            sessionId: "s-1",
            title: "Fix the flaky test",
            cwd: "/srv/app",
            createdAt: 0,
            updatedAt: 0,
            running: false,
            attached: 1,
            archived: false,
            jobs: 0,
          },
        ],
      }),
    session: () => ({
      skills: () => {
        calls.skills += 1;
        return Promise.resolve(emptySkills);
      },
      context: () => {
        calls.context += 1;
        return Promise.resolve({ used: 84_000, exact: true } satisfies SessionContextResult);
      },
      autoAccept: undefined,
    }),
    ...over,
  };
  return { port: base, calls };
}

const view = (state: SessionInfoState) => state.view;

describe("the four pulls run in PARALLEL (F3: a slow MCP never delays Skills)", () => {
  test("a deferred MCP leaves the other three sections ready", async () => {
    const mcp = deferred<readonly McpServerStatus[]>();
    const { port: p } = port({ mcpStatus: () => mcp.promise });
    const info = createSessionInfo(p);
    const opened = info.open();
    await settle();
    // Nothing awaited the MCP pull: the others have already landed.
    const sections = view(info.state()).sections;
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("loading");
    expect(sections.find((s) => s.id === "model")?.phase).toBe("ready");
    expect(sections.find((s) => s.id === "session")?.phase).toBe("ready");
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("empty");
    mcp.resolve([]);
    await opened;
    expect(view(info.state()).sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
  });
});

describe("errors are classified per section (F2)", () => {
  test("MethodNotFound on one pull is `unsupported` there and nowhere else", async () => {
    const { port: p } = port({
      mcpStatus: () =>
        Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method")),
    });
    const info = createSessionInfo(p);
    await info.open();
    const sections = view(info.state()).sections;
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("unsupported");
    expect(sections.find((s) => s.id === "model")?.phase).toBe("ready");
    expect(sections.find((s) => s.id === "session")?.phase).toBe("ready");
  });

  test("anything else is `error`, which offers a retry", async () => {
    const { port: p } = port({ mcpStatus: () => Promise.reject(new Error("boom")) });
    const info = createSessionInfo(p);
    await info.open();
    const mcp = view(info.state()).sections.find((s) => s.id === "mcp");
    expect(mcp?.phase).toBe("error");
    expect(mcp?.retry).toBe(true);
  });
});

describe("the link (F1)", () => {
  test("a pull refused because the link is down is `offline`, and `up` refreshes once", async () => {
    let down = true;
    const listeners: ((status: "up" | "down") => void)[] = [];
    let mcpCalls = 0;
    const { port: p } = port({
      mcpStatus: () => {
        mcpCalls += 1;
        return down
          ? Promise.reject(new Error("not connected to the daemon"))
          : Promise.resolve([] satisfies readonly McpServerStatus[]);
      },
      onLink: (listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    });
    const info = createSessionInfo(p);
    await info.open();
    expect(info.state().link).toBe("down");
    expect(view(info.state()).banner?.kind).toBe("offline");
    expect(view(info.state()).sections.find((s) => s.id === "mcp")?.phase).toBe("offline");
    down = false;
    const before = mcpCalls;
    for (const listener of listeners) {
      listener("up");
    }
    await settle();
    // ONE refresh, not one per section and not none.
    expect(mcpCalls).toBe(before + 1);
    expect(info.state().link).toBe("up");
    expect(view(info.state()).sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
  });

  test("a link that is down when the sheet opens still shows the cached facts, dimmed", async () => {
    let down = false;
    const listeners: ((status: "up" | "down") => void)[] = [];
    const { port: p } = port({
      mcpStatus: () =>
        down
          ? Promise.reject(new Error("not connected to the daemon"))
          : Promise.resolve([{ name: "ghost", state: "connected", tools: ["a"], moreTools: 0 }]),
      onLink: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    });
    const info = createSessionInfo(p);
    await info.open();
    down = true;
    for (const listener of listeners) {
      listener("down");
    }
    const mcp = view(info.state()).sections.find((s) => s.id === "mcp");
    expect(mcp?.phase).toBe("ready");
    expect(mcp?.dim).toBe(true);
    expect(view(info.state()).banner?.kind).toBe("offline");
  });
});

describe("a not-attached session is never asked (F4)", () => {
  test("`skills`/`context` are not called at all, and their sections say why", async () => {
    const { port: p, calls } = port({ phase: () => "failed" });
    const info = createSessionInfo(p);
    await info.open();
    expect(calls.skills).toBe(0);
    expect(calls.context).toBe(0);
    const sections = view(info.state()).sections;
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("not-open");
    // The model/MCP/session facts still arrive: only the session's own are skipped.
    expect(calls.mcp).toBe(1);
    expect(sections.find((s) => s.id === "session")?.phase).toBe("ready");
  });

  test("a `phase` that turns `open` later is followed by the next refresh", async () => {
    let phase: "opening" | "open" | "failed" = "opening";
    const { port: p, calls } = port({ phase: () => phase });
    const info = createSessionInfo(p);
    await info.open();
    expect(calls.skills).toBe(0);
    phase = "open";
    await info.refresh();
    expect(calls.skills).toBe(1);
    expect(view(info.state()).sections.find((s) => s.id === "skills")?.phase).toBe("empty");
  });
});

describe("a stale answer never paints over a newer one (F5)", () => {
  test("the first open's MCP result, resolving after a second open, is dropped", async () => {
    const first = deferred<readonly McpServerStatus[]>();
    const second = deferred<readonly McpServerStatus[]>();
    const queue = [first, second];
    let index = 0;
    const { port: p } = port({
      mcpStatus: () => {
        const next = queue[index] ?? second;
        index += 1;
        return next.promise;
      },
    });
    const info = createSessionInfo(p);
    const opened = info.open();
    await settle();
    info.close();
    const reopened = info.open();
    await settle();
    // The NEWER answer lands first...
    second.resolve([{ name: "new", state: "connected", tools: [], moreTools: 0 }]);
    await reopened;
    // ...then the old one arrives late and must not replace it.
    first.resolve([{ name: "old", state: "connected", tools: [], moreTools: 0 }]);
    await opened;
    const titles = view(info.state())
      .sections.find((s) => s.id === "mcp")
      ?.rows.map((row) => row.title);
    expect(titles).toEqual(["new"]);
  });

  test("a result arriving after close() is dropped (the sheet is gone)", async () => {
    const mcp = deferred<readonly McpServerStatus[]>();
    const { port: p } = port({ mcpStatus: () => mcp.promise });
    const info = createSessionInfo(p);
    const opened = info.open();
    await settle();
    info.close();
    mcp.resolve([]);
    await opened;
    // Nothing was painted after the close: the sheet is not on screen.
    expect(view(info.state()).sections.find((s) => s.id === "mcp")?.phase).toBe("loading");
  });
});

describe("the session list entry (F8)", () => {
  test("the session is found by id, not assumed to be the first row", async () => {
    const { port: p } = port({
      sessionList: () =>
        Promise.resolve({
          sessions: [
            {
              sessionId: "other",
              title: "another",
              cwd: "/srv/other",
              createdAt: 0,
              updatedAt: 0,
              running: true,
              attached: 9,
              archived: false,
            },
            {
              sessionId: "s-1",
              title: "Fix the flaky test",
              cwd: "/srv/app",
              createdAt: 0,
              updatedAt: 0,
              running: false,
              attached: 2,
              archived: false,
              jobs: 1,
            },
          ],
        }),
    });
    const info = createSessionInfo(p);
    await info.open();
    const rows = view(info.state()).sections.find((s) => s.id === "session")?.rows ?? [];
    expect(rows.find((row) => row.title === "Project")?.value).toBe("/srv/app");
    expect(rows.find((row) => row.title === "Devices")?.value).toBe("This phone + 1 other");
    expect(rows.find((row) => row.title === "Background")?.value).toBe("1 job running");
  });

  test("a session not on the page is `empty`, never a fabricated zero (F8)", async () => {
    const { port: p } = port({ sessionList: () => Promise.resolve({ sessions: [] }) });
    const info = createSessionInfo(p);
    await info.open();
    expect(view(info.state()).sections.find((s) => s.id === "session")?.phase).toBe("empty");
  });
});

describe("auto-accept (Owner Q3, F11)", () => {
  test("the switch exists only when the handle offers a link", async () => {
    const absent = createSessionInfo(port().port);
    await absent.open();
    expect(view(absent.state()).autoAccept).toBe(false);

    const link = {
      current: () => false,
      onChange: () => () => undefined,
    };
    const { port: p } = port({
      session: () => ({
        skills: () => Promise.resolve(emptySkills),
        context: () => Promise.resolve({ used: 1, exact: true }),
        autoAccept: link,
      }),
    });
    const info = createSessionInfo(p);
    await info.open();
    expect(view(info.state()).autoAccept).toBe(true);
    expect(info.autoAcceptOn()).toBe(false);
  });

  test("a failed set is REPORTED and keeps the person's decision (it is re-sent)", async () => {
    let on = false;
    const link = {
      current: () => on,
      set: (next: boolean) => {
        // The real link applies locally at once, then sends (`set`'s contract):
        // an unacknowledged value stays pending, so the shown switch agrees with
        // the daemon that will receive it on the next attach.
        on = next;
        return Promise.reject(new Error("not connected to the daemon"));
      },
      onChange: () => () => undefined,
    };
    const { port: p } = port({
      session: () => ({
        skills: () => Promise.resolve(emptySkills),
        context: () => Promise.resolve({ used: 1, exact: true }),
        autoAccept: link,
      }),
    });
    const info = createSessionInfo(p);
    await info.open();
    await info.setAutoAccept(!on);
    expect(info.autoAcceptOn()).toBe(true);
    expect(info.state().autoAcceptError).toContain("not connected");
  });

  test("a flip on another device arrives through the link's own onChange", async () => {
    let on = false;
    let notify: (value: boolean) => void = () => undefined;
    const link = {
      current: () => on,
      onChange: (listener: (value: boolean) => void) => {
        notify = listener;
        return () => undefined;
      },
    };
    const { port: p } = port({
      session: () => ({
        skills: () => Promise.resolve(emptySkills),
        context: () => Promise.resolve({ used: 1, exact: true }),
        autoAccept: link,
      }),
    });
    const info = createSessionInfo(p);
    await info.open();
    on = true;
    notify(true);
    expect(info.autoAcceptOn()).toBe(true);
  });
});

describe("MCP/skill switches (docs/feat/session-capabilities.md S5)", () => {
  type Caps = { disabledMcp: string[]; disabledSkills: string[] };
  type Listener = (state: Caps | undefined, by?: string) => void;
  /**
   * A `RemoteSession`'s switch surface, faithful to its contract: the state is
   * the daemon's, a set's ECHO (with this phone's `by`) arrives BEFORE its
   * answer, and `MethodNotFound` clears the state (an older daemon, F7).
   */
  function fakeCaps() {
    let state: Caps | undefined = { disabledMcp: [], disabledSkills: [] };
    const listeners = new Set<Listener>();
    const sets: { kind: string; name: string; enabled: boolean }[] = [];
    let answer: (op: { kind: "mcp" | "skill"; name: string; enabled: boolean }) => Promise<void> =
      async (op) => {
        caps.push(applied(op), "iPhone");
      };
    const applied = (op: { kind: "mcp" | "skill"; name: string; enabled: boolean }): Caps => {
      const base = state ?? { disabledMcp: [], disabledSkills: [] };
      const key = op.kind === "mcp" ? "disabledMcp" : "disabledSkills";
      const list = base[key].filter((name) => name !== op.name);
      return { ...base, [key]: op.enabled ? list : [...list, op.name].sort() };
    };
    const caps = {
      current: () => state,
      onChange(listener: Listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async set(kind: "mcp" | "skill", name: string, enabled: boolean) {
        sets.push({ kind, name, enabled });
        await answer({ kind, name, enabled });
        return state;
      },
      /** The daemon reports a state (a change from anyone, or a snapshot without `by`). */
      push(next: Caps | undefined, by?: string) {
        state = next;
        for (const listener of [...listeners]) {
          listener(next, by);
        }
      },
      applied,
      sets,
      listeners,
      answerWith(fn: typeof answer) {
        answer = fn;
      },
    };
    return caps;
  }
  const servers: McpServerStatus[] = [
    { name: "k8s", state: "connected", tools: ["get"], moreTools: 0 },
  ];
  function withCaps(caps: ReturnType<typeof fakeCaps>, over: Partial<InfoPort> = {}) {
    return port({
      mcpStatus: () => Promise.resolve(servers),
      session: () => ({
        skills: () => Promise.resolve(emptySkills),
        context: () => Promise.resolve({ used: 1, exact: true }),
        capabilities: caps,
      }),
      ...over,
    }).port;
  }
  const k8s = (state: SessionInfoState) =>
    view(state)
      .sections.find((s) => s.id === "mcp")
      ?.rows.find((row) => row.title === "k8s");

  test("a tap sends ONE set; the row flips only on the daemon's echo (not optimistic)", async () => {
    const caps = fakeCaps();
    const gate = deferred<void>();
    caps.answerWith(async () => {
      await gate.promise;
    });
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    expect(k8s(info.state())?.switch).toMatchObject({ on: true, interactive: true });
    const sent = info.setCapability("mcp", "k8s", false);
    await settle();
    expect(caps.sets).toEqual([{ kind: "mcp", name: "k8s", enabled: false }]);
    // Sent, not echoed: still on.
    expect(k8s(info.state())?.switch?.on).toBe(true);
    caps.push(caps.applied({ kind: "mcp", name: "k8s", enabled: false }), "iPhone");
    gate.resolve();
    await sent;
    expect(k8s(info.state())?.switch?.on).toBe(false);
    // My own echo is not "changed on" anything.
    expect(k8s(info.state())?.subtitle).toBe("Off · hidden from the model");
  });

  test("another device's change repaints the sheet with 'changed on <device>' (Q4)", async () => {
    const caps = fakeCaps();
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    let painted = 0;
    info.subscribe(() => {
      painted += 1;
    });
    caps.push({ disabledMcp: ["k8s"], disabledSkills: [] }, "MacBook");
    expect(painted).toBeGreaterThan(0);
    expect(k8s(info.state())?.subtitle).toBe("Off · hidden from the model · changed on MacBook");
  });

  test("a snapshot (re-attach, no by) is never 'changed on' (F5)", async () => {
    const caps = fakeCaps();
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    caps.push({ disabledMcp: ["k8s"], disabledSkills: [] });
    expect(k8s(info.state())?.switch?.on).toBe(false);
    expect(k8s(info.state())?.subtitle).toBe("Off · hidden from the model");
  });

  test("my own later change clears another device's note on that row", async () => {
    const caps = fakeCaps();
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    caps.push({ disabledMcp: ["k8s"], disabledSkills: [] }, "MacBook");
    await info.setCapability("mcp", "k8s", true);
    expect(k8s(info.state())?.switch?.on).toBe(true);
    expect(k8s(info.state())?.subtitle).toBeUndefined();
  });

  test("close() stops following the switches and forgets the notes (only while open)", async () => {
    const caps = fakeCaps();
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    expect(caps.listeners.size).toBe(1);
    caps.push({ disabledMcp: ["k8s"], disabledSkills: [] }, "MacBook");
    info.close();
    expect(caps.listeners.size).toBe(0);
    await info.open();
    expect(caps.listeners.size).toBe(1);
    expect(k8s(info.state())?.subtitle).toBe("Off · hidden from the model");
  });

  test("a refused set is shown under its section, and cleared by the next attempt", async () => {
    const caps = fakeCaps();
    caps.answerWith(async () => {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "too many names");
    });
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    await info.setCapability("mcp", "k8s", false);
    const mcp = () => view(info.state()).sections.find((s) => s.id === "mcp");
    expect(mcp()?.switchNote).toBe("Couldn't switch: too many names");
    expect(k8s(info.state())?.switch?.on).toBe(true);
    caps.answerWith(async (op) => {
      caps.push(caps.applied(op), "iPhone");
    });
    await info.setCapability("mcp", "k8s", false);
    expect(mcp()?.switchNote).toBe(
      "Off hides it from the model in this session, from the next reply.",
    );
  });

  test("a refused set leaves nothing pending: the same change from another device is news", async () => {
    const caps = fakeCaps();
    caps.answerWith(async () => {
      throw new RpcError(JsonRpcErrorCode.InternalError, "boom");
    });
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    await info.setCapability("mcp", "k8s", false);
    caps.push({ disabledMcp: ["k8s"], disabledSkills: [] }, "MacBook");
    expect(k8s(info.state())?.subtitle).toBe("Off · hidden from the model · changed on MacBook");
  });

  test("an older daemon (MethodNotFound) turns the switches into ghosts, with no error text (F7)", async () => {
    const caps = fakeCaps();
    caps.answerWith(async () => {
      caps.push(undefined);
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "Method not found");
    });
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    await info.setCapability("mcp", "k8s", false);
    const mcp = view(info.state()).sections.find((s) => s.id === "mcp");
    expect(k8s(info.state())?.switch?.interactive).toBe(false);
    expect(mcp?.switchNote).toBe("The tentacle on MacBook Pro can't turn servers off — update it.");
  });

  test("an open that reported no switches is `unsupported` from the start", async () => {
    const caps = fakeCaps();
    // The open's snapshot carried no `capabilities` (an older daemon).
    caps.push(undefined);
    const info = createSessionInfo(withCaps(caps));
    await info.open();
    expect(k8s(info.state())?.switch?.interactive).toBe(false);
  });

  test("not attached: the switches are ghosts and a tap sends nothing (F4)", async () => {
    const caps = fakeCaps();
    const info = createSessionInfo(withCaps(caps, { phase: () => "failed" }));
    await info.open();
    expect(k8s(info.state())?.switch?.interactive).toBe(false);
    await info.setCapability("mcp", "k8s", false);
    expect(caps.sets).toEqual([]);
  });

  test("offline: a tap sends nothing (F1)", async () => {
    const caps = fakeCaps();
    let notify: (status: "up" | "down") => void = () => undefined;
    const info = createSessionInfo(
      withCaps(caps, {
        onLink: (listener) => {
          notify = listener;
          return () => undefined;
        },
      }),
    );
    await info.open();
    notify("down");
    expect(k8s(info.state())?.switch?.interactive).toBe(false);
    await info.setCapability("mcp", "k8s", false);
    expect(caps.sets).toEqual([]);
  });

  test("a handle with no switch surface reads as an older daemon", async () => {
    const info = createSessionInfo(port({ mcpStatus: () => Promise.resolve(servers) }).port);
    await info.open();
    expect(k8s(info.state())?.switch?.interactive).toBe(false);
  });
});

describe("the sheet's facts", () => {
  test("the title, the computer and the daemon come from the port, not the wire", async () => {
    const info = createSessionInfo(port().port);
    await info.open();
    const state = info.state();
    expect(state.view.subtitle).toBe("Fix the flaky test");
    expect(state.view.footer).toBe("tentacle 1.4.0 · MacBook Pro");
  });

  test("an older daemon's daemonInfo is absent, never undefined-shaped", async () => {
    const { port: p } = port({ daemon: () => undefined });
    const info = createSessionInfo(p);
    await info.open();
    const model = view(info.state()).sections.find((s) => s.id === "model");
    expect(model?.rows[0]?.value).toBe("Not reported");
  });

  test("close() unsubscribes from the link", async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const { port: p } = port({
      onLink: () => {
        subscribed += 1;
        return () => {
          unsubscribed += 1;
        };
      },
    });
    const info = createSessionInfo(p);
    await info.open();
    info.close();
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(1);
  });
});

describe("a failed pull is REPORTED as its class, never its text (docs/fix/mobile-chat-glitches.md, item 9a)", () => {
  const CANARY = "secret /Users/x/project prompt";
  /** The port with a `context()` that rejects with `error`, and what it reported. */
  function failing(error: unknown) {
    const reports: { section: string; failure: unknown }[] = [];
    const base = port().port;
    const p: InfoPort = {
      ...base,
      session: () => ({
        skills: () => Promise.resolve(emptySkills),
        context: () => Promise.reject(error),
        autoAccept: undefined,
      }),
      onPullError: (section, failure) => reports.push({ section, failure }),
    };
    return { port: p, reports };
  }
  const contextRow = (state: SessionInfoState) =>
    JSON.stringify(state.view).includes('"title":"Context","value":"Couldn\'t load"');

  test("an RpcError: its class and numeric code, and NOT the message (a canary)", async () => {
    const { port: p, reports } = failing(new RpcError(-32050, CANARY));
    const info = createSessionInfo(p);
    await info.open();
    expect(reports).toEqual([{ section: "context", failure: { error: "RpcError", code: -32050 } }]);
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(JSON.stringify(reports)).not.toContain("/Users/x");
    // The view is unchanged (Owner Q4: keep the wording until 9b).
    expect(contextRow(info.state())).toBe(true);
  });

  test("a timeout: its class", async () => {
    const timeout = Object.assign(new Error(CANARY), { name: "TimeoutError" });
    const { port: p, reports } = failing(timeout);
    const info = createSessionInfo(p);
    await info.open();
    expect(reports).toEqual([{ section: "context", failure: { error: "TimeoutError" } }]);
    expect(contextRow(info.state())).toBe(true);
  });

  test("offline and MethodNotFound are not failures to report (they have their own words)", async () => {
    for (const error of [
      new Error("not connected to the daemon"),
      new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method"),
    ]) {
      const { port: p, reports } = failing(error);
      const info = createSessionInfo(p);
      await info.open();
      expect(reports).toEqual([]);
    }
  });
});

describe("the scheduled wakes feed (cron-tool S6, M7)", () => {
  const wake = (i: number): ScheduleRow => ({
    id: `sc-${i}`,
    kind: "every",
    spec: `every ${i}m`,
    prompt: `check ${i}`,
    nextAt: NOW + i * 60_000,
    fires: i,
    createdAt: NOW,
  });

  /** A fake `InfoSchedules`: the listener is what a real `onSchedules` calls at install. */
  function feed(initial: readonly ScheduleRow[] | undefined): {
    readonly port: InfoSchedules;
    readonly report: (rows: readonly ScheduleRow[] | undefined) => void;
    readonly removed: string[];
    readonly unsubscribed: () => number;
    refuse: ScheduleDeleteResult | undefined;
  } {
    let listener: ((rows: readonly ScheduleRow[] | undefined) => void) | null = null;
    let unsubscribes = 0;
    const removed: string[] = [];
    const handle = {
      refuse: undefined as ScheduleDeleteResult | undefined,
    };
    const port: InfoSchedules = {
      current: () => initial,
      onChange: (next) => {
        listener = next;
        // A real `RemoteSession.onSchedules` reports the current table at once.
        if (initial !== undefined) {
          next(initial);
        }
        return () => {
          unsubscribes += 1;
          // The real client's unsubscribe stops delivering: a frame after it is
          // no listener's business (otherwise this fake would prove nothing).
          if (listener === next) {
            listener = null;
          }
        };
      },
      remove: (scheduleId) => {
        removed.push(scheduleId);
        return Promise.resolve(handle.refuse ?? { deleted: true });
      },
    };
    return {
      port,
      report: (rows) => listener?.(rows),
      removed,
      unsubscribed: () => unsubscribes,
      get refuse() {
        return handle.refuse;
      },
      set refuse(value) {
        handle.refuse = value;
      },
    };
  }

  const withFeed = (f: ReturnType<typeof feed>) =>
    port({ session: () => ({ ...sessionBase, schedules: f.port }) });

  const sessionBase = {
    skills: () => Promise.resolve(emptySkills),
    context: () => Promise.resolve({ used: 84_000, exact: true } as SessionContextResult),
    autoAccept: undefined,
  };

  const sectionOf = (state: SessionInfoState) =>
    state.view.sections.find((s) => s.id === "schedules");

  test("the install's table paints at once; no section without a feed", async () => {
    const without = createSessionInfo(port().port);
    await without.open();
    expect(sectionOf(without.state())).toBeUndefined();

    const f = feed([wake(1), wake(2)]);
    const info = createSessionInfo(withFeed(f).port);
    await info.open();
    expect(sectionOf(info.state())?.phase).toBe("ready");
    expect(sectionOf(info.state())?.rows.map((r) => r.title)).toEqual(["check 1", "check 2"]);
  });

  test("a later frame repaints; `undefined` reads as an older daemon, never an empty list", async () => {
    const f = feed([]);
    const info = createSessionInfo(withFeed(f).port);
    await info.open();
    expect(sectionOf(info.state())?.phase).toBe("empty");

    f.report([wake(3)]);
    expect(sectionOf(info.state())?.phase).toBe("ready");
    expect(sectionOf(info.state())?.rows).toHaveLength(1);

    f.report(undefined);
    expect(sectionOf(info.state())?.phase).toBe("unsupported");
    expect(sectionOf(info.state())?.rows).toEqual([]);
  });

  test("a delete sends the RAW id; the row leaves only on the daemon's next table", async () => {
    const f = feed([wake(1), wake(2)]);
    const info = createSessionInfo(withFeed(f).port);
    await info.open();
    await info.deleteSchedule("sc-1");
    expect(f.removed).toEqual(["sc-1"]);
    // The local list is NOT touched: the next frame is what removes a row.
    expect(sectionOf(info.state())?.rows).toHaveLength(2);
    f.report([wake(2)]);
    expect(sectionOf(info.state())?.rows.map((r) => r.title)).toEqual(["check 2"]);
  });

  test("a refused delete keeps the row and shows the daemon's own reason (no invented cause)", async () => {
    const f = feed([wake(1)]);
    f.refuse = { deleted: false, reason: "this daemon cannot delete a scheduled wake" };
    const info = createSessionInfo(withFeed(f).port);
    await info.open();
    await info.deleteSchedule("sc-1");
    const section = sectionOf(info.state());
    expect(section?.rows).toHaveLength(1);
    expect(section?.footer).toBe("this daemon cannot delete a scheduled wake");
    expect(section?.phase).toBe("ready");
  });

  test("a thrown delete is reported, and the next frame retires the reason", async () => {
    const f = feed([wake(1)]);
    const failing: InfoSchedules = {
      ...f.port,
      remove: () => Promise.reject(new Error("not connected to the daemon")),
    };
    const info = createSessionInfo(
      port({ session: () => ({ ...sessionBase, schedules: failing }) }).port,
    );
    await info.open();
    await info.deleteSchedule("sc-1");
    expect(sectionOf(info.state())?.footer).toBe("not connected to the daemon");
    expect(sectionOf(info.state())?.rows).toHaveLength(1);
    f.report([wake(1)]);
    expect(sectionOf(info.state())?.footer).toBeUndefined();
  });

  test("a session switch refollows: the new table replaces the previous session's", async () => {
    let rows: readonly ScheduleRow[] | undefined = [wake(1)];
    const listener: { next: ((rows: readonly ScheduleRow[] | undefined) => void) | null } = {
      next: null,
    };
    const switching: InfoSchedules = {
      current: () => rows,
      onChange: (next) => {
        listener.next = next;
        if (rows !== undefined) {
          next(rows);
        }
        return () => {
          listener.next = null;
        };
      },
      remove: () => Promise.resolve({ deleted: true }),
    };
    const info = createSessionInfo(
      port({ session: () => ({ ...sessionBase, schedules: switching }) }).port,
    );
    await info.open();
    expect(sectionOf(info.state())?.rows).toHaveLength(1);

    // The next session has none of them: the install reports the truth.
    rows = [];
    await info.refresh();
    expect(sectionOf(info.state())?.phase).toBe("empty");
  });

  test("closing the sheet stops following the feed", async () => {
    const f = feed([wake(1)]);
    const info = createSessionInfo(withFeed(f).port);
    await info.open();
    info.close();
    expect(f.unsubscribed()).toBeGreaterThan(0);
    // A frame that lands after the close paints nothing: the sheet is gone.
    const before = info.state();
    f.report([wake(1), wake(2)]);
    expect(sectionOf(info.state())?.rows).toHaveLength(1);
    expect(sectionOf(before)?.rows).toHaveLength(1);
  });

  test("a delete with no feed at all is a no-op (not attached, or no table)", async () => {
    const info = createSessionInfo(port().port);
    await info.open();
    // Resolves, sends nothing, throws nothing: there is no control to press.
    await info.deleteSchedule("sc-1");
    expect(sectionOf(info.state())).toBeUndefined();
  });

  test("a wiring that offers the feed says `not-open` before any attach (never hides)", async () => {
    const info = createSessionInfo(port({ phase: () => "failed", offersSchedules: true }).port);
    await info.open();
    expect(sectionOf(info.state())?.phase).toBe("not-open");
    expect(sectionOf(info.state())?.rows).toEqual([]);
  });

  test("an attached daemon that reports no table reads `unsupported` (an older build)", async () => {
    const info = createSessionInfo(
      port({ offersSchedules: true, session: () => sessionBase }).port,
    );
    await info.open();
    expect(sectionOf(info.state())?.phase).toBe("unsupported");
  });
});
