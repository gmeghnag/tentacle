/**
 * The daemon's Live Activity SHELL (docs/feat/mobile-live-activity.md Design 4,
 * slice L7): the one place where "a session event happened" becomes "an
 * encrypted activity state is on its way to a phone".
 *
 * Four pieces, in this order, each already tested on its own:
 *
 *  1. **The rules** (`live-activity-rules.ts`, pure): whether a device should be
 *     showing an activity, what it says, and when to send it.
 *  2. **The content** (`@tentacle/protocol`'s `ActivityContent`, already fitted
 *     to the 1024-byte bucket by the rules — L2's gate).
 *  3. **The seal** (`@tentacle/transport/push`'s `sealActivity`): HPKE Auth,
 *     sender = this computer's static key, recipient = the DEVICE's push key,
 *     `info` = "tentacle-la/1", `aad` = `kid ‖ slot`. Apple and the relay only
 *     ever carry a ciphertext (F5), and a state cannot be moved to another
 *     activity (F7).
 *  4. **The sink** (the relay link, injected): a `liveactivity` frame.
 *
 * Two properties this file must not lose, and every test bites on one:
 *
 *  - **The hook is synchronous and O(1), and its I/O is deferred.** It runs
 *    inside `HostedSession.emit`, and `turn_end` runs inside the steering
 *    no-await window (AGENTS §7): the rules run synchronously, and every
 *    seal/send starts from a `queueMicrotask` AFTER the hook returned.
 *  - **A bug here is reported, never thrown into the turn** (F23): the session
 *    wraps the hook too, so this is the second of the two nets.
 *
 * **The update-token table is memory-only** (Owner Q8): an activity lives ≤ 12 h
 * and a restart's activities go stale anyway (L6's heartbeat), so persisting a
 * per-activity credential would buy nothing. `setUpdateToken` on a slot this
 * daemon did not start is `known:false`, which is also how a hostile app cannot
 * name an activity into existence (F25).
 *
 * **Convergence is by STATE, not by event replay** (F3): per slot only the newest
 * desired state is kept, nothing queues while the link is down, and `resendAll`
 * (called on `ready`) sends each live slot's current state once.
 */
import {
  type ActivityAttributes,
  type ActivityContent,
  type ActivityContentState,
  decodeBase64Url,
  encodeBase64Url,
} from "@tentacle/protocol";
import { type SealedPush, sealActivity } from "@tentacle/transport/push";
import type { PushHookEvent, SessionPushObserver } from "./hosted-session.ts";
import {
  type LaCommand,
  type LaRegistration,
  type LiveActivityRules,
  createLiveActivityRules,
} from "./live-activity-rules.ts";
import type { LiveRegistration } from "./live-store.ts";

/** One activity delivery for one device: what the sink needs to reach Apple through the relay. */
export interface LaDelivery {
  readonly deviceId: string;
  /** The UPDATE token when iOS has reported one, else the push-to-START token. */
  readonly token: string;
  readonly env: LiveRegistration["env"];
  /** `start` / `update` / `end` — the clear `aps.event`. */
  readonly event: "start" | "update" | "end";
  readonly priority: 5 | 10;
  /** The sealed state. Absent on `end`. */
  readonly contentState: ActivityContentState | undefined;
  /** The push-to-start attributes. Only on `start`. */
  readonly attributes: ActivityAttributes | undefined;
  /** `aps.stale-date` (seconds), from the rules. */
  readonly staleDate: number | undefined;
  /** `aps.dismissal-date` (seconds), from the rules. */
  readonly dismissalDate: number | undefined;
}

/**
 * Where an activity goes (the relay link). Resolves with the `push-result`
 * vocabulary; never rejects in practice, and this module turns a rejection into
 * `unavailable` anyway, because an activity is best-effort (the ask's own
 * notification is the reliable channel).
 */
export type LaSink = (delivery: LaDelivery) => Promise<string>;

/** Where the registrations come from (L5's store, filtered by the authority snapshot). */
export interface LaRegistrationsSource {
  /** The devices that may be started for RIGHT NOW (a usable record AND in the authority). */
  registered(): Iterable<string>;
  /** One device's registration, read fresh. */
  read(deviceId: string): LiveRegistration | undefined;
  /**
   * The device's X25519 PUSH key (base64url), from task 16's `devices/push/<id>.json`.
   * The same key the phone already uses to open a notification, so the widget
   * needs no second Keychain item — and a device with Live Activities but no
   * banner registration has no key, so it is dropped with a line, not silently.
   */
  pushKeyOf(deviceId: string): string | undefined;
  /** A `gone` from APNs: compare-and-delete, only while the file still holds that token (F13). */
  forget(deviceId: string, token: string): void;
}

/** The session facts an activity's content carries, read when it is built. */
export interface LaSessionFacts {
  readonly title: string;
  /** The daemon's `cwd`: the activity shows its BASENAME as the project. */
  readonly cwd: string;
}

export interface LaNotifierTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveActivityNotifierOptions {
  readonly now: () => number;
  /** `liveActivity.startAfterSeconds` (20 by default). */
  readonly startAfterSeconds?: number;
  /** Injected so a test pins the slot. */
  readonly newSlot?: () => string;
  readonly registrations: LaRegistrationsSource;
  /** The session's title and project, or `undefined` when it is already gone. */
  readonly describe: (sessionId: string) => LaSessionFacts | undefined;
  /**
   * This computer's static key (the seal's sender) and its display name (the
   * content's `computer`). `undefined` = no usable identity, so nothing is
   * sealed. The key ID is NEVER passed in: `sealActivity` derives it from the
   * key, so a caller-supplied one could only ever be a second source of truth
   * that disagrees with the envelope it labels.
   */
  readonly computer: () => { readonly privateKey: Uint8Array; readonly name: string } | undefined;
  readonly sink: LaSink;
  /** One line per event. Never a payload, never a token. */
  readonly onAudit?: (line: string) => void;
  readonly timers?: LaNotifierTimers;
  readonly random?: (length: number) => Uint8Array;
}

const systemTimers: LaNotifierTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never a reason to keep the process alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_RANDOM = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

/** A short id prefix for an audit line: never a whole token. */
const id8 = (id: string): string => id.slice(0, 8);

/**
 * The notifier: a `SessionPushObserver` plus the ONE timer it owns.
 *
 * Built by a `serve` with Live Activities on, and fed by the SAME
 * `onPushEvent` hook `PushNotifier` uses — one observer interface, two
 * subscribers (`SessionHostOptions.push` gets a fan-out; see `serve.ts`).
 * Absent everywhere else, structurally: a pod daemon never holds a token
 * (AGENTS §7).
 */
export interface LiveActivityNotifier extends SessionPushObserver {
  /** Arm the timer for the rules' next deadline (a no-op when nothing is pending). */
  arm(): void;
  /**
   * The registrations changed (a `device/live_activity_register` landed, a
   * device was revoked): read them again and re-decide NOW, without waiting for
   * the next hook event (fix round 1, R2 — the promise `session-host.ts`'s
   * `registerLiveActivity` comment already made).
   */
  registrationChanged(): void;
  /** Stop observing: the timer cleared, nothing in flight awaited. Idempotent. */
  stop(): void;
  /**
   * Swap a slot's push-to-START token for its per-activity UPDATE token (Owner
   * Q8). `false` = this daemon never started that activity: `known:false` on the
   * wire, and nothing changes (F25).
   */
  setUpdateToken(slot: string, token: string, deviceId: string): boolean;
  /** The app says an activity is over (dismissed / ended / stale): forget the slot. */
  reportEnded(slot: string, reason: "dismissed" | "ended" | "stale"): boolean;
  /**
   * The link came up: send the CURRENT state of every live slot once (F3 —
   * convergence by state, never by replaying the events the link missed).
   */
  resendAll(): void;
  /** How many slots this notifier is holding (a bounded count, for diagnostics/tests). */
  retained(): { readonly slots: number };
  /** A tick now, instead of waiting for the timer (a test's handle on the clock). */
  tickForTest(): void;
  /** The deliveries handed to the sink so far (read-only, a test's window on the wire). */
  deliveriesForTest(): readonly LaDelivery[];
}

export function createLiveActivityNotifier(
  options: LiveActivityNotifierOptions,
): LiveActivityNotifier {
  const now = options.now;
  const timers = options.timers ?? systemTimers;
  const random = options.random ?? DEFAULT_RANDOM;
  const audit = options.onAudit ?? (() => {});
  const deliveries: LaDelivery[] = [];
  const rules: LiveActivityRules = createLiveActivityRules({
    now,
    ...(options.startAfterSeconds !== undefined
      ? { startAfterSeconds: options.startAfterSeconds }
      : {}),
    ...(options.newSlot !== undefined ? { newSlot: options.newSlot } : {}),
  });
  /**
   * `${deviceId}\u0000${startToken}` pairs APNs refused with `gone` (R3): that
   * token cannot reach the phone at all, so the device is not a start candidate
   * while it is still the registration's token. Cleared when a device
   * re-registers (a new token), and bounded by the devices a `serve` knows.
   */
  const deadStartTokens = new Set<string>();
  /**
   * `slot → {deviceId, token}`: the per-activity UPDATE tokens (Owner Q8,
   * memory only). A slot leaves when the activity ends, is dismissed or is
   * rolled over.
   */
  const updateTokens = new Map<string, { readonly deviceId: string; readonly token: string }>();
  /**
   * `slot → has a delivery for it ever been CONFIRMED by the sink` (R4). A slot
   * the phone has never acknowledged must be pushed as a `start`: an `update` to
   * a push-to-START token creates nothing, so a resync that sent one leaves the
   * turn invisible on that phone for its whole life.
   */
  const confirmed = new Set<string>();
  /**
   * `sessionId → the turn id it is on`. `tool_call` carries none, and the rules
   * need one to tell two turns apart; one entry per session (replaced by its next
   * `turn_start`), so this is bounded by the sessions a `serve` holds.
   */
  const turnIds = new Map<string, string>();
  let stopped = false;
  let handle: unknown;
  let armedAt: number | undefined;

  /**
   * The registrations, as the rules need them (only the `enabled` flag: WHO may
   * be started for) and as the sink needs them (the token, env and id). Read
   * through the injected source at every decision, so a revoked device or a
   * switched-off one is filtered at the moment it matters (F12).
   */
  const refreshRegistrations = (): Map<string, LaRegistration> => {
    const map = new Map<string, LaRegistration>();
    for (const deviceId of options.registrations.registered()) {
      const registration = options.registrations.read(deviceId);
      if (registration === undefined) {
        continue;
      }
      // R3: a token APNs already called `gone` reaches nothing, so this device is
      // not a start candidate while it is still the token on the record. A
      // re-registration (a NEW token) clears the mark below, and the entry is
      // pruned here so the set cannot grow with every device ever seen.
      const deadKey = `${deviceId}\u0000${registration.startToken}`;
      if (deadStartTokens.has(deadKey)) {
        continue;
      }
      map.set(deviceId, { enabled: registration.enabled });
    }
    for (const key of [...deadStartTokens]) {
      const [deviceId, token] = key.split("\u0000");
      const current =
        deviceId === undefined ? undefined : options.registrations.read(deviceId)?.startToken;
      if (current !== token) {
        deadStartTokens.delete(key);
      }
    }
    rules.setRegistrations(map);
    return map;
  };

  /** The project name a lock screen shows: the LAST path segment of the session's `cwd`. */
  const projectOf = (cwd: string): string => {
    const parts = cwd.split(/[/\\]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? cwd;
  };

  /** The clear `attributes` of a push-to-start (Design 2): the kid and the slot, no content. */
  const attributesOf = (slot: string, keyId: string): ActivityAttributes => ({
    v: 1,
    k: keyId,
    slot,
  });

  /**
   * Seal one content for one activity and hand it to the sink. `undefined` = that
   * device is not reached this time (no registration, an unusable key): one audit
   * line says so, and the other devices are unaffected.
   */
  const deliverOne = async (
    command: LaCommand & { readonly kind: "start" | "update" | "end" },
    content: ActivityContent,
    computer: { readonly privateKey: Uint8Array; readonly name: string },
  ): Promise<void> => {
    if (stopped) {
      return;
    }
    const registration = options.registrations.read(command.deviceId);
    if (registration === undefined) {
      return;
    }
    if (!registration.enabled) {
      return;
    }
    const updateToken = updateTokens.get(command.slot)?.token;
    /**
     * R4 (F3 convergence): an `update` for a slot the sink never CONFIRMED has
     * nothing to update on the phone — an update to a push-to-START token creates
     * nothing — so it goes out as a `start`, and a turn the relay dropped (or
     * dropped before iOS reported a token) still appears.
     *
     * An `end` for such a slot is DROPPED instead: there is nothing on the phone
     * to dismiss, and a start would create an activity for a turn already over.
     */
    const neverDelivered = !confirmed.has(command.slot);
    if (command.kind === "end" && neverDelivered) {
      updateTokens.delete(command.slot);
      audit(`la-dropped never-started ${id8(command.deviceId)}`);
      return;
    }
    const event = command.kind === "update" && neverDelivered ? "start" : command.kind;
    const token = updateToken ?? registration.startToken;
    let contentState: ActivityContentState | undefined;
    let attributes: ActivityAttributes | undefined;
    if (event !== "end") {
      let sealed: SealedPush;
      try {
        sealed = sealActivity(
          new TextEncoder().encode(JSON.stringify(content)),
          computer.privateKey,
          // The DEVICE's push key: the same key task 16's push is sealed to, so
          // the widget opens both with one Keychain item.
          devicePushKey(command.deviceId) ?? new Uint8Array(0),
          command.slot,
          random,
        );
      } catch (error) {
        audit(
          `la-dropped seal ${id8(command.deviceId)} ${error instanceof Error ? error.message : ""}`,
        );
        return;
      }
      contentState = {
        v: 1,
        e: encodeBase64Url(sealed.enc),
        c: encodeBase64Url(sealed.ciphertext),
      };
      if (event === "start") {
        // Only a push-to-start carries attributes (there is no activity to
        // inherit them from) — and its `k` is the kid the widget picks by.
        attributes = attributesOf(command.slot, sealed.keyId);
      }
    }
    const delivery: LaDelivery = {
      deviceId: command.deviceId,
      token,
      env: registration.env,
      event,
      // A push that CREATES the activity is a start, whatever the rules called
      // it (R4): iOS may defer a priority-5 push, and a start must not be
      // deferred or the turn never appears.
      priority: event === "start" ? 10 : command.priority,
      contentState,
      attributes,
      // Both follow the EVENT that actually goes out, not the command the rules
      // wrote (R4): a command re-sent as a `start` must lose the end's dismissal
      // date, or the phone drops the activity it just created.
      staleDate: event === "end" || command.kind === "end" ? undefined : command.staleAt,
      dismissalDate: event === "end" && command.kind === "end" ? command.dismissAt : undefined,
    };
    deliveries.push(delivery);
    let status: string;
    try {
      status = await options.sink(delivery);
    } catch {
      audit(`la-dropped sink ${id8(command.deviceId)}`);
      return;
    }
    if (status === "sent") {
      // The phone took it: from now on this slot exists there, so its next push
      // is an `update` (R4's whole point).
      confirmed.add(command.slot);
      audit(`la-sent ${event} ${id8(command.deviceId)}`);
      return;
    }
    if (status === "gone") {
      // F13: the token is dead. Compare-and-delete, so a fresh re-registration is
      // not muted by a late answer.
      options.registrations.forget(command.deviceId, token);
      audit(`la-gone ${id8(command.deviceId)}`);
      // A push-to-START token APNs refuses reaches nothing at all: the device is
      // not a start candidate until it re-registers (R3, F13).
      if (updateToken === undefined) {
        deadStartTokens.add(`${command.deviceId}\u0000${token}`);
      }
      // R3: the RULES must hear it too. `gone` is the system saying the activity
      // is no longer there (the person dismissed it, iOS ended it at its cap, or
      // the token rotated) — without this the slot stayed "live" for ever and the
      // 10-minute heartbeat kept knocking on a dead token, and F17 (never
      // restarted after a dismissal) / F18 (ONE continuation after a system end)
      // could not exist. `command.kind === "end"` has nothing left to end.
      confirmed.delete(command.slot);
      updateTokens.delete(command.slot);
      if (command.kind !== "end") {
        consume(
          rules.apply({
            type: "ended",
            sessionId: command.sessionId,
            slot: command.slot,
            // A `gone` on an UPDATE/START is the SYSTEM's ending, not the
            // person's gesture: the phone never told us which, and restarting a
            // turn the system cut is right (F18) while restarting a dismissed one
            // is not (F17). The app's own `_ended` is what reports a dismissal.
            reason: "ended",
          }),
        );
      }
      return;
    }
    audit(`la-dropped ${status} ${id8(command.deviceId)}`);
  };

  /**
   * The device's push key, base64url. Read through the registrations source so
   * the notifier never touches the store itself; `undefined` means "no usable
   * key", which `deliverOne` turns into a dropped delivery rather than a throw.
   *
   * The store's record for a device holds BOTH a banner token and the push key
   * (task 16's `push/<id>.json`), while the LIVE record holds only the start
   * token — so the key comes from the banner record, which is the same key the
   * phone already uses. A device with Live Activities but no banner registration
   * has no key to seal to, and is dropped with a line (never silently).
   */
  const devicePushKey = (deviceId: string): Uint8Array | undefined => {
    const keyText = options.registrations.pushKeyOf(deviceId);
    if (keyText === undefined) {
      return undefined;
    }
    // Decoded here rather than in the sink: this module owns the seal, so it owns
    // what the seal is given.
    return decodeBase64Url(keyText);
  };

  /** One rules result: audit its notes, defer its commands out of this stack. */
  const consume = (commands: readonly LaCommand[]): void => {
    if (commands.length === 0) {
      return;
    }
    const batch = [...commands];
    queueMicrotask(() => {
      for (const command of batch) {
        if (command.kind === "note") {
          audit(`la-capped ${command.detail}`);
          continue;
        }
        const computer = options.computer();
        if (computer === undefined) {
          audit("la-dropped no-identity");
          return;
        }
        void deliverOne(command, command.content, computer);
      }
    });
  };

  /**
   * Arm the ONE timer for the rules' next deadline — cancelling an armed timer
   * only when the deadline moved EARLIER, exactly as `PushNotifier` does and for
   * the same reason (a later event must not lengthen a shorter wait).
   */
  const arm = (): void => {
    if (stopped) {
      return;
    }
    const due = rules.nextDeadlineAt();
    if (due === undefined) {
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
        armedAt = undefined;
      }
      return;
    }
    if (handle !== undefined && armedAt !== undefined && armedAt <= due) {
      return;
    }
    if (handle !== undefined) {
      timers.clearTimeout(handle);
    }
    armedAt = due;
    handle = timers.setTimeout(tick, Math.max(0, due - now()));
  };

  /**
   * The rules' deadline arrived: decide, act, and re-arm for the next one.
   */
  const tick = (): void => {
    handle = undefined;
    armedAt = undefined;
    if (stopped) {
      return;
    }
    // The registrations are read HERE, at the decision, not once at the first
    // event (R2): a phone that registers after `serve` has already seen an event
    // — or turns its switch back on — must be a start candidate without a
    // restart. The source is a directory read, and a deadline is a minute apart
    // at worst, so this is not a hot path.
    refreshRegistrations();
    consume(
      rules.apply(
        // The clock decides; the attached set is standing state the rules
        // already hold per session (R1) — this call must never invent one.
        { type: "tick" },
      ),
    );
    arm();
  };

  /** The update-token table must not outlive the activities it names (bounded state). */
  const pruneTokens = (): void => {
    const live = new Set(rules.liveSlots().map((slot) => slot.slot));
    for (const slot of [...updateTokens.keys()]) {
      if (!live.has(slot)) {
        updateTokens.delete(slot);
      }
    }
    // Same for R4's confirmed set: a slot the rules forgot can never be pushed
    // again, so its entry is dead weight (and an unbounded set on a long-lived
    // `serve` is a leak).
    for (const slot of [...confirmed]) {
      if (!live.has(slot)) {
        confirmed.delete(slot);
      }
    }
  };

  /**
   * One session hook event → the rules' vocabulary. `attachment` is the attached
   * set moving (read at the deadline, F17) — the rules need it as an event of its
   * own for exactly the reason task 16's do.
   */
  const translate = (
    sessionId: string,
    event: PushHookEvent,
    attached: { readonly clients: number; readonly devices: readonly string[] },
  ): LaCommand[] => {
    if (event.type === "attachment") {
      // The attached set is STANDING state, per session (R1): recorded, and the
      // clock asked to look again at once — a detach can make a start due this
      // instant, and an attach can cancel one.
      const devices = new Set(attached.devices);
      rules.setAttached(sessionId, devices);
      return rules.apply({ type: "tick" });
    }
    const update = event.update;
    const facts = options.describe(sessionId);
    switch (update.type) {
      case "turn_start":
        turnIds.set(sessionId, update.turnId);
        return rules.apply({
          type: "turn_start",
          sessionId,
          turnId: update.turnId,
          // The content's computer/project/title come from the session, which is
          // where the truth is: `turn_start` itself carries only the turn id.
          computer: options.computer()?.name ?? "",
          project: facts === undefined ? "" : projectOf(facts.cwd),
          title: facts?.title ?? "",
          at: now(),
        });
      case "tool_call":
        return rules.apply({
          type: "tool_call",
          sessionId,
          turnId: currentTurnIdOf(sessionId) ?? "",
          tool: update.title,
        });
      case "permission_request":
        return rules.apply({
          type: "permission_request",
          sessionId,
          requestId: update.requestId,
          tool: update.tool,
          preview: update.explanation ?? update.title,
          // Only the option KINDS the widget may offer (Owner Q6): `allow_once`
          // and `reject_once`. A fragment of the ask, not a decision about it.
          options: update.options
            .filter((option) => option.kind === "allow_once" || option.kind === "reject_once")
            .map((option) => ({ optionId: option.optionId, kind: option.kind })),
        });
      case "permission_resolved":
        return rules.apply({
          type: "permission_resolved",
          sessionId,
          requestId: update.requestId,
        });
      case "session_title":
        return rules.apply({ type: "session_title", sessionId, title: update.title });
      case "turn_end":
        return rules.apply({
          type: "turn_end",
          sessionId,
          turnId: update.turnId,
          stopReason: update.stopReason,
          ...(update.error === undefined ? {} : { error: update.error.message }),
        });
      case "session_closed":
        turnIds.delete(sessionId);
        return rules.apply({ type: "session_closed", sessionId });
      default:
        // Not a watched kind (the session's own filter decides that): nothing.
        return [];
    }
  };

  /**
   * The turn id a session is on, as the daemon announced it. `tool_call` carries
   * no turn id, and the rules need one to tell two turns apart, so the last
   * `turn_start` is remembered — bounded by the sessions this daemon holds.
   */
  const currentTurnIdOf = (sessionId: string): string | undefined => turnIds.get(sessionId);

  return {
    onPushEvent(sessionId, event, attached) {
      if (stopped) {
        return;
      }
      try {
        // The SAME refresh as `tick` (R2), and for the same reason: an ASK is a
        // decision about WHO to start for, so it cannot run on a snapshot taken
        // hours ago. This is what the comment on `refreshRegistrations` has
        // claimed since L7; until fix round 1 it was only done once.
        refreshRegistrations();
        const commands = translate(sessionId, event, attached);
        consume(commands);
        pruneTokens();
        arm();
      } catch (error) {
        // The session's own wrapper reports too; this keeps a notifier bug from
        // costing the updates the clients after it (F23).
        audit(`la-dropped internal ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    /** One hook event, translated into the rules' own vocabulary. */
    arm,

    registrationChanged() {
      if (stopped) {
        return;
      }
      try {
        refreshRegistrations();
        // A registration can make a start due this instant (a phone that was not
        // a candidate a second ago) or cancel one (its switch went off): decide
        // now, then re-arm for whatever deadline the new set implies.
        consume(rules.apply({ type: "tick" }));
        pruneTokens();
        arm();
      } catch (error) {
        audit(`la-dropped internal ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    setUpdateToken(slot, token, deviceId) {
      const known = rules.liveSlots().some((entry) => entry.slot === slot);
      if (!known) {
        return false;
      }
      updateTokens.set(slot, { deviceId, token });
      return true;
    },

    reportEnded(slot, reason) {
      const known = rules.liveSlots().find((entry) => entry.slot === slot);
      if (known === undefined) {
        return false;
      }
      // The rules forget the activity (a `dismissed` one is never restarted for
      // that turn — F17), and its token dies with it.
      consume(rules.apply({ type: "ended", sessionId: known.sessionId, slot, reason }));
      updateTokens.delete(slot);
      confirmed.delete(slot);
      return true;
    },

    resendAll() {
      resend();
    },

    retained: () => ({ slots: rules.liveSlots().length }),
    tickForTest: tick,
    deliveriesForTest: () => deliveries,

    stop() {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
        armedAt = undefined;
      }
      updateTokens.clear();
      confirmed.clear();
      deadStartTokens.clear();
      turnIds.clear();
    },
  };

  /**
   * F3: on `ready`, each live slot's CURRENT state is sent once — an `update`
   * for an activity that already exists, since the phone kept it while the link
   * was down. Sending a `start` again would create a second activity object.
   */
  function resend(): void {
    if (stopped) {
      return;
    }
    const computer = options.computer();
    if (computer === undefined) {
      audit("la-dropped no-identity");
      return;
    }
    const batch: LaCommand[] = [];
    for (const entry of rules.liveSlots()) {
      const content = rules.contentOf(entry.slot);
      if (content === undefined) {
        continue;
      }
      const facts = options.describe(entry.sessionId);
      if (facts === undefined) {
        continue;
      }
      batch.push({
        kind: "update",
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
        slot: entry.slot,
        priority: 5,
        content,
        staleAt: Math.floor((now() + 15 * 60_000) / 1_000),
      });
    }
    queueMicrotask(() => {
      for (const command of batch) {
        if (command.kind === "note") {
          continue;
        }
        void deliverOne(command, command.content, computer);
      }
    });
  }
}

/**
 * The translation from the session hook's own vocabulary to the rules', done
 * inside the factory so it closes over the ONE rules instance (a module-level
 * variable would be shared by every daemon in the process — a real bug, not a
 * style choice).
 */
