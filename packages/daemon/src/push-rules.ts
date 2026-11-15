/**
 * The push RULES: WHEN a push is warranted, to WHICH devices, and under which
 * id (docs/feat/mobile-push.md Design 1, slice P6).
 *
 * Pure (AGENTS §7): no sockets, no fs, no timers of its own. Time is an injected
 * clock, and time-driven work is the explicit `tick` event, so every rule here —
 * the grace, the rate window, the anti-storm cap — is a table test rather than a
 * sleep. The shell (P7's `PushNotifier`) owns the one real timer: it asks
 * {@link PushRules.nextDeadlineAt} and calls `apply({type:"tick"})` when it
 * arrives. That inversion is why this slice is `contained`: there is no timer to
 * leak and no clock to fake.
 *
 * Every decision the design puts here, and the rule it implements:
 *
 *  - **The grace.** An ask is pushed only if it is STILL PENDING `graceMs` after
 *    it was shown (`ask` → a deadline; `tick` → the push). A repeat of the same
 *    `requestId` never restarts the timer (a background child re-offers its ask
 *    at attach, and the replay to a new attachment repeats the same id).
 *  - **Exclusion.** A device currently ATTACHED to that session is not pushed to:
 *    it is showing the sheet. Only a registered device (P5 has a file) that is
 *    also in the authority snapshot (the caller passes what it may push to) is a
 *    candidate at all. "Currently" means at the DEADLINE, so attach and detach
 *    are events of their own (`attachment`): a phone locked mid-grace is pushed
 *    to, a phone picked up mid-grace is not (F17).
 *  - **Replacement.** An ask answered before its grace ends is silent — the
 *    phone never buzzes for something already handled at the desk. An ask
 *    answered AFTER a push sends `ask_resolved` with the SAME collapse id, to
 *    exactly the devices that got the ask, so APNs replaces the banner instead
 *    of leaving a stale actionable one (F19, in either order).
 *  - **The turn rule.** A turn's end is pushed only when NO client of any kind is
 *    attached ("nobody is watching"): a TUI at the desk silences it too.
 *    `cancelled` is never pushed — someone stopped it on purpose.
 *  - **Caps.** At most one `ask` push per session per {@link PUSH_ASK_WINDOW_MS}
 *    (later due asks wait for the window and ride the next push as "+N more
 *    waiting"), and at most {@link PUSH_MAX_PER_MINUTE} pushes overall. Both are
 *    audited as notes, never silent (`push-folded`, `push-capped`). An
 *    `ask_resolved` is NEVER capped: a stale banner must always be replaceable.
 *
 * A note is not a message: the caller maps its `code` to one audit line. The
 * `more` count on a command is a fact about the SESSION ("this many asks are
 * waiting"), which is exactly what the phone renders, never a claim about what
 * one device has already been told.
 */
import {
  DEFAULT_PUSH_GRACE_SECONDS,
  type PushKind,
  type StopReason,
  pushCollapseIdOf,
} from "@tentacle/protocol";

/**
 * One `ask` push per session in this window (Design 1's anti-storm rule). The
 * unit is the session, not the device: the phone shows one banner per session,
 * so a per-device window could neither be stated by one `more` count nor reduce
 * the banner rate any further.
 */
export const PUSH_ASK_WINDOW_MS = 10_000;

/** Relay-wide storm ceiling: pushes per rolling minute, every kind but `ask_resolved`. */
export const PUSH_MAX_PER_MINUTE = 60;

/** How long APNs keeps an undelivered push (`apns-expiration`, ≤ 86 400). Every kind uses the same hour. */
export const PUSH_TTL_SECONDS = 3_600;

/** The default grace, in milliseconds (P2's `DEFAULT_PUSH_GRACE_SECONDS` is the one truth). */
export const DEFAULT_PUSH_GRACE_MS = DEFAULT_PUSH_GRACE_SECONDS * 1_000;

/** What the session's attachments look like at the moment of an event (the hook's `attached`). */
export interface PushAttached {
  /** How many clients of ANY kind are attached (a TUI counts: it means someone is watching). */
  readonly clients: number;
  /** The device ids among them: precisely the devices showing this session right now. */
  readonly devices: readonly string[];
}

/** One thing to push: what, to whom, under which collapse id. Sealing is P7's. */
export interface PushCommand {
  readonly kind: PushKind;
  readonly sessionId: string;
  /** The devices to deliver to, sorted (so two runs of the same rules agree byte for byte). */
  readonly devices: readonly string[];
  /** `apns-collapse-id`: two commands sharing one replace each other on the phone. */
  readonly collapseId: string;
  /** The ask this is about (`ask`, `ask_resolved`). */
  readonly requestId?: string;
  /** The turn this is about (`turn_done`, `turn_failed`). */
  readonly turnId?: string;
  /** "+N more waiting": other asks of this session whose grace had also ended. */
  readonly more?: number;
  /** When the rules decided it (`now()`), so the caller's `at` and the audit line agree. */
  readonly at: number;
}

/** Why nothing was pushed. The caller turns each into one audit line — never silence (F20). */
export interface PushNote {
  readonly code: "push-folded" | "push-capped" | "push-empty";
  readonly sessionId: string;
  readonly detail: string;
}

/** The inputs: session events, plus the explicit `tick` that stands in for the clock. */
export type PushEvent =
  | {
      /**
       * A client attached or detached (the foreground gate opening or closing).
       * It carries no ask and pushes nothing: it exists so the exclusion is read
       * from the attachment set at the DEADLINE, not at the last ask event. A
       * phone locked mid-grace detaches, and must then be pushed to (F17).
       */
      readonly type: "attachment";
      readonly sessionId: string;
      readonly attached: PushAttached;
    }
  | {
      readonly type: "ask";
      readonly sessionId: string;
      readonly requestId: string;
      readonly attached: PushAttached;
    }
  | {
      readonly type: "ask_settled";
      readonly sessionId: string;
      readonly requestId: string;
      readonly attached: PushAttached;
    }
  | {
      readonly type: "turn_end";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stopReason: StopReason;
      readonly attached: PushAttached;
    }
  | { readonly type: "session_closed"; readonly sessionId: string }
  | { readonly type: "tick" };

export interface PushRulesResult {
  readonly commands: readonly PushCommand[];
  readonly notes: readonly PushNote[];
}

export interface PushRulesOptions {
  /** Milliseconds since the epoch — `Date.now` in production, a number in a test. */
  readonly now: () => number;
  /**
   * The devices that may be pushed to RIGHT NOW: a usable registration (P5) AND
   * present in the authority snapshot (`devices.has(id)`), read fresh — a
   * revoked device is filtered within one poll even if its file survives (F14).
   */
  readonly registered: () => Iterable<string>;
  /** `push.graceSeconds` × 1000; `0` = at once. */
  readonly graceMs?: number;
  /** Overridable so the anti-storm boundary is testable at N / N+1. */
  readonly askWindowMs?: number;
  readonly maxPerMinute?: number;
}

/** One ask the rules are tracking: in its grace, or pushed and awaiting an answer. */
interface TrackedAsk {
  readonly requestId: string;
  deadlineAt: number;
  /** Set once it has been decided: the devices told (possibly none — every candidate was attached). */
  pushedTo?: ReadonlySet<string>;
  /** The collapse id it went out under, so `ask_resolved` replaces exactly that banner. */
  collapseId?: string;
}

interface SessionState {
  attached: PushAttached;
  readonly asks: Map<string, TrackedAsk>;
  /** When this session last pushed an `ask` (the rate window); absent = never. */
  lastAskAt?: number;
}

export interface PushRules {
  /** Feed one event (or `tick`) in; get back what to push and what to audit. */
  apply(event: PushEvent): PushRulesResult;
  /** When `apply({type:"tick"})` next has work, or `undefined` when nothing is pending. */
  nextDeadlineAt(): number | undefined;
  /** How many asks this session still tracks (a test hook for "timers cleared"). */
  trackedAsks(sessionId: string): number;
}

const NONE: PushRulesResult = { commands: [], notes: [] };

/** Ids in a stable order, deduplicated: two runs of the same state must agree. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

export function createPushRules(options: PushRulesOptions): PushRules {
  const now = options.now;
  const graceMs = options.graceMs ?? DEFAULT_PUSH_GRACE_MS;
  const askWindowMs = options.askWindowMs ?? PUSH_ASK_WINDOW_MS;
  const maxPerMinute = options.maxPerMinute ?? PUSH_MAX_PER_MINUTE;
  const sessions = new Map<string, SessionState>();
  /** The last minute's push times, for the storm cap (pruned on every read). */
  let recent: number[] = [];

  const stateOf = (sessionId: string, attached?: PushAttached): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      if (attached !== undefined) {
        existing.attached = attached;
      }
      return existing;
    }
    const fresh: SessionState = {
      attached: attached ?? { clients: 0, devices: [] },
      asks: new Map(),
    };
    sessions.set(sessionId, fresh);
    return fresh;
  };

  /** The push times still inside the rolling minute. */
  const recentAt = (at: number): number[] => {
    recent = recent.filter((t) => at - t < 60_000);
    return recent;
  };

  const capReached = (at: number): boolean => recentAt(at).length >= maxPerMinute;

  const candidates = (attached: PushAttached): string[] => {
    const excluded = new Set(attached.devices);
    return sortedIds(options.registered()).filter((id) => !excluded.has(id));
  };

  /**
   * Push every ask of `state` whose grace has ended, unless the session's rate
   * window or the storm cap says wait — in which case the asks stay due and the
   * NEXT tick (at the window's or the minute's end) tries again. `more` counts
   * the other waiting asks, which is what "+N more waiting" means.
   */
  const pushDueAsks = (sessionId: string, state: SessionState, at: number): PushRulesResult => {
    const due = [...state.asks.values()]
      .filter((ask) => ask.pushedTo === undefined && ask.deadlineAt <= at)
      // Deterministic: the oldest deadline first, then the id, so the banner names
      // the same ask whatever order the daemons emitted them in.
      .sort((a, b) => a.deadlineAt - b.deadlineAt || a.requestId.localeCompare(b.requestId));
    if (due.length === 0) {
      return NONE;
    }
    const folded = (detail: string): PushRulesResult => ({
      commands: [],
      notes: [{ code: "push-folded", sessionId, detail }],
    });
    if (state.lastAskAt !== undefined && at - state.lastAskAt < askWindowMs) {
      return folded(
        `${due.length} ask(s) waiting; one push per ${askWindowMs / 1_000}s per session`,
      );
    }
    const devices = candidates(state.attached);
    if (devices.length === 0) {
      // Nobody to tell: every registered device is showing this session, or there
      // is none. Mark them decided, so a later settle stays silent and the asks
      // are not retried forever (the sheet is on the screen that is attached).
      for (const ask of due) {
        ask.pushedTo = new Set();
      }
      return {
        commands: [],
        notes: [
          {
            code: "push-empty",
            sessionId,
            detail: `${due.length} ask(s) ended their grace with no device to push to`,
          },
        ],
      };
    }
    if (capReached(at)) {
      return {
        commands: [],
        notes: [{ code: "push-capped", sessionId, detail: `${maxPerMinute}/min reached` }],
      };
    }
    const primary = due[0];
    if (primary === undefined) {
      return NONE;
    }
    const collapseId = pushCollapseIdOf(sessionId, primary.requestId);
    const told = new Set(devices);
    for (const ask of due) {
      ask.pushedTo = told;
      ask.collapseId = collapseId;
    }
    state.lastAskAt = at;
    recent = [...recentAt(at), at];
    const command: PushCommand = {
      kind: "ask",
      sessionId,
      devices,
      collapseId,
      requestId: primary.requestId,
      at,
      ...(due.length > 1 ? { more: due.length - 1 } : {}),
    };
    return { commands: [command], notes: [] };
  };

  /** `ask_resolved` for one ask, if it was actually pushed to anyone (never capped: F19). */
  const resolveAsk = (sessionId: string, ask: TrackedAsk, at: number): PushCommand | undefined => {
    const told = ask.pushedTo;
    if (told === undefined || told.size === 0 || ask.collapseId === undefined) {
      return undefined;
    }
    return {
      kind: "ask_resolved",
      sessionId,
      devices: sortedIds(told),
      collapseId: ask.collapseId,
      requestId: ask.requestId,
      at,
    };
  };

  /**
   * Whether a banner is now fully answered. A FOLD puts several asks under one
   * collapse id, so APNs shows ONE banner for them; the id and the "answered on
   * another device" text are claims about that banner, and are only true once
   * its LAST ask settles. Settling an earlier one must therefore stay silent —
   * the survivor still blocks the turn, and its banner must stay actionable.
   * (A survivor pushed later goes out under its OWN id, so the grouping is by
   * id, not by session: `ask.collapseId` is undefined for a never-pushed ask,
   * which cannot be sharing a banner with a pushed one.)
   */
  const bannerAnswered = (state: SessionState, ask: TrackedAsk): boolean => {
    const collapseId = ask.collapseId;
    if (collapseId === undefined) {
      return true;
    }
    for (const other of state.asks.values()) {
      if (other.collapseId === collapseId) {
        return false;
      }
    }
    return true;
  };

  const turnCommand = (
    event: Extract<PushEvent, { type: "turn_end" }>,
    at: number,
  ): PushRulesResult => {
    if (event.stopReason === "cancelled") {
      // Someone stopped it on purpose: a buzz would be noise, not news.
      return NONE;
    }
    if (event.attached.clients > 0) {
      // A TUI (or any client) is watching: it already showed the turn end.
      return NONE;
    }
    const devices = sortedIds(options.registered());
    const kind: PushKind = event.stopReason === "error" ? "turn_failed" : "turn_done";
    if (devices.length === 0) {
      return {
        commands: [],
        notes: [
          {
            code: "push-empty",
            sessionId: event.sessionId,
            detail: `${kind} with no registered device`,
          },
        ],
      };
    }
    if (capReached(at)) {
      // A courtesy notice is the first thing to drop under a storm, and it is said.
      return {
        commands: [],
        notes: [
          {
            code: "push-capped",
            sessionId: event.sessionId,
            detail: `${maxPerMinute}/min reached`,
          },
        ],
      };
    }
    recent = [...recentAt(at), at];
    return {
      commands: [
        {
          kind,
          sessionId: event.sessionId,
          devices,
          collapseId: pushCollapseIdOf(event.sessionId, event.turnId),
          turnId: event.turnId,
          at,
        },
      ],
      notes: [],
    };
  };

  return {
    apply(event) {
      if (event.type === "tick") {
        const at = now();
        const commands: PushCommand[] = [];
        const notes: PushNote[] = [];
        // Sorted so the audit trail of one tick is deterministic too.
        for (const sessionId of [...sessions.keys()].sort()) {
          const state = sessions.get(sessionId);
          if (state === undefined) {
            continue;
          }
          const result = pushDueAsks(sessionId, state, at);
          commands.push(...result.commands);
          notes.push(...result.notes);
        }
        return { commands, notes };
      }
      if (event.type === "session_closed") {
        // The session is gone: its asks were settled `cancelled` (so `ask_resolved`
        // already replaced any banner), and its timers must not outlive it.
        sessions.delete(event.sessionId);
        return NONE;
      }
      if (event.type === "attachment") {
        // Only sessions the rules track have an attachment that can matter: a
        // detach of a session with no ask has no deadline to wake. Not creating
        // state here is what keeps a stray attach from leaving a ghost timer
        // (`nextDeadlineAt` walks every tracked session).
        const state = sessions.get(event.sessionId);
        if (state !== undefined) {
          state.attached = event.attached;
        }
        return NONE;
      }
      if (event.type === "ask") {
        const state = stateOf(event.sessionId, event.attached);
        if (state.asks.has(event.requestId)) {
          // A re-offer (a background child re-asking at attach, the replay to a new
          // attachment): the ORIGINAL grace stands. Mutation: overwrite `deadlineAt`
          // → a phone reminded longer and longer the more often the app reconnects.
          return NONE;
        }
        const at = now();
        const ask: TrackedAsk = { requestId: event.requestId, deadlineAt: at + graceMs };
        state.asks.set(event.requestId, ask);
        if (graceMs > 0) {
          return NONE;
        }
        // Grace 0: due at once, through the same path (window and caps included).
        return pushDueAsks(event.sessionId, state, at);
      }
      if (event.type === "ask_settled") {
        const state = sessions.get(event.sessionId);
        if (state === undefined) {
          return NONE;
        }
        state.attached = event.attached;
        const ask = state.asks.get(event.requestId);
        if (ask === undefined) {
          return NONE;
        }
        state.asks.delete(event.requestId);
        const at = now();
        // A sibling under the same banner still pending: the banner is not
        // answered, so nothing is replaced (finding 2). The survivor's own
        // settle replaces it then.
        if (!bannerAnswered(state, ask)) {
          return NONE;
        }
        const command = resolveAsk(event.sessionId, ask, at);
        return command === undefined ? NONE : { commands: [command], notes: [] };
      }
      stateOf(event.sessionId, event.attached);
      return turnCommand(event, now());
    },

    nextDeadlineAt() {
      const at = now();
      let earliest: number | undefined;
      const consider = (candidate: number | undefined): void => {
        if (candidate === undefined) {
          return;
        }
        if (earliest === undefined || candidate < earliest) {
          earliest = candidate;
        }
      };
      for (const state of sessions.values()) {
        for (const ask of state.asks.values()) {
          if (ask.pushedTo !== undefined) {
            continue;
          }
          // A due ask held back by the rate window becomes actionable when it ends.
          const windowEnd =
            state.lastAskAt === undefined ? undefined : state.lastAskAt + askWindowMs;
          consider(Math.max(ask.deadlineAt, windowEnd ?? ask.deadlineAt));
        }
      }
      // The storm cap's own boundary: a due ask held back by it is retried when
      // the oldest push in the window leaves it.
      const held = [...sessions.values()].some((state) =>
        [...state.asks.values()].some((ask) => ask.pushedTo === undefined && ask.deadlineAt <= at),
      );
      if (held) {
        const oldest = recentAt(at)[0];
        if (oldest !== undefined) {
          consider(oldest + 60_000);
        }
      }
      return earliest;
    },

    trackedAsks(sessionId) {
      return sessions.get(sessionId)?.asks.size ?? 0;
    },
  };
}
