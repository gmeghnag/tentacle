/**
 * The Session info controller (docs/feat/mobile-session-info.md): the four pulls
 * started in PARALLEL, each settling its own section, a generation counter that
 * drops a stale answer, and the link's `up` re-running one refresh.
 *
 * Pure and injected (AGENTS §7): its port is what the app wires to the ONE client
 * stack (`link.client` + the open `RemoteSession`), so this module builds no frame
 * and a test needs no socket.
 *
 * The failure modes it exists for are the plan's F1–F5 — each pull settles its OWN
 * section, so a slow or refused one never blanks the others.
 */
import type {
  McpServerStatus,
  ScheduleDeleteResult,
  ScheduleRow,
  SessionCapabilitiesWire,
  SessionContextResult,
  SessionListResult,
  SessionSkillsResult,
} from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { type ErrorShape, errorShape } from "./app-log.ts";
import {
  type CapabilityKind,
  type CapabilityOp,
  type DaemonInfo,
  type InfoFacts,
  type Pull,
  type SessionInfoView,
  capabilityChanges,
  sessionInfoView,
  settledOp,
  switchPhase,
} from "./session-info.ts";

/** What the sheet needs from the session's own handle (a `RemoteSession`). */
export interface InfoSession {
  skills(): Promise<SessionSkillsResult>;
  context(): Promise<SessionContextResult>;
  /** The session's shared auto-accept, when it has one (Owner Q3). */
  readonly autoAccept?: InfoAutoAccept | undefined;
  /**
   * The session's armed scheduled wakes (docs/feat/cron-tool.md S6, M7): the
   * FOLLOW of the daemon's full table, which reports what it already knows at
   * install. Absent: the handle has none, which reads as `unsupported` (an older
   * daemon, or one this client must not trust).
   */
  readonly schedules?: InfoSchedules | undefined;
  /**
   * The session's MCP/skill switches (docs/feat/session-capabilities.md S5);
   * absent: the handle has none, which reads as an older daemon.
   */
  readonly capabilities?: InfoCapabilities | undefined;
}

/**
 * The part of `RemoteSession` the schedule section uses (`onSchedules`,
 * `deleteSchedule`), loosened so a fake needs no more. The rows are already
 * bounded and sanitized by the client; this module never re-shapes one.
 */
export interface InfoSchedules {
  /** The table as last reported, or undefined (nothing reported yet, or an older daemon). */
  current(): readonly ScheduleRow[] | undefined;
  onChange(listener: (rows: readonly ScheduleRow[] | undefined) => void): () => void;
  /** A refusal is a RESULT with a `reason`, never a throw (`RemoteSession.deleteSchedule`). */
  remove(scheduleId: string): Promise<ScheduleDeleteResult>;
}

/**
 * The part of `RemoteSession` the switches use (`capabilities()`,
 * `onCapabilities`, `setCapability`), loosened so a fake needs no more. The
 * state is the DAEMON's: undefined until an open reports switches, and again
 * after a `MethodNotFound` (F7).
 */
export interface InfoCapabilities {
  current(): SessionCapabilitiesWire | undefined;
  set(kind: CapabilityKind, name: string, enabled: boolean): Promise<unknown>;
  onChange(listener: (state: SessionCapabilitiesWire | undefined, by?: string) => void): () => void;
}

/**
 * The part of `AutoAcceptLink` the sheet uses. Loosened to this so the value it
 * takes IS a `RemoteSession.autoAccept` (structural) and a fake needs no more.
 */
export interface InfoAutoAccept {
  current(): boolean;
  set?(on: boolean): Promise<{ on: boolean }> | undefined;
  onChange(listener: (on: boolean) => void): () => void;
}

/**
 * Everything the controller reads, injected. NOTHING here is a frame: each method
 * is a client seam the app already has (`link.client.mcpStatus()`, the open
 * `RemoteSession.skills()`), which is AGENTS §7's one-session-path rule.
 */
export interface InfoPort {
  /** The daemon's handshake facts, re-read every time (F7: a restarted `serve`). */
  daemon(): DaemonInfo | undefined;
  /**
   * The clock the scheduled wakes' times are worded against (`next 14:30`,
   * `today 17:00`, cron-tool S6). Injected as everywhere in this app, so a test
   * never waits for one and two sections never disagree.
   */
  now(): number;
  computerName(): string;
  title(): string;
  /** The SCREEN's attach phase: `not-open` is decided from it (F4). */
  phase(): "opening" | "open" | "failed";
  readonly sessionId: string;
  /**
   * Whether this port can offer the wake feed at all (docs/feat/cron-tool.md S6).
   * A fact about the WIRING, not about a handle: it lets the section say
   * `not-open` on a sheet opened before any attach answered (F4) instead of
   * silently disappearing. Absent: the port offers no feed, and no section is
   * drawn (a build without the feature).
   */
  readonly offersSchedules?: boolean;
  mcpStatus(): Promise<readonly McpServerStatus[]>;
  sessionList(): Promise<SessionListResult>;
  /** The open handle, or `null` (no attach answered yet). */
  session(): InfoSession | null;
  /** The link's own status feed (the app's `onStatus`); absent: nothing to follow. */
  onLink?(listener: (status: "up" | "down") => void): () => void;
  /**
   * A pull FAILED (its section says "Couldn't load"): its error CLASS and numeric
   * code (`errorShape`), never its message — the app log is exportable (F16).
   * Without it the failure was discarded and could not be diagnosed
   * (docs/fix/mobile-chat-glitches.md, item 9a). Not called for offline or
   * MethodNotFound: those have their own words.
   */
  onPullError?(section: InfoSection, failure: ErrorShape): void;
}

/** Which pull a failure came from. */
export type InfoSection = "mcp" | "entry" | "skills" | "context" | "schedules";

export interface SessionInfoState {
  readonly view: SessionInfoView;
  /** The link as the sheet sees it (`down` draws the banner, F1). */
  readonly link: "up" | "down";
  /**
   * The daemon's count of what the session holds NOW (`session/context`), or
   * `null` before it landed/failed. The HEADER's bar falls back to it before any
   * turn measured a fill (the TUI's `contextShown`), so it is exposed here
   * rather than kept privately.
   */
  readonly openContext: { readonly used: number; readonly exact: boolean } | null;
  /** A failed auto-accept set, shown until the next attempt (F11). */
  readonly autoAcceptError: string | null;
}

export interface SessionInfoController {
  state(): SessionInfoState;
  /**
   * Every change the controller PAINTS, so a screen re-renders when a pull lands
   * (Review round 1, MEDIUM 1): a section's own answer, the link's `up`
   * refresh, a replaced history's fresh count, and another device's auto-accept
   * flip all arrive here. The controller also feeds the HEADER's bar, so its
   * `close()` keeps the listeners — the screen unsubscribes on `dispose`.
   */
  subscribe(listener: (state: SessionInfoState) => void): () => void;
  /** Start (or restart) every pull. Resolves when all four have settled. */
  open(): Promise<void>;
  /** Re-run every pull (pull-to-refresh, a Retry row). */
  refresh(): Promise<void>;
  /**
   * Pull ONLY `session/context`, for the header's bar. The TUI asks it at attach
   * (`useSessionLink`: `askContext`), because a session attached after its turns
   * has no `agent_usage` to measure from — without this the bar would stay absent
   * until the next turn, and a sheet never opened would never fill it.
   */
  loadContext(): Promise<void>;
  /** Drop every in-flight answer and stop following the link (F5). */
  close(): void;
  /** The switch's value now (the LINK's, so a flip elsewhere is already here). */
  autoAcceptOn(): boolean;
  /** Flip it; a rejection reverts and records why (F11). */
  setAutoAccept(on: boolean): Promise<void>;
  /**
   * One MCP server's or skill's switch (session-capabilities S5). A no-op unless
   * the switches are usable (attached, link up, a daemon that has them). The
   * row flips on the daemon's echo, never optimistically; a refusal is shown
   * under its section until the next attempt.
   */
  setCapability(kind: CapabilityKind, name: string, enabled: boolean): Promise<void>;
  /**
   * Delete one armed wake (docs/feat/cron-tool.md S6, M7). The ROW LEAVES when
   * the daemon's next table says so, never on a local echo; a refusal keeps the
   * row and shows the daemon's own reason under the section.
   */
  deleteSchedule(scheduleId: string): Promise<void>;
}

/** A "not connected" rejection is the LINK, not the method (F1). */
function isOffline(error: unknown): boolean {
  return error instanceof Error && /not connected to the daemon/i.test(error.message);
}

/** `MethodNotFound`: an older daemon, which a retry can never fix (F2). */
function isUnsupported(error: unknown): boolean {
  return error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound;
}

/** One pull's outcome, as the view takes it. */
function settle<T>(error: unknown): Pull<T> {
  if (isUnsupported(error)) {
    return { state: "error", kind: "unsupported" };
  }
  if (isOffline(error)) {
    return { state: "error", kind: "offline" };
  }
  return { state: "error", kind: "error" };
}
/**
 * Fold a promise into a `Pull`, never throwing (each section settles alone). A
 * plain failure is reported as its safe shape (`onPullError`, item 9a).
 */
async function pull<T>(
  work: () => Promise<T>,
  report: (failure: ErrorShape) => void,
): Promise<Pull<T>> {
  try {
    return { state: "ready", value: await work() };
  } catch (error) {
    const outcome = settle<T>(error);
    if (outcome.state === "error" && outcome.kind === "error") {
      report(errorShape(error));
    }
    return outcome;
  }
}

export function createSessionInfo(port: InfoPort): SessionInfoController {
  let mcp: Pull<{ readonly servers: readonly McpServerStatus[] }> = { state: "loading" };
  let skills: Pull<SessionSkillsResult> = { state: "loading" };
  let context: Pull<SessionContextResult> = { state: "loading" };
  let entry: Pull<SessionListResult["sessions"][number] | null> = { state: "loading" };
  let link: "up" | "down" = "up";
  let autoAcceptError: string | null = null;
  /**
   * The generation every answer is stamped with: an open/close/refresh bumps it,
   * so an answer from an EARLIER open is dropped instead of painted over a newer
   * one (F5).
   */
  let generation = 0;
  let unlink: (() => void) | null = null;
  /** The session's shared auto-accept feed, while the sheet is open (F11). */
  let unSwitch: (() => void) | null = null;
  /** The MCP/skill switches feed, while the sheet is open (session-capabilities S5). */
  let unCaps: (() => void) | null = null;
  /** The scheduled wakes feed, while the sheet is open (cron-tool S6). */
  let unSchedules: (() => void) | null = null;
  /** The daemon's wake table as last reported; `undefined` = none reported (an older daemon). */
  let scheduleRows: readonly ScheduleRow[] | undefined;
  /** A refused delete's reason, under the rows until the next attempt. */
  let schedulesError: string | null = null;
  /**
   * Whether this port offers the wake feed at all (seen on any handle so far).
   * Kept beside the rows so a sheet opened while NOT attached can still say
   * `not-open` instead of silently dropping the section: the value is a fact
   * about the PORT, which no attach is needed to state.
   */
  let feedAvailable = false;
  /** The state the last report left, to tell what a change changed. */
  let lastCaps: SessionCapabilitiesWire | undefined;
  /** My sets not answered yet: their echoes are mine, not another device's. */
  let pendingCaps: readonly CapabilityOp[] = [];
  /** Another device's change per item, while the sheet is open (Owner Q4). */
  let changedBy: Record<string, string> = {};
  let capsError: { readonly kind: CapabilityKind; readonly text: string } | null = null;
  const listeners = new Set<(state: SessionInfoState) => void>();

  function facts(): InfoFacts {
    const handle = port.session();
    const attached = port.phase() === "open" && handle !== null;
    const info = port.daemon();
    return {
      phase: port.phase(),
      link,
      title: port.title(),
      computerName: port.computerName(),
      daemon: info,
      mcp,
      skills,
      context,
      entry,
      autoAccept: attached && handle?.autoAccept !== undefined,
      capabilities: {
        phase: switchPhase({ attached, link, state: handle?.capabilities?.current() }),
        state: handle?.capabilities?.current(),
        changedBy,
        error: capsError,
      },
      // No feed offered by this wiring at all: the section is not drawn.
      ...(feedAvailable ? { schedules: { rows: scheduleRows, error: schedulesError } } : {}),
      now: port.now(),
    };
  }

  /**
   * Follow the handle's armed wakes (cron-tool S6, M7): the install reports the
   * table the client already knows, and every later frame repaints. The sheet is
   * the phone's ONE reader of it, so the daemon's full table is the truth here —
   * a wake fires, expires, or is deleted from the terminal while the sheet is open.
   */
  function followSchedules(): void {
    unSchedules?.();
    const feed = port.session()?.schedules;
    // A port that offers the feed at all: remembered even when there is no
    // handle right now, so a `not-open` sheet still draws the section (F4).
    feedAvailable = feedAvailable || port.offersSchedules === true || feed !== undefined;
    scheduleRows = feed?.current();
    schedulesError = null;
    unSchedules =
      feed?.onChange((rows) => {
        scheduleRows = rows;
        // A section that lands a new table retires the previous refusal: the reason
        // described a row of a list that no longer exists.
        schedulesError = null;
        emit();
      }) ?? null;
  }

  /** Stop following the wakes; a refusal lives only while the sheet is open. */
  function stopSchedules(): void {
    unSchedules?.();
    unSchedules = null;
    schedulesError = null;
  }

  /** Follow the handle's switches (another device's change repaints, Q4). */
  function followCaps(): void {
    unCaps?.();
    const feed = port.session()?.capabilities;
    lastCaps = feed?.current();
    unCaps =
      feed?.onChange((next, by) => {
        const out = capabilityChanges(lastCaps, next, by, pendingCaps);
        lastCaps = next;
        pendingCaps = out.pending;
        if (out.own.length > 0 || out.remote.length > 0) {
          const notes = { ...changedBy };
          for (const key of out.own) {
            delete notes[key];
          }
          for (const change of out.remote) {
            notes[change.key] = change.by;
          }
          changedBy = notes;
        }
        emit();
      }) ?? null;
  }

  /** Stop following the switches; the notes and a refusal live only while open. */
  function stopCaps(): void {
    unCaps?.();
    unCaps = null;
    changedBy = {};
    capsError = null;
  }

  function state(): SessionInfoState {
    const pulled = context.state === "ready" ? context.value : null;
    return {
      view: sessionInfoView(facts()),
      link,
      autoAcceptError,
      openContext: pulled === null ? null : { used: pulled.used, exact: pulled.exact },
    };
  }

  function emit(): void {
    const next = state();
    for (const listener of listeners) {
      listener(next);
    }
  }

  /** The `not-open` reason, so the view never shows a fresh session's facts (F4). */
  function notOpen<T>(): Pull<T> {
    return { state: "error", kind: "not-open" };
  }

  async function run(): Promise<void> {
    const mine = generation;
    const handle = port.phase() === "open" ? port.session() : null;
    // Each pull PAINTS ITS OWN SECTION as it lands, so a slow one (an MCP probe
    // waiting an unresponsive server's ping timeout) never holds back the others
    // (F3). A refresh resets only the sections it re-asks.
    mcp = { state: "loading" };
    entry = { state: "loading" };
    skills = handle === null ? notOpen<SessionSkillsResult>() : { state: "loading" };
    context = handle === null ? notOpen<SessionContextResult>() : { state: "loading" };
    emit();

    /**
     * What one settled pull says about the LINK. A `not connected` rejection is
     * the link (F1) and wins for the whole run; a landed answer proves it is up,
     * so a later `ready` never papers over an earlier refusal in the same run.
     */
    let sawOffline = false;
    const linkFrom = <T>(value: Pull<T>): void => {
      if (value.state === "error" && value.kind === "offline") {
        sawOffline = true;
        link = "down";
      } else if ((value.state === "ready" || value.state === "error") && !sawOffline) {
        link = "up";
      }
    };
    /** Assign one section, unless a newer open/close owns the state now (F5). */
    const paint =
      <T>(apply: (value: Pull<T>) => void) =>
      (value: Pull<T>): void => {
        if (mine !== generation) {
          return;
        }
        apply(value);
        linkFrom(value);
        emit();
      };
    const paintMcp = paint<{ readonly servers: readonly McpServerStatus[] }>((value) => {
      mcp = value;
    });
    const paintEntry = paint<SessionListResult["sessions"][number] | null>((value) => {
      entry = value;
    });
    const paintSkills = paint<SessionSkillsResult>((value) => {
      skills = value;
    });
    const paintContext = paint<SessionContextResult>((value) => {
      context = value;
    });

    await Promise.all([
      pull(async () => ({ servers: await port.mcpStatus() }), reportFor("mcp")).then(paintMcp),
      pull(async () => {
        const page = await port.sessionList();
        return page.sessions.find((row) => row.sessionId === port.sessionId) ?? null;
      }, reportFor("entry")).then(paintEntry),
      (handle === null
        ? Promise.resolve(notOpen<SessionSkillsResult>())
        : pull(() => handle.skills(), reportFor("skills"))
      ).then(paintSkills),
      (handle === null
        ? Promise.resolve(notOpen<SessionContextResult>())
        : pull(() => handle.context(), reportFor("context"))
      ).then(paintContext),
    ]);
  }

  /** A section's failure, reported to the port (item 9a). */
  function reportFor(section: InfoSection): (failure: ErrorShape) => void {
    return (failure) => port.onPullError?.(section, failure);
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open() {
      generation += 1;
      autoAcceptError = null;
      unlink?.();
      // A flip from ANOTHER device is a value this switch shows and never learns
      // by itself: the link needs a listener, or the sheet repaints it only when
      // some unrelated event happens to emit (F11; Review round 1, MEDIUM 1).
      unSwitch?.();
      unSwitch = port.session()?.autoAccept?.onChange(() => emit()) ?? null;
      stopCaps();
      followCaps();
      stopSchedules();
      followSchedules();
      // ONE refresh per link `up`, never one per section (F1).
      unlink =
        port.onLink?.((status) => {
          link = status;
          if (status === "up") {
            void run();
            return;
          }
          emit();
        }) ?? null;
      await run();
    },
    refresh() {
      // A refresh is a NEW attempt: the wake feed is re-installed too, so
      // pull-to-refresh really refreshes the wakes and retires a previous
      // refusal. The install reports the current table at once, so this can
      // never paint a stale list.
      stopSchedules();
      followSchedules();
      return run();
    },
    async loadContext() {
      const handle = port.phase() === "open" ? port.session() : null;
      if (handle === null) {
        // Not attached: asking would describe a session that does not exist (F4).
        context = notOpen<SessionContextResult>();
        emit();
        return;
      }
      const mine = generation;
      const value = await pull(() => handle.context(), reportFor("context"));
      if (mine !== generation) {
        return;
      }
      context = value;
      emit();
    },
    close() {
      generation += 1;
      unlink?.();
      unlink = null;
      unSwitch?.();
      unSwitch = null;
      stopCaps();
      stopSchedules();
      // The LISTENERS stay: the same controller feeds the HEADER's bar, which is
      // on screen with the sheet closed (Owner decision 4), and a pull that lands
      // after the close must still repaint it (Review round 1, MEDIUM 1). The
      // screen drops its own subscription on `dispose`.
    },
    autoAcceptOn() {
      return port.session()?.autoAccept?.current() ?? false;
    },
    async setAutoAccept(on) {
      const link2 = port.session()?.autoAccept;
      if (link2 === undefined) {
        return;
      }
      autoAcceptError = null;
      emit();
      try {
        await link2.set?.(on);
      } catch (error) {
        // A refused set is REPORTED, and the shown value is the LINK's own: it
        // keeps the person's decision pending and re-sends it on the next
        // attach (`auto-accept-link.ts`'s `set`/`recovered`), so a switch that
        // snapped back would disagree with the value the daemon will get.
        autoAcceptError = error instanceof Error ? error.message : String(error);
      }
      emit();
    },
    async setCapability(kind, name, enabled) {
      const feed = port.session()?.capabilities;
      if (feed === undefined || facts().capabilities?.phase !== "on") {
        // Not attached, offline, or a daemon without switches: the ghost
        // switch cannot send (F1, F4, F7).
        return;
      }
      const op: CapabilityOp = { kind, name, enabled };
      pendingCaps = [...pendingCaps, op];
      capsError = null;
      emit();
      try {
        await feed.set(kind, name, enabled);
      } catch (error) {
        // `MethodNotFound` already cleared the state (an older daemon): the
        // section's own "update it" note says it, not an error line (F7).
        if (!isUnsupported(error)) {
          capsError = { kind, text: error instanceof Error ? error.message : String(error) };
        }
      } finally {
        // Answered: an echo that never came (an idempotent set, a refusal) must
        // not make a later identical change from another device look like mine.
        pendingCaps = settledOp(pendingCaps, op);
      }
      emit();
    },
    async deleteSchedule(scheduleId) {
      const feed = port.session()?.schedules;
      if (feed === undefined) {
        // Not attached, or a daemon with no table: nothing to send (F4).
        return;
      }
      schedulesError = null;
      emit();
      try {
        const result = await feed.remove(scheduleId);
        // A refusal is the daemon's own words (an unknown id, an older daemon):
        // the ROW STAYS, because the next table is what removes a row, never a
        // local guess that it should have gone.
        schedulesError = result.deleted ? null : (result.reason ?? "Couldn't delete it");
      } catch (error) {
        schedulesError = error instanceof Error ? error.message : String(error);
      }
      emit();
    },
  };
}
