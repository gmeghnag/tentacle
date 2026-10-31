/**
 * `attach <name>` on a detached run (docs/feat/detached-handover.md): the IO
 * shell around `attach-plan.ts`. `joinRun` opens the run's ONE session as one
 * more client (a stale owner, an ended run and a join are one path); `finish`
 * is its quit, which ends the run when it is the last client (Q1): a last
 * save, `session/close{ifLast}`, and on keep=false the delete.
 *
 * Who is attached is the presence files (`run-state.ts`), never `owner.json`:
 * a lost write cannot lie. Presence-then-lock here against lock-then-presence
 * in the last quit: whichever runs second sees the other, so a delete never
 * lands under an attacher (an attacher that came later waits, then finds the
 * workload gone). Every seam is injected; `main.ts` stays a call.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import type { AttachPlan, QuitPlan } from "./attach-plan.ts";
import { quitPlan } from "./attach-plan.ts";
import { type ControlConn, dialControl } from "./control-socket.ts";
import type { EngineHost } from "./engine-host.ts";
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
  readOwner,
  removePresence,
  writeOwner,
  writePresence,
} from "./run-state.ts";
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
  readonly procOf: ProcOf;
  /** This process (tests: another). */
  readonly pid?: number;
  readonly now?: () => number;
  /** `openTuiSessions` for the run's session, `live`. */
  readonly openSessions: () => Promise<TuiSessions | { readonly exit: number }>;
  /** The engine host of `entry`; `null`: it could not be built (said already). */
  readonly host: () => EngineHost | null;
  /** `attachEngineRuntime` with `shared` and THIS broker (the single-broker invariant). */
  readonly attach: (
    host: EngineHost,
    sessions: TuiSessions,
    permissions: PermissionBroker,
  ) => Promise<LocalRuntime>;
  /** `armSharedExitNet(host, name, othersAlive)`; returns the disarm. */
  readonly armNet: (host: EngineHost, othersAlive: () => boolean) => () => void;
  /** Default `lockHolder(dir, procOf)`. */
  readonly lockOf?: (dir: string) => { readonly pid: number } | null;
  /** `residentStop` of the run dir's lock holder (a draining relay). */
  readonly stopHolder?: (dir: string) => Promise<unknown>;
  /** "Closing": how long to wait for a closing run's lock; default `RM_STOP_GRACE_MS`. */
  readonly closingWaitMs?: number;
  readonly useTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
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
  | { readonly kind: "prepared"; readonly conn: ControlConn; readonly autoAccept: boolean }
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
      return { kind: "prepared", conn, autoAccept: reply.autoAccept === true };
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
          deps.write(
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
  readonly runtime: LocalRuntime;
  /** THE broker: the runtime's, and the one `startTui` must get. */
  readonly permissions: PermissionBroker;
  /** The live session was opened; false: the seeded path (`--resume`-like). */
  readonly attached: boolean;
  /** The quit, after Ink unmounted. `inkRan` false: `startTui` threw, nothing ends. */
  finish(inkRan: boolean): Promise<void>;
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
    presence = writePresence(dir, pid, deps.procOf);
  } catch (error) {
    write(`\n[error] ${shown}: could not register this terminal on the run: ${message(error)}\n`);
    return { kind: "exit", code: 1 };
  }
  const leave = (): void => removePresence(presence);
  const fresh = readOwner(dir);
  const relayHolds = plan.handover && fresh.kind === "owner" && fresh.owner.kind === "relay";
  if (!relayHolds && lockOf(dir) !== null && !(await relayDraining(deps))) {
    // A TUI deleting the workload: wait for it to go. A relay draining after its
    // hand-over is no wait: the session is the TUIs' already, this is a join (Q3).
    leave();
    write(`[${noun}] ${shown}: the run is closing; waiting…\n`);
    const deadline = now() + (deps.closingWaitMs ?? RM_STOP_GRACE_MS);
    while (lockOf(dir) !== null && now() < deadline) {
      await new Promise((r) => setTimeout(r, CLOSING_POLL_MS));
    }
    if (lockOf(dir) !== null) {
      write(`\n[error] ${shown}: the run is still closing; retry in a moment\n`);
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
      `\n[error] ${shown}: the ${noun} no longer exists — session ${untrustedText(plan.sessionId)} cannot be re-attached; its transcript is kept on this laptop\n`,
    );
    return { kind: "exit", code: 1 };
  }
  // 5. ONE broker for the runtime and the TUI (AGENTS §7).
  const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
  let runtime: LocalRuntime;
  try {
    runtime = await deps.attach(host, sessions, permissions);
  } catch (error) {
    leave();
    write(`[${noun}] failed: ${message(error)}\n`);
    return { kind: "exit", code: 1 };
  }
  // 6. A live relay: `prepare` (it freezes BEFORE this client opens, D5).
  let conn: ControlConn | null = null;
  let relayAutoAccept = false;
  if (plan.handover) {
    const prepared = await prepareHandover(deps, lockOf);
    if (prepared.kind !== "prepared" && prepared.kind !== "join") {
      await runtime.release();
      leave();
      if (prepared.kind === "refuse") {
        write(`\n[error] ${deps.relayRefusal?.() ?? `${shown}: a detached run owns it`}\n`);
        return { kind: "exit", code: 1 };
      }
      return { kind: "closing" };
    }
    if (prepared.kind === "prepared") {
      conn = prepared.conn;
      relayAutoAccept = prepared.autoAccept;
    }
  }
  // 7. The live session, eagerly (the runtime is lazy otherwise).
  let attached: boolean;
  try {
    attached = await runtime.attachTo(plan.sessionId, sessions.resume);
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
    write(`\n[error] ${shown}: the detached run is still starting; retry in a moment\n`);
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
        `\n[error] ${shown}: the hand-over did not complete; the detached run still owns it — retry in a moment\n`,
      );
      return { kind: "exit", code: 1 };
    }
    // No ack and its lock is dead: the relay died, this client is the owner.
    if (relayAutoAccept) {
      sessions.notices.notify(
        "Auto-accept ended with the hand-over: this terminal answers the asks now.",
      );
    }
  }
  if (!attached && sessions.resume === null) {
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
    autoAccept: false,
    keep: plan.keep,
    cwd: deps.owner.cwd ?? deps.cwd,
    created: deps.entry.created,
    // A later terminal finds a draining relay by it.
    ...(deps.owner.control !== undefined ? { control: deps.owner.control } : {}),
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
  const disarm = plan.keep ? () => {} : deps.armNet(host, () => others() > 0);
  if (!plan.keep) {
    sessions.notices.notify(
      `Quitting removes the ${noun} once no other terminal is attached, a running turn included.`,
    );
  }

  const finish = async (inkRan: boolean): Promise<void> => {
    if (!inkRan) {
      // 1. The user quit nothing: the session stays, nothing ends.
      disarm();
      await runtime.release();
      leave();
      return;
    }
    // 2. Mine first, then who else is here (advisory: decides only whether to
    // try for the lock, so a non-last TUI never stops a draining relay).
    leave();
    let alone = others() === 0;
    let deleting = !plan.keep && alone;
    // 3. The run's lock through the delete, exactly the relay's rule. Taken
    // BEFORE the authoritative read of who else is here: an attacher that
    // registers after that read sees the lock and waits (`joinRun` step 2).
    let lock: { release(): void } | null = null;
    if (deleting) {
      // Only a draining relay: another holder is a TUI that quit in the same
      // instant, with its save and delete running. The lock lets one through.
      if (lockOf(dir) !== null && (await relayDraining(deps))) {
        await (deps.stopHolder ?? ((d) => residentStop(d, RELAY_STOP_GRACE_MS, deps.procOf)))(dir);
      }
      try {
        lock = acquireResidentLock(dir, deps.procOf);
      } catch {
        lock = null; // lost: no delete
      }
      if (lock && others() > 0) {
        // Someone registered meanwhile: theirs now.
        lock.release();
        lock = null;
        alone = false;
        deleting = false;
      }
    }
    // 4. Before the close: afterwards the session is not listed.
    const use: ResidentUse | null = lock
      ? await bounded(
          runtime.residentUse(plan.sessionId),
          deps.useTimeoutMs ?? USE_READ_TIMEOUT_MS,
        ).catch(() => null)
      : null;
    // 5. The last save, then close{ifLast}.
    const quit = await runtime.quit();
    // 6. With nobody else, the run's last state; if the lock went elsewhere it
    // is that holder's to write.
    const lost = deleting && lock === null;
    if (alone && !lost) {
      writeRecord("idle");
    }
    // 7. The transcript is on the laptop before any delete: not confirmed, no delete.
    const unsaved = await sessions.saver.drain();
    const saved = quit.saved && unsaved.length === 0;
    if (lost && existsSync(dir)) {
      write(`[${noun}] ${shown}: another terminal is closing the run\n`);
    }
    // R2: never a silent detach. An unconfirmed save is said for keep=false AND
    // keep=true: the run did not end, its session is in the workload still.
    if (!saved) {
      write(
        `[${noun}] ${shown}: ${UNSAVED_NOTE} — the session is still in the ${noun}: \`tentacle attach ${name}\` reopens it\n`,
      );
    }
    const decided: QuitPlan = lock
      ? quitPlan({
          keep: plan.keep,
          othersAttached: 0,
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
      write(`[${noun}] removed ${shown}\n`);
    } else if (removal.kind !== "gone") {
      // `other`: the name now holds another tentacle workload (R3). Nothing was
      // deleted; the stale entry went with the run.
      write(`[${noun}] ${shown}: ${removalFate(removal.kind)} — nothing was removed\n`);
    }
    // 9. The net LAST (§7); a completed removal takes the run dir, the lock with it.
    disarm();
    if (purge) {
      purgeRunDir(dir);
    } else {
      lock?.release();
    }
  };
  return { kind: "joined", sessions, runtime, permissions, attached, finish };
}

/** S2b Q4 (b): the removal that clears the entry deletes the run dir. */
function purgeRunDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left: `ps` shows it, `rm` clears it.
  }
}
