/**
 * docs/feat/app-decomposition.md S6 — the attachments' EXECUTOR moved to
 * `useAttachments.ts`. The behaviour itself is pinned by the untouched
 * `attach-app.test.tsx` (30 cases, unedited — the behaviour-preservation proof);
 * this file pins what a MOVE can silently break and a rendering assertion would
 * not catch:
 *
 * 1. **The serialization chain** (`attachChainRef`): one decision at a time, so a
 *    second paste's `existing` sees the first one's chips. Without the chain, two
 *    pastes of the SAME path both read `existing: []`, both pass the duplicate
 *    check, and the draft ends with two identical chips.
 * 2. **Freshness of the draft** (Fable H3): a decision reads `attachRef.current`,
 *    the ref the App and the mouse/submit layers also write, NEVER the render
 *    closure's `attach` — which two chunks with no render between would leave
 *    stale.
 * 3. **The mode is asked at DECISION time** off the LIVE session
 *    (`sessionRef.current`), not captured once: a session whose answer changes
 *    (the seam came or went) is obeyed on the next paste.
 *
 * Each test is red under the one-line mutation named in its title; the `M<n>`
 * tags match the slice's mutation table in the task doc.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { FileProbe, ProbedFile } from "../src/attach-files.ts";
import type { SessionEvent } from "../src/state.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0,
]);
/** A second, DIFFERENT image (its ref's `id` is the bytes' hash, so it is not a duplicate). */
const PNG2 = new Uint8Array([...PNG, 1]);

/** A `FileProbe` over a fixed map, counting reads (so "no disk" stays provable). */
function probeOf(files: Record<string, Uint8Array>): FileProbe & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(path: string): Promise<ProbedFile | null> {
      reads.push(path);
      const bytes = files[path];
      return bytes === undefined ? null : { kind: "file", size: bytes.length, bytes };
    },
  };
}

/** A session whose turns end at once; `mode` may change between calls (see test 3). */
function fakeSession(opts: { mode?: () => "upload" | "off" }): SessionController {
  return {
    send() {
      return (async function* (): AsyncIterable<SessionEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "turn_end", reason: "end_turn" as never };
      })();
    },
    imageInput() {
      return (opts.mode ?? (() => "upload"))() === "off"
        ? { kind: "off" as const, reason: "the seam is gone" }
        : { kind: "upload" as const, maxBytes: 4 * 1024 * 1024 };
    },
    async attachImage(bytes: Uint8Array, meta: { mimeType: string; name?: string }) {
      const ref: AttachmentRef = {
        id: Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .padEnd(64, "0")
          .slice(0, 64),
        mimeType: meta.mimeType,
        size: bytes.length,
      };
      return ref;
    },
  };
}

/** The attach row's own line (what the draft holds), or "" when there is none. */
const attachRowLine = (frame: string): string =>
  frame.split("\n").find((line) => line.includes("📎")) ?? "";

const mount = (session: SessionController, files: Record<string, Uint8Array>) => {
  const probe = probeOf(files);
  const app = render(
    <App
      createSession={() => session}
      model="m"
      cwd="/tmp/work"
      columns={100}
      fileProbe={probe}
      home="/home/u"
      localCwd="/work"
    />,
  );
  return { app, probe, frame: () => strip(app.lastFrame() ?? "") };
};

const A = "/tmp/a.png";
const B = "/tmp/b.png";

describe("S6: one decision at a time, off the LIVE draft", () => {
  // Two pastes written in ONE tick: no render separates them, so a decision that
  // read the render closure's `attach` would see the draft as it was BEFORE the
  // first paste's chips (M1), and one that dropped the chain would run both
  // decisions concurrently against `existing: []` (M2). Either way the duplicate
  // check cannot fire and the draft ends with two identical chips.
  test("two pastes of the same path in one tick ship ONE chip and say it is a duplicate", async () => {
    const { app, probe, frame } = mount(fakeSession({}), { [A]: PNG });
    await delay(40);
    app.stdin.write(`${PASTE_START}${A}${PASTE_END}`);
    app.stdin.write(`${PASTE_START}${A}${PASTE_END}`);
    await delay(400);
    const out = frame();
    expect(probe.reads).toEqual([A, A]); // both probed: the second was a real decision
    expect(out).toContain("this image is already attached");
    const row = attachRowLine(out);
    expect(row).toContain("a.png");
    // ONE chip: the row names the image once, so the duplicate never landed.
    expect(row.match(/a\.png/g) ?? []).toHaveLength(1);
    app.unmount();
  });
});

describe("S6: a result that lands after the unmount is dropped", () => {
  // M7: the generation guard removed — the late continuation then runs on a dead
  // component: `setAttach` on an unmounted App, and worse, `run` called on a
  // session this TUI no longer owns (a turn started by a closed window).
  test("an upload that lands AFTER the unmount starts no turn and settles no chip", async () => {
    let release: (() => void) | undefined;
    let sent = 0;
    const session: SessionController = {
      send() {
        sent += 1;
        return (async function* (): AsyncIterable<SessionEvent> {
          yield { type: "turn_end", reason: "end_turn" as never };
        })();
      },
      imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
      async attachImage(bytes: Uint8Array) {
        await new Promise<void>((r) => {
          release = r;
        });
        return { id: "a".repeat(64), mimeType: "image/png", size: bytes.length };
      },
    };
    const { app } = mount(session, { [A]: PNG });
    await delay(40);
    app.stdin.write(`${PASTE_START}${A}${PASTE_END}`);
    await delay(200); // the chip exists
    app.stdin.write("what?");
    await delay(20);
    app.stdin.write("\r");
    await delay(150); // the upload is in flight and held
    expect(sent).toBe(0);
    app.unmount();
    await delay(20);
    // The upload's promise resolves anyway (a server that answered a closed
    // window): the continuation must notice the generation moved.
    release?.();
    await delay(120);
    expect(sent).toBe(0);
  });
});

describe("S6: the mode comes from the live session, at decision time", () => {
  // M3: `attachMode` captured once (a `useMemo`, or a value read at mount) keeps
  // answering the first session's "off" after the seam appears — the second
  // paste would then be refused too, and no chip would ever exist.
  test("a session that gains its image seam is obeyed on the NEXT paste", async () => {
    let answers = 0;
    const session = fakeSession({
      mode: () => {
        answers += 1;
        return answers === 1 ? "off" : "upload";
      },
    });
    const { app, frame } = mount(session, { [A]: PNG, [B]: PNG2 });
    await delay(40);
    app.stdin.write(`${PASTE_START}${A}${PASTE_END}`);
    await delay(250);
    // The seam's answer off: the reason is said, and nothing is attached.
    expect(frame()).toContain("images are off");
    expect(attachRowLine(frame())).toBe("");
    app.stdin.write(`${PASTE_START}${B}${PASTE_END}`);
    await delay(250);
    const row = attachRowLine(frame());
    expect(row).toContain("b.png");
    app.unmount();
  });
});
