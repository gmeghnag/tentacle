/**
 * `attach <name>` on a detached run (docs/feat/detached-handover.md): the IO
 * shell around `attach-plan.ts`. `joinRun` opens the run's ONE session as one
 * more client (a stale owner, an ended run and a join are one path); `finish`
 * is its quit (docs/fix/detach-live.md A5): a confirmed `/quit` closes the
 * session for every TUI on it, a quit alone on it ends it (`ifLast`), a TUI
 * whose session another one closed just leaves; on keep=false the TUI whose
 * quit ends the session does the delete, under the run's lock, once its
 * session's other TUIs left and no other session is in use.
 *
 * Who is attached is the presence files (`run-state.ts`), never `owner.json`:
 * a lost write cannot lie. Presence-then-lock here against lock-then-presence
 * in the last quit: whichever runs second sees the other, so a delete never
 * lands under an attacher (an attacher that came later waits, then finds the
 * workload gone). Every seam is injected; `main.ts` stays a call.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import type { RunQuit } from "@tentacle/tui";
import type { AttachPlan, QuitPlan } from "./attach-plan.ts";
import { quitPlan } from "./attach-plan.ts";
import { type ControlConn, dialControl } from "./control-socket.ts";
import type { EngineHost } from "./engine-host.ts";
import type { EngineRuntime } from "./engine-runtime.ts";
import {
  type KeptRemoval,
  RM_STOP_GRACE_MS,
  bounded,
  removalFate,
  removeVerifiedKept,
} from "./kept-cmd.ts";
import type { KeptEntry } from "./kept.ts";
import type { LocalRuntime } from "./local-runtime.ts";
import { type ProcOf, acquireResidentLock, lockHolder, residentStop } from "./pod-resident.ts";
import type { ResidentUse } from "./relay-state.ts";
import {
  type OwnerRecord,
  RUN_STATE_VERSION,
  attachers,
  othersOnSession,
  readOwner,
  removePresence,
  setPresenceSession,
  writeOwner,
  writePresence,
} from "./run-state.ts";
import { type SharedAutoAccept, openSharedAutoAccept } from "./shared-auto-accept.ts";
import type { TuiSessions } from "./tui-sessions.ts";
import { untrustedText } from "./untrusted-text.ts";
import { APP_VERSION } from "./version.ts";

/** How long the read of the resident's use before a delete may take. */
const USE_READ_TIMEOUT_MS = 5000;
/** How long the delete itself may take. */
const REMOVE_TIMEOUT_MS = 30_000;
/** How long a draining relay gets before the last quit takes the lock. */
const RELAY_STOP_GRACE_MS = 5000;
/** How often "closing" looks at the lock. */
const CLOSING_POLL_MS = 200;
/** R2: the one wording of an unconfirmed last save (the terminal line and the record). */
const UNSAVED_NOTE = "the last save was not confirmed";
/** How long a `/quit` closing for all waits for its session's other TUIs to leave. */
const OTHERS_LEAVE_MS = 5000;
/** How often that wait looks at the presence files. */
const OTHERS_POLL_MS = 50;

export type RunPlan = Extract<AttachPlan, { kind: "run" }>;

export interface JoinDeps {
  /** The workload's name, as the user typed it. */
  readonly name: string;
  /** `pod` / `container`. */
  readonly noun: string;
  readonly entry: KeptEntry;
  /** The kept index file of `entry` (the delete forgets it). */
  readonly keptFile: string;
  /** The run dir. */
  readonly dir: string;
  readonly plan: RunPlan;
  /** The record the plan was made on. */
  readonly owner: OwnerRecord;
  readonly cwd: string;
  /** Lines before Ink mounts and after it unmounted only (AGENTS §7). */
  readonly write: (text: string) => void;
  /** Informational lines (waiting, closing, removed): grey on a terminal. Absent: `write`. */
  readonly info?: (text: string) => void;
  readonly procOf: ProcOf;
  /** This process (tests: another). */
  readonly pid?: number;
  readonly now?: () => number;
  /** `openTuiSessions` for the run's session, `live`. */
  readonly openSessions: () => Promise<TuiSessions | { readonly exit: number }>;
  /**
   * The run's session as the laptop file holds it NOW: read right before
   * `openSeeded`, never earlier, so no join seeds a session from a copy that
   * went stale during the dial (docs/fix/detach-live.md R8). Rejects if the
   * file is unreadable.
   */
  readonly readRecord: () => Promise<SessionRecord | null>;
  /** The engine host of `entry`; `null`: it could not be built (said already). */
  readonly host: () => EngineHost | null;
  /** `attachEngineRuntime` with `shared` and THIS broker (the single-broker invariant). */
  readonly attach: (
    host: EngineHost,
    sessions: TuiSessions,
    permissions: PermissionBroker,
  ) => Promise<EngineRuntime>;
  /** `armSharedExitNet(host, name, othersAlive, saved, onKept)`; returns the disarm. */
  readonly armNet: (
    host: EngineHost,
    othersAlive: () => boolean,
    saved: () => boolean,
    onKept: () => void,
  ) => () => void;
  /** Default `lockHolder(dir, procOf)`. */
  readonly lockOf?: (dir: string) => { readonly pid: number } | null;
  /** `residentStop` of the run dir's lock holder (a draining relay). */
  readonly stopHolder?: (dir: string) => Promise<unknown>;
  /** "Closing": how long to wait for a closing run's lock; default `RM_STOP_GRACE_MS`. */
  readonly closingWaitMs?: number;
  readonly useTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
  /** How long a `/quit` closing for all waits for the others to leave; default 5 s. */
  readonly othersWaitMs?: number;
  /** Phase B: the relay's control socket (default `dialControl`). */
  readonly dial?: (path: string) => Promise<ControlConn | null>;
  /** Phase B: the hand-over's bounds (tests shorten them). */
  readonly handoverTimes?: Partial<typeof HANDOVER_TIMES>;
  /** S2's refusal, when no hand-over can happen under a live relay. */
  readonly relayRefusal?: () => string;
}

/** The attacher's bounds (docs/feat/detached-handover.md, Phase B). */
const HANDOVER_TIMES = {
  /** No socket for this long under a live relay: S2's refusal. */
  noSocketMs: 5000,
  /** `busy` (another attacher mid-hand-over) for this long: give up. The relay's lease + a margin. */
  busyMs: 35_000,
  pollMs: 200,
  busyPollMs: 500,
  /** Each reply, `commit`'s ack included (the relay's last save is bounded 10 s). */
  ackMs: 15_000,
};

type Prepared =
  | { readonly kind: "prepared"; readonly conn: ControlConn }
  /** Handed over already, or the relay died: a plain join. */
  | { readonly kind: "join" }
  | { readonly kind: "closing" }
  | { readonly kind: "refuse" };

const controlPathOf = (deps: JoinDeps): string =>
  deps.owner.control ?? join(deps.dir, "control.sock");

/**
 * Is the run's lock held by a relay draining after its hand-over? It answers
 * its socket `handed_over`, with no effect on it; a TUI closing the run has no
 * socket. Under a TUI record this is the one way to tell the two apart.
 */
async function relayDraining(deps: JoinDeps): Promise<boolean> {
  const times = { ...HANDOVER_TIMES, ...deps.handoverTimes };
  const conn = await (deps.dial ?? dialControl)(controlPathOf(deps)).catch(() => null);
  if (conn === null) {
    return false;
  }
  const reply = await conn
    .send({ op: "prepare", sessionId: deps.plan.sessionId }, times.ackMs)
    .catch(() => null);
  conn.close();
  return reply !== null && !reply.ok && reply.reason === "handed_over";
}

/** Step 6: `prepare` on the relay's socket, waiting out another attacher's hand-over. */
async function prepareHandover(
  deps: JoinDeps,
  lockOf: (dir: string) => { readonly pid: number } | null,
): Promise<Prepared> {
  const times = { ...HANDOVER_TIMES, ...deps.handoverTimes };
  const now = deps.now ?? Date.now;
  const dial = deps.dial ?? dialControl;
  const path = controlPathOf(deps);
  const start = now();
  let toldBusy = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    if (lockOf(deps.dir) === null) {
      return { kind: "join" }; // the relay is gone: nobody to hand over from
    }
    const conn = await dial(path);
    if (conn === null) {
      if (now() - start >= times.noSocketMs) {
        const read = readOwner(deps.dir);
        return read.kind === "owner" && read.owner.kind === "tui"
          ? { kind: "closing" }
          : { kind: "refuse" };
      }
      await sleep(times.pollMs);
      continue;
    }
    const reply = await conn
      .send({ op: "prepare", sessionId: deps.plan.sessionId }, times.ackMs)
      .catch(() => null);
    if (reply?.ok) {
      return { kind: "prepared", conn };
    }
    conn.close();
    if (reply === null) {
      await sleep(times.pollMs); // the relay went away mid-reply: look again
      continue;
    }
    switch (reply.reason) {
      case "busy":
        // Never open meanwhile: if that hand-over aborts, a thawed relay decides again.
        if (now() - start >= times.busyMs) {
          return { kind: "refuse" };
        }
        if (!toldBusy) {
          toldBusy = true;
          (deps.info ?? deps.write)(
            `[${deps.noun}] ${untrustedText(deps.name)}: another terminal is taking this run over; waiting…\n`,
          );
        }
        await sleep(times.busyPollMs);
        continue;
      case "handed_over":
        return { kind: "join" };
      case "leaving":
        return { kind: "closing" };
      default:
        return { kind: "refuse" };
    }
  }
}

export interface Joined {
  readonly kind: "joined";
  readonly sessions: TuiSessions;
  readonly runtime: EngineRuntime;
  /** THE broker: the runtime's, and the one `startTui` must get. */
  readonly permissions: PermissionBroker;
  /** The live session was opened; false: the seeded path (`--resume`-like). */
  readonly attached: boolean;
  /** The quit, after Ink unmounted. `inkRan` false: `startTui` threw, nothing ends. */
  finish(inkRan: boolean): Promise<void>;
  /** The TUI's `runQuit`: what its `/quit` chose, what happened (docs/fix/detach-live.md A2). */
  readonly runQuit: RunQuit;
  /** The TUI's `createSession`: the runtime's, its presence moved to each new session (`/clear`). */
  readonly createSession: LocalRuntime["createSession"];
  /** The TUI's auto-accept: its session's, shared by its TUIs, laptop-side (B3). */
  readonly autoAccept: SharedAutoAccept;
}

export type JoinResult =
  | Joined
  | { readonly kind: "exit"; readonly code: number }
  /** The run's lock is held by a TUI closing it: waited for; plan again, once. */
  | { readonly kind: "closing" };

const message = (error: unknown): string =>
  untrustedText(error instanceof Error ? error.message : String(error));

/** Step 2..9 of the plan's `joinRun`, the run's session as one more client. */
export async function joinRun(deps: JoinDeps): Promise<JoinResult> {
  const { dir, plan, name, noun, write } = deps;
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? Date.now;
  const lockOf = deps.lockOf ?? ((d: string) => lockHolder(d, deps.procOf));
  const shown = untrustedText(name);
  // 2. Presence, THEN the lock (see the module doc).
  let presence: string;
  try {
    // Its body: the session this TUI is on (A4), the run's until a `/clear`.
    presence = writePresence(dir, pid, deps.procOf, plan.sessionId);
  } catch (error) {
    write(`[error] ${shown}: could not register this terminal on the run: ${message(error)}\n`);
    return { kind: "exit", code: 1 };
  }
  const leave = (): void => removePresence(presence);
  const fresh = readOwner(dir);
  const relayHolds = plan.handover && fresh.kind === "owner" && fresh.owner.kind === "relay";
  if (!relayHolds && lockOf(dir) !== null && !(await relayDraining(deps))) {
    // A TUI deleting the workload: wait for it to go. A relay draining after its
    // hand-over is no wait: the session is the TUIs' already, this is a join (Q3).
    leave();
    (deps.info ?? write)(`[${noun}] ${shown}: the run is closing; waiting…\n`);
    const deadline = now() + (deps.closingWaitMs ?? RM_STOP_GRACE_MS);
    while (lockOf(dir) !== null && now() < deadline) {
      await new Promise((r) => setTimeout(r, CLOSING_POLL_MS));
    }
    if (lockOf(dir) !== null) {
      write(`[error] ${shown}: the run is still closing; retry in a moment\n`);
      return { kind: "exit", code: 1 };
    }
    return { kind: "closing" };
  }
  // 3. The run's session, `live`: no "starting fresh" line for a uid with no record.
  const sessions = await deps.openSessions();
  if ("exit" in sessions) {
    leave();
    return { kind: "exit", code: sessions.exit };
  }
  // 4. DR-8: a gone workload is said, with no local fallback.
  const host = deps.host();
  if (host === null) {
    leave();
    return { kind: "exit", code: 1 };
  }
  let gone = false;
  try {
    gone = (await host.describe(name)) === null;
  } catch {
    // Unknown: the dial reports it.
  }
  if (gone) {
    leave();
    write(
      `[error] ${shown}: the ${noun} no longer exists — session ${untrustedText(plan.sessionId)} cannot be re-attached; its transcript is kept on this laptop\n`,
    );
    return { kind: "exit", code: 1 };
  }
  // 5. ONE broker for the runtime and the TUI (AGENTS §7).
  const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
  let runtime: EngineRuntime;
  try {
    runtime = await deps.attach(host, sessions, permissions);
  } catch (error) {
    leave();
    write(`[${noun}] failed: ${message(error)}\n`);
    return { kind: "exit", code: 1 };
  }
  // 6. A live relay: `prepare` (it freezes BEFORE this client opens, D5).
  let conn: ControlConn | null = null;
  if (plan.handover) {
    const prepared = await prepareHandover(deps, lockOf);
    if (prepared.kind !== "prepared" && prepared.kind !== "join") {
      await runtime.release();
      leave();
      if (prepared.kind === "refuse") {
        write(`[error] ${deps.relayRefusal?.() ?? `${shown}: a detached run owns it`}\n`);
        return { kind: "exit", code: 1 };
      }
      return { kind: "closing" };
    }
    if (prepared.kind === "prepared") {
      conn = prepared.conn;
    }
  }
  // 7. The live session, eagerly (the runtime is lazy otherwise).
  let attached: boolean;
  try {
    // The run's own turn (its relay minted the id, owner.json carries it) is
    // this TUI's too: auto-accept may answer it (B2).
    attached = await runtime.attachTo(
      plan.sessionId,
      sessions.resume,
      deps.owner.runTurnId !== undefined ? { adoptTurn: deps.owner.runTurnId } : {},
    );
  } catch (error) {
    conn?.close(); // the relay aborts
    await runtime.release();
    leave();
    write(`[${noun}] failed: ${message(error)}\n`);
    return { kind: "exit", code: 1 };
  }
  if (!attached && conn !== null) {
    // The relay has not opened its session yet: never seed it under the relay.
    conn.close();
    await runtime.release();
    leave();
    write(`[error] ${shown}: the detached run is still starting; retry in a moment\n`);
    return { kind: "exit", code: 1 };
  }
  // 8. `commit`: irrevocable on the relay's side; its last save is done at the ack.
  if (conn !== null) {
    const times = { ...HANDOVER_TIMES, ...deps.handoverTimes };
    const acked = await conn
      .send({ op: "commit" }, times.ackMs)
      .then((reply) => reply.ok)
      .catch(() => false);
    conn.close();
    if (!acked && lockOf(dir) !== null) {
      await runtime.release();
      leave();
      write(
        `[error] ${shown}: the hand-over did not complete; the detached run still owns it — retry in a moment\n`,
      );
      return { kind: "exit", code: 1 };
    }
    // No ack and its lock is dead: the relay died, this client is the owner.
  }
  let seeded = sessions;
  if (!attached) {
    // The pod no longer has it (closed, reaped): open it NOW from the laptop
    // copy, create-or-attach. A second TUI attaches the first's live session
    // instead of keeping its own stale seed until its first send (KO 4). The
    // copy is read HERE: the one from step 3 predates the dial, and a TUI that
    // closed the session meanwhile saved a longer one (R8).
    try {
      const fresh = await deps.readRecord();
      await runtime.openSeeded(fresh);
      seeded = { ...sessions, resume: fresh };
    } catch (error) {
      await runtime.release();
      leave();
      write(`[${noun}] failed: ${message(error)}\n`);
      return { kind: "exit", code: 1 };
    }
  }
  if (!attached && seeded.resume === null) {
    // The seeded path (the runtime was built with the run's uid and record).
    sessions.notices.notify(
      `The ${noun} no longer has session ${untrustedText(plan.sessionId)}, and this laptop has no copy of it: it starts empty.`,
    );
  }
  // 9. The run's record: what it IS. Any TUI that finds no TUI record writes one.
  const record = (state: "attached" | "idle", detail?: string): OwnerRecord => ({
    schemaVersion: RUN_STATE_VERSION,
    kind: "tui",
    pid,
    appVersion: APP_VERSION,
    sessionId: plan.sessionId,
    state,
    ...(detail !== undefined ? { detail } : {}),
    lastActivityAt: now(),
    // The run's `--auto-accept` and its turn, carried on: a later terminal
    // (the relay gone) starts from them (D2, B2).
    autoAccept: deps.owner.autoAccept,
    keep: plan.keep,
    cwd: deps.owner.cwd ?? deps.cwd,
    created: deps.entry.created,
    // A later terminal finds a draining relay by it.
    ...(deps.owner.control !== undefined ? { control: deps.owner.control } : {}),
    ...(deps.owner.runTurnId !== undefined ? { runTurnId: deps.owner.runTurnId } : {}),
  });
  const writeRecord = (state: "attached" | "idle", detail?: string): boolean => {
    try {
      writeOwner(dir, record(state, detail));
      return true;
    } catch {
      // A full disk: presence still drives `ps`.
      return false;
    }
  };
  if ((deps.owner.kind !== "tui" || deps.owner.state !== "attached") && !writeRecord("attached")) {
    sessions.notices.notify(
      "⚠ The run's state file could not be written; `tentacle ps` may show it wrong.",
    );
  }
  const others = (): number => attachers(dir, deps.procOf).filter((a) => a.pid !== pid).length;
  // R6 (owner, 2026-11-02): a SIGTERM / SIGHUP / crash of the last TUI deletes
  // only a session confirmed saved on the laptop; else it stays, and the record
  // says so (`ps`).
  const disarm = plan.keep
    ? () => {}
    : deps.armNet(
        host,
        () => others() > 0,
        () => runtime.saveConfirmed(),
        () => void writeRecord("idle", `not saved — workload kept: tentacle rm ${name}`),
      );
  if (!plan.keep) {
    sessions.notices.notify(
      `Quitting removes the ${noun} if no other session is in use, a running turn stops.`,
    );
  }
  // The session's auto-accept, shared by its TUIs, laptop-side (B3): its file
  // if one flipped it, else the run's `--auto-accept` from owner.json only —
  // never the socket, never the pod (D2).
  const autoAccept = await openSharedAutoAccept({
    dir,
    sessionId: plan.sessionId,
    fallback: deps.owner.autoAccept,
    onWriteError: (text) => sessions.notices.notify(text),
  });
  if (autoAccept.current()) {
    sessions.notices.notify("auto-accept on (Shift+Tab to turn it off)");
  }
  // What the TUI's `/quit` chose and what happened to its session (A2): read
  // by `finish`; neither changes once it began.
  let finishing = false;
  let closeForAll = false;
  let closedElsewhere = false;
  let closedBy: "closed" | "deleted" | "gone" = "closed";
  /** The session this TUI is on: the run's, a fresh one after `/clear`. */
  let current = plan.sessionId;
  const runQuit: RunQuit = {
    othersOnSession: () => othersOnSession(dir, deps.procOf, pid, current),
    closeForAll: () => {
      if (!finishing) closeForAll = true;
    },
    closedElsewhere: (reason) => {
      if (!finishing) {
        closedElsewhere = true;
        closedBy = reason;
      }
    },
  };
  const createSession: LocalRuntime["createSession"] = () => {
    const controller = runtime.createSession();
    const id = controller.sessionId;
    if (id !== null && id !== current) {
      current = id;
      autoAccept.use(id); // per session: the fresh one's state, the value carried over
      try {
        setPresenceSession(presence, id);
      } catch {
        // Unwritable: it still counts on the run (`others`); only the dialog's count is off.
      }
    }
    return controller;
  };
  /** Wait (bounded) until no other TUI is on `current`: they leave on the close. */
  const othersLeft = async (): Promise<void> => {
    const deadline = now() + (deps.othersWaitMs ?? OTHERS_LEAVE_MS);
    while (runQuit.othersOnSession() > 0 && now() < deadline) {
      await new Promise((r) => setTimeout(r, OTHERS_POLL_MS));
    }
  };

  /**
   * keep: the run's last state, read AFTER this TUI's presence went, so of two
   * leaving together one always sees nobody (S3: the last one out writes it,
   * `ps` never says `tui lost` after a clean quit). keep=false has no such
   * step: the dir may be under the closer's delete. Only over a record still
   * `attached`: a closer's noted `idle` (its save not confirmed) stands.
   */
  const lastOut = (): void => {
    const read = readOwner(dir);
    if (plan.keep && others() === 0 && read.kind === "owner" && read.owner.state === "attached") {
      writeRecord("idle");
    }
  };

  const finish = async (inkRan: boolean): Promise<void> => {
    finishing = true;
    autoAccept.stop();
    if (!inkRan) {
      // 1. The user quit nothing: the session stays, nothing ends.
      disarm();
      await runtime.release();
      leave();
      return;
    }
    if (closedElsewhere && !closeForAll) {
      // 2. Another TUI's `/quit` closed the session: it saved it and decides
      // the workload. Nothing to read or delete here. `release` seals: a turn
      // ending after it reports nothing.
      disarm();
      await runtime.release();
      leave();
      lastOut();
      write(
        closedBy === "closed"
          ? `[${noun}] ${shown}: session closed by another terminal\n`
          : closedBy === "gone"
            ? // Gone while the link was down: no terminal is known to have closed it (Q10).
              `[${noun}] ${shown}: the session ended in the ${noun}\n`
            : `[${noun}] ${shown}: session deleted\n`,
      );
      return;
    }
    // 3. This quit ends its session: confirmed for all, or alone on it, a TUI
    // on another session of the run included: `quitPlan` then says why the
    // workload stays (D1). Advisory: it decides only whether to try for the
    // lock, so a TUI leaving others on its session never stops a draining
    // relay. My presence stays until the end: gone first, another TUI's exit
    // net could fire under this save.
    let deleting = !plan.keep && (closeForAll || runQuit.othersOnSession() === 0);
    /** A relay left draining for a TUI on another session: no lock tried, `quitPlan` says why. */
    let spared = false;
    // 4. The run's lock through the delete, exactly the relay's rule. Taken
    // BEFORE the authoritative read of who else is here: an attacher that
    // registers after that read sees the lock and waits (`joinRun` step 2).
    let lock: { release(): void } | null = null;
    if (deleting) {
      // Only a draining relay: another holder is a TUI that quit in the same
      // instant, with its save and delete running. The lock lets one through.
      // Its call may be a turn this quit stops (the session being closed), never
      // one on another session (D1): that TUI is untouched, the relay stays.
      if (lockOf(dir) !== null && (await relayDraining(deps))) {
        // ONE read, after the probe's round trip. The same-session exemption
        // holds only for a close for all: a Ctrl+C closes nobody else's session.
        const here = attachers(dir, deps.procOf).filter((a) => a.pid !== pid);
        const onSession = here.filter((a) => a.sessionId === current).length;
        if (closeForAll ? here.length > onSession : here.length > 0) {
          spared = true;
          deleting = false;
        } else {
          await (deps.stopHolder ?? ((d) => residentStop(d, RELAY_STOP_GRACE_MS, deps.procOf)))(
            dir,
          );
        }
      }
      try {
        lock = spared ? null : acquireResidentLock(dir, deps.procOf);
      } catch {
        lock = null; // lost: no delete
      }
      if (lock && !closeForAll && runQuit.othersOnSession() > 0) {
        // Alone on it a moment ago, someone registered meanwhile (S3): theirs now.
        lock.release();
        lock = null;
        deleting = false;
      }
    }
    // 5. Before the close: afterwards the session is not listed. Read for the
    // session this TUI is on (its `/clear`ed one may not be open: no use).
    const use: ResidentUse | null = lock
      ? await bounded(
          runtime.residentUse(current, { ownMayBeAbsent: true }),
          deps.useTimeoutMs ?? USE_READ_TIMEOUT_MS,
        ).catch(() => null)
      : null;
    // 6. The last save, then the close: for every TUI on it when confirmed,
    // else `ifLast`.
    // `ending`: alone on its session, the `ifLast` close ends it (Q2).
    const quit = await runtime.quit({ closeForAll, ending: runQuit.othersOnSession() === 0 });
    // 7. Closed for all: its other TUIs leave on the close (bounded; one that
    // hangs is counted below and keeps the workload). Only the lock holder
    // decides, so only it waits: two `/quit`s at once must not wait on each other.
    // A spared quit decides too (its `stay` line): it waits, or it would blame them.
    if ((lock || spared) && closeForAll && quit.saved && quit.sessionsKept === 0) {
      await othersLeft();
    }
    // 8. With nobody else, the run's last state; if the lock went elsewhere it
    // is that holder's to write.
    const lost = deleting && lock === null;
    if (others() === 0 && !lost) {
      writeRecord("idle");
    }
    // The transcript is on the laptop before any delete: not confirmed, no delete.
    const unsaved = await sessions.saver.drain();
    const saved = quit.saved && unsaved.length === 0;
    if (lost && existsSync(dir)) {
      write(`[${noun}] ${shown}: another terminal is closing the run\n`);
    }
    // R2: never a silent detach. An unconfirmed save is said for keep=false AND
    // keep=true; "still in the workload" only when the daemon kept it.
    if (!saved) {
      const where =
        quit.sessionsKept > 0
          ? `the session is still in the ${noun}: \`tentacle attach ${name}\` reopens it`
          : "the session ended, but its last save did not reach this laptop";
      write(`[${noun}] ${shown}: ${UNSAVED_NOTE} — ${where}\n`);
    }
    // 9. The ONE decision.
    const decided: QuitPlan =
      lock || spared
        ? quitPlan({
            keep: plan.keep,
            othersAttached: others(),
            othersOnSession: runQuit.othersOnSession(),
            saved,
            sessionsKept: quit.sessionsKept,
            use,
          })
        : { kind: "stay" };
    if (decided.kind === "stay") {
      if (decided.why !== undefined) {
        const detail = `not removed: ${decided.why} — tentacle rm ${name}`;
        write(`[${noun}] ${shown} ${detail}\n`);
        writeRecord("idle", detail);
      } else if (!saved) {
        // keep=true has no delete to hold, and `quitPlan` gives no `why`: the
        // record still says the run did not end, so `ps` agrees with the line.
        writeRecord("idle", UNSAVED_NOTE);
      }
      disarm();
      leave();
      if (saved) {
        lastOut();
      }
      lock?.release();
      return;
    }
    // 8. The ONE verified delete.
    const removal = await bounded(
      removeVerifiedKept(deps.entry, deps.keptFile, { hostFor: () => host }),
      deps.removeTimeoutMs ?? REMOVE_TIMEOUT_MS,
    ).catch((error: unknown): KeptRemoval => ({ kind: "failed", reason: message(error) }));
    const purge =
      removal.kind !== "unreachable" &&
      removal.kind !== "failed" &&
      removal.forgetError === undefined;
    if (removal.kind === "unreachable" || removal.kind === "failed") {
      const detail = `not removed: ${removal.reason} — tentacle rm ${name}`;
      write(`[${noun}] ${shown} ${detail}\n`);
      writeRecord("idle", detail);
    } else if (removal.forgetError !== undefined) {
      // The workload's fate and its index entry are two facts (relay.ts).
      const detail = `${removalFate(removal.kind)}, but its entry in the kept index stayed: ${removal.forgetError} — tentacle rm ${name}`;
      write(`[${noun}] ${shown} ${detail}\n`);
      writeRecord("idle", detail);
    } else if (removal.kind === "removed") {
      (deps.info ?? write)(`[${noun}] removed ${shown}\n`);
    } else if (removal.kind !== "gone") {
      // `other`: the name now holds another tentacle workload (R3). Nothing was
      // deleted; the stale entry went with the run.
      write(`[${noun}] ${shown}: ${removalFate(removal.kind)} — nothing was removed\n`);
    }
    // 10. The net LAST (§7); a completed removal takes the run dir — the lock
    // and my presence with it; else they go now.
    disarm();
    if (purge) {
      purgeRunDir(dir);
    } else {
      leave();
      lock?.release();
    }
  };
  return {
    kind: "joined",
    sessions: seeded,
    runtime,
    permissions,
    attached,
    finish,
    runQuit,
    createSession,
    autoAccept,
  };
}

/** S2b Q4 (b): the removal that clears the entry deletes the run dir. */
function purgeRunDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left: `ps` shows it, `rm` clears it.
  }
}
