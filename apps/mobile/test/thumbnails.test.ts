/**
 * Image thumbnails (12b; the owner's added requirement): the DECISION module is
 * `thumbnails.ts`; this file pins the two rules the requirement names —
 * never beyond the visible rows, and never the same image twice — plus the
 * failure modes a fetch has (arrive, fail, be scrolled away).
 *
 * `ThumbnailSource` is an injected port and is FAKE here: the channel has no
 * method that reads an image back yet (`docs/feat/attachments-upload.md`,
 * "nothing reads bytes back over the wire"), so there is no real one to use and
 * a fake is the honest test of the decisions.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_CACHED,
  MAX_IN_FLIGHT,
  PREFETCH_ROWS,
  type ThumbnailSource,
  type ThumbnailState,
  aborted,
  drive,
  failed,
  initialThumbnails,
  loaded,
  plan,
  thumbnailFor,
  visibleRefs,
} from "../src/thumbnails.ts";
import type { ImageRef, UserRow } from "../src/transcript.ts";

function ref(name: string): ImageRef {
  return { id: `${"a".repeat(63)}${name}`, mimeType: "image/png", size: 10, name: `${name}.png` };
}

function userRow(images: readonly ImageRef[]): UserRow {
  return { kind: "user", key: `k-${images[0]?.id ?? "none"}`, text: "look", images };
}

const NOTICE = { kind: "notice", key: "n", text: "a notice" };

describe("only the visible rows' images are wanted", () => {
  const rows = [
    userRow([ref("1")]),
    NOTICE,
    userRow([ref("2")]),
    userRow([ref("3")]),
    NOTICE,
    userRow([ref("4")]),
  ];

  test("a window's rows plus PREFETCH_ROWS either side", () => {
    const wanted = visibleRefs(rows, 2, 2).map((image) => image.name);
    expect(wanted).toEqual(["1.png", "2.png", "3.png", "4.png"]);
    // ... and a narrow window far from the top does NOT drag the whole history in.
    const many = Array.from({ length: 100 }, (_, at) => userRow([ref(`${at}`)]));
    const near = visibleRefs(many, 50, 52);
    expect(near).toHaveLength(1 + PREFETCH_ROWS * 2 + 2);
  });

  test("a row with no images contributes nothing, and a duplicate id is one request", () => {
    const shared = ref("shared");
    const withDupe = [userRow([shared]), NOTICE, userRow([shared])];
    expect(visibleRefs(withDupe, 0, 2)).toHaveLength(1);
    expect(visibleRefs([NOTICE, NOTICE], 0, 1)).toHaveLength(0);
  });

  test("the window is clamped at both ends (no negative or past-the-end indexes)", () => {
    // The WINDOW is clamped, then pre-fetched `PREFETCH_ROWS` either side of it —
    // which is what makes a flick upward instant rather than blank. So a window
    // ending before row 0, or starting past the end, still resolves to real rows.
    expect(visibleRefs(rows, -5, 0).map((image) => image.name)).toEqual([
      "1.png",
      "2.png",
      "3.png",
      "4.png",
    ]);
    expect(visibleRefs(rows, 5, 99).map((image) => image.name)).toEqual([
      "1.png",
      "2.png",
      "3.png",
      "4.png",
    ]);
    // And a window in the middle does NOT reach the whole list.
    const many = Array.from({ length: 40 }, (_, at) => userRow([ref(`${at}`)]));
    expect(visibleRefs(many, 20, 20).length).toBeLessThan(40);
  });
});

describe("plan: what to start, what to abandon", () => {
  const rows = [userRow([ref("1")]), userRow([ref("2")]), userRow([ref("3")])];

  test("an unchanged window starts nothing the second time (idempotent)", () => {
    const controller = new AbortController();
    const first = plan(initialThumbnails, rows, 0, 2, controller.signal);
    expect(first.start.map((request) => request.ref.name)).toEqual(["1.png", "2.png", "3.png"]);
    const second = plan(first.state, rows, 0, 2, controller.signal);
    expect(second.start).toHaveLength(0);
  });

  test("requests in flight are bounded", () => {
    const many = Array.from({ length: 20 }, (_, at) => userRow([ref(`${at}`)]));
    const step = plan(initialThumbnails, many, 0, 19, new AbortController().signal);
    expect(step.start).toHaveLength(MAX_IN_FLIGHT);
    expect(step.state.inFlight).toHaveLength(MAX_IN_FLIGHT);
  });

  test("a request scrolled out of the window is abandoned, a visible one is not", () => {
    const controller = new AbortController();
    const started = plan(initialThumbnails, rows, 0, 2, controller.signal);
    const moved = plan(started.state, rows, 2, 2, controller.signal);
    // Row 2 (image 3) is still in the window; 1 and 2 are PREFETCH_ROWS away or less.
    expect(moved.abort).toEqual([]);
    const far = Array.from({ length: 100 }, (_, at) => userRow([ref(`${at}`)]));
    const wide = plan({ ...initialThumbnails, inFlight: ["far"] }, far, 50, 52, controller.signal);
    expect(wide.abort).toEqual(["far"]);
  });

  test("an image already loaded or already failed is never requested", () => {
    const controller = new AbortController();
    const withLoaded: ThumbnailState = {
      ...initialThumbnails,
      loaded: [{ id: ref("1").id, uri: "file://1" }],
    };
    const step = plan(withLoaded, rows, 0, 2, controller.signal);
    expect(step.start.map((request) => request.ref.name)).toEqual(["2.png", "3.png"]);
    const withFailed: ThumbnailState = { ...initialThumbnails, failed: [ref("2").id] };
    expect(plan(withFailed, rows, 0, 2, controller.signal).start.map((r) => r.ref.name)).toEqual([
      "1.png",
      "3.png",
    ]);
  });
});

describe("outcomes", () => {
  test("loaded thumbnails are found by id and the cache is bounded", () => {
    let state: ThumbnailState = initialThumbnails;
    for (let at = 0; at < MAX_CACHED + 5; at += 1) {
      state = loaded(state, { id: `id-${at}`, uri: `file://${at}` });
    }
    expect(state.loaded).toHaveLength(MAX_CACHED);
    expect(thumbnailFor(state, "id-0")).toBeUndefined(); // the oldest fell out
    expect(thumbnailFor(state, `id-${MAX_CACHED + 4}`)?.uri).toBe(`file://${MAX_CACHED + 4}`);
  });

  test("a completed request leaves the in-flight set", () => {
    const started: ThumbnailState = { ...initialThumbnails, inFlight: ["x"] };
    expect(loaded(started, { id: "x", uri: "file://x" }).inFlight).toEqual([]);
  });

  test("a failure is recorded once and never retried", () => {
    const once = failed({ ...initialThumbnails, inFlight: ["x"] }, "x");
    expect(once.failed).toEqual(["x"]);
    expect(once.inFlight).toEqual([]);
    expect(failed(once, "x").failed).toEqual(["x"]);
  });

  test("an abandoned request is not a failure (it may be wanted again)", () => {
    const state = aborted({ ...initialThumbnails, inFlight: ["x"] }, "x");
    expect(state.failed).toEqual([]);
    expect(state.inFlight).toEqual([]);
  });
});

describe("drive: the port", () => {
  /** A fake source that answers from a table, and records every call. */
  function fakeSource(answers: Readonly<Record<string, string | null>>): ThumbnailSource & {
    readonly calls: readonly string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (image: ImageRef) => {
        calls.push(image.id);
        const uri = answers[image.name ?? ""];
        if (uri === undefined) {
          throw new Error("no answer");
        }
        return uri === null ? null : { id: image.id, uri };
      },
    };
  }

  test("an answer becomes a thumbnail", async () => {
    const rows = [userRow([ref("1")]), userRow([ref("2")])];
    const source = fakeSource({ "1.png": "file://1", "2.png": "file://2" });
    let state: ThumbnailState = initialThumbnails;
    drive(state, source, rows, 0, 1, new AbortController().signal, (next) => {
      state = next;
    });
    await Bun.sleep(1);
    expect(source.calls).toHaveLength(2);
    expect(thumbnailFor(state, ref("1").id)?.uri).toBe("file://1");
  });

  test("a null answer is a failure (the bytes are not showable)", async () => {
    const rows = [userRow([ref("1")]), userRow([ref("2")])];
    const source = fakeSource({ "1.png": "file://1", "2.png": null });
    let state: ThumbnailState = initialThumbnails;
    drive(state, source, rows, 0, 1, new AbortController().signal, (next) => {
      state = next;
    });
    await Bun.sleep(1);
    expect(state.failed).toEqual([ref("2").id]);
    expect(state.inFlight).toEqual([]);
  });

  test("two answers landing together both land (the second never overwrites the first)", async () => {
    // The bug this pins: `drive` applied each outcome to the state `plan`
    // returned, so with MAX_IN_FLIGHT requests open the second answer's write
    // dropped the first's thumbnail.
    const rows = [userRow([ref("1")]), userRow([ref("2")])];
    const source = fakeSource({ "1.png": "file://1", "2.png": "file://2" });
    let state: ThumbnailState = initialThumbnails;
    drive(state, source, rows, 0, 1, new AbortController().signal, (next) => {
      state = next;
    });
    await Bun.sleep(1);
    expect(thumbnailFor(state, ref("1").id)?.uri).toBe("file://1");
    expect(thumbnailFor(state, ref("2").id)?.uri).toBe("file://2");
  });

  test("a throwing source is a failure, not an unhandled rejection", async () => {
    const rows = [userRow([ref("9")])];
    const source = fakeSource({});
    let state: ThumbnailState = initialThumbnails;
    drive(state, source, rows, 0, 0, new AbortController().signal, (next) => {
      state = next;
    });
    await Bun.sleep(1);
    expect(state.failed).toEqual([ref("9").id]);
  });
});
