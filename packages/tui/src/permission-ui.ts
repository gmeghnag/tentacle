/**
 * The interactive permission dialog's state, isolated from the App.
 *
 * Installs this App as the `PermissionBroker`'s requester: when a tool needs
 * approval the broker calls us, we surface a prompt (unless auto-accept is on)
 * and resolve the broker's promise with the user's choice. Auto-accept (Shift+
 * Tab) is mirrored in a ref so toggling it mid-session takes effect without
 * re-installing the requester.
 *
 * A prompt can end without a person's choice: its request is withdrawn (the
 * signal aborts — answered on another device, or its turn cancelled) or the
 * TUI unmounts. Both resolve `DISMISSED`: over RPC nothing is sent (the request
 * stays pending for another client); on the worker's own broker the gate reads
 * it as a refusal.
 */
import {
  DISMISSED,
  type PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
  autoApproves,
  onceOnlyAsk,
  ownRequest,
} from "@tentacle/core";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ApprovalScroll,
  NO_APPROVAL_SCROLL,
  approvalHint,
  approvalRows,
} from "./approval-scroll.ts";
import { cellWidth, graphemes, truncateCells } from "./cells.ts";
import { MENU, type OrphanCause, type ReplyMode, draftOf } from "./permission-reply.ts";

/** The sub-agent a request comes from. */
export interface PermissionAgent {
  readonly type: string;
  readonly description: string;
  /** A BACKGROUND child's `sa-N` (absent: a foreground sub-agent). */
  readonly id?: string;
}

export interface PermissionChoice {
  readonly label: string;
  readonly response: PermissionResponse;
  /** "No, let's talk about it": opens the reply field instead of answering. */
  readonly reply?: true;
}

/*
 * `autoApproves` and `ownRequest` moved to `@tentacle/core` (docs/feat/
 * session-auto-accept.md D4): the phone's permission sheet decides with the
 * SAME rule and cannot import the TUI (React 19 vs 18, AGENTS §6). Re-exported
 * here so every existing importer — the App, the detached run's
 * `relay-policy.ts` — keeps working unchanged.
 */
export { autoApproves, ownRequest };

/**
 * The own-vs-foreign test the session offers, or `undefined` when it decides
 * nothing (a local session: every request is mine). The WIDEST one wins:
 * `autoAcceptsTurn` (own turns, and on a trusted `serve` the session's own wake
 * turns) over `ownsTurn`, so a wake turn's ask — and one of a background child
 * it spawned — is not mistaken for another device's
 * (docs/fix/autoaccept-wake-turns.md A5).
 *
 * Pure on purpose (AGENTS §7: branching lives in a pure module): the App hands
 * this to `usePermissionBroker` and renders nothing of it.
 */
export function autoAcceptTest(
  session:
    | { ownsTurn?(turnId: string): boolean; autoAcceptsTurn?(turnId: string): boolean }
    | null
    | undefined,
): ((turnId: string) => boolean) | undefined {
  if (session?.autoAcceptsTurn) {
    return (turnId: string) => session.autoAcceptsTurn?.(turnId) === true;
  }
  if (session?.ownsTurn) {
    return (turnId: string) => session.ownsTurn?.(turnId) === true;
  }
  return undefined;
}

/** Whether the dialog shows the cwd row (`permissionCwdLine`): tool calls only, not a trust or a hop request. */
export function permissionShowsCwd(req: PermissionRequest): boolean {
  return req.kind !== "hooks_trust" && req.kind !== "session_hop";
}

/**
 * The cwd row's note (docs/feat/write-tmpdir.md). Static: the TUI does not know
 * the daemon's `tools.writableDirs` (no wire field for a label); the detail row
 * above already shows the concrete path.
 */
export const WRITES_NOTE = "writes limited to here + allowed dirs";

/** The dialog's cwd row: the cwd cut to fit, then the note — one row at `columns`. */
export function permissionCwdLine(cwd: string, columns: number): string {
  // The row's leading space + " · " + the note, and one spare cell.
  const reserved = 1 + 3 + WRITES_NOTE.length + 1;
  const line = `${truncateCells(cwd, Math.max(10, columns - reserved))} · ${WRITES_NOTE}`;
  // Too narrow for both: cut the whole row (the note's end first), so it never
  // wraps and `permissionPromptRows` stays true (review LOW 3).
  return truncateCells(line, Math.max(1, columns - 2));
}

/**
 * The dialog's row naming the sub-agent that asks (`explore · "find callers"`),
 * truncated to the width. Display only: nothing decides on it.
 */
export function permissionAgentLine(agent: PermissionAgent, columns: number): string {
  const line =
    agent.id !== undefined
      ? `${agent.id} · ${agent.type} · "${agent.description}" · background`
      : `${agent.type} · "${agent.description}"`;
  return truncateCells(line, Math.max(10, columns - 3));
}

/** At most this many detail rows in the dialog (a hooks trust request lists several). */
export const MAX_DETAIL_ROWS = 10;

/**
 * The dialog's detail rows: one for a tool (its subject, or "—"); the asker's
 * own lines for a hooks trust or a session-hop request (each a laptop-written
 * fact, or an already-sanitized one), capped at `MAX_DETAIL_ROWS` (the last row
 * then says how many were left out). The component truncates each row.
 */
export function permissionDetailLines(req: PermissionRequest): string[] {
  if (req.kind === undefined || req.kind === "tool") {
    return [req.detail ? req.detail : "—"];
  }
  const lines = (req.detail ?? "—").split("\n");
  if (lines.length <= MAX_DETAIL_ROWS) {
    return lines;
  }
  return capRows(lines);
}

/** At most `MAX_DETAIL_ROWS`; when cut, the last row says how many were left out. */
function capRows(lines: readonly string[]): string[] {
  if (lines.length <= MAX_DETAIL_ROWS) {
    return [...lines];
  }
  const kept = lines.slice(0, MAX_DETAIL_ROWS - 1);
  return [...kept, `… ${lines.length - kept.length} more lines`];
}

/** `line` cut into consecutive pieces of at most `width` cells (`""` stays one row). */
function wrapCells(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const g of graphemes(line)) {
    const w = cellWidth(g);
    if (used + w > width && row !== "") {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += g;
    used += w;
  }
  rows.push(row);
  return rows;
}

/** What the dialog draws under its title: the subject rows and the model's sentence. */
export interface PermissionView {
  /** Each row already fits `columns − 3` cells (the component draws them as they are). */
  readonly detailRows: string[];
  /** `the model says: “…”`, one row; `null` when there is no sentence to show. */
  readonly intentRow: string | null;
  /**
   * A `workflow_approve`'s WHOLE wrapped list: how many rows it takes, and how
   * tall its window is. The key layer scrolls with these (the scroll's one
   * decision lives here, beside the paint); 0 for any other ask.
   */
  readonly detailTotal: number;
  readonly detailWindow: number;
}

/**
 * The ONE decision both the layout (row count) and `PermissionPrompt` (paint)
 * read (docs/feat/shell-intent-line.md Design §5, Q3). A `shell` ask shows the
 * WHOLE command: each of its lines wrapped to the width, capped at
 * `MAX_DETAIL_ROWS` with a `… N more lines` row — never a silent cut (a shell
 * ROW cuts its command to make room for `exit=N`; the ask must show what really
 * runs). A `workflow_approve` shows its WHOLE step list the same way — every
 * `run` command verbatim, wrapped, never cut — in a window of at most
 * `MAX_DETAIL_ROWS` rows, scrolled by `scroll` with a row saying how much is
 * left (docs/fix/workflow-approve-detail.md D2: an approval must never hide a
 * command, and Yes stays allowed). Other asks: today's rows, each cut to one row.
 * `intent`: the asking call's own sentence (display only, never decided on).
 */
export function permissionView(
  req: PermissionRequest,
  intent: string | null,
  columns: number,
  scroll: ApprovalScroll = NO_APPROVAL_SCROLL,
): PermissionView {
  const width = Math.max(10, columns - 3);
  if (req.kind === "workflow_approve") {
    // Every line of the list, wrapped: the dialog never cuts a step or a command.
    const wrapped = (req.detail ?? "—").split("\n").flatMap((line) => wrapCells(line, width));
    // Scrollable: the last row is the hint, so the window is one row shorter and
    // the dialog stays exactly `MAX_DETAIL_ROWS` tall (the layout counts this).
    const scrollable = wrapped.length > MAX_DETAIL_ROWS - 1;
    const window = scrollable ? MAX_DETAIL_ROWS - 1 : Math.max(1, wrapped.length);
    const { rows, below } = approvalRows(wrapped, scroll.offset, window);
    return {
      detailRows: [...rows, ...(scrollable ? [truncateCells(approvalHint(below), width)] : [])],
      intentRow: intent === null ? null : truncateCells(`the model says: “${intent}”`, width),
      detailTotal: wrapped.length,
      detailWindow: window,
    };
  }
  const detailRows =
    req.tool === "shell" && (req.kind === undefined || req.kind === "tool")
      ? capRows(
          req.detail ? req.detail.split("\n").flatMap((line) => wrapCells(line, width)) : ["—"],
        )
      : permissionDetailLines(req).map((line) => truncateCells(line, width));
  const intentRow = intent === null ? null : truncateCells(`the model says: “${intent}”`, width);
  return { detailRows, intentRow, detailTotal: 0, detailWindow: 0 };
}

/** The trust menu: 4 choices when the laptop stores decisions, else this session only. */
function hooksTrustChoices(req: PermissionRequest): PermissionChoice[] {
  const input = req.input as { storeBacked?: unknown } | null;
  const storeBacked = input !== null && typeof input === "object" && input.storeBacked === true;
  return storeBacked
    ? [
        { label: "Trust for this session", response: { allowed: true, scope: "once" } },
        { label: "Always trust this project", response: { allowed: true, scope: "session" } },
        { label: "Don't trust", response: { allowed: false } },
        { label: "Never for this project", response: { allowed: false, scope: "session" } },
      ]
    : [
        { label: "Trust for this session", response: { allowed: true, scope: "once" } },
        { label: "Don't trust", response: { allowed: false } },
      ];
}

/** The session-hop menu (D9): yes ONCE, or no — never a standing approval. */
function hopChoices(req: PermissionRequest): PermissionChoice[] {
  // A refusal may carry the owner's own words (D9's `[move declined]` line is
  // the laptop's, but a typed reply is the model's to read). Offered only when
  // the asker takes one (`req.reply`), exactly as a tool refusal does.
  return [
    { label: "Yes, move it", response: { allowed: true, scope: "once" } },
    { label: "No", response: { allowed: false } },
    ...(req.reply
      ? [
          {
            label: "No, let's talk about it",
            response: { allowed: false },
            reply: true as const,
          },
        ]
      : []),
  ];
}

/** The arrow-menu options for a request: once / always (scoped) / deny. */
export function buildPermissionChoices(req: PermissionRequest): PermissionChoice[] {
  if (req.kind === "hooks_trust") {
    return hooksTrustChoices(req);
  }
  if (req.kind === "session_hop") {
    return hopChoices(req);
  }
  // A remote agent's question (docs/feat/a2a-client.md C10): the answer is the
  // reply TEXT (`allowed:true + message`, sent by the field), never a grant.
  if (req.kind === "question") {
    return [
      ...(req.reply
        ? [{ label: "Answer…", response: { allowed: true as const }, reply: true as const }]
        : []),
      { label: "Skip", response: { allowed: false } },
    ];
  }
  // A model-proposed remote agent: once-only, session-scoped, no "always".
  if (req.kind === "agent_add") {
    return [
      { label: "Yes, for this session", response: { allowed: true, scope: "once" } },
      { label: "No", response: { allowed: false } },
      ...(req.reply
        ? [{ label: "No, let's talk about it", response: { allowed: false }, reply: true as const }]
        : []),
    ];
  }
  // Publishing a public page (docs/feat/session-apps-publish.md D3): this one
  // publish or not — no "always" exists.
  if (req.kind === "app_publish") {
    return [
      { label: "Publish once", response: { allowed: true, scope: "once" } },
      { label: "No", response: { allowed: false } },
      ...(req.reply
        ? [{ label: "No, let's talk about it", response: { allowed: false }, reply: true as const }]
        : []),
    ];
  }
  // A workflow approval (the hash, or an approve step) is ONE human decision:
  // the daemon offers allow-once / deny only (`daemon/src/permission-map.ts`),
  // so an "always" here would be rejected as "option not offered". A browser
  // action likewise (docs/feat/browser-inspect.md B5).
  if (onceOnlyAsk(req)) {
    return [
      { label: "Yes", response: { allowed: true, scope: "once" } },
      { label: "No", response: { allowed: false } },
      ...(req.reply
        ? [{ label: "No, let's talk about it", response: { allowed: false }, reply: true as const }]
        : []),
    ];
  }
  // `workload_shell`'s "always" is scoped to the SINGLE workload
  // (docs/feat/workload-shell.md D6), so its label says so — and with no
  // derivable prefix there is nothing to scope, so no "always" is offered at
  // all. Offering the session-wide wording here would read as broader than the
  // rule; the rule being narrower than the label is the safe direction, but a
  // label that is simply WRONG is not.
  if (req.tool === "workload_shell") {
    return [
      { label: "Yes", response: { allowed: true, scope: "once" } },
      ...(req.suggestion
        ? [
            {
              label: `Yes, and don't ask again for \`${req.suggestion.prefix}\` commands on this workload`,
              response: { allowed: true, scope: "session" as const },
            },
          ]
        : []),
      { label: "No", response: { allowed: false } },
      ...(req.reply
        ? [{ label: "No, let's talk about it", response: { allowed: false }, reply: true as const }]
        : []),
    ];
  }
  const always = req.suggestion
    ? `Yes, and don't ask again for \`${req.suggestion.prefix}\` commands`
    : "Yes, and don't ask again this session";
  return [
    { label: "Yes", response: { allowed: true, scope: "once" } },
    { label: always, response: { allowed: true, scope: "session" } },
    { label: "No", response: { allowed: false } },
    // Only where the asker takes a reply (docs/feat/permission-reply.md).
    ...(req.reply
      ? [{ label: "No, let's talk about it", response: { allowed: false }, reply: true as const }]
      : []),
  ];
}

export interface PermissionController {
  /** The request currently awaiting a choice, or null. */
  readonly pending: PermissionRequest | null;
  /** The sub-agent that asks `pending`, or null (the session's own call). */
  readonly pendingAgent: PermissionAgent | null;
  /** The menu options for `pending` (empty when idle). */
  readonly choices: PermissionChoice[];
  /** Highlighted option index. */
  readonly selected: number;
  readonly setSelected: Dispatch<SetStateAction<number>>;
  /** Resolve the pending request with `response` and clear the prompt. */
  answer(response: PermissionResponse): void;
  /** Auto-accept mode: `"ask"` tools run without prompting. */
  readonly autoApprove: boolean;
  /** Toggle auto-accept; granting a prompt already on screen when turning on. */
  toggleAutoApprove(): void;
  /**
   * Turn auto-accept OFF in THIS TUI *and* in the shared feed — what a hop does
   * (D9: a move never inherits an approval). Turning it off from outside the
   * toggle needs this: `feed.set` alone publishes the flip for other terminals
   * and leaves this one's state (and status bar) saying "on".
   */
  clearAutoApprove(): void;
  /** The dialog's mode: the menu, or the reply field open (`permission-reply.ts`). */
  readonly mode: ReplyMode;
  /** The mode as of now (a ref: keys and pastes arriving between renders compose). */
  readMode(): ReplyMode;
  setMode(mode: ReplyMode): void;
  /**
   * When the dialog for `pending` was first DRAWN (`Date.now()`, null when no
   * request is up or it has not committed yet): the arming window's stamp
   * (docs/fix/quit-enter-ask.md). A ref read, not a render value — the window's
   * length is real time, not frames.
   */
  shownAt(): number | null;
  /**
   * Where a `workflow_approve`'s detail is scrolled to, as of NOW (a ref: the
   * key path composes scrolls inside one tick, docs/fix/workflow-approve-detail.md
   * D2). Reset with `shownAt`, so a new request always starts at the top.
   */
  approvalScroll(): ApprovalScroll;
  /** Write the scroll the key decided (`stepApprovalScroll`). */
  setApprovalScroll(scroll: ApprovalScroll): void;
}

/**
 * Auto-accept held outside this TUI (a detached run's session, shared by
 * every TUI on it, docs/fix/detach-live.md B3): its state at mount, a flip
 * from elsewhere (`onChange`), and this TUI's own flips (`set`).
 */
export interface AutoAcceptFeed {
  current(): boolean;
  set(on: boolean): void;
  /** Another TUI flipped it; returns the unsubscribe. */
  onChange(listener: (on: boolean) => void): () => void;
}

/**
 * A feed that can also report flips from ANOTHER DEVICE
 * (docs/feat/session-auto-accept.md D5): the routing feed binds to a shared
 * session's link, so a contrast between what this TUI last showed and what the
 * daemon says came from somewhere else. `lastBy()` names it when the daemon
 * did (display only: untrusted text, so a surface must sanitize it).
 */
export interface AutoAcceptSharedFeed extends AutoAcceptFeed {
  /** Who made the last change, when the daemon named one. */
  lastBy(): string | undefined;
  /**
   * Was the last change another DEVICE's? Only one of those earns a transcript
   * notice: the person who pressed Shift+Tab here saw the status bar change, and
   * reporting their own flip back to them as news would be noise.
   */
  remote(): boolean;
}

/**
 * Where a reply's text goes when it was not sent (docs/feat/permission-reply.md,
 * owner Q4 "a message is never lost silently"): the request closed with a
 * draft in the field, or a sent reply did not reach the agent. `App` puts it
 * back in the main input with `orphanNotice(cause)`.
 */
export type DraftBack = (text: string, cause: OrphanCause) => void;

/**
 * `ownsTurn`: read at each request — the current session's own-vs-foreign test
 * (`ownRequest`), or undefined when no session decides. Auto-accept answers
 * only a request of my own turn — or, on a trusted `serve` daemon, of the
 * session's own wake turn (the App supplies `autoAcceptTest`'s widest test, so
 * a `wake-…` ask is not another device's; docs/fix/autoaccept-wake-turns.md
 * A5). `feed`: auto-accept's state lives there (seeded at mount, so a request
 * held until mount is answered by it); absent, it starts off and stays this
 * TUI's.
 */
export function usePermissionBroker(
  permissions?: PermissionBroker,
  ownsTurn?: () => ((turnId: string) => boolean) | undefined,
  feed?: AutoAcceptFeed,
  onDraftBack?: DraftBack,
): PermissionController {
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [pendingAgent, setPendingAgent] = useState<PermissionAgent | null>(null);
  const [selected, setSelected] = useState(0);
  const [autoApprove, setAutoApprove] = useState(() => feed?.current() ?? false);
  const [mode, setModeState] = useState<ReplyMode>(MENU);
  const resolveRef = useRef<((r: PermissionResponse) => void) | null>(null);
  // Seeded before any effect: the broker's held requests reach the requester
  // installed below, and are answered by THIS value.
  const autoApproveRef = useRef<boolean | null>(null);
  if (autoApproveRef.current === null) {
    autoApproveRef.current = feed?.current() ?? false;
  }
  const pendingRef = useRef<PermissionRequest | null>(null);
  /** The request on screen is of my own turn (auto-accept may answer it). */
  const pendingOwnRef = useRef(true);
  const ownsTurnRef = useRef(ownsTurn);
  ownsTurnRef.current = ownsTurn;
  /** Mirrors `mode` for the callbacks (a withdrawal reads the draft at once). */
  const modeRef = useRef<ReplyMode>(MENU);
  /**
   * When the current request's dialog was first drawn, for the arming window
   * (docs/fix/quit-enter-ask.md): `null` until the commit that draws it.
   */
  const shownAtRef = useRef<number | null>(null);
  /**
   * The `workflow_approve` detail's scroll for the request on screen
   * (docs/fix/workflow-approve-detail.md D2): a ref, like `shownAt` — keys in one
   * tick compose, and the paint reads it each render. Reset with `shownAt`.
   */
  const approvalScrollRef = useRef<ApprovalScroll>(NO_APPROVAL_SCROLL);
  /** Bumped to repaint after a scroll key wrote only the ref. */
  const [, setApprovalScrollTick] = useState(0);
  const draftBackRef = useRef(onDraftBack);
  draftBackRef.current = onDraftBack;

  const setMode = useCallback((next: ReplyMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);
  const readMode = useCallback(() => modeRef.current, []);
  const shownAt = useCallback(() => shownAtRef.current, []);
  const approvalScroll = useCallback(() => approvalScrollRef.current, []);
  const setApprovalScroll = useCallback((next: ApprovalScroll) => {
    approvalScrollRef.current = next;
    setApprovalScrollTick((n) => n + 1);
  }, []);

  /** The request closed: an unsent draft goes back (`cause`), the mode resets. */
  const closeDraft = useCallback(
    (cause: OrphanCause) => {
      const draft = draftOf(modeRef.current);
      setMode(MENU);
      if (draft.trim() !== "") {
        draftBackRef.current?.(draft, cause);
      }
    },
    [setMode],
  );

  const answer = useCallback(
    (response: PermissionResponse) => {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      pendingRef.current = null;
      setPending(null);
      approvalScrollRef.current = NO_APPROVAL_SCROLL;
      const message = response.message;
      if (message !== undefined) {
        // Sent: the field's text IS the message. If it never reaches the
        // agent, the runtime hands it back (`onAnswerLost`).
        setMode(MENU);
        resolve?.({
          ...response,
          onAnswerLost: (cause) => draftBackRef.current?.(message, cause),
        });
        return;
      }
      closeDraft(response.dismissed ? "withdrawn" : "answered");
      resolve?.(response);
    },
    [closeDraft, setMode],
  );

  /** The one way auto-accept changes: this TUI's toggle and a flip from the feed. */
  const applyAuto = useCallback(
    (next: boolean) => {
      autoApproveRef.current = next;
      setAutoApprove(next);
      // If a request is on screen when auto-accept turns on, grant it immediately
      // — unless auto-accept may not answer it (a hooks trust request, another
      // device's turn). Its reply draft, if any, goes back (owner Q3): the
      // field of a request NOT granted stays open — still being answered.
      if (
        next &&
        resolveRef.current &&
        pendingRef.current &&
        autoApproves(pendingRef.current, pendingOwnRef.current)
      ) {
        closeDraft("approved");
        answer({ allowed: true, scope: "once" });
      }
    },
    [answer, closeDraft],
  );

  const feedRef = useRef(feed);
  feedRef.current = feed;
  const toggleAutoApprove = useCallback(() => {
    const next = !autoApproveRef.current;
    applyAuto(next);
    feedRef.current?.set(next);
  }, [applyAuto]);
  /**
   * D9's reset (a hop moved the session): this TUI's state AND the shared feed.
   * `applyAuto` is the half `feed.set` cannot do — the flip from elsewhere
   * arrives only through `onChange`, which a no-op feed never calls.
   */
  const clearAutoApprove = useCallback(() => {
    applyAuto(false);
    feedRef.current?.set(false);
  }, [applyAuto]);

  useEffect(() => {
    const off = feed?.onChange(applyAuto);
    // A flip between the render's read and this subscription has no later event.
    if (feed && feed.current() !== autoApproveRef.current) {
      applyAuto(feed.current());
    }
    return off;
  }, [feed, applyAuto]);

  useEffect(() => {
    if (!permissions) {
      return;
    }
    permissions.setRequester((req, options) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return Promise.resolve(DISMISSED);
      }
      const own = ownRequest(options?.turnId, ownsTurnRef.current?.());
      // Auto-accept mode: grant without prompting (not remembered — scope once).
      // A HOP answer also carries `auto: true`, saying no human was asked, so the
      // outcome line can say `(auto-accepted)` (docs/feat/session-hop-ux OD4) —
      // and ONLY a hop: every other tool's answer keeps its long-standing shape
      // (the tests, and the runtimes, compare it whole). Process-internal either
      // way: the router sends only `optionId`/`message`.
      if (autoApproveRef.current && autoApproves(req, own)) {
        return Promise.resolve({
          allowed: true,
          scope: "once",
          ...(req.kind === "session_hop" ? { auto: true as const } : {}),
        });
      }
      return new Promise<PermissionResponse>((resolve) => {
        const onAbort = (): void => {
          // Withdrawn: close the dialog only if it is still this request's
          // (its unsent reply draft goes back to the input).
          if (resolveRef.current === settle) {
            resolveRef.current = null;
            pendingRef.current = null;
            setPending(null);
            approvalScrollRef.current = NO_APPROVAL_SCROLL;
            closeDraft("withdrawn");
          }
          resolve(DISMISSED);
        };
        const settle = (response: PermissionResponse): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        resolveRef.current = settle;
        pendingRef.current = req;
        pendingOwnRef.current = own;
        // A NEW request: the window starts when its dialog commits (the effect
        // below), never when the request arrived — a slow render must not eat it.
        shownAtRef.current = null;
        approvalScrollRef.current = NO_APPROVAL_SCROLL;
        setSelected(0);
        setMode(MENU);
        setPendingAgent(options?.agent ?? null);
        setPending(req);
      });
    });
    return () => {
      // Unmounting is not a decision: resolve a dangling request DISMISSED.
      // (A reply draft is lost with the TUI: the session view ends.)
      resolveRef.current?.(DISMISSED);
      resolveRef.current = null;
      permissions.reset();
    };
  }, [permissions, closeDraft, setMode]);

  /**
   * Stamp the arming window at the commit that DRAWS the dialog (post-render, so
   * a slow frame does not shorten the window). Keyed on `pending`: each request
   * restamps, so a second ask opening right after the first was answered is
   * guarded too.
   */
  useEffect(() => {
    if (pending !== null) {
      shownAtRef.current = Date.now();
    }
  }, [pending]);

  const choices = pending ? buildPermissionChoices(pending) : [];
  return {
    pending,
    pendingAgent: pending ? pendingAgent : null,
    choices,
    selected,
    setSelected,
    answer,
    autoApprove,
    toggleAutoApprove,
    clearAutoApprove,
    mode,
    readMode,
    setMode,
    shownAt,
    approvalScroll,
    setApprovalScroll,
  };
}
