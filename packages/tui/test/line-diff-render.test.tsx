/**
 * docs/fix/tui-line-diff-render.md — the row diff on the REAL `App` and Ink's real,
 * non-debug renderer (`ink-testing-library` forces `debug: true`, which skips
 * `log-update`, the code that writes the frames).
 *
 * T1: a Thinking tick repaints only the changed row (the bug's property).
 * T6: what the user SEES is unchanged — every write of Ink and its diffed
 *     replacement are fed to two VT screen models; after each write both grids
 *     and both cursors are identical.
 *
 * Non-vacuity (mutation-checked, see the doc's Execution): T1 red with an
 * identity wrapper; T6 red with an off-by-one up-move and with the final
 * move-down dropped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import chalk from "chalk";
import { render } from "ink";
import { App } from "../src/App.tsx";
import { lineDiffStdout } from "../src/line-diff.ts";
import { messagesToItems } from "../src/resume.ts";
import { BSU, ESU, synchronizedStdout } from "../src/sync-output.ts";
import { inertSession } from "./session-stub.ts";

/** A fake TTY stdout that records every write. */
class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  writes: string[] = [];
  onWrite: (s: string) => void = () => {};
  write = (chunk: unknown, ..._rest: unknown[]): boolean => {
    const s = String(chunk);
    this.writes.push(s);
    this.onWrite(s);
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

/**
 * A minimal VT screen: the escapes Ink and `lineDiffStdout` emit (`ESC[2K`,
 * `ESC[nA/B`, `ESC[G`, `\r`, `\n` as CR+LF, `ESC[2J`, `ESC[3J`, `ESC[H`), SGR and
 * private modes ignored, one cell per code point, autowrap and scroll.
 */
class Screen {
  grid: string[][];
  r = 0;
  c = 0;
  constructor(
    readonly rows: number,
    readonly cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank());
  }
  private blank(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }
  private lineFeed(): void {
    if (this.r === this.rows - 1) {
      this.grid.shift();
      this.grid.push(this.blank());
    } else this.r++;
  }
  feed(s: string): void {
    for (let i = 0; i < s.length; ) {
      const ch = s[i] ?? "";
      if (ch === "\x1b") {
        const m = /^\x1b\[([?0-9;:]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) throw new Error(`unmodelled escape at ${JSON.stringify(s.slice(i, i + 12))}`);
        const [all, arg = "", op] = m;
        const n = Math.max(1, Number(arg) || 1);
        if (op === "A") this.r = Math.max(0, this.r - n);
        else if (op === "B") this.r = Math.min(this.rows - 1, this.r + n);
        else if (op === "G") this.c = n - 1;
        else if (op === "H") [this.r, this.c] = [0, 0];
        else if (op === "K" && arg === "2") this.grid[this.r] = this.blank();
        else if (op === "J" && arg === "2") this.grid = Array.from({ length: this.rows }, () => this.blank());
        else if (!(op === "m" || (op === "J" && arg === "3") || arg.startsWith("?")))
          throw new Error(`unmodelled CSI ${JSON.stringify(all)}`);
        i += all.length;
        continue;
      }
      const cp = String.fromCodePoint(s.codePointAt(i) ?? 32);
      i += cp.length;
      if (cp === "\r") this.c = 0;
      else if (cp === "\n") {
        this.c = 0;
        this.lineFeed();
      } else {
        if (this.c >= this.cols) {
          this.c = 0;
          this.lineFeed();
        }
        const row = this.grid[this.r];
        if (row) row[this.c] = cp;
        this.c++;
      }
    }
  }
  /** The visible state: every row, and the cursor (pending-wrap collapsed to the last column). */
  snapshot(): string {
    const lines = this.grid.map((row) => row.join("").trimEnd());
    return `${lines.join("\n")}\n@${this.r},${Math.min(this.c, this.cols - 1)}`;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const unwrap = (w: string): string => (w.startsWith(BSU) && w.endsWith(ESU) ? w.slice(BSU.length, -ESU.length) : w);

type Send = () => AsyncGenerator<unknown>;
const hang: Send = async function* () {
  await new Promise(() => {});
};

/**
 * Mount `App` with `stdout` (the wrapped fake), a styled transcript taller than the
 * screen, then submit "hi" — the turn runs `send`.
 */
async function mount(stdout: unknown, send: Send = hang) {
  const stdin = new FakeStdin();
  const createSession = () => ({ ...inertSession(), send });
  const msgs = Array.from({ length: 40 }, (_, k) => ({
    role: k % 2 ? "assistant" : "user",
    content: `**line** ${k} \`code\` `.repeat(3),
  }));
  const instance = render(
    <App
      // biome-ignore lint/suspicious/noExplicitAny: the stub is only the members App calls in this path
      createSession={createSession as any}
      model="qwen3"
      cwd="/tmp/work"
      // biome-ignore lint/suspicious/noExplicitAny: plain test messages
      initialItems={messagesToItems(msgs as any)}
    />,
    {
      stdout: stdout as NodeJS.WriteStream,
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
  return { instance, stdin };
}

// Colour on, as on a real terminal: SGR in every row is what the diff must survive.
let level: typeof chalk.level = 0;
beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

describe("row diff on the real renderer", () => {
  test("T1: a Thinking tick repaints only the changed row, no full erase", async () => {
    const fake = new FakeTty();
    const { instance } = await mount(lineDiffStdout(synchronizedStdout(fake)));
    fake.writes = [];
    await delay(400);
    instance.unmount();
    // Every tick, not just the unmount's final frame.
    const ticks = fake.writes.slice(0, -1);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const w of ticks) {
      expect(w.startsWith(BSU) && w.endsWith(ESU)).toBe(true);
      expect(w).not.toContain("\x1b[2J");
      expect(count(w, "\x1b[2K")).toBeLessThanOrEqual(1);
    }
  });

  test("T6: after every write, the screen and cursor equal Ink's full repaint", async () => {
    const fake = new FakeTty();
    const full = new Screen(fake.rows, fake.columns);
    const diffed = new Screen(fake.rows, fake.columns);
    const mismatches: number[] = [];
    let n = 0;
    let diffedWrites = 0;
    fake.onWrite = (s) => diffed.feed(unwrap(s));
    const inner = lineDiffStdout(synchronizedStdout(fake));
    // Tee: Ink's own bytes go to `full`, then through the row diff to `diffed`.
    const tee = Object.assign(Object.create(inner), {
      write: (chunk: unknown, ...rest: unknown[]) => {
        full.feed(String(chunk));
        const before = fake.writes.length;
        const ok = inner.write(chunk, ...rest);
        if (unwrap(fake.writes[before] ?? "") !== String(chunk)) diffedWrites++;
        if (full.snapshot() !== diffed.snapshot()) mismatches.push(n);
        n++;
        return ok;
      },
    });
    // Text streams after a short Thinking: several rows change per frame.
    const send: Send = async function* () {
      await delay(250);
      for (let k = 0; k < 40; k++) {
        await delay(10);
        yield { type: "text", delta: k % 7 === 6 ? "\n" : `tok${k} ` };
      }
      await new Promise(() => {});
    };
    const { instance, stdin } = await mount(tee, send);
    await delay(700);
    for (const ch of "abc") {
      stdin.write(ch);
      await delay(40);
    }
    await delay(100);
    instance.unmount();
    expect(n).toBeGreaterThanOrEqual(10);
    // Non-vacuous: most writes went through the diff, and colour is on.
    expect(diffedWrites).toBeGreaterThanOrEqual(n / 2);
    expect(fake.writes.some((w) => /\x1b\[[0-9;]*m/.test(w))).toBe(true);
    expect(mismatches).toEqual([]);
  });
});
