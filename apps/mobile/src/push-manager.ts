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
  initialPushState,
  pushPhaseText,
  shouldAskNotificationPermission,
} from "./push-registration.ts";

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
      await link()?.pushUnregister();
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
}

export interface PushManagerDeps {
  readonly store: PushMemoryStore;
  readonly platform: PushPlatform;
  readonly now?: () => number;
  /** Re-render hook: called with the computer whose state changed. */
  readonly onChange?: (computerId: string, state: PushState) => void;
}

export function createPushManager(deps: PushManagerDeps): PushManager {
  const registrars = new Map<string, PushRegistrar>();
  const now = deps.now ?? Date.now;

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
    });
    registrars.set(computerId, created);
    return created;
  };

  return {
    async sync(computerId, link) {
      await registrarOf(computerId).sync(linkPushSink(link));
    },

    async setEnabled(computerId, enabled, link) {
      await registrarOf(computerId).setEnabled(enabled, linkPushSink(link));
    },

    view(computerId, computerName, permission) {
      const registrar = registrars.get(computerId);
      // No registrar = no link has come up yet for this computer: the row says
      // what the TOGGLE is (default on) without claiming a status nobody read.
      const state = registrar?.state() ?? initialPushState();
      return notificationsView(state, computerName, permission);
    },

    async setEnabledForAll(computers, enabled, linkOf) {
      for (const computer of computers) {
        await registrarOf(computer.id).setEnabled(enabled, linkPushSink(linkOf(computer.id)));
      }
    },

    viewForAll(computers, permission) {
      if (computers.length === 0) {
        // Nothing to register WITH: the switch is shown (it explains why) and is
        // not operable — a tap would have no computer to reach.
        return {
          ...notificationsView(initialPushState(), "this computer", permission),
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
      // start one), so a computer whose link never came up reads as `unknown` —
      // which is the truth, not a claim that nothing will arrive.
      const states = computers.map(
        (computer) => registrars.get(computer.id)?.state() ?? initialPushState(),
      );
      const worst = states.reduce((a, b) => ((rank[b.phase] ?? 0) > (rank[a.phase] ?? 0) ? b : a));
      const name =
        computers.find((_, index) => states[index] === worst)?.name ??
        computers[0]?.name ??
        "this computer";
      const enabled = states.some((state) => state.enabled);
      const view = notificationsView(worst, name, permission);
      return { ...view, enabled };
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
