/**
 * docs/fix/tui-redraw-flash.md: each Ink frame is ONE synchronized update
 * (DEC mode 2026), so a terminal cannot paint between the frame's erase-all
 * and its redraw.
 *
 * Mounts `App` with Ink's REAL, non-debug `render` (`ink-testing-library` forces
 * `debug: true`, which skips `log-update`, the code that writes the frames).
 *
 * Non-vacuity (mutation-checked, see the doc's Execution): T1 red with an
 * identity `write`; T2 red with `rows` copied at wrap time; T3 red with the wrap
 * dropped from `run.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import { App } from "../src/App.tsx";
import { BSU, ESU, synchronizedStdout } from "../src/sync-output.ts";
import { inertSession } from "./session-stub.ts";

/** A fake TTY stdout that records every write. */
class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  writes: string[] = [];
  write = (chunk: unknown, ..._rest: unknown[]): boolean => {
    this.writes.push(String(chunk));
    return true;
  };
}

/** The `ink-testing-library` stdin shape: `write` → `readable` + `data`. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (d: string): void => {
    this.data = d;
    this.emit("readable");
    this.emit("data", d);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (s: string, needle: string): number => s.split(needle).length - 1;
/** A frame write: Ink's erase-lines prefix or its clear-terminal branch. */
const isFrame = (w: string): boolean => w.includes("\x1b[2K") || w.includes("\x1b[2J");

/** Mount `App` on `fake` through the wrapper, in a turn that never ends ("Thinking…"). */
async function mountThinking(fake: FakeTty) {
  const stdin = new FakeStdin();
  const createSession = () => ({
    ...inertSession(),
    async *send() {
      await new Promise(() => {});
    },
  });
  const instance = render(
    // biome-ignore lint/suspicious/noExplicitAny: the hanging stub is only the members App calls in this path
    <App createSession={createSession as any} model="qwen3" cwd="/tmp/work" />,
    {
      stdout: synchronizedStdout(fake) as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await delay(100);
  stdin.write("hi");
  await delay(50);
  stdin.write("\r");
  await delay(200);
  return instance;
}

describe("synchronized output around Ink frames", () => {
  test("T1: every frame while Thinking is one complete BSU…ESU update", async () => {
    const fake = new FakeTty();
    const instance = await mountThinking(fake);
    fake.writes = [];
    await delay(400);
    instance.unmount();
    const frames = fake.writes.filter(isFrame);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const w of frames) {
      expect(w.startsWith(BSU)).toBe(true);
      expect(w.endsWith(ESU)).toBe(true);
      expect(count(w, BSU)).toBe(1);
      expect(count(w, ESU)).toBe(1);
    }
  });

  test("T2: a resize through the wrapper re-lays the frame out to the new rows", async () => {
    const fake = new FakeTty();
    const instance = await mountThinking(fake);
    fake.rows = 24;
    fake.columns = 80;
    fake.writes = [];
    fake.emit("resize");
    await delay(300);
    instance.unmount();
    const frames = fake.writes.filter(isFrame);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const last = frames[frames.length - 1] ?? "";
    // Strip BSU/ESU and Ink's erase / clear prefix, keep the frame's rows.
    let body = last.split(BSU).join("").split(ESU).join("");
    const prefixes = ["\x1b[2K", "\x1b[1A", "\x1b[G", "\x1b[2J", "\x1b[3J", "\x1b[H"];
    for (let p = prefixes.find((x) => body.startsWith(x)); p; ) {
      body = body.slice(p.length);
      p = prefixes.find((x) => body.startsWith(x));
    }
    const rows = (body.endsWith("\n") ? body.slice(0, -1) : body).split("\n").length;
    expect(rows).toBeLessThanOrEqual(23);
  });

  test("T3: startTui hands Ink the wrapped stdout under the fullscreen gate", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "run.tsx"), "utf8");
    const options = /\{\s*stdin,[\s\S]*?exitOnCtrlC: false,\s*\}/.exec(src)?.[0] ?? "";
    expect(options).toMatch(/stdout:\s*fullscreen\s*\?\s*\(?synchronizedStdout\(process\.stdout\)/);
  });
});

describe("synchronizedStdout unit", () => {
  test("a non-empty string becomes one bracketed write; rest is forwarded", () => {
    const fake = new FakeTty();
    const seen: unknown[][] = [];
    fake.write = (chunk: unknown, ...rest: unknown[]) => {
      seen.push([chunk, ...rest]);
      return true;
    };
    const cb = () => {};
    synchronizedStdout(fake).write("frame", "utf8", cb);
    expect(seen).toEqual([[`${BSU}frame${ESU}`, "utf8", cb]]);
  });

  test("an empty string or a non-string passes through untouched", () => {
    const fake = new FakeTty();
    const seen: unknown[] = [];
    fake.write = (chunk: unknown) => {
      seen.push(chunk);
      return true;
    };
    const bytes = new Uint8Array([1, 2]);
    const out = synchronizedStdout(fake);
    out.write("");
    out.write(bytes);
    expect(seen).toEqual(["", bytes]);
  });

  test("columns/rows/isTTY are live and listeners land on the real stream", () => {
    const fake = new FakeTty();
    const out = synchronizedStdout(fake);
    fake.rows = 12;
    fake.columns = 40;
    expect(out.rows).toBe(12);
    expect(out.columns).toBe(40);
    expect(out.isTTY).toBe(true);
    let fired = 0;
    const onResize = () => {
      fired++;
    };
    expect(out.on("resize", onResize)).toBe(out);
    fake.emit("resize");
    out.off("resize", onResize);
    fake.emit("resize");
    expect(fired).toBe(1);
    expect(fake.listenerCount("resize")).toBe(0);
  });
});
