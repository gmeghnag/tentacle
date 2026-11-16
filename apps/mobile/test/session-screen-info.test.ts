/**
 * Session info ON THE SCREEN (docs/feat/mobile-session-info.md slice 4): the "…"
 * menu opens it, the four pulls start when it does, and the title tap renames
 * through the EXISTING `session/rename` path (Owner decision 5).
 *
 * The controller is the seam (AGENTS §7): a fake handle answers `skills`,
 * `context` and `rename`, so what is asserted is the wiring the screen owns, not
 * the sheet's looks.
 */
import { describe, expect, test } from "bun:test";
import type { AutoAcceptLink, SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type {
  McpServerStatus,
  QueueState,
  SessionContextResult,
  SessionListResult,
  SessionSkillsResult,
} from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { createSessionController } from "../src/session-controller.ts";
import type { InfoCapabilities, InfoPort, InfoSession } from "../src/session-info-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";

/** The session's shared auto-accept, as the screen's own switch reads it. */
function fakeAutoAccept(on = false) {
  let value = on;
  const listeners = new Set<(on: boolean) => void>();
  const link: AutoAcceptLink = {
    current: () => value,
    set: (next: boolean) => {
      value = next;
      for (const listener of listeners) {
        listener(next);
      }
      return Promise.resolve({ on: next });
    },
    onChange: (listener) => {
      const one = (next: boolean) => listener(next, "update");
      listeners.add(one);
      return () => {
        listeners.delete(one);
      };
    },
    shared: () => true,
    lastBy: () => undefined,
  };
  return {
    link,
    /** Another device's flip: the daemon's `auto_accept` update. */
    flip(next: boolean) {
      value = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    watchers: () => listeners.size,
  };
}

function harness(
  options: {
    readonly rename?: (title: string) => Promise<string>;
    readonly skills?: () => Promise<SessionSkillsResult>;
    readonly context?: () => Promise<SessionContextResult>;
    /** Absent: a handle that offers no shared switch (no `autoAccept`). */
    readonly autoAccept?: ReturnType<typeof fakeAutoAccept>;
    readonly mcp?: () => Promise<readonly McpServerStatus[]>;
    /** The handle's MCP/skill switches (session-capabilities S5); absent: none. */
    readonly capabilities?: InfoCapabilities;
  } = {},
) {
  const calls = { skills: 0, context: 0, mcp: 0, list: 0 };
  const renamed: string[] = [];
  /** Every state the SCREEN emitted (`onChange`) — what a re-render would see. */
  const emitted: SessionScreenState[] = [];
  /** The screen's own `watch` listener (a turn, a history replace from the daemon). */
  let watcher: ((activity: SessionActivity) => void) | null = null;
  /** The port's link feed (F1's `up`): what the app's `onStatus` would call. */
  const linkListeners: ((status: "up" | "down") => void)[] = [];
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
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    skills: () => {
      calls.skills += 1;
      return (
        options.skills?.() ??
        Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 })
      );
    },
    context: () => {
      calls.context += 1;
      return options.context?.() ?? Promise.resolve({ used: 84_000, exact: true });
    },
    rename: (title) => {
      renamed.push(title);
      return options.rename?.(title) ?? Promise.resolve(title);
    },
    ...(options.autoAccept === undefined ? {} : { autoAccept: options.autoAccept.link }),
  };
  // The screen's handle, shaped as the port's `InfoSession` (a real `RemoteSession`
  // answers all three; a fake here need not be complete).
  const session: InfoSession = {
    skills: () =>
      handle.skills?.() ??
      Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: () => handle.context?.() ?? Promise.resolve({ used: 0, exact: true }),
    ...(options.autoAccept === undefined ? {} : { autoAccept: options.autoAccept.link }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  };
  const port: InfoPort = {
    daemon: () => ({ version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 }),
    now: () => Date.now(),
    computerName: () => "e2e-mac",
    title: () => "Alpha",
    phase: () => "open",
    sessionId: "s1",
    mcpStatus: () => {
      calls.mcp += 1;
      return options.mcp?.() ?? Promise.resolve([] as readonly McpServerStatus[]);
    },
    sessionList: () => {
      calls.list += 1;
      return Promise.resolve({
        sessions: [
          {
            sessionId: "s1",
            title: "Alpha",
            cwd: "/srv/app",
            createdAt: 0,
            updatedAt: 0,
            running: false,
            attached: 1,
            archived: false,
          },
        ],
      } as SessionListResult);
    },
    session: () => session,
    onLink: (listener) => {
      linkListeners.push(listener);
      return () => {
        const at = linkListeners.indexOf(listener);
        if (at >= 0) {
          linkListeners.splice(at, 1);
        }
      };
    },
  };
  const screen = () =>
    createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: () => handle,
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1,
      info: () => port,
      onChange: (next) => emitted.push(next),
    });
  return {
    screen,
    calls,
    renamed,
    handle,
    emitted,
    port,
    emitActivity: (activity: SessionActivity) => watcher?.(activity),
    link: (status: "up" | "down") => {
      for (const listener of [...linkListeners]) {
        listener(status);
      }
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
};

describe("opening Session info", () => {
  test("the context pull runs AT ATTACH, so the header's bar has a figure (the TUI's rule)", async () => {
    const h = harness();
    const screen = h.screen();
    expect(screen.state().view.headerContext).toBeNull();
    await screen.open();
    // ONE pull at attach: the session's count, before any turn measured a fill.
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
    }
    expect(h.calls.context).toBe(1);
    // 84k of a 200k window. The figure is the daemon's count (an EXACT one here),
    // so no `≈`.
    expect(screen.state().view.headerContext).toEqual({ percent: 42, approx: false });
  });

  test("nothing else is pulled at attach (the sheet's own pulls wait for it)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    expect(h.calls.mcp).toBe(0);
    expect(h.calls.skills).toBe(0);
    expect(screen.state().info === null || screen.state().info?.view.sections.length === 4).toBe(
      true,
    );
  });
  test("opening it starts all four pulls over the client stack", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    expect(h.calls.mcp).toBe(1);
    expect(h.calls.list).toBe(1);
    expect(h.calls.skills).toBe(1);
    // The attach already asked for the context (the header's bar): the sheet's
    // pull is a SECOND, fresh one — never reusing a figure a turn has outdated.
    expect(h.calls.context).toBe(2);
    const sections = screen.state().info?.view.sections ?? [];
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("empty");
  });

  test("closing it stops following the link (a second open starts over)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    screen.closeInfo();
    await screen.openInfo();
    await settle();
    expect(h.calls.mcp).toBe(2);
  });

  test("a daemon too old for session/skills says so in that ONE section", async () => {
    const h = harness({
      skills: () => Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method")),
    });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    const sections = screen.state().info?.view.sections ?? [];
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("unsupported");
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
  });

  test("the header's model comes from the daemon's handshake (Owner decision 2)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    expect(screen.state().view.headerModel).toBe("claude-sonnet-4-5");
  });
});

describe("renaming from the title (Owner decision 5)", () => {
  test("the field opens on the CURRENT title, and Save sends session/rename", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    expect(screen.state().renaming?.text).toBe("Alpha");
    screen.setRenameText("A better name");
    await screen.submitRename();
    expect(h.renamed).toEqual(["A better name"]);
    // The header follows what the daemon stored, and the field closes.
    expect(screen.state().renaming).toBeNull();
    expect(screen.state().view.title).toBe("A better name");
  });

  test("an EMPTY or unchanged title is a no-op: nothing is sent", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("");
    await screen.submitRename();
    expect(h.renamed).toEqual([]);
    expect(screen.state().renaming).toBeNull();

    screen.beginRename();
    screen.setRenameText("Alpha");
    await screen.submitRename();
    expect(h.renamed).toEqual([]);
  });

  test("Cancel closes the field and sends nothing", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("nope");
    screen.cancelRename();
    expect(screen.state().renaming).toBeNull();
    expect(h.renamed).toEqual([]);
  });

  test("a failed rename keeps the words and says why (never a silent success)", async () => {
    const h = harness({ rename: () => Promise.reject(new Error("not connected to the daemon")) });
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("Both a name");
    await screen.submitRename();
    const field = screen.state().renaming;
    expect(field?.text).toBe("Both a name");
    expect(field?.error).toContain("not connected");
    // The header keeps the title it had: nothing was renamed.
    expect(screen.state().view.title).toBe("Alpha");
  });

  test("an older daemon's MethodNotFound reads as a tentacle to update", async () => {
    const h = harness({
      rename: () => Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method")),
    });
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("Both a name");
    await screen.submitRename();
    expect(screen.state().renaming?.error).toContain("too old");
  });

  test("a rename made here reaches the SHEET's subtitle too (Review round 1, LOW)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    expect(screen.state().info?.view.subtitle).toBe("Alpha");
    screen.beginRename();
    screen.setRenameText("A better name");
    await screen.submitRename();
    // The sheet's subtitle is bound to the screen's LIVE title, not to the
    // route's copy captured when the screen was built.
    expect(screen.state().info?.view.subtitle).toBe("A better name");
  });

  test("a rename asked with NO handle says that, never 'too old' (Review round 1, LOW)", async () => {
    const h = harness();
    const screen = h.screen();
    // No `open()`: the attach never answered, so there is no handle at all.
    screen.beginRename();
    screen.setRenameText("A better name");
    await screen.submitRename();
    const error = screen.state().renaming?.error ?? "";
    expect(error).not.toContain("too old");
    expect(error).toContain("Not connected");
  });
});

/** The LAST state the screen emitted: what the mounted component would render. */
const lastEmitted = (emitted: readonly SessionScreenState[]): SessionScreenState => {
  const last = emitted.at(-1);
  if (last === undefined) {
    throw new Error("the screen emitted nothing");
  }
  return last;
};

describe("a pull that lands REPAINTS the screen (Review round 1, MEDIUM 1)", () => {
  test("the attach-time context pull reaches the emitted state (the header's bar)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    // `state()` is a PULL; a mounted component only ever sees the EMITTED state,
    // so the bar is real only if the pull that filled it emitted (nothing else
    // changes on an idle session, so no later event would repaint it).
    expect(screen.state().view.headerContext).toEqual({ percent: 42, approx: false });
    expect(lastEmitted(h.emitted).view.headerContext).toEqual({ percent: 42, approx: false });
  });

  test("skills/context landing while the MCP probe is still pending repaint the sheet", async () => {
    let resolveMcp: (servers: readonly McpServerStatus[]) => void = () => undefined;
    const h = harness({
      mcp: () =>
        new Promise<readonly McpServerStatus[]>((ok) => {
          resolveMcp = ok;
        }),
    });
    const screen = h.screen();
    await screen.open();
    void screen.openInfo();
    await settle();
    // The MCP probe is still waiting an unresponsive server (F3).
    expect(h.calls.mcp).toBe(1);
    const emitted = lastEmitted(h.emitted).info;
    expect(emitted?.view.sections.find((s) => s.id === "mcp")?.phase).toBe("loading");
    // ...yet what the person sees must already say what DID land: a screen that
    // only reads `state()` on its own emits shows `loading` for every section
    // until MCP settles (F3 is false end to end).
    expect(emitted?.view.sections.find((s) => s.id === "skills")?.phase).toBe("empty");
    expect(emitted?.view.sections.find((s) => s.id === "model")?.rows[1]?.value).toContain("42 %");
    resolveMcp([]);
  });

  test("the link coming back up repaints the sheet from the auto-refresh (F1)", async () => {
    let down = true;
    const h = harness({
      mcp: () =>
        down
          ? Promise.reject(new Error("not connected to the daemon"))
          : Promise.resolve([] as readonly McpServerStatus[]),
    });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    expect(lastEmitted(h.emitted).info?.view.banner?.kind).toBe("offline");
    down = false;
    h.link("up");
    await settle();
    // The refresh's answer reached the person, not only `state()`.
    expect(lastEmitted(h.emitted).info?.view.banner).toBeUndefined();
    expect(lastEmitted(h.emitted).info?.view.sections.find((s) => s.id === "mcp")?.phase).toBe(
      "empty",
    );
  });
  test("an auto-accept flip from another device repaints the switch (F11)", async () => {
    const auto = fakeAutoAccept(false);
    const h = harness({ autoAccept: auto });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    expect(screen.autoAcceptOn()).toBe(false);
    const before = h.emitted.length;
    auto.flip(true);
    // The VALUE is the link's (`autoAcceptOn()` is read at render), so what a
    // flip needs is a REPAINT: with no listener on the link the sheet kept the
    // switch drawn one way until some unrelated event emitted (F11).
    expect(h.emitted.length).toBeGreaterThan(before);
    expect(screen.autoAcceptOn()).toBe(true);
    expect(lastEmitted(h.emitted).info?.view.autoAccept).toBe(true);
  });

  test("a server's switch reaches the session's set, and its echo repaints the row (S5)", async () => {
    type Caps = { disabledMcp: string[]; disabledSkills: string[] };
    let state: Caps = { disabledMcp: [], disabledSkills: [] };
    let notify: (next: Caps | undefined, by?: string) => void = () => undefined;
    const sets: unknown[] = [];
    const capabilities: InfoCapabilities = {
      current: () => state,
      onChange: (listener) => {
        notify = listener;
        return () => undefined;
      },
      set: (kind, name, enabled) => {
        sets.push({ kind, name, enabled });
        state = { ...state, disabledMcp: enabled ? [] : [name] };
        notify(state, "iPhone");
        return Promise.resolve(state);
      },
    };
    const h = harness({
      capabilities,
      mcp: () =>
        Promise.resolve([{ name: "k8s", state: "connected", tools: ["get"], moreTools: 0 }]),
    });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    await screen.setCapability("mcp", "k8s", false);
    expect(sets).toEqual([{ kind: "mcp", name: "k8s", enabled: false }]);
    const row = lastEmitted(h.emitted)
      .info?.view.sections.find((s) => s.id === "mcp")
      ?.rows.find((r) => r.title === "k8s");
    expect(row?.switch?.on).toBe(false);
  });
});

describe("a REPLACED history re-asks the context (Review round 1, MEDIUM 2)", () => {
  test("the header's bar keeps repainting after the sheet was opened and closed", async () => {
    let used = 120_000;
    const h = harness({
      context: () => Promise.resolve({ used, exact: true } satisfies SessionContextResult),
    });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    screen.closeInfo();
    used = 3_000;
    h.emitActivity({ kind: "history", messages: [], reason: "clear" });
    await settle();
    // Closing the SHEET stops the pulls (F5) — never the HEADER's feed, which is
    // on screen the whole time (Owner decision 4). A `close()` that dropped the
    // controller's listeners would freeze the bar at the old figure for the rest
    // of the screen's life.
    expect(screen.state().view.headerContext).toEqual({ percent: 2, approx: false });
    expect(lastEmitted(h.emitted).view.headerContext).toEqual({ percent: 2, approx: false });
  });
  test("after a /clear the header's bar follows the emptied session, not the dropped chat", async () => {
    let used = 120_000;
    const h = harness({
      context: () => Promise.resolve({ used, exact: true } satisfies SessionContextResult),
    });
    const screen = h.screen();
    await screen.open();
    await settle();
    // 120k of 200k: the attach's figure.
    expect(screen.state().view.headerContext).toEqual({ percent: 60, approx: false });
    // The session is cleared on another device: the chat those 120k described is
    // gone, and the daemon now counts an empty one.
    used = 3_000;
    h.emitActivity({ kind: "history", messages: [], reason: "clear" });
    await settle();
    // The TUI forgets the measured fill AND re-asks (`useSessionLink:350-353`);
    // forgetting alone leaves the attach-time figure on the bar for ever.
    expect(screen.state().view.headerContext).toEqual({ percent: 2, approx: false });
    expect(lastEmitted(h.emitted).view.headerContext).toEqual({ percent: 2, approx: false });
  });
});
