/**
 * Push registration on the phone (docs/feat/mobile-push.md slice P9, Design 7;
 * decision 19: the RAW APNs token, never Expo's push service).
 *
 * Two layers, the repo's usual split (AGENTS §7):
 *  - **the decisions are pure** — when to register (a `(token, env, key)`
 *    fingerprint per computer), what a daemon's answer means, what Settings
 *    says, whether the permission may be asked yet, and the ONE case that must
 *    never loop (an older daemon's `MethodNotFound`);
 *  - **one runner** (`createPushRegistrar`) performs them through injected
 *    seams (`sink` = the link's two calls, `store` = the per-computer memory,
 *    `permission`/`token` = the OS), so every rule below is tested with fakes
 *    and no simulator.
 *
 * Load-bearing properties, each pinned by a test here:
 * - **register at most once per fingerprint per computer**: a re-connect with
 *   the same token, environment and key sends NOTHING (a daemon restart, a
 *   reconnect storm or a screen remount must not re-register);
 * - **any change of the fingerprint re-registers** (F11: iOS rotates the token;
 *   F12: the push key is regenerated) — the hash is over all three;
 * - **`MethodNotFound` is terminal, not retried** (F16): an older daemon
 *   answers every attempt the same way, so the phone says "update tentacle on
 *   <computer>" and stops asking until the app is relaunched;
 * - **the toggle off UNREGISTERS** (and clears the fingerprint), so a later ask
 *   reaches no banner here, while turning it back on registers at once.
 */
import {
  PUSH_ENVIRONMENTS,
  type PushEnvironment,
  type PushRegisterStatus,
} from "@tentacle/protocol";

/** What identifies a registration: the token, the environment it is valid in, and the push key. */
export interface PushFacts {
  /** The RAW APNs token, lowercase hex (P0(d): `getDevicePushTokenAsync` hex-encodes it). */
  readonly token: string;
  readonly env: PushEnvironment;
  /** This phone's per-device X25519 push public key, base64url. */
  readonly key: string;
}

/** What this phone remembers about ONE computer's registration (the store's shape). */
export interface PushRegistration {
  /** The fingerprint last ACCEPTED by that computer (`pushFactsHash`). */
  readonly hash: string;
  readonly registeredAt: number;
}

/**
 * The OS's notification permission, as the app can see it. `unavailable` = the
 * device/build cannot ask at all (a simulator with no push entitlement), which
 * is shown like a denial and never retried.
 */
export type PushPermission = "granted" | "denied" | "undetermined" | "unavailable";

/**
 * What Settings shows, and the ONE piece of state this module keeps. `status`
 * carries the daemon's own answer (`on` / `off` / `relay-off` /
 * `relay-no-push`) plus the two the phone alone knows.
 */
export type PushPhase =
  | "unknown"
  | PushRegisterStatus
  | "daemon-too-old"
  | "notifications-off"
  | "failed";

/** The daemon's status, or the two local ones. Never a fourth vocabulary. */
export type PushState = {
  /** The person's toggle (default on: notifications are asked about, then used). */
  readonly enabled: boolean;
  readonly phase: PushPhase;
  /** The fingerprint last accepted, when this session knows it. */
  readonly registeredHash?: string;
};

/** The initial state: enabled, nothing decided yet. */
export function initialPushState(): PushState {
  return { enabled: true, phase: "unknown" };
}

const encoder = new TextEncoder();

/**
 * The fingerprint of one registration: `(token, env, key)` with the fields
 * LENGTH-PREFIXED, so no two different triples can collide by concatenation
 * (`("ab","c")` and `("a","bc")` are different inputs).
 *
 * Not a hash: this is stored beside the token in the Keychain item's own JSON
 * record, never sent, and a straight comparison is easier to read in a bug
 * report than 64 hex characters. Its only job is "is this the same
 * registration?".
 */
export function pushFactsHash(facts: PushFacts): string {
  const parts = [facts.token, facts.env, facts.key].map(
    (part) => `${encoder.encode(part).length}:${part}`,
  );
  return parts.join("|");
}

/** `true` iff `value` is an environment the wire accepts (a token tagged otherwise is refused). */
export function isPushEnvironment(value: unknown): value is PushEnvironment {
  return typeof value === "string" && (PUSH_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Why a connect sent nothing. `same` is the common case; the rest exist so a
 * test (and a bug report) can tell "we did not need to" from "we could not".
 */
export type PushSkipReason = "disabled" | "no-permission" | "no-token" | "same" | "daemon-too-old";

/** What one connect should do. */
export type PushPlan =
  | { readonly kind: "skip"; readonly reason: PushSkipReason }
  | { readonly kind: "register"; readonly hash: string };

export interface PushPlanInput {
  readonly state: PushState;
  readonly permission: PushPermission;
  /** Absent = the OS gave no token (a simulator, or a build with no entitlement). */
  readonly facts: PushFacts | undefined;
  /** What this computer last accepted (from its own Keychain record). */
  readonly last: PushRegistration | undefined;
}

/**
 * The whole decision for one connect. Ordered so the CHEAPEST and most
 * fundamental refusal wins, and so a disabled toggle never even looks at the
 * token (the OS call is the caller's, and it is skipped: `no-token` here means
 * "we would not use it").
 */
export function planPushRegistration(input: PushPlanInput): PushPlan {
  const { state, permission, facts, last } = input;
  if (!state.enabled) {
    return { kind: "skip", reason: "disabled" };
  }
  // The terminal case first: an older daemon never grows the method, so nothing
  // else (a token change included) may re-ask in this session (F16).
  if (state.phase === "daemon-too-old") {
    return { kind: "skip", reason: "daemon-too-old" };
  }
  if (permission !== "granted") {
    return { kind: "skip", reason: "no-permission" };
  }
  if (facts === undefined) {
    return { kind: "skip", reason: "no-token" };
  }
  const hash = pushFactsHash(facts);
  if (last !== undefined && last.hash === hash) {
    return { kind: "skip", reason: "same" };
  }
  return { kind: "register", hash };
}

/**
 * What the daemon's answer means for the row: the four statuses verbatim, and
 * nothing else (a status this build does not know is `failed`, never a guess).
 */
export function phaseOfStatus(status: unknown): PushPhase {
  return status === "on" || status === "off" || status === "relay-off" || status === "relay-no-push"
    ? status
    : "failed";
}

/** The one RPC error that means "this computer is too old": JSON-RPC's `MethodNotFound`. */
export const METHOD_NOT_FOUND = -32601;

/** `true` iff `error` is an older daemon's answer (the terminal case). */
export function isDaemonTooOld(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === METHOD_NOT_FOUND
  );
}

/** The Settings copy for a phase. Every branch says what the PERSON can do, or why not. */
export function pushPhaseText(phase: PushPhase, computerName = "this computer"): string {
  switch (phase) {
    case "on":
      return "On — this computer can send notifications";
    case "off":
      return "Off — notifications are turned off on this computer";
    case "relay-off":
      return "This computer uses no relay, so notifications cannot reach this iPhone";
    case "relay-no-push":
      return "This computer's relay does not deliver notifications";
    case "daemon-too-old":
      return `Update tentacle on ${computerName} to turn on notifications`;
    case "notifications-off":
      return "Notifications are off for tentacle in iOS Settings";
    case "failed":
      return "Could not turn on notifications — it will try again next time it connects";
    case "unknown":
      return "Not checked yet";
  }
}

/**
 * Whether the OS permission prompt may be shown NOW.
 *
 * Decision 10 ("asked only when needed and explained"): exactly once, and only
 * after the FIRST successful pairing — a person who never paired a computer has
 * no reason to be asked, and one who denied it is never nagged again.
 */
export interface PermissionAskInput {
  /** A pairing succeeded in this session (the caller passes the app's own fact). */
  readonly pairedNow: boolean;
  /** This phone has paired at least one computer (the store answered non-empty). */
  readonly hasComputer: boolean;
  readonly permission: PushPermission;
  /** The OS's "we already asked" flag (`ios.status === UNDETERMINED` otherwise). */
  readonly asked: boolean;
}

export function shouldAskNotificationPermission(input: PermissionAskInput): boolean {
  return (
    input.pairedNow && input.hasComputer && !input.asked && input.permission === "undetermined"
  );
}

// --- the one runner -------------------------------------------------------

/** The two calls the link offers (the app passes its `RemoteClient`). */
export interface PushSink {
  register(
    facts: PushFacts,
  ): Promise<{ readonly push: PushRegisterStatus; readonly graceSeconds: number }>;
  unregister(): Promise<void>;
}

/** Where a computer's fingerprint is remembered: its own Keychain record. */
export interface PushMemory {
  read(computerId: string): Promise<PushRegistration | undefined>;
  write(computerId: string, value: PushRegistration | undefined): Promise<void>;
}

export interface PushRegistrarDeps {
  readonly computerId: string;
  readonly memory: PushMemory;
  /** The OS: the current permission (re-read every sync — a person may change it in Settings). */
  readonly permission: () => Promise<PushPermission>;
  /** The OS: the raw APNs token, or `undefined` when this build cannot produce one. */
  readonly facts: () => Promise<PushFacts | undefined>;
  readonly now: () => number;
  /** Every state change, for the row that renders it. */
  readonly onChange: (state: PushState) => void;
  /** The state is per COMPUTER, so a link that goes away takes it with it. */
  readonly initial?: PushState;
}

export interface PushRegistrar {
  readonly state: () => PushState;
  /**
   * Called on every successful connect. Resolves after the registration
   * attempt (or the skip) — the caller does not await it in the render path.
   */
  sync(sink: PushSink): Promise<void>;
  /** The Settings toggle. Off unregisters and forgets the fingerprint. */
  setEnabled(enabled: boolean, sink: PushSink | undefined): Promise<void>;
}

export function createPushRegistrar(deps: PushRegistrarDeps): PushRegistrar {
  let state: PushState = deps.initial ?? initialPushState();
  /** One attempt at a time: a reconnect during an attempt must not double-register. */
  let queue: Promise<unknown> = Promise.resolve();

  const set = (next: PushState): void => {
    state = next;
    deps.onChange(state);
  };
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  async function register(sink: PushSink, facts: PushFacts, hash: string): Promise<void> {
    try {
      const result = await sink.register(facts);
      const phase = phaseOfStatus(result.push);
      // The fingerprint is written only for a registration the daemon will act on
      // (`on`). A `off` / `relay-off` / `relay-no-push` answer is still accepted and
      // stored DAEMON-side, but remembering it here would mute the phone forever
      // after the computer's config changed (F3/F4): the next connect asks again.
      if (phase === "on") {
        await deps.memory
          .write(deps.computerId, { hash, registeredAt: deps.now() })
          .catch(() => {});
      }
      set({ ...state, phase, ...(phase === "on" ? { registeredHash: hash } : {}) });
    } catch (error) {
      if (isDaemonTooOld(error)) {
        // Terminal for this session: never retried in a loop (F16), and the
        // fingerprint is NOT written, so a NEW app against a newer daemon
        // registers on its first connect.
        set({ ...state, phase: "daemon-too-old" });
        return;
      }
      // Anything else is transient (a drop mid-call, a full disk — F25): the
      // next connect tries again, which is the retry loop's only form here.
      set({ ...state, phase: "failed" });
    }
  }

  return {
    state: () => state,

    sync(sink: PushSink): Promise<void> {
      return serialise(async () => {
        const permission = await deps.permission();
        const last = await deps.memory.read(deps.computerId).catch(() => undefined);
        const enabledFacts =
          state.enabled && permission === "granted" ? await deps.facts() : undefined;
        const plan = planPushRegistration({ state, permission, facts: enabledFacts, last });
        if (plan.kind === "skip") {
          if (plan.reason === "no-permission" && state.phase !== "daemon-too-old") {
            set({ ...state, phase: "notifications-off" });
          }
          return;
        }
        if (enabledFacts === undefined) {
          return;
        }
        await register(sink, enabledFacts, plan.hash);
      });
    },

    setEnabled(enabled: boolean, sink: PushSink | undefined): Promise<void> {
      return serialise(async () => {
        if (enabled) {
          // On: register on the next sync. `unknown`, because the row must not
          // claim `on` before the daemon agreed (and it does not claim `off`
          // either: the toggle is the person's, the phase is the computer's).
          set({
            enabled: true,
            phase: "unknown",
            ...(state.registeredHash === undefined ? {} : { registeredHash: state.registeredHash }),
          });
          return;
        }
        // Off: the daemon forgets THIS device's registration, then the phone
        // forgets the fingerprint — in that order, so a crash between the two
        // leaves a stale file (harmless: the toggle is off, so nothing asks it to
        // push) instead of a phone that believes it is unregistered while the
        // daemon still buzzes it.
        //
        // Best effort both ways: with no link the daemon keeps the file until the
        // next connect (a pod/daemon restart), and the phone must still stop
        // showing the row as `on` — the person's decision is the phone's.
        await sink?.unregister().catch(() => {});
        await deps.memory.write(deps.computerId, undefined).catch(() => {});
        set({ enabled: false, phase: "off" });
      });
    },
  };
}
