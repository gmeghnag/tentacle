/**
 * The app's ONE push wiring (docs/feat/mobile-push.md slice P9, Design 7).
 *
 * This module is the seam between the pure decisions (`push-registration.ts`)
 * and the app: it builds each computer's registrar, feeds it the link's own two
 * calls, and exposes the Settings row's view-model. `App.tsx` only calls it
 * (like `computer-memory.ts`, it exists so the wiring can be tested at all —
 * `App.tsx` imports React Native and no test can load it).
 *
 * How a computer registers, end to end:
 *  - its link coming UP (`onStatus("up")`) is the trigger: a phone only
 *    registers with a computer it is actually talking to, over the same
 *    authenticated Noise channel as everything else (AGENTS §7, one session
 *    path);
 *  - the registrar decides from `(token, env, pushKey)` + the store's stored
 *    fingerprint, so a reconnect storm, a remount or a daemon restart sends
 *    NOTHING, while a rotated token or a regenerated key sends one;
 *  - the memory is the computer's own Keychain record (`setPush`), so the fact
 *    survives an app restart — the daemon keeps its file either way.
 */
import type { PushRegisterStatus } from "@tentacle/protocol";
import type { StoredComputer } from "./computer-store.ts";
import {
  type PushFacts,
  type PushMemory,
  type PushPermission,
  type PushRegistrar,
  type PushSink,
  type PushState,
  createPushRegistrar,
  pushPhaseText,
  shouldAskNotificationPermission,
} from "./push-registration.ts";
import type { PushToggleStore } from "./push-toggle-store.ts";

/** The store calls the memory needs (`KEYCHAIN_STORE` and its `setPush`). */
export interface PushMemoryStore {
  get(id: string): Promise<StoredComputer | undefined>;
  setPush(
    id: string,
    value: { readonly hash: string; readonly registeredAt: number } | undefined,
  ): Promise<void>;
}

/** The link's two calls (`RemoteClient.pushRegister` / `pushUnregister`). */
export interface PushClient {
  pushRegister(facts: PushFacts): Promise<{
    readonly push: PushRegisterStatus;
    readonly graceSeconds: number;
  }>;
  pushUnregister(): Promise<void>;
}

/** The OS side, injected (the app passes `push-expo.ts`). */
export interface PushPlatform {
  readonly permission: () => Promise<PushPermission>;
  readonly request: () => Promise<PushPermission>;
  readonly asked: () => Promise<boolean>;
  readonly facts: () => Promise<PushFacts | undefined>;
}

/** `PushMemory` over the Keychain, keyed by ONE computer id. */
export function keychainPushMemory(store: PushMemoryStore, computerId: string): PushMemory {
  return {
    // `store.get` returning `undefined` (an unreadable record) reads as "never
    // registered" — the fingerprint is not worth blocking a registration on.
    read: async (id) => (await store.get(id))?.push,
    write: async (id, value) => store.setPush(id, value),
  };
}

/** The link, as a `PushSink`. Built per call so a re-dial hands over a NEW client. */
export function linkPushSink(link: () => PushClient | undefined): PushSink {
  return {
    register: async (facts) => {
      const client = link();
      if (client === undefined) {
        throw new Error("no link to register with");
      }
      return client.pushRegister(facts);
    },
    unregister: async () => {
      // A missing link THROWS, exactly like `register` (review round 1, H2). It
      // used to be `await link()?.pushUnregister()`, which resolves when there is
      // no client: the registrar then believed the daemon had been told, forgot
      // its fingerprint, and the phone kept being pushed to. A throw is what
      // makes the toggle-off leave a debt for the next connect instead.
      const client = link();
      if (client === undefined) {
        throw new Error("no link to unregister with");
      }
      await client.pushUnregister();
    },
  };
}

/** The row's view-model, or `undefined` while there is nothing to show. */
export interface NotificationsView {
  readonly enabled: boolean;
  readonly detail: string;
  readonly switchable: boolean;
}

/**
 * What the Settings row shows for one computer's state.
 *
 * `switchable` is false in exactly the cases where flipping the switch would be
 * a lie: the person has no permission in iOS (only the Settings app can grant
 * it) or the computer is too old to listen (nothing changes until it updates).
 */
export function notificationsView(
  state: PushState,
  computerName: string,
  permission: PushPermission,
): NotificationsView {
  const blocked =
    state.phase === "daemon-too-old" || permission === "denied" || permission === "unavailable";
  const detail =
    permission === "denied" || permission === "unavailable"
      ? pushPhaseText("notifications-off")
      : pushPhaseText(state.phase, computerName);
  return { enabled: state.enabled, detail, switchable: !blocked };
}

/**
 * The app's ONE push manager: a registrar per computer, and the Settings row's
 * state for the computer on screen.
 *
 * Deliberately NOT a singleton with global state: every method takes the
 * computer id, and the whole thing keeps nothing but the registrars (one per
 * computer, so a switch between computers cannot cross their fingerprints).
 */
export interface PushManager {
  /** Called whenever a computer's link is UP. Idempotent: the registrar decides. */
  sync(computerId: string, link: () => PushClient | undefined): Promise<void>;
  /** The Settings toggle for one computer. */
  setEnabled(
    computerId: string,
    enabled: boolean,
    link: () => PushClient | undefined,
  ): Promise<void>;
  /**
   * The Settings toggle for EVERY paired computer. Settings is one screen for the
   * phone, so "Notifications" is the phone's decision, not a computer's: turning
   * it off unregisters from all of them (and on registers on each next connect).
   */
  setEnabledForAll(
    computers: readonly { readonly id: string }[],
    enabled: boolean,
    linkOf: (computerId: string) => () => PushClient | undefined,
  ): Promise<void>;
  /** The row for one computer (the Settings screen's props), or `undefined`. */
  view(
    computerId: string,
    computerName: string,
    permission: PushPermission,
  ): NotificationsView | undefined;
  /**
   * The ONE row Settings shows, over every paired computer: the person's toggle,
   * and the most informative status among them (an old daemon or a relay without
   * push is worth more than "on" — it is the reason nothing will arrive).
   */
  viewForAll(
    computers: readonly { readonly id: string; readonly name: string }[],
    permission: PushPermission,
  ): NotificationsView;
  /** The state, for a test and for a re-render. */
  stateOf(computerId: string): PushState | undefined;
  /** The permission prompt, on the FIRST successful pairing (decision 10). */
  paired(computerId: string, hasComputer: boolean): Promise<void>;
  /** Forget a computer's registrar (Remove / a re-pair). */
  forget(computerId: string): void;
  /**
   * The phone-wide switch has been read from the Keychain. `App` awaits it before
   * it trusts the row's `enabled` (H1); every method below awaits it too.
   */
  ready(): Promise<void>;
}

export interface PushManagerDeps {
  readonly store: PushMemoryStore;
  readonly platform: PushPlatform;
  /**
   * The phone-wide switch, on disk (review round 1, H1). REQUIRED: leaving it out
   * is what made "off" last only until the app was relaunched, so no caller gets
   * to forget it.
   */
  readonly toggle: PushToggleStore;
  readonly now?: () => number;
  /** Re-render hook: called with the computer whose state changed. */
  readonly onChange?: (computerId: string, state: PushState) => void;
}

export function createPushManager(deps: PushManagerDeps): PushManager {
  const registrars = new Map<string, PushRegistrar>();
  const now = deps.now ?? Date.now;
  /**
   * The phone-wide decision, as last read from (or written to) the Keychain. It
   * is the row's `enabled` for every computer, including one whose link has never
   * come up — otherwise a relaunch would show "on" to a person who turned it off.
   */
  let enabled = true;
  let hydration: Promise<void> | undefined;

  /**
   * Read the switch ONCE, and never again: after that the memory is authoritative
   * (a write that failed is the session's decision, exactly like the app-lock
   * setting's preserved-record rule), so one unreadable Keychain cannot flip a
   * person's toggle back on mid-session.
   */
  const ready = (): Promise<void> => {
    hydration ??= (async () => {
      const read = await deps.toggle.read().catch(() => undefined);
      if (read !== undefined) {
        enabled = read.enabled;
      }
    })();
    return hydration;
  };
  // Fired at creation so the first render (which is synchronous) sees the stored
  // value as soon as it can, and every operation below awaits it before acting.
  void ready();

  /** The state a computer starts from: the PHONE's decision, nothing read yet. */
  const initialState = (): PushState => ({ enabled, phase: enabled ? "unknown" : "off" });

  /** One registrar per computer, created on first use with the phone's switch. */
  const registrarOf = (computerId: string): PushRegistrar => {
    const known = registrars.get(computerId);
    if (known !== undefined) {
      return known;
    }
    const created = createPushRegistrar({
      computerId,
      memory: keychainPushMemory(deps.store, computerId),
      permission: () => deps.platform.permission(),
      facts: () => deps.platform.facts(),
      now,
      onChange: (state) => deps.onChange?.(computerId, state),
      initial: initialState(),
    });
    registrars.set(computerId, created);
    return created;
  };

  /** Persist the switch. A failure keeps the session's decision (the next launch
   * reads what is on disk, which is the honest thing to say). */
  const rememberEnabled = async (next: boolean): Promise<void> => {
    enabled = next;
    await deps.toggle.write(next).catch(() => {});
  };

  /**
   * The sink for a toggle, but ONLY when a client is dialable now.
   *
   * A toggle-off with no link must take the debt path rather than pretending it
   * sent something (H2), and a toggle-on with no link must stay `unknown` for the
   * next connect instead of turning a disconnected computer's row into `failed`
   * (which would also outrank a genuinely `on` computer in the one Settings row).
   */
  const toggleSink = (link: () => PushClient | undefined): PushSink | undefined => {
    const client = link();
    return client === undefined ? undefined : linkPushSink(() => client);
  };

  return {
    ready,

    async sync(computerId, link) {
      await ready();
      await registrarOf(computerId).sync(linkPushSink(link));
    },

    async setEnabled(computerId, next, link) {
      await ready();
      await registrarOf(computerId).setEnabled(next, toggleSink(link));
      await rememberEnabled(next);
    },

    view(computerId, computerName, permission) {
      const registrar = registrars.get(computerId);
      // No registrar = no link has come up yet for this computer: the row says
      // what the TOGGLE is (the stored decision) without claiming a status nobody
      // read.
      const state = registrar?.state() ?? initialState();
      return notificationsView(state, computerName, permission);
    },

    async setEnabledForAll(computers, next, linkOf) {
      await ready();
      for (const computer of computers) {
        await registrarOf(computer.id).setEnabled(next, toggleSink(linkOf(computer.id)));
      }
      // Persisted ONCE for the phone, after the computers were told: the switch is
      // one decision, not one per computer (H1).
      await rememberEnabled(next);
    },

    viewForAll(computers, permission) {
      if (computers.length === 0) {
        // Nothing to register WITH: the switch is shown (it explains why) and is
        // not operable — a tap would have no computer to reach.
        return {
          ...notificationsView(initialState(), "this computer", permission),
          switchable: false,
        };
      }
      // ONE row for the phone: it is on iff any computer will push to it, and its
      // detail is the most informative status among them (a computer that cannot
      // deliver is the reason nothing arrives, so it outranks "on").
      const rank: Record<string, number> = {
        "daemon-too-old": 6,
        failed: 5,
        "relay-no-push": 4,
        "relay-off": 3,
        "notifications-off": 2,
        off: 1,
        unknown: 1,
        on: 0,
      };
      // Read-ONLY: a view never creates a registrar (a render is not the place to
      // start one), so a computer whose link never came up reads as the phone's
      // own decision, with no status claimed.
      const states = computers.map(
        (computer) => registrars.get(computer.id)?.state() ?? initialState(),
      );
      const worst = states.reduce((a, b) => ((rank[b.phase] ?? 0) > (rank[a.phase] ?? 0) ? b : a));
      const name =
        computers.find((_, index) => states[index] === worst)?.name ??
        computers[0]?.name ??
        "this computer";
      // The row speaks for the PHONE: while the switch is off it says off, not
      // the status of a computer nothing is being sent to.
      const shown = enabled ? worst : { enabled: false, phase: "off" as const };
      const view = notificationsView(shown, name, permission);
      // `notificationsView`'s `daemon-too-old` rule is a ONE-computer rule ("the
      // switch would be a lie: nothing changes until it updates"). Applied to the
      // phone's single row it is a trap — one old daemon would make the row
      // unswitchable, so a person could not turn notifications off for the
      // computers that DO deliver (review round 1, H4). The phone-wide switch can
      // always be flipped; only the OS's own refusal stops it.
      const switchable = !(permission === "denied" || permission === "unavailable");
      return { ...view, enabled, switchable };
    },

    stateOf(computerId) {
      return registrars.get(computerId)?.state();
    },

    async paired(computerId, hasComputer) {
      // The pure decision (decision 10): once, after the FIRST successful
      // pairing, and only while the OS still says `undetermined`.
      const [permission, asked] = await Promise.all([
        deps.platform.permission(),
        deps.platform.asked(),
      ]);
      if (!shouldAskNotificationPermission({ pairedNow: true, hasComputer, permission, asked })) {
        return;
      }
      await deps.platform.request();
      // The registrar reads the permission again on the next sync, so a grant
      // registers at once on the next connect (and a denial shows its copy).
      deps.onChange?.(computerId, registrarOf(computerId).state());
    },

    forget(computerId) {
      registrars.delete(computerId);
    },
  };
}
