/**
 * The hop's ordered sequence (docs/feat/session-hop.md D1) — pure in the sense
 * that matters: every EFFECT arrives as an injected function (a target factory,
 * a record reader, the commit hook, the leave hook), so this module decides
 * ORDER and nothing else. It never dials an engine, never writes a file, never
 * touches the terminal: a hop's output is a status sink and a notice sink (D6).
 *
 * The rule the whole file is built around: a session is never lost. The target
 * is opened BEFORE the old runtime is sealed or disposed, so a failure at any
 * step leaves the old one live and saving; and once the target holds the
 * session, NOTHING rolls back (review M3) — a dispose that fails or hangs is
 * one notice, never a half-moved session.
 *
 * A hop IS the existing `--resume` seed path (AGENTS §7, one session path): the
 * same `createLocalRuntime`, the same broker, the same saver, the laptop's own
 * record of the SAME uid.
 */
import type { LoadResult, SessionRecord } from "@tentacle/agent";
import type { HopSpec } from "@tentacle/tui";
import type { KubeNamespace } from "./engine-select.ts";
import { type HopPlace, ownUidVerdict, placeText } from "./hop-plan.ts";
import type { HopFolderFate } from "./hop-turn.ts";
import type { LocalRuntime, PersistingController } from "./local-runtime.ts";

/** How long the commit lets the old runtime close before it gives up (D1 step 5). */
export const HOP_DISPOSE_TIMEOUT_MS = 3_000;

/**
 * What a target factory built: the runtime, where the session now is, and how
 * to undo the build. The factory owns everything engine-side (provision, the
 * kept labels, the delete of what it created — D5); the orchestrator only calls
 * `rollback` when the hop fails, and never invents its own cleanup.
 */
export interface HopBuilt {
  readonly runtime: LocalRuntime;
  /** The badge's facts after the hop (`local` has no badge: D3). */
  readonly place: HopPlace;
  /**
   * Whether the laptop's folder is visible in the new place (docs/feat/session-hop-ux
   * OD6): `shared` (a container built WITH the mount), `not shared` (a pod, or an
   * existing workload nobody mounted for), `local` (it IS the laptop's). The one
   * fact the wake-up message could not otherwise state, since it comes from the
   * container build's plan (`plan.kind === "mount"`), which is not on `HopPlace`.
   */
  readonly folder: HopFolderFate;
  /** The daemon runs in a pod: spilled output is "saved in the pod". */
  readonly daemonInPod: boolean;
  /**
   * The daemon existed before this hop (any `attach`), so it may already hold
   * our uid — D1 step 4(a) then checks it first. A fresh worker or container
   * cannot, so it skips.
   */
  readonly preexisting: boolean;
  /**
   * Undo the build: dispose the runtime and remove the workload THIS hop
   * created (never a user-owned one). Never throws — a rollback that failed is
   * one notice, not a second failure of the hop.
   */
  readonly rollback: () => Promise<void>;
  /**
   * OD3: the k8s namespace's PROVENANCE (`namespace ns (from context; …)`) when
   * the build resolved one. It rides the outcome line because under auto-accept
   * NO prompt is shown and a typed `/move` never asks — the transcript is then
   * the only place the owner can read why that namespace was dialled.
   */
  readonly trace?: string;
}

export type HopBuild =
  | { readonly kind: "built"; readonly built: HopBuilt }
  /** It could not be built (a pull, an inject, a refused dial): the old session is untouched. */
  | { readonly kind: "failed"; readonly notice: string };

export interface HopRequest {
  readonly spec: HopSpec;
  /**
   * The uid of the session being moved: the SAME id on the target, so the
   * laptop's `<uid>.jsonl` continues (never a new session).
   */
  readonly sessionId: string | null;
  /**
   * The owner's approval already carried the mount gate's warning (a PROPOSED
   * move's prompt merged it, D9/M6): the build must not ask a second time
   * (H5 review finding 2). A typed `/move` never sets it.
   */
  readonly gateAnswered?: true;
  /**
   * OD3: the PROVENANCE of the namespace the spec was PINNED with (a proposal's
   * turn-end resolution). It rides the request so the build states WHY, instead
   * of re-resolving the value the pin already wrote — a re-resolution always
   * answers `explicit`, which hid the real source (fix round 2, finding 1).
   */
  readonly namespace?: KubeNamespace;
}

export interface HopDeps {
  /**
   * Build the target runtime (H4's factories): the ONLY effect this module
   * cannot do itself. `sessionId` is the uid the target must take — the record
   * carries it when something was persisted, and it must still be the SAME uid
   * when nothing was (D1 step 3: `resume: null` PLUS the minted uid).
   */
  readonly build: (
    spec: HopSpec,
    sessionId: string,
    opts: { readonly gateAnswered?: true; readonly namespace?: KubeNamespace },
  ) => Promise<HopBuild>;
  /** The laptop record of a uid — the seed (`LogSessionStore.load`). */
  readonly load: (uid: string) => Promise<LoadResult>;
  /** A phase line (`moving to docker:box — saving the session`). Never the terminal (D6). */
  readonly status?: (line: string) => void;
  /**
   * Step 5's commit point, after the old controllers are sealed and before the
   * old runtime is disposed: the facade swaps to the target, the TUI moves its
   * controller, auto-accept is turned off (D2, D3, D9). Awaited, so the order
   * above is not a comment. A throw here does NOT roll back (the target holds
   * the session): it becomes the notice, and the old runtime is still disposed.
   */
  readonly onCommit?: (built: HopBuilt, facts: { readonly cwd?: string }) => void | Promise<void>;
  /**
   * After the old runtime was disposed: the D5 decision for the place we left
   * (D1 step 5). Resolves an optional notice (a kept workload, a delete that
   * could not be verified).
   */
  readonly afterLeave?: (spec: HopSpec) => Promise<string | null>;
}

export type HopOutcome =
  | {
      readonly kind: "moved";
      readonly built: HopBuilt;
      /**
       * The session on the target, opened seeded under the SAME uid: the one
       * controller the TUI takes (never the target's `createSession`, F2).
       */
      readonly controller: PersistingController;
      /** The whole outcome in one line (`moved to docker:box — …`). */
      readonly notice: string;
      /**
       * Only the suffixes of `notice` (`the old session did not close`, a leave
       * notice): the TUI's own moved line carries them (D2 of
       * docs/fix/session-hop-live.md). Absent when the hop was clean.
       */
      readonly note?: string;
    }
  /** Nothing moved: the old runtime is live and saving, the notice says why. */
  | { readonly kind: "failed"; readonly notice: string };

/** `not moved: …` — the one shape of a refusal (`hopPlan`'s is the pre-flight one). */
export const notMoved = (why: string): HopOutcome => ({
  kind: "failed",
  notice: `not moved: ${why}`,
});

/** What `closeOrRefuseOwn` decided about our own uid on the target (D1 4(a)). */
type OwnVerdict = "ok" | "busy" | "unknown";

/**
 * D1: move `old`'s session to the target the factory builds. The caller has
 * already decided the hop may run (`hopPlan`) and measured the facts; this
 * function is the ordered sequence, and every step's failure mode is one of
 * the `notMoved` lines below.
 */
export async function hopSession(
  old: LocalRuntime,
  request: HopRequest,
  deps: HopDeps,
): Promise<HopOutcome> {
  const { spec, sessionId } = request;
  if (sessionId === null) {
    return notMoved("this session has no id yet");
  }
  // ---- step 2: prepare (reversible; the old runtime is not touched) --------
  // The record is read FIRST, so a copy that cannot be read refuses the hop
  // before a container is created for it (moving now would lose the very
  // conversation the hop exists to carry).
  const stored = await deps.load(sessionId);
  if (stored.status === "unreadable") {
    return notMoved(`the laptop copy of this session could not be read (${stored.reason})`);
  }
  // An ABSENT file means "nothing persisted" (M2) only when this runtime holds
  // no controller for the uid. A session WITH turns whose save failed (a lock,
  // EACCES, ENOSPC) has no file either, and a STALE file (an earlier save
  // landed, a later one failed) is just as wrong a seed: the record is read
  // again AFTER the freeze, which is what heals it (review H2 round 2, HIGH).
  const holdsIt = old.holdsSession(sessionId);
  deps.status?.(`moving to ${targetText(spec)} — preparing the target`);
  const built = await deps.build(spec, sessionId, {
    ...(request.gateAnswered === true ? { gateAnswered: true as const } : {}),
    ...(request.namespace === undefined ? {} : { namespace: request.namespace }),
  });
  if (built.kind === "failed") {
    return { kind: "failed", notice: built.notice };
  }
  const target = built.built;
  const failed = async (why: string): Promise<HopOutcome> => {
    await target.rollback();
    return notMoved(why);
  };

  // ---- step 3: freeze (the old runtime stays live: nothing is sealed) ------
  // The record read above only GUARDED this step (an unreadable copy must not
  // create a container); the SEED below is read after it, because the freeze is
  // what puts the latest history on disk.
  let seed: SessionRecord | null = null;
  if (stored.status === "ok" || holdsIt) {
    deps.status?.(`moving to ${targetText(spec)} — saving the session`);
    // THIS uid only (review M1): another session's failed save is not a reason
    // to refuse, and a hop never moves a session it could not put on disk.
    if (!(await old.freeze(sessionId))) {
      return failed("the session could not be saved");
    }
    // Only a read taken AFTER the freeze can say what the session holds: an
    // absent file may exist now, and a stale one may have been healed. Still
    // absent with a controller held means the save is what failed (refused
    // above); still absent with none really is an empty session (M2), and the
    // target opens the SAME uid unseeded.
    const again = await deps.load(sessionId);
    if (again.status === "unreadable") {
      return failed(`the laptop copy of this session could not be read (${again.reason})`);
    }
    if (again.status === "ok") {
      seed = again.record;
    }
  }

  // ---- step 4(a): a pre-existing target may already hold our uid ----------
  if (target.preexisting) {
    let own: OwnVerdict;
    try {
      own = await closeOrRefuseOwn(target, sessionId);
    } catch (error) {
      // A dropped link or a daemon error is still a refusal with the target
      // rolled back: the caller must answer the TUI, never see a rejection
      // that skips the rollback (review H2 round 2, MEDIUM).
      return failed(
        `can't tell whether ${targetText(spec)} holds this session — not joining it (${errorText(error, "no answer")})`,
      );
    }
    if (own === "busy") {
      return failed(`${targetText(spec)} still holds an older copy of this session`);
    }
    if (own === "unknown") {
      return failed(`can't tell whether ${targetText(spec)} holds this session — not joining it`);
    }
  }
  // D7's "someone else is already there" belongs to the FACTORY: it measures
  // the resident before it opens anything and reports a refusal instead of a
  // runtime, so by the time a hop gets here that check has passed (H6 wires
  // `attachVerdict` into it — and a check that must precede every open cannot
  // live after one).

  // ---- step 4(b): open on the target, then require its save ---------------
  deps.status?.(`moving to ${targetText(spec)} — opening the session`);
  let controller: PersistingController;
  try {
    // `openSeeded(null)` would CLEAR the runtime's own seed: the
    // nothing-persisted case passes `undefined`, so the factory's
    // `resume: null` + the uid it was given is what opens (M2). `claim`: the
    // seeded controller is handed over only through the outcome — a
    // `createSession` racing in (a TUI's foreign-close path, a `/clear`) gets
    // a fresh session and can never steal it (docs/fix/session-hop-live.md F2).
    controller = await target.runtime.openSeeded(seed === null ? undefined : seed, {
      claim: true,
    });
  } catch (error) {
    return failed(errorText(error, "the session could not be opened there"));
  }
  if (!target.runtime.saveConfirmedFor(sessionId)) {
    // Review M1: the open's own save must have LANDED, or the target's copy is
    // not the truth and the move would lose this turn.
    return failed("the session could not be saved there");
  }
  // D4 (docs/fix/session-hop-live.md): where the session's tools now run, as
  // the target daemon reports it. Cosmetic: a miss (`null`) keeps the laptop's.
  const cwd = await target.runtime.sessionCwd(sessionId).catch(() => null);

  // ---- step 5: commit — from here NOTHING rolls back (review M3) ----------
  const notes: string[] = [];
  try {
    // Seal BEFORE the swap and only after the target holds the session: a read
    // of the old runtime still in flight reports nothing from here on.
    old.sealSessions();
    await deps.onCommit?.(target, cwd === null ? {} : { cwd });
  } catch (error) {
    notes.push(errorText(error, "the view could not be switched"));
  }
  // Bounded: a hung daemon must not freeze the TUI on a hop it already made.
  if (!(await closesWithin(old, HOP_DISPOSE_TIMEOUT_MS))) {
    notes.push("the old session did not close");
  }
  try {
    const left = await deps.afterLeave?.(spec);
    if (left !== null && left !== undefined) {
      notes.push(left);
    }
  } catch (error) {
    // The session IS on the target: a cleanup that threw is one notice, not a
    // `moved` hop turned into a rejection (review H2 round 2, MEDIUM).
    notes.push(errorText(error, "the old place could not be tidied"));
  }
  const notice = [`moved to ${placeText(target.place)}`, ...notes].join(" — ");
  // OD3: the provenance rides the outcome too (a hop shows no prompt when
  // auto-accept answered it, and a typed `/move` never shows one at all), so a
  // live test reads "why that namespace" from the line it already keeps.
  const trace = target.trace === undefined ? [] : [target.trace];
  const note = [...notes, ...trace].join(" — ");
  return { kind: "moved", built: target, controller, notice, ...(note === "" ? {} : { note }) };
}

/** The target as the status row and the refusals say it (D3's badge wording, in words). */
function targetText(spec: HopSpec): string {
  if (spec.target === "local") {
    return "local";
  }
  if (spec.target === "attach") {
    return placeText({ kind: "workload", ...spec.workload });
  }
  return spec.image === undefined ? "a container" : `a container (${spec.image})`;
}

/** D1 step 4(a)/D7c: our own uid on the target — seed, close it first, or refuse. */
async function closeOrRefuseOwn(target: HopBuilt, sessionId: string): Promise<OwnVerdict> {
  const verdict = ownUidVerdict(await target.runtime.ownUse(sessionId));
  switch (verdict.kind) {
    case "absent":
      return "ok";
    case "unknown":
      return "unknown";
    case "busy":
      return "busy";
    case "close":
      // The daemon's `open` would ATTACH this copy and ignore the seed (review
      // H1), so it is closed first — and only a fresh read may say it is gone.
      return (await target.runtime.closeOwn(sessionId)) ? "ok" : "busy";
  }
}

/** `old.dispose()` inside a bound: `true` when it settled, `false` on a throw or a timeout. */
async function closesWithin(old: LocalRuntime, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    const closed = old.dispose().then(
      () => true,
      () => false,
    );
    return await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** One line, no raw daemon text: an error's message is container-supplied (AGENTS §7). */
export function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? fallback : message;
}
