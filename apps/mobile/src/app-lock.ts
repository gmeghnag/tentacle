/**
 * The app lock's state machine (docs/feat/mobile-lock.md D1; mobile decision 14).
 *
 * **The lock never fails open** (the plan's load-bearing assumption): every path
 * where the app cannot prove "recently unlocked" yields `cover: "lock"`, and no
 * content is visible while it does. Two properties carry that, and both are
 * pinned by tests here:
 *
 * 1. **The elapsed time comes from the HEARTBEAT, never from the `background`
 *    event** (F7). iOS suspends JS, so `background` and `active` can arrive
 *    together minutes later: a timestamp taken on `background` reads ~0 s and
 *    the app would unlock itself on return. `lastSeenActive` advances only on
 *    `tick` (a 1 s interval that stops when iOS suspends JS) and on a
 *    successful auth, so the elapsed time is measured from the suspension
 *    whatever order the events arrive in.
 * 2. **Locking wins every tie**: the threshold is strictly `>` (exactly 5:00
 *    does not lock, F9), a clock that moved BACKWARDS locks (F8), a setting
 *    still `loading` covers the first frame (F10), an unreadable setting is
 *    `5m` and never `never` (F11, in `lock-settings-store.ts`), and a device
 *    with no passcode runs unlocked with a notice rather than a lock nobody can
 *    open (F2).
 *
 * Pure and React-free (AGENTS §7): `now` is always injected, there is no timer
 * in here, and the component that renders the output owns no decision.
 */

/** The four delays Owner Q1/Q2 approve (decision 14). */
export type LockDelay = "immediately" | "5m" | "1h" | "never";

/** The setting while the store is still being read (fail-closed: the view is covered). */
export type LockSetting = LockDelay | "loading";

/** The app's own state, as RN's `AppState` reports it (Android's extra ones are `inactive`). */
export type AppStateName = "active" | "inactive" | "background";

/**
 * What an authentication attempt concluded — `expo-local-authentication`'s
 * `error` strings mapped onto these by `lock-auth.ts` (D2). `not_interactive`
 * is the kind iOS gives when an evaluation is started while the app is not
 * active (the reason `prompt` is only raised on `active`).
 */
export type AuthResult = "success" | "cancel" | "fail" | "lockout" | "not_interactive";

/**
 * Whether this device can authenticate a person at all: `none` = no passcode
 * and no biometrics (F2). `unknown` until asked — which never unlocks anything.
 */
export type Capability = "unknown" | "ok" | "none";

/** The reason the app is running unlocked although a lock was asked for (F2/Owner Q5). */
export type LockNotice = "no-passcode";

/** What the component renders. No colour, no copy: this is the decision. */
export interface LockView {
  /** `lock` = the content tree is covered (hidden from VoiceOver and Maestro too, D5). */
  readonly cover: "none" | "lock";
  /** Raise the system prompt NOW (once per lock episode, and only while `active`). */
  readonly prompt: boolean;
  /** F20: task 17 routes a notification's "Open" after the unlock. */
  readonly locked: boolean;
  /** A persistent line for the Settings screen and the launch notice. */
  readonly notice?: LockNotice;
}

/** Milliseconds of background time each delay tolerates. `immediately` = lock at once. */
export const DELAY_MS: Record<LockDelay, number> = {
  immediately: 0,
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  never: Number.POSITIVE_INFINITY,
};

/** The delays, weakest lock first — the order Owner Q6's "weaker" is read in. */
const STRENGTH: readonly LockDelay[] = ["immediately", "5m", "1h", "never"];

/** Is `next` a WEAKER lock than `current` (a longer delay, or `never`)? Owner Q6. */
export function isWeaker(next: LockDelay, current: LockDelay): boolean {
  return STRENGTH.indexOf(next) > STRENGTH.indexOf(current);
}

export interface AppLockState {
  readonly setting: LockSetting;
  /** The setting a successful auth must apply (Owner Q6: weakening asks first). */
  readonly pendingSetting?: LockDelay;
  readonly appState: AppStateName;
  /** The lock EPISODE flag. The view's `cover` also consults `capability`. */
  readonly locked: boolean;
  /** The heartbeat: the last moment JS was proven alive AND the app active. */
  readonly lastSeenActive: number;
  /** The app left the foreground since the last `active` (cleared on `active`). */
  readonly wentBackground: boolean;
  /** Whether this lock episode already raised the prompt (no loops: F5). */
  readonly prompted: boolean;
  /** The prompt to raise right now. */
  readonly prompt: boolean;
  readonly capability: Capability;
}

export interface AppLockDeps {
  /** The clock, injected (a test moves it by hand). */
  readonly now: () => number;
}

export type AppLockEvent =
  /** The first frame. `"loading"` covers it (F10). */
  | { readonly type: "launch" }
  /** The setting finished loading (D3's async read). */
  | { readonly type: "loaded"; readonly setting: LockDelay }
  /** The 1 s heartbeat, while JS runs. */
  | { readonly type: "tick" }
  | { readonly type: "appState"; readonly state: AppStateName }
  | { readonly type: "authResult"; readonly result: AuthResult }
  | { readonly type: "capability"; readonly capability: Capability }
  /** Settings: ask for a delay (weakening needs a successful auth first, Owner Q6). */
  | { readonly type: "setSetting"; readonly setting: LockDelay }
  /**
   * The component STARTED the system prompt, so the one-shot `prompt` is
   * consumed. Without this ack the flag would stay true and every re-render
   * would raise the evaluation again (the prompt loop F5 forbids).
   */
  | { readonly type: "prompted" };

/** The initial state, BEFORE the launch event (nothing is rendered from it). */
export function initialAppLock(now: () => number): AppLockState {
  return {
    setting: "loading",
    appState: "active",
    locked: true,
    lastSeenActive: now(),
    wentBackground: false,
    prompted: false,
    prompt: false,
    capability: "unknown",
  };
}

/** Can this device open a lock? A device with no passcode cannot (F2). */
function canLock(capability: Capability): boolean {
  return capability !== "none";
}

/** Begin a lock episode: locked, nothing prompted yet, then maybe prompt (active only). */
function beginEpisode(state: AppLockState): AppLockState {
  const prompt = state.appState === "active";
  return { ...state, locked: true, prompted: prompt, prompt };
}

/** The delay in force; a setting still loading behaves like `immediately` (fail-closed). */
function effectiveDelay(state: AppLockState): LockDelay {
  return state.setting === "loading" ? "immediately" : state.setting;
}

function onLaunch(state: AppLockState): AppLockState {
  return beginEpisode(state);
}

function onLoaded(state: AppLockState, setting: LockDelay): AppLockState {
  const next: AppLockState = { ...state, setting };
  // `never` is the ONE setting that shows content at launch (Owner Q1).
  if (setting === "never") {
    return { ...next, locked: false, prompt: false, prompted: false };
  }
  // Still covered from launch: keep the episode, but never prompt while not active.
  return next.locked ? next : beginEpisode(next);
}

function onTick(state: AppLockState, now: number): AppLockState {
  // The heartbeat: only while the app is genuinely active, so a suspension stops
  // it and `lastSeenActive` then marks the moment JS stopped (F7).
  return state.appState === "active" ? { ...state, lastSeenActive: now } : state;
}

function onAppState(state: AppLockState, name: AppStateName, now: number): AppLockState {
  if (name === "background") {
    const delay = effectiveDelay(state);
    const next: AppLockState = { ...state, appState: name };
    if (delay === "never") {
      return { ...next, wentBackground: true };
    }
    if (delay === "immediately") {
      return beginEpisode({ ...next, wentBackground: true });
    }
    // Else: only MARK it. The elapsed time is the heartbeat's job (F7).
    return { ...next, wentBackground: true };
  }
  if (name === "inactive") {
    // Control Center, a call banner, the Face ID prompt itself: no timer change
    // and no lock (F6) — `inactive` is not leaving the app.
    return { ...state, appState: name };
  }
  // `active`: the one place elapsed background time is judged.
  const returning: AppLockState = { ...state, appState: "active", wentBackground: false };
  if (!state.wentBackground) {
    return returnToActive(returning);
  }
  const delay = effectiveDelay(state);
  if (delay === "never") {
    return returnToActive(returning);
  }
  const elapsed = now - state.lastSeenActive;
  // Strictly greater (F9); a clock that moved backwards locks (F8).
  const expired = now < state.lastSeenActive || elapsed > DELAY_MS[delay];
  if (!expired) {
    return returnToActive(returning);
  }
  return beginEpisode(returning);
}

/** Coming back to `active`: a lock is already up (e.g. `immediately`), so prompt now. */
function returnToActive(state: AppLockState): AppLockState {
  if (!state.locked || state.prompted || !canLock(state.capability)) {
    return state;
  }
  return { ...state, prompted: true, prompt: true };
}

function onAuthResult(state: AppLockState, result: AuthResult, now: number): AppLockState {
  if (result !== "success") {
    // F5: stay locked, the Unlock button shows, and NO automatic re-prompt —
    // otherwise the prompt's own `inactive` → `active` re-arms it forever.
    const kept: AppLockState = { ...state, prompt: false, prompted: true };
    return { ...kept, pendingSetting: undefined };
  }
  // A successful auth unlocks AND waives the delay: the person is here NOW.
  const unlocked: AppLockState = {
    ...state,
    locked: false,
    prompt: false,
    prompted: false,
    lastSeenActive: now,
    wentBackground: false,
    pendingSetting: undefined,
  };
  const pending = state.pendingSetting;
  if (pending === undefined) {
    return unlocked;
  }
  return { ...unlocked, setting: pending };
}

function onCapability(state: AppLockState, capability: Capability): AppLockState {
  if (capability !== "none") {
    return { ...state, capability };
  }
  // F2/Owner Q5: no passcode and no biometrics → run unlocked with a notice.
  // Never the other way round: `none` is the only capability that unlocks.
  return { ...state, capability, locked: false, prompt: false, prompted: false };
}

function onSetSetting(state: AppLockState, setting: LockDelay): AppLockState {
  const current = effectiveDelay(state);
  if (!isWeaker(setting, current)) {
    // Stronger (or the same): no proof of presence needed (Owner Q6).
    return { ...state, setting };
  }
  // Weaker: take effect only after a successful auth. The prompt is raised at
  // once if we can be interactive, and the old setting stays in force until then.
  const canPrompt = state.appState === "active" && canLock(state.capability);
  return { ...state, pendingSetting: setting, prompt: canPrompt, prompted: canPrompt };
}

/** Apply one event. Total, pure: the same state and event always give the same state. */
export function reduceAppLock(state: AppLockState, event: AppLockEvent, now: number): AppLockState {
  switch (event.type) {
    case "launch":
      return onLaunch(state);
    case "loaded":
      return onLoaded(state, event.setting);
    case "tick":
      return onTick(state, now);
    case "appState":
      return onAppState(state, event.state, now);
    case "authResult":
      return onAuthResult(state, event.result, now);
    case "capability":
      return onCapability(state, event.capability);
    case "setSetting":
      return onSetSetting(state, event.setting);
    case "prompted":
      return state.prompt ? { ...state, prompt: false } : state;
  }
}

/**
 * What the component renders. `cover` is `lock` while locked, AND while the
 * setting is loading (the first frame never shows content), AND never for a
 * device that cannot authenticate.
 */
export function lockView(state: AppLockState): LockView {
  const locked = state.locked && canLock(state.capability);
  const cover = locked || state.setting === "loading" ? "lock" : "none";
  const notice: LockNotice | undefined = state.capability === "none" ? "no-passcode" : undefined;
  return {
    cover,
    // NOT gated on `cover`: Owner Q6's weakening prompt happens while the app is
    // unlocked and visible. Only interactivity gates it (an evaluation started
    // while not active fails at once, `not_interactive`).
    prompt: state.prompt && state.appState === "active",
    locked,
    ...(notice === undefined ? {} : { notice }),
  };
}

export interface AppLock {
  /** The current state (a snapshot; the reducer never mutates one in place). */
  state(): AppLockState;
  dispatch(event: AppLockEvent): LockView;
  view(): LockView;
}

/** The lock's ONE instance in the app: the store behind `LockGate` (D5). */
export function createAppLock(deps: AppLockDeps): AppLock {
  let current = initialAppLock(deps.now);
  return {
    state: () => current,
    dispatch(event: AppLockEvent): LockView {
      current = reduceAppLock(current, event, deps.now());
      return lockView(current);
    },
    view: () => lockView(current),
  };
}
