/**
 * docs/feat/tui-clickable-links.md T8 — a click on a URL through the REAL App:
 * SGR press/release on screen cells in, the link opener port (or an inline
 * notice) out. Frames come from `ink-testing-library` (SGR stripped, AGENTS §6).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import type { LinkOpener } from "../src/os-open.ts";
import { inertSession } from "./session-stub.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const drag = (x: number, y: number): string => `\u001B[<32;${x};${y}M`;
const release = (x: number, y: number): string => `\u001B[<0;${x};${y}m`;
const WHEEL_UP = "\u001B[<64;10;5M";

/** Long enough to wrap at the harness's 100 columns. */
const URL_TEXT = `https://example.com/${"a".repeat(150)}/end`;
const HEAD = "https://example.com/aaa";

/** Poll the condition the next assertion reads; a timeout THROWS (AGENTS §9). */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (done()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** For an assertion that something did NOT happen: let the input be handled. */
const settle = () => new Promise((r) => setTimeout(r, 120));

const replying = (reply: string): SessionController =>
  ({
    ...inertSession(),
    async *send() {
      yield { type: "text", delta: reply };
      yield { type: "turn_end", reason: "end_turn" };
    },
  }) as unknown as SessionController;

function spyOpener(over: Partial<LinkOpener> = {}) {
  const opened: string[] = [];
  const opener: LinkOpener = {
    ssh: false,
    open: async (url) => {
      opened.push(url);
    },
    ...over,
  };
  return { opener, opened };
}

async function mount(reply: string, props: Partial<AppProps> = {}) {
  const copied: string[] = [];
  const session = replying(reply);
  const app = render(
    <App
      createSession={() => session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      clipboard={async (text) => {
        copied.push(text);
      }}
      {...props}
    />,
  );
  const rows = () => strip(app.lastFrame() ?? "").split("\n");
  /** The 1-based screen row holding `needle`, or 0. */
  const yOf = (needle: string) => rows().findIndex((r) => r.includes(needle)) + 1;
  await settle();
  app.stdin.write("zzprompt");
  await until(() => yOf("zzprompt") > 0, "the typed prompt");
  // The Enter handler is re-registered by an effect: give it a tick.
  await settle();
  app.stdin.write("\r");
  await until(() => yOf("LAST LINE") > 0, "the reply");
  await settle();
  const click = (x: number, y: number) => app.stdin.write(`${press(x, y)}${release(x, y)}`);
  return { app, rows, yOf, click, copied };
}

const SHORT = `plain words only\n\nsee ${URL_TEXT} then\n\nLAST LINE`;

describe("a click on a link in the transcript", () => {
  test("(a) on the URL's second row opens the whole URL, once", async () => {
    const spy = spyOpener();
    const t = await mount(SHORT, { linkOpener: spy.opener });
    const y = t.yOf(HEAD) + 1;
    expect(t.rows()[y - 1]).toStartWith("aaaa"); // really a continuation row
    // The underline survives Ink's own output pass.
    expect(t.app.lastFrame()?.split("\n")[y - 1]).toContain("\x1b[4maaaa");
    t.click(3, y);
    await until(() => spy.opened.length > 0, "the open");
    await settle();
    expect(spy.opened).toEqual([URL_TEXT]);
    t.app.unmount();
  });

  test("(b) on plain text opens nothing", async () => {
    const spy = spyOpener();
    const t = await mount(SHORT, { linkOpener: spy.opener });
    const y = t.yOf("plain words only");
    expect(y).toBeGreaterThan(0);
    t.click(5, y);
    await settle();
    expect(spy.opened).toEqual([]);
    t.app.unmount();
  });

  test("(c) scrolled up, the URL's new screen row opens it; the input box does not", async () => {
    const filler = (tag: string) =>
      Array.from({ length: 30 }, (_, i) => `${tag} ${i}`).join("\n\n");
    const spy = spyOpener();
    const t = await mount(
      `${filler("before")}\n\nsee ${URL_TEXT}\n\n${filler("after")}\n\nLAST LINE`,
      {
        linkOpener: spy.opener,
      },
    );
    expect(t.yOf(HEAD)).toBe(0); // off screen at the tail
    for (let i = 0; i < 60 && (t.yOf(HEAD) === 0 || t.yOf(HEAD) > 8); i += 1) {
      const before = t.rows().join("\n");
      t.app.stdin.write(WHEEL_UP);
      await until(() => t.rows().join("\n") !== before, "the scroll");
    }
    const y = t.yOf(HEAD);
    expect(y).toBeGreaterThan(0);
    // The input box, below the viewport.
    t.click(3, t.rows().length - 1);
    await settle();
    expect(spy.opened).toEqual([]);
    t.click(3, y + 1);
    await until(() => spy.opened.length > 0, "the open");
    expect(spy.opened).toEqual([URL_TEXT]);
    t.app.unmount();
  });

  test("(d) a failed open says so inline", async () => {
    const spy = spyOpener({ open: () => Promise.reject(new Error("open exited with code 1")) });
    const t = await mount(SHORT, { linkOpener: spy.opener });
    t.click(3, t.yOf(HEAD) + 1);
    await until(() => t.yOf("Couldn't open") > 0, "the notice");
    expect(t.rows().join("")).toContain("open exited with code 1");
    t.app.unmount();
  });

  test("(e) over SSH nothing is spawned, and the notice says why", async () => {
    const spy = spyOpener({ ssh: true });
    const t = await mount(SHORT, { linkOpener: spy.opener });
    t.click(3, t.yOf(HEAD) + 1);
    await until(() => t.yOf("Not opened: this TUI runs over SSH") > 0, "the notice");
    expect(spy.opened).toEqual([]);
    t.app.unmount();
  });

  test("(f) a drag across the URL selects it and opens nothing", async () => {
    const spy = spyOpener();
    const t = await mount(SHORT, { linkOpener: spy.opener });
    const y = t.yOf(HEAD) + 1;
    t.app.stdin.write(`${press(3, y)}${drag(20, y)}${release(20, y)}`);
    await until(() => t.copied.length > 0, "the copy");
    await settle();
    expect(spy.opened).toEqual([]);
    expect(t.copied[0]).toStartWith("aaaa");
    expect(t.copied[0]).not.toContain("\x1b");
    t.app.unmount();
  });

  test("(g) a session with no opener says so", async () => {
    const t = await mount(SHORT);
    t.click(3, t.yOf(HEAD) + 1);
    await until(() => t.yOf("No link opener in this session.") > 0, "the notice");
    t.app.unmount();
  });
});
