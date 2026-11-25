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
import type { AskOrigin } from "@tentacle/client";
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
 * The ask's peek detent (docs/fix/mobile-ask-surfaces.md D3): it must hold the
 * one-row `AskSlim` (≈ 76 pt) on the smallest phone (667 pt), pinned by a test.
 */
export const PEEK = 0.12;
const PERMISSION_DETENTS: readonly number[] = [PEEK, 0.5, 1.0];

/**
 * The per-sheet table. Outbox opens at M, not S: its title, quote and five pills
 * (≈ 420 pt) do not fit 0.3 (Owner Q1).
 */
export const SHEET_SPEC: Record<SheetKind, SheetSpec> = {
  // dimmed 0: behind the peek row the screen is live (an ask never blocks).
  permission: { detents: PERMISSION_DETENTS, initial: MIDDLE, dimmed: 0, grabber: true },
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
 * Whether the native sheet can be swiped/backdrop-dismissed: always. An ask is
 * never blocking (docs/fix/mobile-ask-surfaces.md): a swipe PARKS it
 * (`ask-park.ts`), it never withdraws it.
 */
export function sheetGestureEnabled(_kind: SheetKind, _asking: boolean): boolean {
  return true;
}

/**
 * The subset of `NativeStackNavigationOptions` this table decides, spelled out
 * instead of imported. The import would be TYPE-only but not type-ERASABLE at
 * the program level: `@react-navigation/native-stack` pulls `react-native`,
 * whose `src/types/globals.d.ts` `declare global`s `setInterval(...): number`.
 * `scripts/mockup-kit/sources.ts` imports `drawer-nav.ts` → this module, so that
 * ambient global landed in the ROOT `tsc --noEmit` program and retyped every
 * timer in the monorepo — seven `setInterval/setTimeout(...).unref()` sites in
 * cli/exec/docker/k8s/daemon stopped compiling. `App.tsx` (a `.tsx`, compiled by
 * `tsc -p apps/mobile` only) passes these to `Stack.Screen`, where the object is
 * checked against the real option type — the assignment is the acceptance test.
 */
export interface SheetNavigationOptions {
  readonly headerShown: boolean;
  readonly presentation: "formSheet";
  readonly sheetAllowedDetents: number[];
  readonly sheetInitialDetentIndex: number;
  readonly sheetLargestUndimmedDetentIndex: number;
  readonly sheetGrabberVisible: boolean;
  readonly sheetExpandsWhenScrolledToEdge: boolean;
  readonly gestureEnabled: boolean;
}

/**
 * The route's options for one kind (`Stack.Screen options`). Every index passes
 * `clampDetent`, so RNS's dev asserts are unreachable; `contentStyle` is not set
 * here (the route resolves `sheetGround` through the palette).
 */
export function sheetOptions(
  kind: SheetKind,
  ctx: DetentContext & { readonly asking?: boolean },
): SheetNavigationOptions {
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

/** The session screen's three open flags, one per user sheet. */
export interface UserSheetFlags {
  readonly commands: boolean;
  readonly tools: boolean;
  readonly info: boolean;
}

/**
 * The ONE user sheet `desiredStack` gets from the screen's three flags. Every
 * opener is reached from the session UI under no sheet, so two flags are not
 * expected together. If they ever are, the precedence is fixed here:
 * info > tools > commands. Info is the sheet the others link into, and Commands
 * closes itself before anything it starts.
 */
export function userSheet(flags: UserSheetFlags): UserSheet | null {
  if (flags.info) {
    return "info";
  }
  if (flags.tools) {
    return "tools";
  }
  if (flags.commands) {
    return "commands";
  }
  return null;
}

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

/**
 * The ONE route name the sheets live under (`routes.ts`'s `Sheet`, D1). App.tsx
 * declares the screen with it and the screen reads the stack back with it, so the
 * two cannot drift.
 */
export const SHEET_ROUTE = "Sheet";

/** What a navigation route looks like to `sheetEntriesOf` (no router import). */
export interface SheetRouteLike {
  readonly key: string;
  readonly name: string;
  readonly params?: unknown;
}

/**
 * The sheet routes in a navigation state, bottom→top — the `actual` the
 * reconcile loop runs on. Anything that is not the `Sheet` route (the Session
 * itself, a screen pushed before the sheets) is not part of the stack, and a
 * route whose params name no known kind is ignored rather than guessed.
 */
export function sheetEntriesOf(routes: readonly SheetRouteLike[]): SheetEntry[] {
  const entries: SheetEntry[] = [];
  for (const route of routes) {
    if (route.name !== SHEET_ROUTE) {
      continue;
    }
    const params = route.params as { readonly kind?: unknown } | undefined;
    const kind = params?.kind;
    if (typeof kind !== "string" || !(SHEET_KINDS as readonly string[]).includes(kind)) {
      continue;
    }
    entries.push({ kind: kind as SheetKind, key: route.key });
  }
  return entries;
}

/**
 * The DRAIN: every key to pop, TOP-DOWN, for one pass of the loop (Owner
 * decision A, Step 0b). The screen dispatches these in order, in one pass — the
 * stack must be empty ~before the app-switcher snapshot, and one step per render
 * would take as many renders as there are sheets. Every key is popped by itself
 * (`reconcile`'s top-only rule), so a lower sheet never takes an upper route
 * with it and `dismissedNatively` reports nothing.
 */
export function drainPops(actual: readonly SheetEntry[]): string[] {
  return actual.map((entry) => entry.key).reverse();
}

/**
 * The wanted stack, restricted to the kinds this build PRESENTS natively (the
 * sheet migrations land slice by slice: S3 commands + outbox, S4 tools + info,
 * S5 permission). A kind whose content is still drawn by its own RN `Modal` must
 * never be pushed as a route — the route would draw nothing and the person would
 * see an empty sheet over the modal one. Order is `desiredStack`'s, untouched.
 */
export function managedStack(
  desired: readonly SheetKind[],
  managed: readonly SheetKind[],
): SheetKind[] {
  return desired.filter((kind) => managed.includes(kind));
}

/** Whether two `actual` stacks are the same (the state listener's no-op test). */
export function sameStack(a: readonly SheetEntry[], b: readonly SheetEntry[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.key !== b[i]?.key || a[i]?.kind !== b[i]?.kind) {
      return false;
    }
  }
  return true;
}

/**
 * The kinds THIS build presents as native routes. The sheet migration lands slice
 * by slice (S3: commands + outbox; S4: tools + info; S5: permission), and a kind
 * whose content is still drawn by its own RN `Modal` must never be pushed as a
 * route — the route would have nothing to draw and the person would see an empty
 * sheet over the modal. `managedStack` filters with this list.
 */
export const PRESENTED_SHEET_KINDS: readonly SheetKind[] = [
  "commands",
  "outbox",
  "tools",
  "info",
  "permission",
];

/**
 * The stack's SIGNATURE: one string per sheet route, in order. `useNavigationState`
 * compares its selection with `Object.is`, so a selector returning a fresh array
 * would re-render for ever; this returns a string that only changes when the
 * stack does. A route whose params name no known kind contributes nothing, exactly
 * like `sheetEntriesOf`.
 */
export function stackSignature(routes: readonly SheetRouteLike[]): string {
  return sheetEntriesOf(routes)
    .map((entry) => `${entry.key}:${entry.kind}`)
    .join("|");
}

/**
 * The sheet routes belonging to ONE session screen.
 *
 * Two Session screens can be mounted at once (a native stack keeps blur's
 * screens mounted), and every `Sheet` route lives in the SAME root stack — so a
 * blurred screen must never pop or push a sheet that is not its own. The drain is
 * the exception: privacy drains the WHOLE stack, whoever pushed it.
 */
export function sheetsOfSession(
  routes: readonly SheetRouteLike[],
  owner: { readonly computerId: string; readonly sessionId: string },
): SheetEntry[] {
  return sheetEntriesOf(routes).filter((entry) => {
    const route = routes.find((candidate) => candidate.key === entry.key);
    const params = route?.params as
      | { readonly computerId?: unknown; readonly sessionId?: unknown }
      | undefined;
    return params?.computerId === owner.computerId && params?.sessionId === owner.sessionId;
  });
}

/**
 * `AppState.currentState` as `sheet-plan`'s activity. RN reports `null` before
 * the first event and `"unknown"`/`"extension"` on some platforms; neither may
 * read as `active` (that would leave a sheet up in the switcher), so anything
 * unrecognised is `unknown` — which `sheetHidden` drains on.
 */
export function appActivity(state: string | null | undefined): AppActivity {
  return state === "active" || state === "inactive" || state === "background"
    ? state
    : state === "extension"
      ? "extension"
      : "unknown";
}

/**
 * The app's ONE detent memory (D3): held outside React, like the reveal's
 * tracker, so the route that observes a change and the screen options that apply
 * it on the next presentation share one store.
 */
export const SHEET_DETENTS: DetentMemory = createDetentMemory();

/**
 * The id a permission route carries for one presented ask (`SheetRouteParam
 * .askId`): the daemon's `requestId` when the requester had one, else the
 * sheet's own per-presentation `seq` — prefixed, so a numeric requestId and a
 * seq can never collide. It is only an identity (detent memory, and the key the
 * blocked-dismissal note is stored under), so a local ask still has one.
 */
export function askRouteId(requestId: string | null, seq: number): string {
  return requestId ?? `seq:${seq}`;
}

/**
 * The opening context for a sheet's options: Dynamic Type, the detent the person
 * left this sheet at (D3), and whether Session info was opened with a reveal —
 * the one opening that scrolls inside the sheet, so it needs the room.
 *
 * `reveal` is a parameter rather than something this module could look up: the
 * reveal's tracker (`reveal-report.ts`) belongs to the session screen, and the
 * route's options are resolved by the navigator (`App.tsx`) before the route's
 * screen mounts. So the screen states the fact on the route's params
 * (`SheetRouteParam.reveal`), and this resolves it — the decision stays here.
 */
export function sheetDetentContext(
  kind: SheetKind,
  identity: string | null,
  fontScale: number,
  reveal = false,
): DetentContext {
  const remembered = rememberedDetent(SHEET_DETENTS, kind, identity);
  return {
    fontScale,
    ...(kind === "info" && reveal ? { reveal: true } : {}),
    ...(remembered === null ? {} : { detent: remembered }),
  };
}

/**
 * A sheet's detent-memory identity (`DetentMemory`): the ask's own id for
 * Permission — so a re-delivery of the SAME ask keeps the detent the person left
 * it at (Step 0b L3) — and `null` (the kind itself) for the user sheets.
 */
export function sheetIdentity(kind: SheetKind, askId: string | null): string | null {
  return kind === "permission" ? askId : null;
}

/**
 * Fold one `sheetDetentChange` into the memory. Only a STABLE change is
 * remembered: RNS reports the intermediate detents of a drag too, and a
 * remembered mid-drag value would re-open the sheet where the finger passed.
 * Returns whether it was remembered (a drag's transient index is not).
 */
export function recordDetent(
  memory: DetentMemory,
  kind: SheetKind,
  identity: string | null,
  change: { readonly index: number; readonly stable: boolean },
): boolean {
  if (!change.stable) {
    return false;
  }
  rememberDetent(memory, kind, identity, change.index);
  return true;
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
 * The route's params a screen may rewrite in place, by `SET_PARAMS` keyed on the
 * route: `asking` is the ONLY one (`{asking:false}` once the ask is settled and
 * its reply or decision is on its way down, so the sheet is free to swipe again
 * — D5's `returned`).
 */
export interface SheetParamUpdate {
  readonly key: string;
  readonly params: { readonly asking: boolean; readonly askId?: string };
}

/**
 * What the presented ask now is, as the route's params must say it: whether it is
 * still unanswered (D5's `gestureEnabled`), and which ask it is (`askId` — the
 * detent identity and the blocked-note key). `null` = nothing to say (idle).
 */
export interface SheetAskParams {
  readonly asking: boolean;
  readonly askId: string | null;
}

/**
 * What OUR ask's route currently SAYS, or `null` when no permission route of this
 * session is up. Read from the params rather than from the sheet's state on
 * purpose: once the ask settles the sheet holds no id any more (it is a
 * `returned` reply), and the route is then the only place that still knows which
 * ask it was — which is what the note that ask earned must be forgotten under.
 */
export function askRouteParams(
  routes: readonly SheetRouteLike[],
  owner: { readonly computerId: string; readonly sessionId: string },
): SheetAskParams | null {
  const mine = sheetsOfSession(routes, owner);
  const top = mine[mine.length - 1];
  if (top === undefined || top.kind !== "permission") {
    return null;
  }
  const route = routes.find((candidate) => candidate.key === top.key);
  const params = route?.params as
    | { readonly asking?: unknown; readonly askId?: unknown }
    | undefined;
  return {
    asking: params?.asking === true,
    askId: typeof params?.askId === "string" ? params.askId : null,
  };
}

/**
 * The `SET_PARAMS` the ask's own route needs, or `null` when it already says so.
 * A rewrite in place rather than a re-push: `navigate` would REPLACE the stack's
 * params (`openSheet`'s reason), and the sheet is already up — it must not blink.
 *
 * BOTH facts are compared: a SECOND ask arrives while the same route is up (the
 * sheet presents the queued one at once, `permission-sheet.ts`'s `present`), and a
 * route left saying the previous ask's id would key its note and its detent on an
 * ask that is gone.
 */
export function askingParamUpdate(
  routes: readonly SheetRouteLike[],
  owner: { readonly computerId: string; readonly sessionId: string },
  next: SheetAskParams,
): SheetParamUpdate | null {
  const current = askRouteParams(routes, owner);
  if (current === null) {
    return null;
  }
  const askingStale = current.asking !== next.asking;
  const idStale = next.askId !== null && current.askId !== next.askId;
  if (!askingStale && !idStale) {
    return null;
  }
  const key = sheetsOfSession(routes, owner).at(-1)?.key;
  if (key === undefined) {
    return null;
  }
  return {
    key,
    params: {
      asking: next.asking,
      ...(idStale && next.askId !== null ? { askId: next.askId } : {}),
    },
  };
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
export function sessionInFront(
  focused: boolean,
  actual: readonly SheetEntry[],
  ownRun = false,
): boolean {
  return focused || actual.length > 0 || ownRun;
}

/** The route `WorkflowRun` is registered under (`routes.ts`). */
export const WORKFLOW_RUN_ROUTE = "WorkflowRun";

/**
 * The id of THIS session's own run when it is the screen on top (docs/fix/
 * mobile-ask-surfaces.md D6), else null. `Sheet` routes above it are ignored: the
 * run is what the person is looking at under them. A run of another session, or
 * any other screen above the run, is not "on top".
 */
export function ownRunTopId(
  routes: readonly SheetRouteLike[],
  owner: { readonly computerId: string; readonly sessionId: string },
): string | null {
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    if (route === undefined || route.name === SHEET_ROUTE) {
      continue;
    }
    if (route.name !== WORKFLOW_RUN_ROUTE) {
      return null;
    }
    const params = route.params as
      | { readonly computerId?: unknown; readonly sessionId?: unknown; readonly runId?: unknown }
      | undefined;
    return params?.computerId === owner.computerId &&
      params?.sessionId === owner.sessionId &&
      typeof params.runId === "string"
      ? params.runId
      : null;
  }
  return null;
}

/** Whether this session's own run is the screen on top (the session is then "in front"). */
export function ownRunOnTop(
  routes: readonly SheetRouteLike[],
  owner: { readonly computerId: string; readonly sessionId: string },
): boolean {
  return ownRunTopId(routes, owner) !== null;
}

/**
 * Whether the ask may be presented as a SHEET on the screen in front (Q1, owner
 * «only the slim row»): over a run (`topRunId`) only that run's own ask; anything
 * else (main agent, a sub-agent, another run, a run id the daemon did not send)
 * stays a slim row. Everywhere else, always.
 */
export function askPresentable(origin: AskOrigin, topRunId: string | null): boolean {
  if (topRunId === null) {
    return true;
  }
  return origin.kind === "workflow" && origin.runId === topRunId;
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
