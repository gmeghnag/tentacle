/**
 * The Live Activity RULES: whether a device should be showing an activity for a
 * session, what it should say, and when to send it
 * (docs/feat/mobile-live-activity.md Design 3, slice L6).
 *
 * Pure (AGENTS §7): no sockets, no fs, no timers of its own, no clock but the
 * injected one. Time-driven work is the explicit `tick` event, so every rule here
 * — the start threshold, the coalescing window, the heartbeat, the 8 h rollover —
 * is a table test rather than a sleep. The shell (L7's `LiveActivityNotifier`)
 * owns the one real timer: it asks {@link LiveActivityRules.nextDeadlineAt} and
 * calls `apply({type:"tick"})` when it arrives. That inversion is why this slice
 * is `contained`: there is no timer to leak and no clock to fake.
 *
 * **It decides only DISPLAY.** Nothing here can answer an ask: the activity's
 * buttons open the app, which re-opens the sealed state and then goes through
 * task 17's coordinator to the one `session/resolve_permission` path. The daemon
 * never settles an ask of its own (AGENTS §7 "one session path", and
 * `hosted-session.ts`'s own header comment), so an activity can never race a
 * decision — the worst a hostile or buggy activity can do is show a stale view.
 *
 * The rules, one per Design 3 bullet:
 *
 *  - **Start** for a (device, session) where the device has an ENABLED
 *    registration and is NOT attached to that session, once the turn has run
 *    {@link DEFAULT_LA_START_AFTER_SECONDS} or an ask is raised (immediately: a
 *    waiting approval is the one thing worth a lock-screen light).
 *  - **Update** on a new tool call (COALESCED to one per
 *    {@link LA_TOOL_COALESCE_MS}, priority 5), on an ask (`asking`, immediate,
 *    priority 10), on its resolution (`running`, immediate, 10), on the title
 *    (coalesced) and a HEARTBEAT every {@link LA_HEARTBEAT_MS} of silence that
 *    moves `stale-date` (priority 5).
 *  - **End** on the turn's end (`done` / `failed` / `cancelled`, dismissal
 *    {@link LA_DONE_LINGER_MS} away) and on `session_closed` (at once).
 *  - **The 8 h cap**: at {@link LA_ROLLOVER_MS} of an activity's life with the
 *    turn still running, end it and START A CONTINUATION — a new slot (a new
 *    activity object on the phone) with the SAME `turnId` and `startedAt`, so the
 *    elapsed timer is continuous across the seam.
 *  - **Dismissed** by the person: never restarted for that turn (the next turn
 *    may start one).
 *  - **At most {@link LA_MAX_LIVE_PER_DEVICE}** live per device: a new start
 *    evicts the oldest `done` one; with nothing to evict it is SKIPPED with a
 *    note (`la-capped`), never silently.
 */
import {
  ACTIVITY_COMPUTER_MAX,
  ACTIVITY_PROJECT_MAX,
  ACTIVITY_TITLE_MAX,
  ACTIVITY_TOOL_MAX,
  type ActivityAskOption,
  type ActivityContent,
  type ActivityKind,
  type LiveActivityEndReason,
  clipActivityText,
  fitActivityContent,
} from "@tentacle/protocol";

/**
 * How long a turn must run before a device that is not watching it gets an
 * activity: 20 s, so short Q&A never lights a phone at someone's desk (Owner Q3).
 */
export const DEFAULT_LA_START_AFTER_SECONDS = 20;

/** Tool / title updates are coalesced to one per this window (design 3: ≤ 1 / 15 s). */
export const LA_TOOL_COALESCE_MS = 15_000;

/** A heartbeat this long after the last push moves `stale-date`, so a quiet daemon reads "may be out of date". */
export const LA_HEARTBEAT_MS = 10 * 60_000;

/** How far ahead of a heartbeat `stale-date` sits: 15 min, i.e. one heartbeat plus slack (F2). */
export const LA_STALE_MS = 15 * 60_000;

/** How long a finished activity stays on the lock screen: "done for a few minutes" (decision 11). */
export const LA_DONE_LINGER_MS = 5 * 60_000;

/**
 * When a live activity is rolled over: 7 h 45 min of ITS OWN life, leaving iOS's
 * 8 h cap a 15-minute margin (Owner Q5). Measured from the activity's start, not
 * the turn's, because that is what iOS measures.
 */
export const LA_ROLLOVER_MS = (7 * 60 + 45) * 60_000;

/**
 * How many activities one device may have live at once: 3, where iOS allows
 * about 5 per app — the headroom is for the rollover's end+start pair, which for
 * a moment is two (Owner Q3).
 */
export const LA_MAX_LIVE_PER_DEVICE = 3;

/** What a device's registration says, as the rules need it (the store's record, narrowed). */
export interface LaRegistration {
  readonly enabled: boolean;
}

/**
 * One update the rules were asked about. `tool_call` / `session_title` are the
 * kinds task 16's push hook did not watch; L7 widens the hook's filter for them.
 */
export type LaEvent =
  | {
      readonly type: "turn_start";
      readonly sessionId: string;
      readonly turnId: string;
      readonly computer: string;
      readonly project: string;
      readonly title: string;
      /** The turn's ORIGINAL start (ms): the elapsed timer's origin, and the rollover's. */
      readonly at: number;
    }
  | {
      readonly type: "tool_call";
      readonly sessionId: string;
      readonly turnId: string;
      readonly tool: string;
    }
  | {
      readonly type: "permission_request";
      readonly sessionId: string;
      readonly requestId: string;
      readonly tool: string;
      readonly preview: string;
      readonly options: readonly ActivityAskOption[];
    }
  | { readonly type: "permission_resolved"; readonly sessionId: string; readonly requestId: string }
  | { readonly type: "session_title"; readonly sessionId: string; readonly title: string }
  | {
      readonly type: "turn_end";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stopReason: string;
      readonly error?: string;
    }
  | { readonly type: "session_closed"; readonly sessionId: string }
  /**
   * The app reports an activity gone: `dismissed` is the person's gesture (never
   * restart it for that turn), `ended` / `stale` are the system's (a fresh one
   * may be started — F18's "one continuation start" after iOS ended it first).
   */
  | {
      readonly type: "ended";
      readonly sessionId: string;
      readonly slot: string;
      readonly reason: LiveActivityEndReason;
    }
  /**
   * The clock has reached `nextDeadlineAt`, or simply "look again now".
   *
   * It carries NO attached set: who is watching a session is a STANDING fact
   * about that session, not a property of one event, and it arrives on its own
   * through {@link LiveActivityRules.setAttached} (fix round 1, R1 — a tick that
   * took the set as an argument could only ever be as fresh as its caller, and
   * the shell's own timer had no set to pass).
   */
  | { readonly type: "tick" };

/**
 * What the shell must do, in order. `start` and `end` name the activity by
 * `slot` — the daemon's own handle on one activity object on the phone, and the
 * AEAD's aad half (L1), so a state can never be rendered inside another.
 */
export type LaCommand =
  | LaPushCommand
  | {
      readonly kind: "end";
      readonly sessionId: string;
      readonly deviceId: string;
      readonly slot: string;
      readonly priority: 10;
      readonly content: ActivityContent;
      /** `aps.dismissal-date` (seconds): when the phone may drop it. */
      readonly dismissAt: number;
    }
  /** An audit line the shell logs (never silent: F20). */
  | { readonly kind: "note"; readonly code: string; readonly detail: string };

/** `start` and `update` differ only in kind: both push a content-state at a priority. */
export interface LaPushCommand {
  readonly kind: "start" | "update";
  readonly sessionId: string;
  readonly deviceId: string;
  readonly slot: string;
  readonly priority: 5 | 10;
  readonly content: ActivityContent;
  /** `now + LA_STALE_MS` (seconds, for `aps.stale-date`). */
  readonly staleAt: number;
}

/** What one (session, device) activity currently is. */
interface LiveActivityState {
  readonly sessionId: string;
  readonly deviceId: string;
  /** Changes on a rollover: the phone's activity object, and the aad's second half. */
  slot: string;
  readonly turnId: string;
  /** The turn's original start (ms) — never reset by a rollover. */
  readonly startedAt: number;
  /** When THIS activity object began (ms): the rollover is measured from here. */
  objectStartedAt: number;
  /** The last content sent, so a heartbeat can repeat it with a fresh `stale-date`. */
  content: ActivityContent;
  /** `seq` for the next content, monotonic per slot (a widget can order by it). */
  seq: number;
  kind: ActivityKind;
  /** When the last UPDATE went out, for coalescing. `undefined` = the window is empty. */
  lastUpdateAt: number | undefined;
  /** When the last push of ANY kind went out, for the heartbeat. */
  lastPushAt: number;
  /** A turn has ended and this is `done`/`failed`/`cancelled`: it may be evicted. */
  finished: boolean;
  /** The person swiped it away: never restart for this turn. */
  dismissed: boolean;
  computer: string;
  project: string;
  title: string;
  tool: string | undefined;
  ask:
    | { requestId: string; tool: string; preview: string; options: readonly ActivityAskOption[] }
    | undefined;
  error: string | undefined;
}

/** A session the rules are tracking a TURN for (independent of any activity). */
interface TurnState {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startedAt: number;
  computer: string;
  project: string;
  title: string;
  tool: string | undefined;
  ask:
    | { requestId: string; tool: string; preview: string; options: readonly ActivityAskOption[] }
    | undefined;
  error: string | undefined;
  stopReason: string | undefined;
  /** The last content kind, so a resolution can return to `running` only from `asking`. */
  kind: ActivityKind;
}

export interface LiveActivityRulesOptions {
  readonly now: () => number;
  /** `liveActivity.startAfterSeconds` (20 by default). */
  readonly startAfterSeconds?: number;
  /** Injected so a test (and the vectors) can pin the slot; defaults to the protocol's random one. */
  readonly newSlot?: () => string;
}

export interface LiveActivityRules {
  /** The registration for each device (the store's records, as the shell read them). */
  setRegistrations(registrations: ReadonlyMap<string, LaRegistration>): void;
  /**
   * The devices attached (app foreground) to ONE session, as the session's own
   * hook just reported them. Standing state, per session: the start rule reads
   * it at the deadline, on an ask, and on every other decision (F16, R1).
   */
  setAttached(sessionId: string, attached: ReadonlySet<string>): void;
  /** Override the slot source (a test pins it; the shell leaves it alone). */
  setSlotSource(newSlot: () => string): void;
  /** Feed one event; get the commands it implies, in order. */
  apply(event: LaEvent): LaCommand[];
  /** The earliest instant `apply({type:"tick"})` is worth calling, or `undefined` when idle. */
  nextDeadlineAt(): number | undefined;
  /** Every live activity's slot and session, for a resync on `ready` (the shell resends these). */
  liveSlots(): readonly {
    readonly slot: string;
    readonly sessionId: string;
    readonly deviceId: string;
  }[];
  /** The content last sent for a slot, so a resync can repeat it (convergence by state). */
  contentOf(slot: string): ActivityContent | undefined;
}

const keyOf = (sessionId: string, deviceId: string): string => `${sessionId}\u0000${deviceId}`;

/** The set a session nobody is attached to reports: allocated once, never mutated. */
const EMPTY_ATTACHED: ReadonlySet<string> = new Set<string>();

/**
 * The turn's outcome as the activity's kind. `end_turn` and `max_tokens` are both
 * a normal finish (the turn did what it could); `cancelled` says someone stopped
 * it; anything else is a failure with an error line.
 */
function kindOfStop(stopReason: string): ActivityKind {
  if (stopReason === "end_turn" || stopReason === "max_tokens") {
    return "done";
  }
  if (stopReason === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

/** `true` iff `stopReason` is a clean finish (an `error` line makes no sense for it). */
function isCleanStop(stopReason: string): boolean {
  return stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "cancelled";
}

export function createLiveActivityRules(options: LiveActivityRulesOptions): LiveActivityRules {
  const startAfterMs = (options.startAfterSeconds ?? DEFAULT_LA_START_AFTER_SECONDS) * 1_000;
  let newSlot = options.newSlot ?? ((): string => newActivitySlotLocal());
  const turns = new Map<string, TurnState>();
  const activities = new Map<string, LiveActivityState>();
  /** Turns whose activity the person dismissed: never restarted until the next turn. */
  const dismissedTurns = new Set<string>();
  let registrations: ReadonlyMap<string, LaRegistration> = new Map();
  /**
   * `sessionId → the devices attached to it` (app foreground). Standing state,
   * written by the session's own `attachment` hook event and read at every
   * decision (F16, R1). Bounded by the sessions this daemon holds: an entry goes
   * with `session_closed`.
   */
  const attachedBySession = new Map<string, ReadonlySet<string>>();

  /** The devices attached to one session (empty when the session reported none). */
  const attachedTo = (sessionId: string): ReadonlySet<string> =>
    attachedBySession.get(sessionId) ?? EMPTY_ATTACHED;

  const nowMs = (): number => options.now();

  /** The live activities for one device, oldest activity object first. */
  const liveFor = (deviceId: string): LiveActivityState[] =>
    [...activities.values()]
      .filter((state) => state.deviceId === deviceId)
      .sort((a, b) => a.objectStartedAt - b.objectStartedAt);

  /** The content for a state at `seq`/`at`, clipped to the wire's budget (L2's gate). */
  const contentOf = (state: LiveActivityState, kind: ActivityKind, at: number): ActivityContent => {
    const base: ActivityContent = {
      v: 1,
      slot: state.slot,
      seq: state.seq,
      at,
      kind,
      computer: clipActivityText(state.computer, ACTIVITY_COMPUTER_MAX),
      project: clipActivityText(state.project, ACTIVITY_PROJECT_MAX),
      title: clipActivityText(state.title, ACTIVITY_TITLE_MAX),
      turnId: state.turnId,
      startedAt: state.startedAt,
      ...(state.tool === undefined
        ? {}
        : { tool: clipActivityText(state.tool, ACTIVITY_TOOL_MAX) }),
      ...(kind === "asking" && state.ask !== undefined
        ? {
            ask: {
              requestId: state.ask.requestId,
              tool: state.ask.tool,
              preview: state.ask.preview,
              // `ActivityContent`'s array is mutable; ours is readonly by design
              // (the rules never reorder an option), so copy at the boundary.
              options: [...state.ask.options],
            },
          }
        : {}),
      ...(kind === "failed" && state.error !== undefined ? { error: state.error } : {}),
    };
    return fitActivityContent(base);
  };

  /** Mark every activity as needing a fresh `stale-date` (the heartbeat's whole job). */
  const pushOf = (
    state: LiveActivityState,
    kind: ActivityKind,
    priority: 5 | 10,
    at: number,
  ): { command: LaPushCommand; state: LiveActivityState } => {
    const seq = state.seq + 1;
    const next: LiveActivityState = { ...state, seq, kind };
    const content = contentOf(next, kind, at);
    next.content = content;
    next.lastPushAt = at;
    next.lastUpdateAt = at;
    const command: LaPushCommand = {
      kind: "update",
      sessionId: next.sessionId,
      deviceId: next.deviceId,
      slot: next.slot,
      priority,
      content,
      staleAt: Math.floor((at + LA_STALE_MS) / 1_000),
    };
    return { state: next, command };
  };

  /**
   * The start command for one (session, device), or a `la-capped` note when the
   * device already has the maximum and nothing `done` to evict. A device
   * attached to THAT session is never started for — the person is looking at it
   * — and the check lives here so no caller can forget it (R1).
   */
  const startFor = (
    turn: TurnState,
    deviceId: string,
    kind: ActivityKind,
    at: number,
  ): LaCommand[] => {
    if (attachedTo(turn.sessionId).has(deviceId)) {
      return [];
    }
    const live = liveFor(deviceId);
    const commands: LaCommand[] = [];
    if (live.length >= LA_MAX_LIVE_PER_DEVICE) {
      // Evict the OLDEST finished one; if none is finished, skip and say so.
      const evictable = live.find((state) => state.finished);
      if (evictable === undefined) {
        return [
          {
            kind: "note",
            code: "la-capped",
            detail: `${deviceId} already has ${LA_MAX_LIVE_PER_DEVICE} live activities`,
          },
        ];
      }
      commands.push({
        kind: "end",
        sessionId: evictable.sessionId,
        deviceId,
        slot: evictable.slot,
        priority: 10,
        content: contentOf(evictable, evictable.kind, at),
        dismissAt: Math.floor(at / 1_000),
      });
      activities.delete(keyOf(evictable.sessionId, deviceId));
    }
    const state: LiveActivityState = {
      sessionId: turn.sessionId,
      deviceId,
      slot: newSlot(),
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      objectStartedAt: at,
      seq: 0,
      kind,
      lastUpdateAt: at,
      lastPushAt: at,
      finished: kind !== "running" && kind !== "asking",
      dismissed: false,
      computer: turn.computer,
      project: turn.project,
      title: turn.title,
      tool: turn.tool,
      ask: turn.ask,
      error: turn.error,
      content: {
        v: 1,
        slot: "",
        seq: 0,
        at,
        kind,
        computer: "",
        project: "",
        title: "",
        turnId: turn.turnId,
        startedAt: turn.startedAt,
      },
    };
    const content = contentOf(state, kind, at);
    state.content = content;
    activities.set(keyOf(turn.sessionId, deviceId), state);
    commands.push({
      kind: "start",
      sessionId: turn.sessionId,
      deviceId,
      slot: state.slot,
      priority: 10,
      content,
      staleAt: Math.floor((at + LA_STALE_MS) / 1_000),
    });
    return commands;
  };

  /** Every activity of a session, keyed by device. */
  const activitiesOfSession = (sessionId: string): LiveActivityState[] =>
    [...activities.values()].filter((state) => state.sessionId === sessionId);

  /**
   * A plain content update for every live activity of a session, honouring the
   * coalescing window when `coalesced` is set. Returns the commands and mutates
   * the stored states in place (through `activities.set`).
   */
  const updateAll = (
    sessionId: string,
    kind: ActivityKind,
    priority: 5 | 10,
    at: number,
    coalesced: boolean,
  ): LaCommand[] => {
    const commands: LaCommand[] = [];
    const turn = turns.get(sessionId);
    for (const state of activitiesOfSession(sessionId)) {
      if (state.dismissed) {
        continue;
      }
      if (
        coalesced &&
        state.lastUpdateAt !== undefined &&
        at - state.lastUpdateAt < LA_TOOL_COALESCE_MS
      ) {
        continue;
      }
      // The TURN is the source of truth for what the view says; the activity
      // carries only its own identity (slot, turnId, startedAt) and cadence.
      // Without this copy an update would render the state the activity was
      // STARTED with (a stale tool, a stale title) — the bug this line exists for.
      const fresh: LiveActivityState =
        turn === undefined
          ? state
          : {
              ...state,
              computer: turn.computer,
              project: turn.project,
              title: turn.title,
              tool: turn.tool,
              ask: turn.ask,
              error: turn.error,
            };
      const { command, state: next } = pushOf(fresh, kind, priority, at);
      activities.set(keyOf(state.sessionId, state.deviceId), next);
      commands.push(command);
    }
    return commands;
  };

  const apply = (event: LaEvent): LaCommand[] => {
    const at = nowMs();
    switch (event.type) {
      case "turn_start": {
        const existing = turns.get(event.sessionId);
        // A NEW turnId is a new turn; the same one is a re-announcement (a
        // successor's `turn_start` re-uses the session, and must not reset the
        // timer the rollover is measured from).
        if (existing === undefined || existing.turnId !== event.turnId) {
          // The previous turn's activity, if any, is already ended; a new turn
          // clears the dismissal memory only by having a new turnId.
          turns.set(event.sessionId, {
            sessionId: event.sessionId,
            turnId: event.turnId,
            startedAt: event.at,
            computer: event.computer,
            project: event.project,
            title: event.title,
            tool: undefined,
            ask: undefined,
            error: undefined,
            stopReason: undefined,
            kind: "running",
          });
        }
        return [];
      }
      case "tool_call": {
        const turn = turns.get(event.sessionId);
        if (turn === undefined || turn.turnId !== event.turnId) {
          return [];
        }
        turn.tool = event.tool;
        return updateAll(event.sessionId, "running", 5, at, true);
      }
      case "permission_request": {
        const turn = turns.get(event.sessionId);
        if (turn === undefined) {
          return [];
        }
        turn.ask = {
          requestId: event.requestId,
          tool: event.tool,
          preview: event.preview,
          options: event.options,
        };
        turn.kind = "asking";
        // An ask is IMMEDIATE and uncoalesced: an approval waiting is the point
        // of the whole feature. Anything already live is updated; a device with
        // no activity yet STARTS one (an ask never waits for the 20 s threshold).
        const existing = activitiesOfSession(event.sessionId);
        const commands =
          existing.length > 0
            ? [
                ...updateAll(event.sessionId, "asking", 10, at, false),
                // A device that had no activity but is registered and not attached
                // gets one now: the ask IS the reason.
              ]
            : [];
        const have = new Set(existing.map((state) => state.deviceId));
        for (const [deviceId, registration] of registrations) {
          if (!registration.enabled || have.has(deviceId)) {
            continue;
          }
          commands.push(...startFor(turn, deviceId, "asking", at));
        }
        return commands;
      }
      case "permission_resolved": {
        const turn = turns.get(event.sessionId);
        if (turn === undefined) {
          return [];
        }
        // Only the ask that is actually showing: a stale resolution for an older
        // requestId (two asks in a row) must not clear the newer one.
        if (turn.ask?.requestId === event.requestId) {
          turn.ask = undefined;
          turn.kind = "running";
          return updateAll(event.sessionId, "running", 10, at, false);
        }
        return [];
      }
      case "session_title": {
        const turn = turns.get(event.sessionId);
        if (turn === undefined) {
          return [];
        }
        turn.title = event.title;
        return updateAll(event.sessionId, turn.kind, 5, at, true);
      }
      case "turn_end": {
        const turn = turns.get(event.sessionId);
        if (turn === undefined || turn.turnId !== event.turnId) {
          return [];
        }
        turn.stopReason = event.stopReason;
        turn.kind = kindOfStop(event.stopReason);
        turn.error = isCleanStop(event.stopReason) ? undefined : event.error;
        const commands: LaCommand[] = [];
        for (const state of activitiesOfSession(event.sessionId)) {
          if (state.dismissed) {
            continue;
          }
          const next: LiveActivityState = {
            ...state,
            finished: true,
            kind: turn.kind,
            error: turn.error,
            ask: undefined,
            tool: turn.tool,
            title: turn.title,
          };
          const content = contentOf(next, turn.kind, at);
          next.content = content;
          activities.set(keyOf(state.sessionId, state.deviceId), next);
          commands.push({
            kind: "end",
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            slot: state.slot,
            priority: 10,
            content,
            // "Done for a few minutes" (decision 11).
            dismissAt: Math.floor((at + LA_DONE_LINGER_MS) / 1_000),
          });
        }
        return commands;
      }
      case "session_closed": {
        turns.delete(event.sessionId);
        attachedBySession.delete(event.sessionId);
        const commands: LaCommand[] = [];
        for (const state of activitiesOfSession(event.sessionId)) {
          // An activity already ENDED by its turn's `turn_end` is done: re-ending
          // it would be a second dismissal-date for a view that is already
          // fading, and the person would see it flicker back. (It is kept in the
          // map until then so the cap can evict a `done` one — that is the only
          // reason a finished state is still here.)
          if (state.finished) {
            activities.delete(keyOf(state.sessionId, state.deviceId));
            continue;
          }
          const content = contentOf(state, state.kind, at);
          activities.delete(keyOf(state.sessionId, state.deviceId));
          // At once: the session is gone, so nothing it shows is still true.
          commands.push({
            kind: "end",
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            slot: state.slot,
            priority: 10,
            content,
            dismissAt: Math.floor(at / 1_000),
          });
        }
        return commands;
      }
      case "ended": {
        // The app (or a `gone` from APNs) says this activity is over.
        for (const state of activitiesOfSession(event.sessionId)) {
          if (state.slot !== event.slot) {
            continue;
          }
          activities.delete(keyOf(state.sessionId, state.deviceId));
          if (event.reason === "dismissed") {
            // The person's gesture on THAT phone: never restart it for this turn
            // (F17). Keyed by device too (fix round 2): one phone's swipe must
            // not silence the person's other phone for the rest of the turn.
            dismissedTurns.add(`${state.sessionId}\u0000${state.turnId}\u0000${state.deviceId}`);
          }
        }
        return [];
      }
      case "tick": {
        return tick(at);
      }
    }
  };

  /** Everything the clock decides: start, heartbeat, rollover, and eviction. */
  function tick(at: number): LaCommand[] {
    const commands: LaCommand[] = [];
    for (const turn of turns.values()) {
      if (turn.stopReason !== undefined) {
        continue;
      }
      const running = at - turn.startedAt;
      const live = activitiesOfSession(turn.sessionId);
      const liveDevices = new Set(live.map((state) => state.deviceId));
      // Who is watching THIS session, as it last reported (R1): standing state,
      // never an argument of this call, so the shell's own timer cannot lose it.
      const attached = attachedTo(turn.sessionId);

      for (const [deviceId, registration] of registrations) {
        if (!registration.enabled) {
          continue;
        }
        // F16: a device attached to THIS session is showing it; the person left
        // the app and the gate detached them, which is exactly when we start.
        if (attached.has(deviceId)) {
          continue;
        }
        const key = keyOf(turn.sessionId, deviceId);
        const state = activities.get(key);
        if (state === undefined) {
          // Start: past the threshold, or an ask waiting (handled immediately in
          // `permission_request`, so here the threshold is what matters). A
          // NEGATIVE `running` (the clock has not reached the announced
          // `startedAt` yet, e.g. a fixture stamped slightly ahead) counts as
          // elapsed — `startAfterSeconds: 0` means "at once".
          if (running < startAfterMs && running >= 0) {
            continue;
          }
          if (dismissedTurns.has(`${turn.sessionId}\u0000${turn.turnId}\u0000${deviceId}`)) {
            continue;
          }
          if (liveDevices.has(deviceId)) {
            continue;
          }
          const kind: ActivityKind = turn.ask === undefined ? "running" : "asking";
          commands.push(...startFor(turn, deviceId, kind, at));
          liveDevices.add(deviceId);
          continue;
        }
        if (state.dismissed) {
          continue;
        }
        // Rollover: iOS caps an activity at 8 h; end it at 7 h 45 and start a
        // continuation with the SAME startedAt so the elapsed timer is seamless.
        if (at - state.objectStartedAt >= LA_ROLLOVER_MS) {
          commands.push({
            kind: "end",
            sessionId: state.sessionId,
            deviceId,
            slot: state.slot,
            priority: 10,
            content: contentOf(state, state.kind, at),
            dismissAt: Math.floor(at / 1_000),
          });
          activities.delete(key);
          // The continuation is a NEW activity object: a new slot, same turn.
          commands.push(...startFor(turn, deviceId, state.kind, at));
          continue;
        }
        // Heartbeat: after HEARTBEAT of silence, repeat the state with a fresh
        // stale-date so the view does not read "out of date" while it is fine.
        if (at - state.lastPushAt >= LA_HEARTBEAT_MS) {
          const { command, state: next } = pushOf(state, state.kind, 5, at);
          next.lastUpdateAt = state.lastUpdateAt; // a heartbeat is not a "real" update
          activities.set(key, next);
          commands.push(command);
        }
      }
    }
    return commands;
  }

  return {
    setRegistrations(next) {
      registrations = next;
    },
    setAttached(sessionId, attached) {
      // Copy at the boundary: the caller's set is a per-event snapshot it may
      // reuse, and this one is read at deadlines much later.
      attachedBySession.set(sessionId, new Set(attached));
    },
    setSlotSource(next) {
      newSlot = next;
    },
    apply,
    nextDeadlineAt() {
      let earliest: number | undefined;
      const consider = (candidate: number): void => {
        if (earliest === undefined || candidate < earliest) {
          earliest = candidate;
        }
      };
      for (const turn of turns.values()) {
        if (turn.stopReason !== undefined) {
          continue;
        }
        const live = activitiesOfSession(turn.sessionId);
        if (live.length === 0) {
          // The start threshold, unless an ask means "now".
          consider(turn.ask === undefined ? turn.startedAt + startAfterMs : turn.startedAt);
        }
        for (const state of live) {
          consider(state.objectStartedAt + LA_ROLLOVER_MS);
          consider(state.lastPushAt + LA_HEARTBEAT_MS);
        }
      }
      return earliest;
    },
    liveSlots() {
      return [...activities.values()].map((state) => ({
        slot: state.slot,
        sessionId: state.sessionId,
        deviceId: state.deviceId,
      }));
    },
    contentOf(slot) {
      for (const state of activities.values()) {
        if (state.slot === slot) {
          return state.content;
        }
      }
      return undefined;
    },
  };
}

/**
 * A 96-bit slot, hex — the same shape `newActivitySlot` (protocol) produces.
 * Kept local so this module's only protocol import is the wire types, and so a
 * test can inject its own (`setSlotSource`) without touching global crypto.
 */
function newActivitySlotLocal(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
