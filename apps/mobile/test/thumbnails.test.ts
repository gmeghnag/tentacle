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
import { PREVIEW_MAX_BYTES } from "../src/artifact-preview.ts";
import {
  MAX_CACHED,
  MAX_IN_FLIGHT,
  PREFETCH_ROWS,
  type ThumbnailDriver,
  type ThumbnailSource,
  type ThumbnailState,
  aborted,
  artifactPreviewRef,
  createThumbnailDriver,
  failed,
  gone,
  initialThumbnails,
  loaded,
  plan,
  thumbnailFor,
  visibleRefs,
} from "../src/thumbnails.ts";
import type { ImageRef, ToolRow, UserRow } from "../src/transcript.ts";

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

  test("a presented IMAGE on a tool row is wanted too (model-artifacts D9, Owner Q6)", () => {
    const card = (over: Record<string, unknown>): ToolRow => ({
      kind: "tool",
      key: "t",
      id: "call-1",
      name: "present",
      label: "present",
      args: "",
      status: "ok",
      artifact: {
        artifactId: "a",
        version: 1,
        sha256: "b".repeat(64),
        size: 1000,
        mimeType: "image/png",
        kind: "image",
        title: "chart.png",
        callId: "call-1",
        createdAt: 0,
        ...over,
      },
    });
    expect(visibleRefs([card({})], 0, 0).map((ref) => ref.id)).toEqual(["b".repeat(64)]);
    // Over the preview cap (docs/feat/mobile-file-preview-cards.md: 5 MiB) it
    // draws its symbol: it is opened, not fetched.
    expect(visibleRefs([card({ size: PREVIEW_MAX_BYTES + 1 })], 0, 0)).toHaveLength(0);
    // A PDF / HTML / markdown is previewed too now; a zip never is.
    expect(
      visibleRefs([card({ kind: "html", mimeType: "text/html", size: 10 })], 0, 0),
    ).toHaveLength(1);
    expect(
      visibleRefs([card({ kind: "other", mimeType: "application/zip", size: 10 })], 0, 0),
    ).toHaveLength(0);
  });

  test("a presented artifact's ref is keyed by its sha, the title only a label", () => {
    const ref = artifactPreviewRef({
      artifactId: "a",
      version: 1,
      sha256: "b".repeat(64),
      size: 10,
      mimeType: "image/png",
      kind: "image",
      title: "übersicht.png",
      callId: "call-1",
      createdAt: 0,
    });
    expect(ref.id).toBe("b".repeat(64));
    expect(ref.name).toBe("übersicht.png");
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

describe("the driver applies each outcome to a thumbnail", () => {
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
    const { driver, state } = mount(source);
    driver.view(rows, 0, 1);
    await settle();
    expect(source.calls).toHaveLength(2);
    expect(thumbnailFor(state(), ref("1").id)?.uri).toBe("file://1");
  });

  test("a null answer is a failure (the bytes are not showable)", async () => {
    const rows = [userRow([ref("1")]), userRow([ref("2")])];
    const source = fakeSource({ "1.png": "file://1", "2.png": null });
    const { driver, state } = mount(source);
    driver.view(rows, 0, 1);
    await settle();
    expect(state().failed).toEqual([ref("2").id]);
    expect(state().inFlight).toEqual([]);
  });

  test("two answers landing together both land (the second never overwrites the first)", async () => {
    // The bug this pins (M8): each outcome was applied to the state `plan`
    // returned, so with MAX_IN_FLIGHT requests open the second answer's write
    // dropped the first's thumbnail.
    const rows = [userRow([ref("1")]), userRow([ref("2")])];
    const source = fakeSource({ "1.png": "file://1", "2.png": "file://2" });
    const { driver, state } = mount(source);
    driver.view(rows, 0, 1);
    await settle();
    expect(thumbnailFor(state(), ref("1").id)?.uri).toBe("file://1");
    expect(thumbnailFor(state(), ref("2").id)?.uri).toBe("file://2");
  });
});

/**
 * Drain the microtask queue the way an RN frame would: `settle` runs inside
 * promise callbacks, so the assertions below run after they have landed.
 */
async function settle(): Promise<void> {
  await Bun.sleep(1);
}

/** A mounted screen's driver, with its latest state kept for assertions. */
function mount(
  source: ThumbnailSource,
  unmount: AbortSignal = new AbortController().signal,
): { readonly driver: ThumbnailDriver; readonly state: () => ThumbnailState } {
  let state: ThumbnailState = initialThumbnails;
  const driver = createThumbnailDriver(
    source,
    (next) => {
      state = next;
    },
    unmount,
  );
  return { driver, state: () => state };
}

describe("the driver: a source that says the bytes are GONE", () => {
  test("`gone` is a failure (never retried) AND marks the id gone", async () => {
    let calls = 0;
    const { driver, state } = mount({
      fetch: async () => {
        calls += 1;
        return "gone";
      },
    });
    const rows = [userRow([ref("1")])];
    driver.view(rows, 0, 0);
    await settle();
    expect(state().failed).toEqual([ref("1").id]);
    expect(state().gone).toEqual([ref("1").id]);
    driver.view(rows, 0, 0);
    await settle();
    expect(calls).toBe(1);
  });

  test("`gone` is idempotent and a plain failure is not gone", () => {
    const once = gone(initialThumbnails, "x");
    expect(gone(once, "x").gone).toEqual(["x"]);
    expect(failed(initialThumbnails, "y").gone).toBeUndefined();
  });
});

describe("the driver: one state and one controller table per screen", () => {
  /** A source that never settles on its own: the test decides when and how. */
  function deferredSource(): {
    readonly source: ThumbnailSource;
    readonly calls: readonly {
      readonly id: string;
      readonly signal: AbortSignal;
      readonly resolve: (thumb: { id: string; uri: string } | null) => void;
    }[];
  } {
    const calls: {
      id: string;
      signal: AbortSignal;
      resolve: (thumb: { id: string; uri: string } | null) => void;
    }[] = [];
    return {
      calls,
      source: {
        fetch: (image: ImageRef, signal: AbortSignal) =>
          new Promise((resolve) => {
            calls.push({ id: image.id, signal, resolve });
          }),
      },
    };
  }

  const many = Array.from({ length: 200 }, (_, at) => userRow([ref(`${at}`)]));

  test("a window change ABANDONS the fetches it scrolled away from", () => {
    // Finding 1 (review round 1). Before the fix every request got the SAME
    // shared signal, so `plan.abort` only dropped ids from `inFlight`: the
    // fetches kept running, three window changes left 12 requests open while
    // `inFlight` said 4, and "never downloaded beyond the visible rows" was false.
    const { source, calls } = deferredSource();
    const { driver, state } = mount(source);
    for (const first of [0, 60, 120]) {
      driver.view(many, first, first + 2);
    }
    const live = calls.filter((call) => !call.signal.aborted);
    expect(live).toHaveLength(MAX_IN_FLIGHT);
    expect(calls.filter((call) => call.signal.aborted)).toHaveLength(8);
    expect(state().inFlight).toHaveLength(MAX_IN_FLIGHT);
    // The still-wanted ones are the LAST window's, never an earlier one's.
    expect(live.map((call) => call.id)).toEqual(
      many
        .slice(112, 123)
        .flatMap((row) => (row as UserRow).images ?? [])
        .map((image) => image.id)
        .slice(0, MAX_IN_FLIGHT),
    );
  });

  test("an abandoned fetch that arrives late is NOT cached", async () => {
    const { source, calls } = deferredSource();
    const { driver, state } = mount(source);
    driver.view(many, 0, 2);
    driver.view(many, 150, 152);
    calls.find((call) => call.id === ref("0").id)?.resolve({ id: ref("0").id, uri: "file://0" });
    await settle();
    expect(state().loaded).toEqual([]);
  });

  test("a settle from an EARLIER window never rolls back a later one", async () => {
    // Finding 2 (review round 1): each `drive` call captured its own `current`,
    // so a settle from window A wrote A's state over everything window D
    // produced — D's visible thumbnail vanished, and D's ids were re-requested.
    const { source, calls } = deferredSource();
    const { driver, state } = mount(source);
    driver.view(many, 0, 2);
    driver.view(many, 150, 152);
    calls
      .find((call) => call.id === ref("142").id)
      ?.resolve({ id: ref("142").id, uri: "file://142" });
    await settle();
    expect(state().loaded.map((thumb) => thumb.uri)).toEqual(["file://142"]);
    const inFlightAfterLater = [...state().inFlight];
    calls.find((call) => call.id === ref("0").id)?.resolve({ id: ref("0").id, uri: "file://0" });
    await settle();
    expect(state().loaded.map((thumb) => thumb.uri)).toEqual(["file://142"]);
    expect(state().inFlight).toEqual(inFlightAfterLater);
  });

  test("unmount aborts every request still in flight", () => {
    const { source, calls } = deferredSource();
    const unmount = new AbortController();
    const { driver } = mount(source, unmount.signal);
    driver.view(many, 0, 2);
    unmount.abort();
    expect(calls.filter((call) => !call.signal.aborted)).toHaveLength(0);
  });

  test("a signal that already fired leaves nothing running", () => {
    const { source, calls } = deferredSource();
    const unmount = new AbortController();
    unmount.abort();
    const { driver } = mount(source, unmount.signal);
    driver.view(many, 0, 2);
    expect(calls.filter((call) => !call.signal.aborted)).toHaveLength(0);
  });

  test("a throwing source is a failure, not an unhandled rejection", async () => {
    const source: ThumbnailSource = {
      fetch: async () => {
        throw new Error("no answer");
      },
    };
    const { driver, state } = mount(source);
    driver.view([userRow([ref("9")])], 0, 0);
    await settle();
    expect(state().failed).toEqual([ref("9").id]);
  });
});

describe("the driver notifies only on a changed plan", () => {
  // The screen asks for its window on every new `rows` (the FlatList effect).
  // An unchanged window must be silent: a commit per ask rendered the screen
  // twice for each streamed update (docs/feat/mobile-ui-fluidity-s1.md).
  function counting(): {
    readonly source: ThumbnailSource;
    /** The requests the driver started, each answerable by index. */
    readonly answers: ((thumb: { id: string; uri: string }) => void)[];
  } {
    const answers: ((thumb: { id: string; uri: string }) => void)[] = [];
    return {
      source: {
        fetch: () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      },
      answers,
    };
  }

  test("an unchanged window is silent; a start, a settle and an abort-only step each commit once", async () => {
    let commits = 0;
    const counted = counting();
    const driver = createThumbnailDriver(
      counted.source,
      () => {
        commits += 1;
      },
      new AbortController().signal,
    );
    const rows = [
      userRow([ref("a")]),
      ...Array.from({ length: 40 }, () => NOTICE),
      userRow([ref("b")]),
    ];
    driver.view([NOTICE], 0, 0);
    expect(commits).toBe(0);
    driver.view(rows, 0, 0); // start a
    driver.view(rows, 0, 0); // unchanged, a in flight: nothing to notify
    expect(commits).toBe(1);
    counted.answers[0]?.({ id: ref("a").id, uri: "file:a" });
    await settle();
    driver.view(rows, 0, 0); // unchanged, a loaded: nothing to notify
    expect(commits).toBe(2);
    driver.view(rows, 41, 41); // start b
    expect(commits).toBe(3);
    driver.view([NOTICE], 0, 0); // abort b only
    expect(commits).toBe(4);
    expect(driver.state().inFlight).toEqual([]);
  });

  test("a queued image still starts at the next unchanged window, and that commits", async () => {
    let commits = 0;
    const counted = counting();
    const driver = createThumbnailDriver(
      counted.source,
      () => {
        commits += 1;
      },
      new AbortController().signal,
    );
    // One row more images than the in-flight bound: the rest queue, and the next
    // ask for the same window starts one — a real change, so it commits (the
    // guard must skip the notification, never the step).
    const many = userRow(Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) => ref(String(i))));
    driver.view([many], 0, 0);
    expect(commits).toBe(1);
    counted.answers[0]?.({ id: ref("0").id, uri: "file:0" });
    await settle();
    expect(commits).toBe(2);
    driver.view([many], 0, 0);
    expect(commits).toBe(3);
    expect(driver.state().inFlight).toHaveLength(MAX_IN_FLIGHT);
  });
});
