/**
 * The native sheets' DECISIONS (docs/feat/mobile-native-sheets.md D3), pure and
 * React-free (AGENTS §7): which sheet is up, at which detent, and the ONE next
 * step of the reconcile loop. The route (`screens/NativeSheetRoute.tsx`) and the
 * session screen only render and apply what these return, so every rule below is
 * pinned by `test/sheet-plan.test.ts` instead of on a simulator.
 *
 * The specs exist because `react-native-screens` DEV-ASSERTS its input
 * (`src/components/helpers/sheet.tsx:11-19` unsorted detents, `:58-66` an
 * out-of-range undimmed index, `:92-99` an out-of-range initial index): a bad
 * table would throw at the first presentation on a simulator only. Here the
 * table cannot be unsorted and every index goes through `clampDetent`.
 *
 * Two facts from the plan's simulator spike shape the rules:
 * - **A lower sheet is never popped** (F4): popping the route BELOW the top
 *   removes BOTH natively, and the upper route is lost from state — so its close
 *   handler would run for a sheet the person did not dismiss. `reconcile` only
 *   ever pops the top, and `dismissedNatively` treats everything a planned pop
 *   removed as collateral.
 * - **`inactive` is the load-bearing drain trigger** (Step 0b, L1): iOS suspends
 *   JS after `inactive`, so `background` is not reliably delivered. Hence
 *   `sheetHidden` is "locked OR not active", and the drain never waits for a
 *   transition.
 */
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { DENSE_FONT_SCALE } from "./theme.ts";

/**
 * The two ground tokens a sheet route paints with, both `Palette` keys: `bg` is
 * the banded ground the four user sheets share, `sheet` the ask's own surface.
 */
export type SheetGround = "bg" | "sheet";

/** The five sheets that become stack routes (D1). */
export type SheetKind = "permission" | "outbox" | "commands" | "tools" | "info";

/** Every kind (for exhaustive loops; the bottom→top order is `desiredStack`'s). */
export const SHEET_KINDS: readonly SheetKind[] = [
  "outbox",
  "commands",
  "tools",
  "info",
  "permission",
];

/**
 * One sheet's native presentation (the per-sheet table, Owner Q1: S/M/L =
 * 0.3/0.5/1.0 of the maximum detent height for all five).
 */
export interface SheetSpec {
  /** `sheetAllowedDetents`, ASCENDING — RNS dev-throws otherwise. */
  readonly detents: readonly number[];
  /** `sheetInitialDetentIndex` at a normal font scale and with no reveal. */
  readonly initial: number;
  /** `sheetLargestUndimmedDetentIndex`: -1 = dimmed at every detent (Owner Q2). */
  readonly dimmed: number;
  /** The native grabber replaces the one the JS sheet drew. */
  readonly grabber: boolean;
}

const DETENTS: readonly number[] = [0.3, 0.5, 1.0];
const MIDDLE = 1;

/**
 * The per-sheet table. Outbox opens at M, not S: its title, quote and five pills
 * (≈ 420 pt) do not fit 0.3 (Owner Q1).
 */
export const SHEET_SPEC: Record<SheetKind, SheetSpec> = {
  permission: { detents: DETENTS, initial: MIDDLE, dimmed: -1, grabber: true },
  outbox: { detents: DETENTS, initial: MIDDLE, dimmed: -1, grabber: true },
  commands: { detents: DETENTS, initial: MIDDLE, dimmed: -1, grabber: true },
  tools: { detents: DETENTS, initial: MIDDLE, dimmed: -1, grabber: true },
  info: { detents: DETENTS, initial: MIDDLE, dimmed: -1, grabber: true },
};

/** The last valid index of a spec's detent list. */
function lastDetent(spec: SheetSpec): number {
  return spec.detents.length - 1;
}

/**
 * A detent index the spec can present: a non-integer or non-finite one falls
 * back to the spec's own initial, anything else is clamped into range. This is
 * the only way an index reaches `sheetOptions`, so RNS's dev assert cannot fire.
 */
export function clampDetent(spec: SheetSpec, index: number): number {
  if (!Number.isInteger(index)) {
    return clampDetent(spec, spec.initial);
  }
  return Math.min(Math.max(index, 0), lastDetent(spec));
}

/** What decides the OPENING detent (`initialDetent`). */
export interface DetentContext {
  /** `PixelRatio.getFontScale()` — Dynamic Type. */
  readonly fontScale: number;
  /** Session info opened with a reveal (a section to land on): the list needs room. */
  readonly reveal?: boolean;
  /** A remembered detent (`openingDetent`): wins over the spec's. */
  readonly detent?: number;
}

/**
 * The detent a sheet opens at. The spec's index; one step up at a dense font
 * scale (`DENSE_FONT_SCALE`, Dynamic Type needs the room); the LARGEST when
 * Session info opens with a reveal — nothing else, because that is the one
 * opening that scrolls inside the sheet.
 */
export function initialDetent(kind: SheetKind, ctx: DetentContext): number {
  const spec = SHEET_SPEC[kind];
  const largest = lastDetent(spec);
  if (kind === "info" && ctx.reveal === true) {
    return largest;
  }
  const dense = Number.isFinite(ctx.fontScale) && ctx.fontScale >= DENSE_FONT_SCALE;
  return clampDetent(spec, dense ? spec.initial + 1 : spec.initial);
}

/**
 * Whether the native sheet can be swiped/backdrop-dismissed. Only a permission
 * ask IN PROGRESS is held (D5, Owner Q2): its dismissal semantics are "withdraw
 * and send nothing", which needs an explicit "Not now" button, not a gesture the
 * person may make by accident. `returned` is free again.
 */
export function sheetGestureEnabled(kind: SheetKind, asking: boolean): boolean {
  return !(kind === "permission" && asking);
}

/**
 * The route's options for one kind (`Stack.Screen options`). Every index passes
 * `clampDetent`, so RNS's dev asserts are unreachable; `contentStyle` is not set
 * here (the route resolves `sheetGround` through the palette).
 */
export function sheetOptions(
  kind: SheetKind,
  ctx: DetentContext & { readonly asking?: boolean },
): NativeStackNavigationOptions {
  const spec = SHEET_SPEC[kind];
  const opening =
    ctx.detent === undefined ? initialDetent(kind, ctx) : clampDetent(spec, ctx.detent);
  return {
    headerShown: false,
    presentation: "formSheet",
    sheetAllowedDetents: [...spec.detents],
    sheetInitialDetentIndex: opening,
    sheetLargestUndimmedDetentIndex: spec.dimmed,
    sheetGrabberVisible: spec.grabber,
    sheetExpandsWhenScrolledToEdge: true,
    gestureEnabled: sheetGestureEnabled(kind, ctx.asking === true),
  };
}

/** The palette token the route paints its ground with (D3 "Colours"). */
export function sheetGround(kind: SheetKind): SheetGround {
  return kind === "permission" ? "sheet" : "bg";
}

/**
 * The sheet the person opened through the session UI. At most ONE may be up
 * (commands, tools or info): they are three ways into the same session, and the
 * plan's "sheet over sheet" rule pops the old one before the new one is pushed.
 */
export type UserSheet = "commands" | "tools" | "info";

/** What the session screen knows, in the form the stack is derived from. */
export interface DesiredInput {
  /** The one user sheet that is open, if any. */
  readonly user: UserSheet | null;
  /** The outbox decision is waiting for an owner decision. */
  readonly outbox: boolean;
  /** A permission ask is on screen (`SheetState.kind === "asking"`). */
  readonly permission: boolean;
}

/**
 * The stack the person's state WANTS, bottom→top: the user sheet, the outbox
 * above it, the ask always on top (F4: it must never be popped under a sheet the
 * person is reading).
 */
export function desiredStack(input: DesiredInput): SheetKind[] {
  const stack: SheetKind[] = [];
  if (input.user !== null) {
    stack.push(input.user);
  }
  if (input.outbox) {
    stack.push("outbox");
  }
  if (input.permission) {
    stack.push("permission");
  }
  return stack;
}

/** One route in the navigation state, as the reconcile loop sees it. */
export interface SheetEntry {
  readonly kind: SheetKind;
  readonly key: string;
}

/** What the loop may do in one pass: push the first missing kind, or pop the top. */
export type SheetStep =
  | { readonly action: "push"; readonly kind: SheetKind }
  | { readonly action: "pop"; readonly key: string };

/** The two states that gate the loop. */
export interface ReconcileGate {
  /** `sheetHidden`: locked, or the app is not active — drain everything, now. */
  readonly hidden: boolean;
  /** A presentation is in flight: one step at a time, nothing new. */
  readonly transitioning: boolean;
}

/**
 * ONE next step, or `null` when the stack already matches.
 *
 * - **hidden** → pop the TOP, and do not wait for a transition: the drain must be
 *   finished ~before the app-switcher snapshot (Step 0b L1: ~6 ms after
 *   `inactive`), and `desired` is untouched, so the same sheets re-push after the
 *   unlock. Never a push while hidden.
 * - **transitioning** → nothing.
 * - otherwise → pop the top while there is anything above the wanted prefix,
 *   else push the first missing kind. Only the TOP is ever popped (F4), so a
 *   swap converges pops-first and never flashes.
 */
export function reconcile(
  desired: readonly SheetKind[],
  actual: readonly SheetEntry[],
  gate: ReconcileGate,
): SheetStep | null {
  if (gate.hidden) {
    const top = actual[actual.length - 1];
    return top === undefined ? null : { action: "pop", key: top.key };
  }
  if (gate.transitioning) {
    return null;
  }
  let i = 0;
  while (i < actual.length && i < desired.length && actual[i]?.kind === desired[i]) {
    i++;
  }
  if (i < actual.length) {
    // Something is extra (or wrong) at or above `i`: the top goes first.
    const top = actual[actual.length - 1];
    return top === undefined ? null : { action: "pop", key: top.key };
  }
  const wanted = desired[i];
  return wanted === undefined ? null : { action: "push", kind: wanted };
}

/**
 * The kinds the person SWIPED away between two states. A key the screen popped
 * itself (`plannedPop`) is not a dismissal, and neither is anything ABOVE it
 * (F4: a lower pop removes both routes natively — reporting the upper one would
 * run its close handler, e.g. the outbox's "Not now" or the ask's `dismiss()`).
 */
export function dismissedNatively(
  prev: readonly SheetEntry[],
  next: readonly SheetEntry[],
  plannedPop: readonly string[],
): SheetKind[] {
  const stillThere = new Set(next.map((e) => e.key));
  const collateralFrom = prev.length;
  let cutoff = collateralFrom;
  for (let i = 0; i < prev.length; i++) {
    const key = prev[i]?.key;
    if (key !== undefined && plannedPop.includes(key)) {
      cutoff = Math.min(cutoff, i);
    }
  }
  const gone: SheetKind[] = [];
  for (let i = 0; i < prev.length; i++) {
    const entry = prev[i];
    if (entry === undefined || stillThere.has(entry.key) || i >= cutoff) {
      continue;
    }
    if (!gone.includes(entry.kind)) {
      gone.push(entry.kind);
    }
  }
  return gone;
}

/** How many sheet identities keep their detent (a bounded, oldest-out store). */
export const DETENT_MEMORY_MAX = 16;

/**
 * The last STABLE detent per sheet identity (D3). Held outside React, like the
 * reveal's tracker (`reveal-report.ts`): a `sheetDetentChange` writes it, a
 * re-push reads it. Identity is the kind for the user sheets and the ask's
 * request id for Permission — so a re-delivery of the SAME ask on resume
 * (Step 0b L3: `idle → asking` for ~70 ms) re-opens at its detent instead of
 * resetting to the spec's, while a DIFFERENT ask opens fresh.
 */
export interface DetentMemory {
  /** `identity key → detent index`, oldest first. */
  readonly seen: Map<string, number>;
}

/** A fresh store. */
export function createDetentMemory(): DetentMemory {
  return { seen: new Map() };
}

/** The key an identity is remembered under (a separator no id can contain). */
function memoryKey(kind: SheetKind, identity: string | null): string {
  return `${kind}\u0000${identity ?? ""}`;
}

/** Remember the stable detent of one sheet identity, evicting the oldest past the cap. */
export function rememberDetent(
  memory: DetentMemory,
  kind: SheetKind,
  identity: string | null,
  index: number,
): void {
  const key = memoryKey(kind, identity);
  // Re-inserting moves it to the newest slot, so a sheet in use is never evicted.
  memory.seen.delete(key);
  memory.seen.set(key, clampDetent(SHEET_SPEC[kind], index));
  while (memory.seen.size > DETENT_MEMORY_MAX) {
    const oldest = memory.seen.keys().next();
    if (oldest.done === true) {
      break;
    }
    memory.seen.delete(oldest.value);
  }
}

/** The remembered detent of an identity, or `null` if it has none. */
export function rememberedDetent(
  memory: DetentMemory,
  kind: SheetKind,
  identity: string | null,
): number | null {
  return memory.seen.get(memoryKey(kind, identity)) ?? null;
}

/**
 * The detent a (re)push opens at: the identity's remembered one if it has any,
 * else the spec's / the font scale's / the reveal's (`initialDetent`).
 */
export function openingDetent(
  memory: DetentMemory | null,
  kind: SheetKind,
  identity: string | null,
  ctx: DetentContext,
): number {
  const remembered = memory === null ? null : rememberedDetent(memory, kind, identity);
  return remembered ?? initialDetent(kind, ctx);
}

/**
 * An intent that needs its sheet GONE first, because what it opens is an RN
 * `Modal` and a Modal may not open while a native sheet is up (F6b wedges the
 * navigator for every later presentation).
 */
export type AfterDismissIntent = "rename" | "artifacts";

/** Which sheet each intent has to leave (`renameFromCommands`, info → Artifacts). */
export const INTENT_SHEET: Record<AfterDismissIntent, UserSheet> = {
  rename: "commands",
  artifacts: "info",
};

/** Queue an intent (idempotent, in order: two paths may ask for the same one). */
export function queueAfterDismiss(
  queue: readonly AfterDismissIntent[],
  intent: AfterDismissIntent,
): AfterDismissIntent[] {
  return queue.includes(intent) ? [...queue] : [...queue, intent];
}

/** What may run now, and what still has to wait. */
export interface ReadyIntents {
  readonly run: AfterDismissIntent[];
  readonly rest: AfterDismissIntent[];
}

/**
 * The intents to run: only with no sheet up (or once the close's
 * `transitionEnd {closing:true}` has landed — the closed route can still be in
 * the navigation state there) and with no transition in flight.
 */
export function readyIntents(
  queue: readonly AfterDismissIntent[],
  actual: readonly SheetEntry[],
  gate: { readonly transitioning: boolean; readonly closingDone?: boolean },
): ReadyIntents {
  const ready = !gate.transitioning && (actual.length === 0 || gate.closingDone === true);
  return ready ? { run: [...queue], rest: [] } : { run: [], rest: [...queue] };
}

/**
 * True while an RN `Modal` must stay closed: a native sheet is up, or one is
 * about to be pushed. A stale `visible` Modal wedges EVERY later formSheet (F6),
 * so the surfaces that are RN Modals (the hub/session action sheets, Activity,
 * Rename) are hidden rather than left drawn. Rename's text survives in the
 * controller, so nothing the person typed is lost.
 */
export function yieldForeign(
  desired: readonly SheetKind[],
  actual: readonly SheetEntry[],
): boolean {
  return desired.length > 0 || actual.length > 0;
}

/**
 * Whether this session is what the person is looking at — for the voice gates,
 * which today read `useIsFocused()` alone. A sheet route on top BLURS Session,
 * so without this an ask's auto-read would stop exactly when its own sheet opens.
 */
export function sessionInFront(focused: boolean, actual: readonly SheetEntry[]): boolean {
  return focused || actual.length > 0;
}

/** The app activity `AppState` reports (`AppStateStatus`, minus its RN typing). */
export type AppActivity = "active" | "inactive" | "background" | "unknown" | "extension";

/**
 * Whether the sheet stack must be DRAINED right now (Owner decision A, Step 0b).
 *
 * `locked` is the lock instance's OWN value (never `AppShell`'s render-time
 * `lockView`, which the spike proved stale), and it gates the `active`-while-locked
 * window; `inactive` is the load-bearing leg, because iOS may suspend JS before
 * delivering `background`. Together they cover the app-switcher snapshot, the
 * Face ID prompt, Control Center and a call banner — the accepted price of never
 * showing session content in the switcher (Owner answer 1, Step 0b).
 */
export function sheetHidden(locked: boolean, activity: AppActivity): boolean {
  return locked || activity !== "active";
}
