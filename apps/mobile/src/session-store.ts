/**
 * The session screen's store (docs/feat/mobile-ui-fluidity-s3.md): the screen's
 * state cut into SLICES, one per part of the screen, each keeping its identity
 * while nothing it reads has changed — so a streamed token wakes only the
 * transcript. The render coalescer lives inside (`publish("stream")`).
 *
 * A publish carries no data: `read()` at fire time is the latest state, so a
 * coalesced or queued publish never loses anything.
 *
 * Pure and React-free (AGENTS §7): the state, the clock and the timer are
 * injected.
 */
import { type ChildReport, reportsOf } from "./activity-memory.ts";
import { createRenderCoalescer } from "./render-coalesce.ts";
import type { SessionScreenState } from "./session-screen-controller.ts";
import type { SessionView } from "./session-view.ts";

export type SliceKey = "rows" | "header" | "composer" | "hub" | "sheets";

export const SLICE_KEYS: readonly SliceKey[] = ["rows", "header", "composer", "hub", "sheets"];

type TopFact = Exclude<keyof SessionScreenState, "view">;
type ViewFact = `view.${keyof SessionView}`;
export type SliceFact = TopFact | ViewFact;

/**
 * Which slices carry each fact. TOTAL over the state and its view: a new field
 * does not compile until somebody says which parts of the screen read it. A
 * slice's TYPE follows this table, so reading a fact it does not carry does not
 * compile either.
 */
export const SLICE_FACTS = {
  status: ["rows", "header"],
  transcript: ["rows"],
  draft: ["composer"],
  notice: ["composer"],
  sheet: ["header", "sheets"],
  askQueued: ["header", "sheets"],
  askAutoAccepted: ["sheets"],
  thumbnails: ["rows"],
  compose: ["composer", "sheets"],
  info: ["hub", "sheets"],
  riskStrip: ["composer"],
  renaming: ["header", "sheets"],
  sends: ["rows", "composer"],
  activity: ["hub", "sheets"],
  schedules: ["hub", "sheets"],
  refreshing: ["rows", "sheets"],
  catalogue: ["hub"],
  artifacts: ["rows", "hub"],
  slot: ["rows", "hub"],
  commands: ["hub", "sheets"],
  "view.title": ["header"],
  "view.project": ["header"],
  "view.headerModel": ["header"],
  "view.headerFolder": ["header"],
  "view.headerContext": ["header"],
  "view.state": ["rows", "header"],
  "view.banner": ["rows", "header"],
  "view.retry": ["header"],
  "view.reopen": ["header"],
  "view.rows": ["rows"],
  "view.turn": ["rows"],
  "view.composer": ["rows", "composer", "hub", "sheets"],
  "view.editable": ["composer"],
  "view.queued": ["composer"],
  "view.returnedOthers": ["composer"],
  "view.outbox": ["composer"],
  "view.photos": ["composer"],
  "view.notices": ["composer"],
  "view.pending": ["rows", "composer"],
  "view.editing": ["composer"],
  "view.unqueueOff": ["composer"],
} as const satisfies { readonly [K in SliceFact]: readonly SliceKey[] };

/**
 * The facts compared by reference: big, or already replaced only when they
 * change. Every other fact is compared structurally (`sameData`).
 */
export const REF_FACTS: ReadonlySet<SliceFact> = new Set<SliceFact>([
  "transcript",
  "view.rows",
  "thumbnails",
  "artifacts",
  "sheet",
]);

type FactsOf<K extends SliceKey> = {
  [F in SliceFact]: K extends (typeof SLICE_FACTS)[F][number] ? F : never;
}[SliceFact];
type ViewNames<F> = F extends `view.${infer N}` ? N & keyof SessionView : never;
type SliceData<K extends SliceKey> = Pick<SessionScreenState, FactsOf<K> & TopFact> & {
  readonly view: Pick<SessionView, ViewNames<FactsOf<K>>>;
};

/**
 * Facts DERIVED from a bigger one that a slice must not carry whole (the
 * transcript changes on every delta; these do not).
 */
interface HeaderDerived {
  readonly link: "up" | "down";
  readonly closed: SessionScreenState["transcript"]["closed"];
  readonly running: boolean;
  readonly asking: boolean;
}
interface HubDerived {
  readonly link: "up" | "down";
  readonly turn: SessionScreenState["transcript"]["turn"];
  readonly closed: SessionScreenState["transcript"]["closed"];
  /**
   * The sub-agent reports in the transcript, as ENTRIES: `reportsOf` answers a
   * `Map`, which `sameData` compares by reference (a fresh one per delta).
   */
  readonly reports: readonly (readonly [string, ChildReport])[];
}

export type RowsSlice = SliceData<"rows">;
export type HeaderSlice = SliceData<"header"> & HeaderDerived;
export type ComposerSlice = SliceData<"composer">;
export type HubSlice = SliceData<"hub"> & HubDerived;
export type SheetsSlice = SliceData<"sheets">;

export interface SessionSlices {
  readonly rows: RowsSlice;
  readonly header: HeaderSlice;
  readonly composer: ComposerSlice;
  readonly hub: HubSlice;
  readonly sheets: SheetsSlice;
}

/** The slices of a state, as FRESH objects (identity is `keepSlices`' job). */
export function deriveSlices(s: SessionScreenState): SessionSlices {
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of SLICE_KEYS) {
    out[key] = { view: {} };
  }
  const top = s as unknown as Record<string, unknown>;
  const view = s.view as unknown as Record<string, unknown>;
  for (const [fact, keys] of Object.entries(SLICE_FACTS)) {
    for (const key of keys) {
      const slice = out[key] as Record<string, unknown>;
      if (fact.startsWith("view.")) {
        const name = fact.slice("view.".length);
        (slice.view as Record<string, unknown>)[name] = view[name];
      } else {
        slice[fact] = top[fact];
      }
    }
  }
  const { link, turn, closed } = s.transcript;
  Object.assign(out.header as object, {
    link,
    closed,
    running: s.view.composer.running,
    asking: s.sheet.kind === "asking",
  });
  Object.assign(out.hub as object, {
    link,
    turn,
    closed,
    reports: [...reportsOf(s.transcript.rows)],
  });
  return out as unknown as SessionSlices;
}

/**
 * Whether two values are surely the same DATA: plain objects, arrays and
 * primitives, compared structurally. Anything else (a function, a `Map`, a
 * `Set`, a class instance) only equals itself. It may answer "different" for
 * equal values (one extra render), never "same" for different ones (a stale
 * pane).
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameData(item, b[i]))
    );
  }
  if (!isPlain(a) || !isPlain(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

/** The previous slice object wherever nothing the slice carries changed. */
export function keepSlices(prev: SessionSlices | null, next: SessionSlices): SessionSlices {
  if (prev === null) {
    return next;
  }
  const out = {} as Record<SliceKey, unknown>;
  for (const key of SLICE_KEYS) {
    out[key] = sameSlice(prev[key], next[key]) ? prev[key] : next[key];
  }
  return out as unknown as SessionSlices;
}

/** Whether every member of two slices is equal under its fact's policy. */
function sameSlice(a: object, b: object, prefix = ""): boolean {
  const before = a as Record<string, unknown>;
  const after = b as Record<string, unknown>;
  const keys = Object.keys(after);
  return (
    keys.length === Object.keys(before).length &&
    keys.every((key) => {
      if (prefix === "" && key === "view") {
        return sameSlice(before.view as object, after.view as object, "view.");
      }
      // A derived member is not in `REF_FACTS`: it is compared as data.
      return REF_FACTS.has(`${prefix}${key}` as SliceFact)
        ? Object.is(before[key], after[key])
        : sameData(before[key], after[key]);
    })
  );
}

export interface SessionStore {
  /** `stream` is coalesced (`render-coalesce.ts`); `now` fires at once. */
  publish(cause: "stream" | "now"): void;
  /** The slice as last published (derived on the first call). */
  get<K extends SliceKey>(key: K): SessionSlices[K];
  /** `fn` runs only when THAT slice's identity changed. */
  subscribe(key: SliceKey, fn: () => void): () => void;
  /** Every publish, with the whole state, BEFORE the slice listeners. */
  onPublish(fn: (state: SessionScreenState) => void): () => void;
  /** Drop a pending publish; later publishes do nothing. */
  dispose(): void;
}

export interface SessionStoreDeps {
  readonly read: () => SessionScreenState;
  readonly clock: () => number;
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly windowMs?: number;
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  let slices: SessionSlices | null = null;
  let disposed = false;
  let firing = false;
  /** Publishes raised while one is firing: drained after it, in order. */
  let queued = 0;
  const whole = new Set<(state: SessionScreenState) => void>();
  const bySlice = new Map<SliceKey, Set<() => void>>(SLICE_KEYS.map((key) => [key, new Set()]));

  const current = (): SessionSlices => {
    slices ??= deriveSlices(deps.read());
    return slices;
  };

  const publishOnce = (): void => {
    const full = deps.read();
    const prev = slices;
    const next = keepSlices(prev, deriveSlices(full));
    slices = next;
    for (const fn of whole) {
      fn(full);
    }
    for (const key of SLICE_KEYS) {
      if (prev === null || prev[key] !== next[key]) {
        for (const fn of bySlice.get(key) ?? []) {
          fn();
        }
      }
    }
  };

  const fire = (): void => {
    if (disposed) {
      return;
    }
    if (firing) {
      queued += 1;
      return;
    }
    firing = true;
    try {
      publishOnce();
      while (queued > 0 && !disposed) {
        queued -= 1;
        publishOnce();
      }
    } finally {
      firing = false;
      queued = 0;
    }
  };

  const coalescer = createRenderCoalescer({
    fire,
    clock: deps.clock,
    schedule: deps.schedule,
    ...(deps.windowMs === undefined ? {} : { windowMs: deps.windowMs }),
  });

  return {
    publish(cause) {
      if (disposed) {
        return;
      }
      if (cause === "stream") {
        coalescer.soon();
      } else {
        coalescer.now();
      }
    },
    get: (key) => current()[key],
    subscribe(key, fn) {
      const set = bySlice.get(key);
      set?.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
    onPublish(fn) {
      whole.add(fn);
      return () => {
        whole.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      coalescer.dispose();
      whole.clear();
      for (const set of bySlice.values()) {
        set.clear();
      }
    },
  };
}
