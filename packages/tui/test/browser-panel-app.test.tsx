/**
 * `/browser` in the live App (docs/feat/browser-inspect.md B6a): Space sends
 * `session/set_capability`, the panel and the status bar follow the daemon's
 * ECHO only, the sign follows `browser/status`, and every failure is said. The
 * decisions are `browser-view.ts`'s (its own suite); this pins the wiring.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_GROUPS } from "@tentacle/core";
import type { BrowserStatusResult } from "@tentacle/protocol";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/app-types.ts";
import type { CapOp, CapsView } from "../src/capability-toggles.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = "\u001B[B";
const MEMBERS = TOOL_GROUPS.browser ?? [];

/** Poll the condition the next assertion reads; throw on timeout. */
async function until(read: () => boolean, what: () => string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (read()) return;
    await delay(10);
  }
  throw new Error(`timed out: ${what()}`);
}

const caps = (
  actions: "ask" | "auto" = "ask",
  secrets: "masked" | "clear" = "masked",
  off: readonly string[] = [],
): CapsView => ({
  disabledMcp: [],
  disabledSkills: [],
  disabledTools: off,
  browser: { enabled: off.length === 0, actions, secrets },
});

const tab = (id: number) => ({
  id,
  title: `Page ${id}`,
  where: "example.com/",
  handedOver: false,
  traced: false,
});

const connected = (n: number): BrowserStatusResult => ({
  available: true,
  link: { state: "connected", managed: false },
  tabs: Array.from({ length: n }, (_, i) => tab(i + 1)),
});

function browserSession(
  opts: {
    caps?: CapsView;
    status?: () => Promise<BrowserStatusResult>;
    fail?: Error;
    opened?: boolean;
  } = {},
) {
  let state: CapsView | undefined = opts.caps ?? caps();
  const listeners = new Set<(c: CapsView | undefined, by?: string) => void>();
  const sets: CapOp[] = [];
  const reads = { n: 0 };
  let tabs = 1;
  const answers: (() => void)[] = [];
  const session: SessionController = {
    ...inertSession(),
    async *send() {
      yield { type: "tool_start", id: "c1", name: "browser_open", arguments: "{}" };
      tabs = 3;
      yield { type: "tool_result", id: "c1", name: "browser_open", result: { content: "ok" } };
    },
    capabilities: () => state,
    onCapabilities: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCapability: (kind, name, enabled) => {
      sets.push({ kind, name, enabled });
      if (opts.fail) return Promise.reject(opts.fail);
      return new Promise((resolve) => {
        answers.push(() => resolve(state));
      });
    },
    browserStatus: () => {
      reads.n += 1;
      return opts.status ? opts.status() : Promise.resolve(connected(tabs));
    },
    opened: () => opts.opened ?? true,
  };
  const echo = (next: CapsView, by?: string): void => {
    state = next;
    for (const l of [...listeners]) l(next, by);
  };
  return { session, sets, reads, echo, answers };
}

/** The `n`th switch has left the App. */
const sent = (sets: readonly CapOp[], n: number): Promise<void> =>
  until(
    () => sets.length >= n,
    () => `${n} sets, got ${JSON.stringify(sets)}`,
  );

function mount(session: SessionController) {
  const r = render(<App createSession={() => session} model="qwen3" cwd="/tmp/work" />);
  const frame = (): string => r.lastFrame() ?? "";
  const see = (text: string): Promise<void> =>
    until(
      () => frame().includes(text),
      () => `«${text}» not in:\n${frame()}`,
    );
  const type = async (line: string): Promise<void> => {
    await delay(30);
    r.stdin.write(line);
    await delay(30);
    r.stdin.write("\r");
    await delay(30);
  };
  return { ...r, frame, see, type };
}

describe("/browser in the App (B6a)", () => {
  test("the sign shows while the browser is on; `▲ AUTO` appears only after the daemon's echo", async () => {
    const d = browserSession();
    const app = mount(d.session);
    await app.see("◉ chrome 1 tab");
    await app.type("/browser");
    await app.see("❯   [✓] Browser tools");
    expect(app.frame()).toContain("◉ connected");
    expect(app.frame()).toContain("space on/off · ↑↓ select · enter expand · esc close");
    app.stdin.write(DOWN);
    await app.see("❯   [ ] Act without asking");
    app.stdin.write(" ");
    await sent(d.sets, 1);
    expect(d.sets).toEqual([{ kind: "browser", name: "auto", enabled: true }]);
    // Not optimistic: no echo yet (a few frames given to a wrong flip to show).
    await delay(60);
    expect(app.frame()).toContain("❯   [ ] Act without asking");
    expect(app.frame()).not.toContain("▲ AUTO");

    d.echo(caps("auto"), "this-mac");
    await app.see("▲ AUTO");
    expect(app.frame()).toContain("❯   [✓] Act without asking");
    for (const answer of d.answers) answer();
    app.unmount();
  });

  test("a refused set says why; the panel and the bar stay as the daemon reported", async () => {
    const d = browserSession({ fail: new Error("this session has no browser") });
    const app = mount(d.session);
    await app.type("/browser clear");
    await app.see("Could not turn clear on: this session has no browser");
    expect(d.sets).toEqual([{ kind: "browser", name: "clear", enabled: true }]);
    expect(app.frame()).not.toContain("SECRETS VISIBLE");
    app.unmount();
  });

  test("`/browser off` is ONE group op; its own echo is not news, and the sign goes", async () => {
    const d = browserSession({ caps: caps("auto") });
    const app = mount(d.session);
    await app.see("▲ AUTO");
    await app.type("/browser off");
    await sent(d.sets, 1);
    expect(d.sets).toEqual([{ kind: "tool", name: "browser", enabled: false }]);
    d.echo(caps("auto", "masked", MEMBERS), "this-mac");
    await until(
      () => !app.frame().includes("chrome"),
      () => app.frame(),
    );
    expect(app.frame()).not.toContain("▲ AUTO");
    expect(app.frame()).not.toContain("turned off on");
    expect(app.frame()).not.toContain("tools off");
    app.unmount();
  });

  test("another device turning clear on converges here from the echo alone", async () => {
    const d = browserSession();
    const app = mount(d.session);
    await app.see("◉ chrome");
    d.echo(caps("ask", "clear"), "iPhone");
    await app.see("▲ SECRETS VISIBLE");
    expect(d.sets).toEqual([]);
    app.unmount();
  });

  test("status errors (an older daemon): link unknown, no count, the switches still work", async () => {
    const d = browserSession({
      status: () => Promise.reject(Object.assign(new Error("nope"), { code: -32601 })),
    });
    const app = mount(d.session);
    await app.see("◉ chrome");
    await app.type("/browser");
    await app.see("Browser · unknown");
    expect(app.frame()).toContain("Tabs unknown");
    expect(app.frame()).not.toMatch(/chrome \d/);
    app.stdin.write(" ");
    await sent(d.sets, 1);
    expect(d.sets).toEqual([{ kind: "tool", name: "browser", enabled: false }]);
    app.unmount();
  });

  test("a status that fails after a good one is shown unknown, not the old count", async () => {
    let broken = false;
    const d = browserSession({
      status: () =>
        broken ? Promise.reject(new Error("link down")) : Promise.resolve(connected(2)),
    });
    const app = mount(d.session);
    await app.see("◉ chrome 2 tabs");
    broken = true;
    d.echo(caps("auto"), "iPhone");
    await app.see("▲ AUTO");
    await until(
      () => !app.frame().includes("2 tabs"),
      () => app.frame(),
    );
    app.unmount();
  });

  test("a finished browser tool re-reads: the count follows", async () => {
    const d = browserSession();
    const app = mount(d.session);
    await app.see("◉ chrome 1 tab");
    await app.type("go");
    await app.see("◉ chrome 3 tabs");
    app.unmount();
  });

  test("opening the panel re-reads, and the open panel follows the answer", async () => {
    let n = 1;
    const d = browserSession({ status: () => Promise.resolve(connected(n)) });
    const app = mount(d.session);
    await app.see("◉ chrome 1 tab");
    n = 2;
    const before = d.reads.n;
    await app.type("/browser");
    await app.see("Tabs · 2");
    expect(d.reads.n).toBeGreaterThan(before);
    app.unmount();
  });

  test("an older answer landing late never overwrites a newer one", async () => {
    const waiting: ((s: BrowserStatusResult) => void)[] = [];
    const d = browserSession({
      status: () => new Promise((resolve) => waiting.push(resolve)),
    });
    const app = mount(d.session);
    await until(
      () => waiting.length === 1,
      () => `reads: ${waiting.length}`,
    );
    d.echo(caps("auto"), "iPhone");
    await until(
      () => waiting.length === 2,
      () => `reads: ${waiting.length}`,
    );
    waiting[1]?.(connected(5));
    await app.see("◉ chrome 5 tabs");
    waiting[0]?.(connected(9));
    await delay(60);
    expect(app.frame()).toContain("◉ chrome 5 tabs");
    app.unmount();
  });

  test("no browser (a pod, an older daemon): a notice, no sign, no read", async () => {
    const d = browserSession({
      caps: { disabledMcp: [], disabledSkills: [], disabledTools: [] },
    });
    const app = mount(d.session);
    await app.type("/browser");
    await app.see("No browser in this session.");
    await app.type("/browser auto");
    // Both commands answered: the notice twice.
    await until(
      () => app.frame().split("No browser in this session.").length === 3,
      () => app.frame(),
    );
    expect(d.sets).toEqual([]);
    expect(d.reads.n).toBe(0);
    expect(app.frame()).not.toContain("chrome");
    app.unmount();
  });
});
