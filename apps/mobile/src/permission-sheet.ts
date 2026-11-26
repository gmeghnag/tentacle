import { type AskOrigin, type AutoAcceptLink, askOrigin } from "@tentacle/client";
/**
 * The permission sheet (docs/feat/mobile-session-view.md 12c): the phone's
 * `PermissionRequester`. Pure and React-free (AGENTS §7) — the screen renders
 * `view(now)` and calls `answer`, so every rule below is tested without a
 * simulator.
 *
 * Rules this module owns:
 * - **One ask at a time, FIFO.** The client's router already serialises its
 *   prompts (`permission-router.ts`), and this queue makes a second one wait
 *   even if a future caller does not.
 * - **Age guard (plan P10).** A tap within `ARM_MS` of an ask APPEARING (or of
 *   the sheet changing to the next one) is ignored: the daemon's ask can land
 *   the instant a person's finger is already moving, and the TUI's open item
 *   (3) is exactly that stray tap approving a request nobody read (P10). The
 *   person taps again.
 * - **The options are the daemon's.** It offered `allow_once` / `allow_always` /
 *   `reject_once` (`packages/daemon/src/permission-map.ts`); the sheet derives
 *   the same set from what reaches the requester (a scope, a suggestion, a
 *   reply), and only ever answers with an option the daemon offered — a
 *   choice it does not offer is `unoffered` at the client, which is a bug to
 *   prove absent, not a runtime surprise (see `permission-sheet.test.ts`).
 * - **A withdrawn ask sends NOTHING.** The requester's `signal` (answered on
 *   another device, its turn cancelled, this client detached) resolves
 *   `DISMISSED`, which the router maps to no frame at all (P3): the request
 *   stays pending for another client.
 * - **The person's words are never lost.** `onAnswerLost` (a reply that did not
 *   reach the agent) hands them back into the sheet's refusal field, with the
 *   reason said once (`permission-reply.ts`'s own wording, reused).
 */
import type {
  AnswerLostCause,
  PermissionRequest,
  PermissionRequestOptions,
  PermissionRequester,
  PermissionResponse,
} from "@tentacle/core";
import {
  DISMISSED,
  autoApproves,
  onceOnlyAsk,
  otherDevicesAsked,
  ownRequest,
} from "@tentacle/core";
import { stripAnsi } from "./ansi.ts";

/**
 * How long a freshly-shown ask ignores taps (plan P10; the TUI's open item 3 is
 * the bug this exists to prevent). Short enough not to feel broken, long enough
 * to outlast a thumb already in motion.
 */
export const ARM_MS = 400;

/** The options the daemon offers, as the app spells them (`permission-map.ts`). */
export type SheetOptionId =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reply"
  /** A `container_share` made PUBLIC; its secret link is `allow_once`. */
  | "share_public";

export interface SheetOption {
  readonly optionId: SheetOptionId;
  readonly label: string;
  /** What the button is: an approval, a refusal, or the one that asks for words. */
  readonly kind: "allow" | "deny" | "reply";
}

/** The ask on screen (or the one whose reply came back). */
export type SheetState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "asking";
      /** A monotonic id per presented ask: React keys, and the "the ask CHANGED" arm test. */
      readonly seq: number;
      /**
       * The daemon's id for this ask (`PermissionRequestOptions.requestId`),
       * when the requester had one: the sheet's route param keys the presented
       * sheet on it, so one ask is told from the next
       * (docs/feat/mobile-native-sheets.md D5). Null: a local ask, no id.
       */
      readonly requestId: string | null;
      readonly request: PermissionRequest;
      readonly options: readonly SheetOption[];
      /** The words the person is typing into the refusal field ("" until they do). */
      readonly replyText: string;
      /** The reply option was chosen: the refusal field is open (F7's path). */
      readonly replyOpen: boolean;
      /** False while the age guard holds: the screen dims every option (P10). */
      readonly armed: boolean;
      /**
       * Milliseconds until the guard releases (0 once armed). The screen needs it
       * to re-render when the window ends: `armed` is computed from the clock, and
       * nothing else would wake the sheet up (found on the simulator — the options
       * stayed dimmed and disabled for ever).
       */
      readonly armedInMs: number;
      /** The sub-agent that asked, when the daemon said so (display only). */
      readonly agent: { readonly type: string; readonly description: string } | null;
      /**
       * The asker's own id when the daemon gave one (a workflow step's ask is
       * `"<runId>.<stepId>"`, the run's hash approval `"<runId>"`): what a workflow
       * card pairs the ask with (`askForStep`, docs/feat/workflows-ui.md D4). Null
       * otherwise. Display/pairing only.
       */
      readonly agentId: string | null;
      /**
       * Who asked, from the structured fields only (`askOrigin`: workflow beats
       * agent; nothing parsed out of text). Display only — it feeds no decision.
       */
      readonly origin?: AskOrigin;
      /**
       * The OTHER devices this ask also reached (docs/feat/session-auto-accept.md
       * D7): each a bounded, sanitized label, this phone's own already dropped.
       * Empty when nobody else was asked. Display only; the first answer wins.
       */
      readonly alsoAsked: readonly string[];
      /**
       * The person swiped the sheet away (docs/fix/mobile-ask-surfaces.md): the ask
       * is still pending and answerable, only its sheet is down (a banner shows).
       */
      readonly parked: boolean;
      /**
       * The person brought this ask up from a banner
       * (docs/fix/mobile-workflows-landing-v2.md D1): over the Workflows landing
       * only such an ask is a sheet (`askPresentable`). Born false, set by
       * `unpark()`; a swipe keeps it. Presentation only — it sends nothing.
       */
      readonly reviewed: boolean;
    }
  | {
      /**
       * A reply came back: the ask was settled elsewhere (or could not be
       * answered at all), and the person's words are in the field again.
       */
      readonly kind: "returned";
      readonly text: string;
      readonly cause: AnswerLostCause;
      readonly notice: string;
    };

/**
 * The scheduler the age guard's release rides (`setTimeout` in the app): a
 * CLOCK event, so it is injected — and it is what makes `armed` become true
 * without the screen having to poll. Without it the options stayed dimmed and
 * `disabled` for ever on the simulator (found by flow 08).
 */
export type SheetSchedule = (fn: () => void, ms: number) => { cancel(): void };

export interface PermissionSheetDeps {
  /** The clock (injected: the age guard is tested without waiting). */
  readonly now: () => number;
  /** Override the arm window (the plan's mutation is `0`). */
  readonly armMs?: number;
  /** Told whenever the state changes: the screen re-renders. */
  readonly onChange?: (state: SheetState) => void;
  /** How the arm window's end is delivered (defaults to the host's `setTimeout`). */
  readonly schedule?: SheetSchedule;
  /**
   * The session's SHARED auto-accept (docs/feat/session-auto-accept.md D6): the
   * phone's `AutoAcceptLink`. A FUNCTION, because the handle (and so the link)
   * only exists after the attach — the sheet is built first. Absent, or returning
   * undefined (a handle with no link, an older client) → no switch and no
   * automatic answer: the sheet behaves exactly as before.
   */
  readonly autoAccept?: () => AutoAcceptLink | undefined;
  /**
   * THIS phone's own device label (`ClientInfo.host`) when it declared one, so
   * an ask's "also asked on" note never names the device it is shown on
   * (docs/feat/session-auto-accept.md D7). Absent → nothing is dropped.
   */
  readonly ownHost?: () => string | undefined;
  /**
   * The session's own-vs-foreign test — the WIDEST it offers
   * (`RemoteSession.autoAcceptsTurn`), the same one a terminal feeds
   * `autoApproves` (`autoAcceptTest`, docs/fix/autoaccept-wake-turns.md A5).
   * Absent: a NAMED turn is this app's, and an ask with NO turn id is never
   * auto-answered (docs/feat/session-auto-accept.md D4 — one rule on every
   * device, and the terminal's is the stricter one).
   */
  readonly autoAcceptsTurn?: (turnId: string) => boolean;
  /**
   * Was this daemon ask PARKED by the person before (a re-delivery after a
   * detach, a session switch)? True → it opens parked, never as a surprise sheet
   * (`ask-park.ts`'s `ASK_PARKS.has`). Absent → every ask opens presented.
   */
  readonly wasParked?: (requestId: string) => boolean;
  /**
   * A daemon ask was ANSWERED here (a tap, a card, a sent reply): its park note is
   * spent. Never called on a withdrawal (a detach, `permission_resolved`, a
   * dismiss) — a detach's replay must still find the note
   * (docs/fix/mobile-ask-surfaces.md, Review S4–S7b finding 1).
   */
  readonly onSettled?: (requestId: string) => void;
}

/**
 * The auto-answer's shape: `allow_once`, never a stored approval — the same
 * answer a terminal's Shift+Tab gives (`autoApproves` + scope `"once"`).
 */
export const AUTO_ACCEPT_RESPONSE: PermissionResponse = { allowed: true, scope: "once" };

export interface PermissionSheet {
  /** The `PermissionRequester` the client's ONE broker gets on mount. */
  readonly requester: PermissionRequester;
  /** The state, with `armed` computed for `now`. */
  view(now?: number): SheetState;
  /** A tap on one of the options. `ignored` while the age guard holds. */
  answer(optionId: SheetOptionId, now?: number): "sent" | "typing" | "ignored";
  /**
   * A workflow card's answer (docs/feat/workflows-ui.md D4): `answer`, but only
   * when the ask on screen IS `requestId` — a card left over from an ask that
   * was settled elsewhere must never answer the one that replaced it. The same
   * settle path as a tap (never a second resolve path) and the same age guard.
   * `"reply"` is the exception: opening the text field settles nothing, so it is
   * not guarded and not sent (docs/fix/a2a-question-workflow-label.md D5) — it
   * unparks and opens the field, and `sendReply` stays the guarded send. A field
   * already open keeps the words typed in it (a swiped-down ask parks with its
   * draft), so a second open only unparks.
   */
  answerFor(
    requestId: string,
    optionId: SheetOptionId,
    now?: number,
  ): "sent" | "typing" | "ignored";
  /** The refusal field's text (only while the reply option is open). */
  setReplyText(text: string): void;
  /** Send the refusal with the person's words (`reject_once` + `message`). */
  sendReply(now?: number): "sent" | "ignored";
  /**
   * The person swiped the ask down: it stays pending (nothing resolved, nothing
   * sent) and only its sheet goes. No-op unless an ask is on screen.
   */
  park(): void;
  /**
   * The banner was tapped: bring a parked ask back and mark it `reviewed`. No-op
   * unless an ask is on screen, or on one already up and reviewed. Sends nothing.
   */
  unpark(): void;
  /** The screen went away: withdraw the ask, send nothing (`reset()` on the broker). */
  dismiss(): void;
  /** Clear a returned reply (its notice was read and its text reused or dropped). */
  clearReturned(): void;
  /** Whether an ask is on screen. */
  readonly asking: boolean;
  /** Asks waiting behind the one on screen (the banner's «+1»). */
  readonly queued: number;
  /**
   * The session's shared auto-accept, for the screen's switch (`null`: this
   * computer does not share it — the switch is disabled with a reason).
   */
  readonly autoAccept: AutoAcceptLink | null;
  /**
   * The line a recent automatic answer left in the sheet (`auto-accepted ·
   * <tool>`), or null. Display only, and the TOOL name only: never the
   * command, never the person's text (the app log's P4 rule).
   */
  readonly autoAccepted: string | null;
}

/**
 * The options a request gets: the daemon's own three, plus the reply option
 * exactly when the asker takes a reply (`req.reply`, `permission-reply.md`).
 * The "for this session" wording carries the suggested rule when there is one —
 * the same sentence the TUI and the daemon's option name use.
 */
export function sheetOptions(req: PermissionRequest): readonly SheetOption[] {
  // A remote agent's question (docs/feat/a2a-client.md C10): the answer is TEXT
  // (`allowed:true + message`), never a grant — so no allow options at all;
  // "Answer…" opens the field, "Skip" declines. No reply bound → only Skip.
  if (req.kind === "question") {
    return [
      ...(req.reply !== undefined
        ? ([{ optionId: "reply", label: "Answer…", kind: "reply" }] as const)
        : []),
      { optionId: "reject_once", label: "Skip", kind: "deny" },
    ];
  }
  // A model-proposed remote agent: one human decision, session-scoped (C11).
  if (req.kind === "agent_add") {
    return [
      { optionId: "allow_once", label: "Yes, for this session", kind: "allow" },
      { optionId: "reject_once", label: "No", kind: "deny" },
      ...(req.reply !== undefined
        ? ([{ optionId: "reply", label: "No, let's talk about it", kind: "reply" }] as const)
        : []),
    ];
  }
  // Publishing a public page (docs/feat/session-apps-publish.md D3): once or no.
  if (req.kind === "app_publish") {
    return [
      { optionId: "allow_once", label: "Publish once", kind: "allow" },
      { optionId: "reject_once", label: "No", kind: "deny" },
      ...(req.reply !== undefined
        ? ([{ optionId: "reply", label: "No, let's talk about it", kind: "reply" }] as const)
        : []),
    ];
  }
  // A container preview (docs/feat/container-apps-devices.md OD2): once or no.
  if (req.kind === "container_preview") {
    return [
      { optionId: "allow_once", label: "Show once", kind: "allow" },
      { optionId: "reject_once", label: "No", kind: "deny" },
      ...(req.reply !== undefined
        ? ([{ optionId: "reply", label: "No, let's talk about it", kind: "reply" }] as const)
        : []),
    ];
  }
  // A port on the internet (docs/feat/session-apps-container-ports.md): the
  // secret link first, public only by its own button.
  if (req.kind === "container_share") {
    return [
      { optionId: "allow_once", label: "Share with a secret link", kind: "allow" },
      { optionId: "share_public", label: "Share PUBLICLY: anyone with the address", kind: "allow" },
      { optionId: "reject_once", label: "No", kind: "deny" },
      ...(req.reply !== undefined
        ? ([{ optionId: "reply", label: "No, let's talk about it", kind: "reply" }] as const)
        : []),
    ];
  }
  const always =
    req.suggestion !== undefined
      ? `Allow \`${req.suggestion.prefix}\` commands for this session`
      : "Allow for the rest of this session";
  // A workflow approval is ONE human decision: the daemon offers no
  // `allow_always` for it, so offering one here would be rejected. A browser
  // action likewise (docs/feat/browser-inspect.md B5).
  const once = onceOnlyAsk(req);
  return [
    { optionId: "allow_once", label: "Allow once", kind: "allow" },
    ...(once ? [] : ([{ optionId: "allow_always", label: always, kind: "allow" }] as const)),
    { optionId: "reject_once", label: "Deny", kind: "deny" },
    ...(req.reply !== undefined
      ? ([{ optionId: "reply", label: "No, let's talk about it", kind: "reply" }] as const)
      : []),
  ];
}

/** The reply field's copy: a question's words are an ANSWER, any other's a refusal. */
export function replyCopy(req: PermissionRequest): { placeholder: string; send: string } {
  return req.kind === "question"
    ? { placeholder: "Your answer", send: "Send answer" }
    : { placeholder: "Tell it what to do instead", send: "Send reply" };
}

/** Why a returned reply came back, in the TUI's own words (`permission-reply.ts`). */
export function returnedNotice(cause: AnswerLostCause): string {
  switch (cause) {
    case "settled":
      return "Your reply did not reach the agent (the request was already settled): it is back here";
    case "unreplyable":
      return "Your reply was not sent (this computer does not take a reply): it is back here";
    case "session-lost":
      return "Your reply may not have reached the agent (the session was lost): it is back here";
    default:
      return "Your reply could not be sent: it is back here";
  }
}

/** The response an option sends: the bridge's own vocabulary, never a guess. */
export function responseFor(
  optionId: SheetOptionId,
  text: string,
  kind?: PermissionRequest["kind"],
): PermissionResponse | null {
  switch (optionId) {
    case "allow_once":
      return { allowed: true, scope: "once" };
    case "allow_always":
      return { allowed: true, scope: "session" };
    case "share_public":
      return { allowed: true, scope: "once", choice: "public" };
    case "reject_once":
      return { allowed: false };
    case "reply":
      // A question's words are its ANSWER (`allowed:true + message`, no scope).
      return text.trim() === "" ? null : { allowed: kind === "question", message: text };
  }
}

interface Pending {
  readonly req: PermissionRequest;
  readonly options: PermissionRequestOptions | undefined;
  readonly resolve: (response: PermissionResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
}

export function createPermissionSheet(deps: PermissionSheetDeps): PermissionSheet {
  const armMs = deps.armMs ?? ARM_MS;
  const schedule: SheetSchedule =
    deps.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    });
  let state: SheetState = { kind: "idle" };
  /** The ask the person can answer, when one is on screen. */
  let current: Pending | null = null;
  /** Asks waiting behind it (FIFO: the router serialises, this is the guard). */
  const queue: Pending[] = [];
  /** When the ask on screen appeared (or the sheet changed to it): the age guard. */
  let armedAt = 0;
  /** The pending release of the age guard (cancelled when the ask changes). */
  let armRelease: { cancel(): void } | null = null;
  let seq = 0;
  /** The option the person chose as a refusal-with-words (still typing). */
  let replyOpen = false;
  /** The words of the answer that came back (its `onAnswerLost`). */
  let lostText = "";

  const now = (at?: number): number => at ?? deps.now();

  function commit(next: SheetState): void {
    state = next;
    deps.onChange?.(next);
  }

  /** Show `entry` (or go idle when none is left), arming its age guard. */
  function present(entry: Pending | null): void {
    armRelease?.cancel();
    armRelease = null;
    current = entry;
    replyOpen = false;
    if (entry === null) {
      commit({ kind: "idle" });
      return;
    }
    armedAt = now();
    seq += 1;
    commit({
      kind: "asking",
      seq,
      requestId: entry.options?.requestId ?? null,
      request: entry.req,
      options: sheetOptions(entry.req),
      replyText: "",
      replyOpen: false,
      armed: armMs <= 0,
      armedInMs: Math.max(0, armMs),
      agent:
        entry.options?.agent !== undefined
          ? {
              type: entry.options.agent.type,
              description: entry.options.agent.description,
            }
          : null,
      agentId: entry.options?.agent?.id ?? null,
      origin: askOrigin({
        ...(entry.options?.agent === undefined ? {} : { agent: entry.options.agent }),
        ...(entry.options?.workflow === undefined ? {} : { workflow: entry.options.workflow }),
      }),
      // The daemon's list of who else was asked, minus this phone's own label
      // (docs/feat/session-auto-accept.md D7). Display only, and the labels come
      // from a daemon that may be a pod: bounded and stripped, never trusted.
      alsoAsked: otherDevicesAsked(entry.options?.askedOn, deps.ownHost?.()).map((label) =>
        stripAnsi(label).replace(/\s+/g, " ").trim().slice(0, 40),
      ),
      parked:
        entry.options?.requestId !== undefined &&
        deps.wasParked?.(entry.options.requestId) === true,
      reviewed: false,
    });
    if (armMs > 0 && entry === current) {
      // The window's END is a state change, not a guess: the sheet says so once,
      // through the same `onChange` every other change uses (so the screen never
      // has to poll a clock — the bug flow 08 found).
      armRelease = schedule(() => {
        armRelease = null;
        if (current === entry) {
          commit({
            ...(state as Extract<SheetState, { kind: "asking" }>),
            armed: true,
            armedInMs: 0,
          });
        }
      }, armMs);
    }
  }

  /** Settle the ask on screen and move to the next one. */
  function settle(response: PermissionResponse): void {
    const entry = current;
    detach(entry);
    const next = queue.shift() ?? null;
    present(next);
    const id = entry?.options?.requestId;
    if (id !== undefined) {
      deps.onSettled?.(id);
    }
    entry?.resolve(response);
  }

  function detach(entry: Pending | null): void {
    entry?.detach();
  }

  /** The requester: queue, present, and resolve from a tap or from the signal. */
  const requester: PermissionRequester = (req, options) =>
    new Promise<PermissionResponse>((resolve, reject) => {
      if (options?.signal?.aborted === true) {
        // Withdrawn before it was ever shown: no ask, no frame (P3).
        resolve(DISMISSED);
        return;
      }
      // The session's auto-accept (docs/feat/session-auto-accept.md D6): with
      // it ON, an ask this device may answer is answered `allow_once` at once —
      // never shown, never `allow_always`, and the age guard does not apply (it
      // exists for a stray TAP, and no finger is involved).
      if (eligible(req, options)) {
        noteAutoAccepted(req);
        resolve(AUTO_ACCEPT_RESPONSE);
        return;
      }
      const entry: Pending = {
        req,
        options,
        resolve,
        reject,
        detach: () => options?.signal?.removeEventListener("abort", onAbort),
      };
      function onAbort(): void {
        // Answered elsewhere / its turn was cancelled / this client detached:
        // the sheet closes and NOTHING is sent — the request stays pending for
        // whoever can still answer it (`permission-router.ts`'s dismissed rule).
        const wasCurrent = current === entry;
        const at = queue.indexOf(entry);
        if (at >= 0) {
          queue.splice(at, 1);
        }
        entry.detach();
        if (wasCurrent) {
          const next = queue.shift() ?? null;
          present(next);
        } else if (at >= 0) {
          commit(state); // the queue shrank: the «+1» is re-read
        }
        resolve(DISMISSED);
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (current === null) {
        present(entry);
      } else {
        queue.push(entry);
        commit(state); // the queue grew: the «+1» is re-read
      }
    });

  /** Whether a tap is allowed right now: the age guard (P10). */
  function armed(at: number): boolean {
    return armMs <= 0 || at - armedAt >= armMs;
  }

  /** The line an automatic answer leaves (display only; the tool, never the command). */
  let autoAccepted: string | null = null;

  function noteAutoAccepted(req: PermissionRequest): void {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    const printable = stripAnsi(req.tool).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    autoAccepted = `auto-accepted · ${printable.slice(0, 40)}`;
    commit(state);
  }

  /**
   * May this ask be answered automatically? The SAME rule every surface uses —
   * `autoApproves` (moved to `@tentacle/core`, so the phone and a terminal can
   * never disagree) over the session's own-turn test, and the session's shared
   * switch is ON. A `hooks_trust` or `session_hop` ask, and another device's
   * turn, always reach a person.
   */
  function eligible(
    req: PermissionRequest,
    options: PermissionRequestOptions | undefined,
  ): boolean {
    const link = deps.autoAccept?.();
    if (link === undefined || !link.shared() || !link.current()) {
      return false;
    }
    // The session's own-turn test, or — with none wired — "a NAMED turn is this
    // app's". Either way an ask with NO turn id is not mine, which is the rule
    // a terminal applies too (D4; Review round 1, MEDIUM 4): the switch must
    // never grant an ask no device can attribute to a turn.
    const owns = deps.autoAcceptsTurn ?? (() => true);
    return autoApproves(req, ownRequest(options?.turnId, owns));
  }

  /** The person's reply did not reach the agent: their words come back. */
  function returnReply(cause: AnswerLostCause): void {
    const text = lostText;
    lostText = "";
    commit({ kind: "returned", text, cause, notice: returnedNotice(cause) });
  }

  return {
    requester,
    get asking() {
      return state.kind === "asking";
    },
    get queued() {
      return queue.length;
    },
    get autoAccept() {
      return deps.autoAccept?.() ?? null;
    },
    get autoAccepted() {
      return autoAccepted;
    },
    view(at) {
      const when = now(at);
      if (state.kind !== "asking") {
        return state;
      }
      const isArmed = armed(when);
      const armedInMs = isArmed ? 0 : Math.max(0, armedAt + armMs - when);
      return isArmed === state.armed && armedInMs === state.armedInMs
        ? state
        : { ...state, armed: isArmed, armedInMs };
    },
    answer(optionId, at) {
      const entry = current;
      if (entry === null || state.kind !== "asking") {
        return "ignored";
      }
      if (!armed(now(at))) {
        // The stray tap the age guard exists for (P10): nothing happens, and the
        // ask stays where it is.
        return "ignored";
      }
      const offered = sheetOptions(entry.req).some((o) => o.optionId === optionId);
      if (!offered) {
        return "ignored";
      }
      if (optionId === "reply") {
        // Not an answer yet: the refusal field opens with the ask still pending.
        replyOpen = true;
        if (state.kind === "asking") {
          commit({ ...state, replyOpen: true, replyText: "" });
        }
        return "typing";
      }
      const response = responseFor(optionId, "");
      if (response === null) {
        return "ignored";
      }
      settle(response);
      return "sent";
    },
    answerFor(requestId, optionId, at) {
      if (state.kind !== "asking" || state.requestId !== requestId) {
        return "ignored";
      }
      const entry = current;
      if (entry === null) {
        return "ignored";
      }
      if (optionId === "reply") {
        // Opening the field sends nothing, so the age guard does not apply (it
        // protects a DECISION from a stray tap); `sendReply` stays guarded. Keyed
        // on `requestId`, it can never touch another ask.
        if (!sheetOptions(entry.req).some((o) => o.optionId === "reply")) {
          return "ignored";
        }
        replyOpen = true;
        // A draft already typed survives this tap: a sheet swiped down while
        // asking keeps its field open and its words, so opening it twice must
        // only bring it back (`Review`/`unpark` does the same).
        commit(
          state.replyOpen
            ? { ...state, parked: false }
            : { ...state, parked: false, replyOpen: true, replyText: "" },
        );
        return "typing";
      }
      if (!armed(now(at))) {
        return "ignored";
      }
      const offered = sheetOptions(entry.req).some((o) => o.optionId === optionId);
      const response = offered ? responseFor(optionId, "") : null;
      if (response === null) {
        return "ignored";
      }
      settle(response);
      return "sent";
    },
    setReplyText(text) {
      if (state.kind !== "asking" || !replyOpen) {
        return;
      }
      commit({ ...state, replyText: text });
    },
    sendReply(at) {
      const entry = current;
      if (entry === null || state.kind !== "asking" || !replyOpen) {
        return "ignored";
      }
      if (!armed(now(at))) {
        return "ignored";
      }
      const text = state.replyText;
      const response = responseFor("reply", text, entry.req.kind);
      if (response === null) {
        return "ignored"; // nothing typed: the words would go as a bare No (owner Q2)
      }
      lostText = text;
      // The person's words come back if they never reach the agent.
      settle({ ...response, onAnswerLost: returnReply });
      return "sent";
    },
    park() {
      if (state.kind === "asking" && !state.parked) {
        commit({ ...state, parked: true });
      }
    },
    unpark() {
      if (state.kind === "asking" && (state.parked || !state.reviewed)) {
        commit({ ...state, parked: false, reviewed: true });
      }
    },
    dismiss() {
      // Everything the sheet holds is withdrawn: the ask on screen AND the ones
      // queued behind it. Nothing is sent (each resolves `DISMISSED`), so every
      // request stays pending for a client that can still answer it.
      const entries = [current, ...queue.splice(0)].filter((e): e is Pending => e !== null);
      current = null;
      replyOpen = false;
      present(null);
      for (const entry of entries) {
        entry.detach();
        entry.resolve(DISMISSED);
      }
    },
    clearReturned() {
      if (state.kind === "returned") {
        commit({ kind: "idle" });
      }
    },
  };
}

/** The sheet's 50 pt pill kinds (mockup `Approval`; `PillButton`'s own names). */
export type OptionPill = "primary" | "secondary" | "destructive" | "neutral";

export interface OptionStyle {
  readonly pill: OptionPill;
  /** An SF Symbol beside the label, or none. */
  readonly icon: "bubble.left" | null;
}

const OPTION_STYLE: Readonly<Record<string, OptionStyle>> = {
  allow_once: { pill: "primary", icon: null },
  allow_always: { pill: "secondary", icon: null },
  share_public: { pill: "secondary", icon: null },
  reject_once: { pill: "destructive", icon: null },
  reply: { pill: "neutral", icon: "bubble.left" },
};

/**
 * How an answer LOOKS, by the option id the daemon sent (Slice 4): allow once is
 * the filled primary, allow always the tinted one, deny destructive, reply
 * neutral with a speech bubble. An id this build does not know is neutral — it
 * is still shown, in the daemon's order, never dropped.
 */
export function optionStyle(optionId: string): OptionStyle {
  return OPTION_STYLE[optionId] ?? { pill: "neutral", icon: null };
}

export interface LabelRun {
  readonly text: string;
  readonly code: boolean;
}

/**
 * A label's `code` spans, so the sheet shows `bun test` in mono instead of with
 * literal backticks (B3's class). Only PAIRED backticks open a run; an unpaired
 * one stays text.
 */
export function labelRuns(label: string): readonly LabelRun[] {
  const parts = label.split("`");
  if (parts.length < 3) {
    return [{ text: label, code: false }];
  }
  const runs: LabelRun[] = [];
  const paired = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  for (let at = 0; at < paired; at += 1) {
    const text = parts[at] ?? "";
    if (text !== "") {
      runs.push({ text, code: at % 2 === 1 });
    }
  }
  if (paired < parts.length) {
    // An odd backtick out: the rest is text, the backtick included.
    const rest = `\`${parts.slice(paired).join("`")}`;
    const last = runs.at(-1);
    if (last !== undefined && !last.code) {
      runs[runs.length - 1] = { text: last.text + rest, code: false };
    } else {
      runs.push({ text: rest, code: false });
    }
  }
  return runs;
}
