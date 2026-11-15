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
  SessionContextResult,
  SessionSkillsResult,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type InfoPort,
  type SessionInfoState,
  createSessionInfo,
} from "../src/session-info-controller.ts";

const emptySkills: SessionSkillsResult = { slash: [], skills: [], problems: [], moreProblems: 0 };

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
