import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  type ProbeStream,
  type ProbeTimer,
  probeBackground,
} from "../src/terminal-background-probe.ts";
import { canProbe as canProbeNow } from "../src/terminal-background.ts";

/**
 * Fix round 2, Review MEDIUM 1 (docs/feat/tui-light-theme.md): what the user
 * types during the probe window must reach Ink BYTE-IDENTICAL.
 *
 * The probe reads the terminal's bytes and hands the non-reply ones back with
 * `unshift`. Those bytes are whatever the keyboard produced, so for anything
 * outside ASCII they are a UTF-8 SEQUENCE: `è` is `C3 A8`, `😀` is
 * `F0 9F 98 9D`. Two ways to break them, both caught here:
 *
 *  - handing back a re-encoded string (`unshift("Ã¨")` → `C3 83 C2 A8`);
 *  - reading a UTF-8 continuation byte as a C1 control: the `9D` inside `😀`
 *    was an 8-bit OSC introducer, so the emoji lost its last byte to the guard.
 *
 * The stream here is a REAL `node:stream` `Readable` (only `setRawMode` added),
 * not the fake: `unshift`/`read` encoding is exactly what the fix hinges on, and
 * the fake records a string where the real one records bytes.
 */

const ok = { stdinTty: true, stdoutTty: true, term: "xterm-256color", chalkLevel: 3 };

/** A real `Readable` standing in for a tty: its `read`/`unshift` are Node's own. */
class TtyStream extends Readable implements ProbeStream {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  override _read(): void {
    // Nothing to pull: the test pushes, as a tty would.
  }
  /** `Buffer` and `Uint8Array` differ only in typing; the stream wants bytes. */
  pushBytes(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }
}

/** A manual clock: the test decides when the timeout fires. */
function fakeTimer(): { timer: ProbeTimer; fire: () => void } {
  let pending: (() => void) | null = null;
  return {
    timer: {
      set(callback) {
        pending = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear() {
        pending = null;
      },
    },
    fire: () => {
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

/** Let the stream's `readable` listener run, as the tty would after a key press. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Drain what the probe left for Ink, as BYTES (no encoding set anywhere). */
function drain(stream: Readable): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = stream.read();
    if (chunk === null) {
      break;
    }
    chunks.push(new Uint8Array(Buffer.from(chunk as string, "utf8")));
  }
  return chunks;
}

/** The drained bytes, concatenated. */
const all = (chunks: readonly Uint8Array[]): Uint8Array =>
  chunks.reduce((acc, next) => {
    const out = new Uint8Array(acc.length + next.length);
    out.set(acc, 0);
    out.set(next, acc.length);
    return out;
  }, new Uint8Array(0));

/** A `Buffer`'s bytes as a plain `Uint8Array` (the same bytes, no `Buffer` typing). */
const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

describe("MEDIUM 1: a UTF-8 key typed in the probe window comes back byte-identical", () => {
  for (const typed of ["è", "😀", "aè😀b"]) {
    test(`"${typed}" survives the hand-over whole`, async () => {
      const stdin = new TtyStream();
      const timer = fakeTimer();
      const handle = probeBackground({
        stdin,
        write: () => {},
        canProbe: canProbeNow(ok),
        timer: timer.timer,
      });
      const bytes = bytesOf(typed);
      stdin.pushBytes(bytes);
      await settle();
      // A mute terminal: the timeout is the hand-over point.
      timer.fire();
      const result = await handle.wait();
      expect(result.late).toBe(true);
      // Mutation: `unshift(rest)` with the string (no encoding) → `è` comes back as
      // `C3 83 C2 A8`; keeping the 8-bit forms → `😀` loses its `9D`.
      expect(all(drain(stdin))).toEqual(bytes);
    });
  }

  test("a character SPLIT across two chunks still comes back whole", async () => {
    // A tty `read()` returns whatever is buffered, which can be ONE byte, so a
    // 4-byte emoji can arrive as `F0` + `9F 98 9D`. Decoding each chunk alone
    // turns the first into U+FFFD and drops the rest.
    // Mutation: `chunk.toString("utf8")` per chunk → `EF BF BD 9F 98 9D` here.
    const stdin = new TtyStream();
    const timer = fakeTimer();
    const handle = probeBackground({
      stdin,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: timer.timer,
    });
    const bytes = bytesOf("😀");
    stdin.pushBytes(bytes.subarray(0, 1));
    await settle();
    stdin.pushBytes(bytes.subarray(1));
    await settle();
    timer.fire();
    await handle.wait();
    expect(all(drain(stdin))).toEqual(bytes);
  });

  test("a reply in the SAME chunk is still stripped, and the key before it is intact", async () => {
    // The sentinel path, not the timeout: the reply goes, the typed bytes stay.
    const stdin = new TtyStream();
    const handle = probeBackground({
      stdin,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: fakeTimer().timer,
    });
    const typed = bytesOf("è");
    const reply = bytesOf("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1;2c");
    stdin.pushBytes(all([typed, reply]));
    await settle();
    const result = await handle.wait();
    expect(result.color).toEqual([255, 255, 255]);
    expect(all(drain(stdin))).toEqual(typed);
  });
});
