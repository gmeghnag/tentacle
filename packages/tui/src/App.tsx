import { type Agent, type AgentEvent, Session } from "@tentacle/agent";
import type { JobController, PermissionBroker } from "@tentacle/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard, readClipboard } from "./clipboard.ts";
import {
  helpText,
  isSessionMutating,
  lastAssistantText,
  lastUserText,
  matchCommands,
  transcriptToMarkdown,
} from "./commands.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { LineInput } from "./components/LineInput.tsx";
import { PermissionPrompt, permissionPromptRows } from "./components/PermissionPrompt.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Thinking } from "./components/Thinking.tsx";
import { useLineEditor, usePaintScheduler } from "./hooks.ts";
import { type MouseReport, isMousePrefix, splitMouseReports } from "./mouse.ts";
import { stepPaste, stripPasteMarkers } from "./paste.ts";
import { usePermissionBroker } from "./permission-ui.ts";
import { layoutTranscript, sliceLaid, stripAnsi } from "./render-lines.ts";
import { applyScroll, clampOffset, isScrolledUp, windowFor } from "./scroll.ts";
import { type Selection, extractSelection, isNonEmpty, rowSelectionRange } from "./selection.ts";
import {
  type DisplayItem,
  type DisplayState,
  appendBackgroundExit,
  applyEvent,
  backgroundExitNotice,
  failTurn,
  initialState,
  startContinuation,
  startTurn,
} from "./state.ts";

/**
 * The conversation the App drives. Both the local agent `Session` and the
 * remote `RemoteSession` satisfy it, so the TUI renders a local or remote
 * session identically.
 */
export interface SessionController {
  send(prompt: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** Compact the conversation (summarise + replace history); optional. */
  compact?(signal?: AbortSignal): Promise<{ before: number; after: number }>;
  /** Queue a message mid-turn (steering); optional (local sessions only). */
  enqueue?(text: string): void;
}

export interface AppProps {
  /** A local agent; used to build sessions unless `createSession` is given. */
  readonly agent?: Agent;
  /** Factory for a session (local or remote). Overrides `agent` when present. */
  readonly createSession?: () => SessionController;
  readonly model: string;
  readonly cwd: string;
  readonly contextWindow?: number;
  /** Broker whose interactive requester this app installs for tool approvals. */
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
  /**
   * Auto-wake: when a background job exits while idle, start a continuation turn
   * so the agent reacts to it without a user prompt. Default: true.
   */
  readonly autoWakeOnJobExit?: boolean;
  /** Injectable for tests (defaults to the OS clipboard + Bun.write). */
  readonly clipboard?: (text: string) => Promise<void>;
  /** Injectable for tests (defaults to the OS clipboard read). */
  readonly paste?: () => Promise<string>;
  readonly saveFile?: (path: string, content: string) => Promise<void>;
  /** Transcript to seed on start (a resumed session); replaces the welcome line. */
  readonly initialItems?: readonly DisplayItem[];
}

// Rows reserved below the transcript viewport: a blank spacer, the input/thinking
// line, the status bar, plus one slack row so the frame never overflows the
// terminal (which, on the alternate screen, has no scrollback to absorb it).
const RESERVED_ROWS = 4;
const FRAME_MS = 33; // ~30fps streaming throttle
// If a bracketed paste's closing marker never arrives, recover this long after
// the last paste chunk: flush what we captured and leave paste mode, so input
// is never frozen. Real pastes stream their chunks within one pty read window,
// far faster than this, so a legitimate paste never trips it.
const PASTE_TIMEOUT_MS = 250;
// Max content lines the input box shows before it windows around the cursor.
const MAX_INPUT_ROWS = 10;

const WELCOME = "Tentacle ready. Type a task, or `/help` for commands.";

// Lines scrolled per mouse-wheel notch.
const WHEEL_LINES = 3;
// Any control byte — such chars are never inserted into the input buffer by the
// single-keystroke path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detects control bytes
const CONTROL_RE = /[\x00-\x1f\x7f]/;
// Pasted text keeps newlines and tabs (the prompt is multi-line); CRLF/CR are
// normalised to LF and every other control byte is stripped. `\t` (\u0009) and
// `\n` (\u000a) are intentionally outside this class.
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control bytes from pastes
const PASTE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const sanitizePasted = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(PASTE_CONTROL_RE, "");
// Clipboard reads are trimmed: copied terminal output often has a trailing
// newline that would otherwise land as a stray blank line.
const flattenPasted = (text: string): string => sanitizePasted(text).trim();

const INPUT_PLACEHOLDER = "Type a task or /command";

export function App({
  agent,
  createSession,
  model,
  cwd,
  contextWindow = 128000,
  permissions,
  jobs,
  autoWakeOnJobExit = true,
  clipboard = copyToClipboard,
  paste = readClipboard,
  saveFile = (path, content) => Bun.write(path, content).then(() => undefined),
  initialItems,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [expandAll, setExpandAll] = useState(false);
  const field = useLineEditor();
  const [commandIndex, setCommandIndex] = useState(0);
  // Messages the user queued while a turn is running (steering), shown above
  // the input until the agent injects them (a `steer` event clears them FIFO).
  const [queued, setQueued] = useState<readonly string[]>([]);
  // Interactive tool-approval dialog + auto-accept (Shift+Tab), all self-contained.
  const permission = usePermissionBroker(permissions);
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  // Partial SGR mouse report held across data chunks (see the mouse handling
  // in useInput): some terminals/ptys split a report in half.
  const pendingMouseRef = useRef("");
  const pendingMouseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Carry-over buffer while a bracketed paste spans multiple input chunks.
  const pasteBufRef = useRef<string | null>(null);
  // Recovery timer: fires if a paste's closing marker never arrives (see below).
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef<DisplayState>({
    ...initialState,
    // A resumed session seeds its prior transcript; otherwise the welcome line.
    items:
      initialItems && initialItems.length > 0
        ? [...initialItems]
        : [{ kind: "assistant", text: WELCOME }],
  });
  const sessionRef = useRef<SessionController | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserRef = useRef<string | null>(null);
  const prevRowsRef = useRef(0);
  // Autonomous wake on a background-job exit: a job that finishes while a turn
  // is running sets this, so the wake fires once the current turn settles (the
  // running turn won't see the exit — the agent flushes exits at turn START).
  const wakePendingRef = useRef(false);
  // Latest `run`, so the jobs subscription and the post-turn check can start a
  // continuation turn without re-subscribing or a circular callback dependency.
  const runRef = useRef<((text: string, opts?: { continuation?: boolean }) => void) | null>(null);
  // Build a session from the factory, or from the local agent by default.
  const makeSession = useCallback((): SessionController => {
    if (createSession) {
      return createSession();
    }
    if (!agent) {
      throw new Error("App requires either `agent` or `createSession`");
    }
    return new Session(agent);
  }, [createSession, agent]);
  if (sessionRef.current === null) {
    sessionRef.current = makeSession();
  }

  // --- throttled rendering -------------------------------------------------
  const { scheduleFlush, flushNow } = usePaintScheduler(FRAME_MS);

  // --- live background-job exits -------------------------------------------
  // Surface a finished background job the instant it exits, even while idle.
  // The agent also emits a `background_exit` event at the next turn; the shared
  // jobId dedupes (appendBackgroundExit) so the notice shows exactly once.
  useEffect(() => {
    if (!jobs) {
      return;
    }
    return jobs.onExit((job) => {
      stateRef.current = appendBackgroundExit(
        stateRef.current,
        backgroundExitNotice(job.id, job.command, job.status, job.exitCode),
      );
      setScrollOffset(0);
      flushNow();
      // Autonomous wake: react to the exit without a user prompt. If a turn is
      // running, defer to its post-turn check (it flushes exits at the next
      // start); if idle, start a continuation turn now. Multiple exits coalesce
      // — the agent drains all pending exits at the next turn's start.
      if (!autoWakeOnJobExit) {
        return;
      }
      if (stateRef.current.running) {
        wakePendingRef.current = true;
      } else {
        runRef.current?.("", { continuation: true });
      }
    });
  }, [jobs, flushNow, autoWakeOnJobExit]);

  // --- terminal resize -----------------------------------------------------
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") {
      return;
    }
    const onResize = (): void =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => void stdout.off?.("resize", onResize);
  }, [stdout]);

  // Reset the palette selection whenever the typed text changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on field.value
  useEffect(() => setCommandIndex(0), [field.value]);

  // --- derived layout (recomputed each render) -----------------------------
  const st = stateRef.current;
  const columns = Math.max(20, size.columns);
  const termRows = Math.max(8, size.rows);
  // Slash-command autocomplete: open only while idle and typing a `/command`.
  const paletteCommands = !permission.pending && !st.running ? matchCommands(field.value) : [];
  const paletteOpen = paletteCommands.length > 0;
  const commandSel = paletteOpen
    ? Math.min(Math.max(0, commandIndex), paletteCommands.length - 1)
    : 0;
  // The input box grows with a multi-line prompt (paste / `\`-continuation),
  // capped at MAX_INPUT_ROWS content lines; +2 for its top/bottom borders.
  const inputContentLines = Math.min(
    field.value === "" ? 1 : field.value.split("\n").length,
    MAX_INPUT_ROWS,
  );
  const inputBoxRows = inputContentLines + 2;
  // Rows the bottom area occupies: the permission dialog; or, while running, the
  // thinking line (1) + the queued-message lines + the input box; or, when idle,
  // the input box plus any open palette rows.
  const activeRows = permission.pending
    ? permissionPromptRows(permission.choices.length)
    : st.running
      ? 1 + queued.length + inputBoxRows
      : inputBoxRows + paletteCommands.length;
  const viewport = Math.max(3, termRows - (RESERVED_ROWS - 1 + activeRows));
  // Positional layout only (O(items) cache lookups, no full array): take the
  // row `total` for scroll maths and materialise just the visible window. The
  // whole transcript is assembled on demand (sliceLaid 0..total) only where a
  // full buffer is genuinely needed — a text selection on mouse-release.
  const layout = layoutTranscript(st.items, { expandAll, width: columns });
  const total = layout.total;
  const win = windowFor(total, viewport, scrollOffset);
  const visible = sliceLaid(layout.laid, win.start, win.end);
  const scrolledUp = isScrolledUp(scrollOffset, total, viewport);
  const hiddenAbove = win.start;

  // Keep the read position anchored when new rows arrive while scrolled up —
  // or while a text selection is in progress, so the content the user is
  // selecting (e.g. during a running turn) does not scroll out from under them.
  useEffect(() => {
    const prev = prevRowsRef.current;
    if (prev !== total) {
      const selecting = selectionRef.current !== null;
      if (total > prev && (scrollOffset > 0 || selecting)) {
        setScrollOffset((o) => clampOffset(o + (total - prev), total, viewport));
      }
      prevRowsRef.current = total;
    }
  }, [total, viewport, scrollOffset]);

  const pushNotice = useCallback(
    (text: string) => {
      stateRef.current = {
        ...stateRef.current,
        items: [...stateRef.current.items, { kind: "assistant", text }],
      };
      setScrollOffset(0);
      flushNow();
    },
    [flushNow],
  );

  const run = useCallback(
    async (text: string, opts?: { continuation?: boolean }) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      // A continuation turn has no user input (an autonomous wake reacting to a
      // background-job exit): no user bubble, and an empty prompt to `send` so
      // the session runs over existing history without appending a user message.
      const continuation = opts?.continuation ?? false;
      if (!continuation) {
        lastUserRef.current = text;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      stateRef.current = continuation
        ? startContinuation(stateRef.current, Date.now())
        : startTurn(stateRef.current, text, Date.now());
      setScrollOffset(0);
      flushNow();
      try {
        for await (const event of session.send(continuation ? "" : text, controller.signal)) {
          stateRef.current = applyEvent(stateRef.current, event, Date.now());
          // A queued message was just injected — drop it from the pending list.
          if (event.type === "steer") {
            setQueued((q) => q.slice(1));
          }
          if (event.type === "text") {
            scheduleFlush();
          } else {
            flushNow();
          }
        }
      } catch (error) {
        stateRef.current = failTurn(stateRef.current, String(error), Date.now());
      } finally {
        abortRef.current = null;
        setQueued([]); // the turn is over; nothing stays queued
        flushNow();
        // A background job that exited mid-turn could not be seen by the turn
        // that was running (the agent flushes exits at turn start). Now idle,
        // fire a continuation so the agent reacts to it.
        if (wakePendingRef.current) {
          wakePendingRef.current = false;
          setTimeout(() => {
            if (!stateRef.current.running) {
              runRef.current?.("", { continuation: true });
            }
          }, 0);
        }
      }
    },
    [flushNow, scheduleFlush],
  );
  runRef.current = run;

  const handleCommand = useCallback(
    (raw: string): void => {
      const cmd = raw.split(/\s+/)[0];
      // Guard turn-starting / session-swapping commands while a turn runs: they
      // would corrupt the session (concurrent send) or cancel-handle state.
      if (cmd && isSessionMutating(cmd) && stateRef.current.running) {
        pushNotice(`_Can't run ${cmd} while a turn is running — stop it first (esc)._`);
        return;
      }
      switch (cmd) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          pushNotice(helpText());
          return;
        case "/clear":
          sessionRef.current = makeSession();
          stateRef.current = initialState;
          setExpandAll(false);
          setScrollOffset(0);
          flushNow();
          return;
        case "/compact": {
          const session = sessionRef.current;
          if (!session?.compact) {
            pushNotice("_Compaction isn't available for this session._");
            return;
          }
          if (stateRef.current.running) {
            pushNotice("_Can't compact while a turn is running._");
            return;
          }
          pushNotice("_Compacting the conversation…_");
          void session.compact().then(
            (r) => pushNotice(`_Context compacted — ${r.before} → ${r.after} messages._`),
            (e) => pushNotice(`_Compact failed: ${String(e)}_`),
          );
          return;
        }
        case "/model":
          pushNotice(`Model: \`${model}\``);
          return;
        case "/tokens": {
          const t = stateRef.current.sessionTokens;
          pushNotice(
            `Tokens — prompt ${t.prompt}, completion ${t.completion}, total ${t.prompt + t.completion}`,
          );
          return;
        }
        case "/retry": {
          const last = lastUserRef.current ?? lastUserText(stateRef.current.items);
          if (last) {
            void run(last);
          } else {
            pushNotice("_Nothing to retry yet._");
          }
          return;
        }
        case "/copy": {
          const text = lastAssistantText(stateRef.current.items);
          if (!text) {
            pushNotice("_No assistant reply to copy._");
            return;
          }
          void clipboard(text).then(
            () => pushNotice("_Copied last reply to the clipboard._"),
            () => pushNotice("_Clipboard unavailable._"),
          );
          return;
        }
        case "/save": {
          const path = `${cwd}/tentacle-transcript-${Date.now()}.md`;
          const md = transcriptToMarkdown(stateRef.current.items);
          void saveFile(path, md).then(
            () => pushNotice(`_Saved transcript to ${path}_`),
            (e) => pushNotice(`_Save failed: ${String(e)}_`),
          );
          return;
        }
        default:
          pushNotice(`_Unknown command: ${cmd}. Try /help._`);
      }
    },
    [makeSession, clipboard, cwd, exit, flushNow, model, pushNotice, run, saveFile],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      field.reset();
      if (text === "") {
        return;
      }
      if (text.startsWith("/")) {
        handleCommand(text);
        return;
      }
      // Mid-turn: queue the task (steering) so it is handed to the agent before
      // its next round, instead of starting a new turn. Call through the session
      // (not a detached reference) so `this` is preserved.
      if (stateRef.current.running) {
        if (sessionRef.current?.enqueue) {
          sessionRef.current.enqueue(text);
          setQueued((q) => [...q, text]);
        }
        return;
      }
      void run(text);
    },
    [handleCommand, run, field.reset],
  );

  // All line editing lives in `useLineEditor` (pure `editor.ts` ops), so no
  // control key — Ctrl+O, mouse reports, escapes — can ever be echoed into the
  // buffer, independent of input-handler ordering.

  // --- mouse text selection → clipboard ------------------------------------
  const setSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);

  /** Copy the current selection's text, then clear it. `rows` is the colour buffer. */
  const finishSelection = useCallback(
    (rows: readonly string[]) => {
      const sel = selectionRef.current;
      setSelection(null);
      if (!sel || !isNonEmpty(sel)) {
        return;
      }
      const text = extractSelection(rows.map(stripAnsi), sel);
      if (text.trim() === "") {
        return;
      }
      // Copy silently on success: the on-screen notice made the viewport jump
      // (pushNotice resets scrollOffset to the tail). Surface failures only.
      void clipboard(text).catch(() => pushNotice("_Clipboard unavailable._"));
    },
    [clipboard, pushNotice, setSelection],
  );

  // --- fragmented SGR mouse reports ----------------------------------------
  // Hold a partial report until the next data chunk completes it. The timer
  // releases the hold when nothing follows — i.e. the held "[" was really a
  // typed bracket (the two halves of a real report arrive within the same pty
  // read window, so 100 ms is far longer than any split).
  const clearMouseHold = useCallback(() => {
    if (pendingMouseTimerRef.current) {
      clearTimeout(pendingMouseTimerRef.current);
      pendingMouseTimerRef.current = null;
    }
  }, []);
  const holdMouse = useCallback(
    (partial: string) => {
      pendingMouseRef.current = partial;
      if (pendingMouseTimerRef.current) {
        clearTimeout(pendingMouseTimerRef.current);
      }
      pendingMouseTimerRef.current = setTimeout(() => {
        pendingMouseTimerRef.current = null;
        const p = pendingMouseRef.current;
        pendingMouseRef.current = "";
        if (p === "[") {
          field.insert(p); // it was a typed bracket after all
        }
        // A longer p was a truncated report: drop it.
      }, 100);
    },
    [field.insert],
  );
  useEffect(() => {
    return () => clearMouseHold();
  }, [clearMouseHold]);

  // --- bracketed-paste freeze recovery -------------------------------------
  const clearPasteTimeout = useCallback(() => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
  }, []);
  const armPasteTimeout = useCallback(() => {
    clearPasteTimeout();
    pasteTimerRef.current = setTimeout(() => {
      pasteTimerRef.current = null;
      const buf = pasteBufRef.current;
      pasteBufRef.current = null;
      if (buf) {
        const clean = sanitizePasted(buf);
        if (clean) {
          field.insert(clean);
        }
      }
    }, PASTE_TIMEOUT_MS);
  }, [clearPasteTimeout, field.insert]);
  useEffect(() => {
    return () => clearPasteTimeout();
  }, [clearPasteTimeout]);

  useInput((char, key) => {
    // Shift+Tab toggles auto-accept in any state (idle, running, or with a
    // prompt showing). Checked first so it never reaches the palette's Tab.
    if (key.tab && key.shift) {
      permission.toggleAutoApprove();
      return;
    }
    // While the permission dialog is up, keys drive it (nothing else). Arrows
    // move the selection, enter confirms it; y/a/n are direct shortcuts.
    if (permission.pending) {
      const choices = permission.choices;
      const n = choices.length;
      if (key.ctrl && char === "c") {
        permission.answer({ allowed: false });
        abortRef.current?.abort();
      } else if (key.upArrow) {
        permission.setSelected((s) => (s - 1 + n) % n);
      } else if (key.downArrow) {
        permission.setSelected((s) => (s + 1) % n);
      } else if (key.return) {
        permission.answer(choices[permission.selected]?.response ?? { allowed: false });
      } else if (char === "y") {
        permission.answer({ allowed: true, scope: "once" });
      } else if (char === "a") {
        permission.answer(choices[1]?.response ?? { allowed: true, scope: "session" });
      } else if (char === "n" || key.escape) {
        permission.answer({ allowed: false });
      }
      return;
    }
    if (key.ctrl && char === "c") {
      if (stateRef.current.running && abortRef.current) {
        abortRef.current.abort();
      } else {
        exit();
      }
      return;
    }
    // Bracketed paste: capture pasted text (markers stripped) before the
    // escape-abort below, since a paste's leading ESC can look like Escape. Runs
    // whether idle or mid-turn, so text can be pasted into a queued task too.
    const pasteStep = stepPaste(pasteBufRef.current, char);
    if (pasteStep.consumed) {
      pasteBufRef.current = pasteStep.buffer;
      // Still inside a paste → arm the recovery timer; finished → disarm it.
      if (pasteStep.buffer !== null) {
        armPasteTimeout();
      } else {
        clearPasteTimeout();
      }
      if (pasteStep.text !== undefined) {
        const clean = sanitizePasted(pasteStep.text);
        if (clean) {
          field.insert(clean);
        }
      }
      return;
    }
    if (key.escape && stateRef.current.running && abortRef.current) {
      abortRef.current.abort();
      return;
    }
    if (key.ctrl && char === "o") {
      setExpandAll((v) => !v);
      return;
    }
    // Slash-command palette: when open, arrows move the selection, Tab completes
    // the name, Enter runs the highlighted command, Esc dismisses it. These take
    // priority over scrolling/line-editing so the menu is drivable.
    if (paletteOpen) {
      const n = paletteCommands.length;
      if (key.upArrow) {
        setCommandIndex((i) => (Math.min(i, n - 1) - 1 + n) % n);
        return;
      }
      if (key.downArrow) {
        setCommandIndex((i) => (Math.min(i, n - 1) + 1) % n);
        return;
      }
      if (key.tab) {
        const name = paletteCommands[commandSel]?.name;
        if (name) {
          field.set(name);
        }
        return;
      }
      if (key.return) {
        const name = paletteCommands[commandSel]?.name;
        if (name) {
          field.reset();
          handleCommand(name);
        }
        return;
      }
      if (key.escape) {
        field.reset();
        return;
      }
    }
    // Mouse (SGR 1006). Ink strips the leading ESC and hands us the report(s)
    // as `char`. A fast wheel or drag coalesces several reports into one chunk,
    // and some terminals/ptys split one report across two chunks (the first
    // half then arriving as a bare "[", indistinguishable from a typed
    // bracket). So a chunk may carry any number of complete reports plus, at
    // the end, a half-delivered one. We dispatch every complete report and hold
    // any trailing partial, so no report byte ever leaks into the input.
    const dispatchMouse = (r: MouseReport): void => {
      // Wheel notches (64=up, 65=down).
      if (r.btn & 64) {
        const dir = r.btn & 1 ? -WHEEL_LINES : WHEEL_LINES;
        setScrollOffset((o) => clampOffset(o + dir, total, viewport));
        return;
      }
      // Left button: release copies the selection, press/drag starts/extends it.
      if (!r.press) {
        // Selection can span rows scrolled out of view, so assemble the whole
        // buffer here — only on release, never on the per-frame render path.
        finishSelection(sliceLaid(layout.laid, 0, total));
        return;
      }
      const visibleIndex = r.y - 1;
      if ((r.btn & 3) === 0 && visibleIndex >= 0 && visibleIndex < visible.length) {
        const row = win.start + visibleIndex;
        const col = Math.max(0, r.x - 1);
        const point = { row, col };
        const dragging = (r.btn & 32) !== 0;
        setSelection(
          dragging && selectionRef.current
            ? { anchor: selectionRef.current.anchor, head: point }
            : { anchor: point, head: point },
        );
      }
    };

    // Prepend any partial report held from the previous chunk.
    const held = pendingMouseRef.current;
    if (held) {
      pendingMouseRef.current = "";
      clearMouseHold();
    }
    const data = held + char;
    const { reports, rest } = splitMouseReports(data);
    if (reports.length > 0) {
      for (const r of reports) {
        dispatchMouse(r);
      }
      if (isMousePrefix(rest)) {
        holdMouse(rest); // a trailing, half-delivered report
      }
      return;
    }
    // No complete report. If the chunk is still a growable report prefix (and
    // this event is not a real keypress), keep holding it for the next chunk.
    const plainKey =
      !key.return &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.pageUp &&
      !key.pageDown &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.backspace &&
      !key.delete;
    if (isMousePrefix(data) && plainKey) {
      holdMouse(data);
      return;
    }
    // Not a report or a continuable prefix: a held bare "[" was a typed bracket,
    // so restore it (a longer truncated hold is dropped). It precedes whatever
    // this event's own key does below.
    const restored = held === "[" ? "[" : "";
    if (restored) {
      if (key.return) {
        // Same-event submit: `field` is still the pre-insert closure value, so
        // append the restored bracket here instead of inserting it.
        submit(field.value + restored);
        return;
      }
      field.insert(restored);
    }

    // Scrolling works whether or not a turn is running.
    if (key.upArrow) {
      setScrollOffset((o) => applyScroll(o, "lineUp", total, viewport));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((o) => applyScroll(o, "lineDown", total, viewport));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((o) => applyScroll(o, "pageUp", total, viewport));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => applyScroll(o, "pageDown", total, viewport));
      return;
    }

    // Line editing works while idle AND while a turn runs (so a task can be
    // typed and queued for steering); Enter routes to `submit`, which either
    // runs or enqueues based on the running state.
    // Ctrl+V: read the OS clipboard and insert at the cursor. (The terminal's
    // own paste — Cmd+V on macOS — never reaches us as a key; it arrives as a
    // text chunk, handled by the insert branch below.)
    if (key.ctrl && char === "v") {
      void paste().then(
        (text) => {
          const clean = flattenPasted(text);
          if (clean) {
            field.insert(clean);
          }
        },
        () => pushNotice("_Clipboard unavailable._"),
      );
      return;
    }
    if (key.return) {
      // A `\` immediately before the cursor is a line continuation: replace it
      // with a newline instead of submitting (terminal-independent multi-line
      // entry; Shift/Alt+Enter aren't reliably distinguishable in a TTY).
      if (field.value.slice(0, field.cursor).endsWith("\\")) {
        field.deleteBack();
        field.insert("\n");
        return;
      }
      submit(field.value);
      return;
    }
    if (key.leftArrow) {
      field.moveCursor(-1);
      return;
    }
    if (key.rightArrow) {
      field.moveCursor(1);
      return;
    }
    if (key.backspace || key.delete) {
      field.deleteBack();
      return;
    }
    // Insert only genuine printable text; never a control/modified key. A
    // multi-char chunk (the terminal's native paste) is flattened so an
    // embedded newline neither breaks the line nor submits it.
    if (char && !key.ctrl && !key.meta && !key.escape && !key.tab) {
      const clean =
        char.length === 1
          ? CONTROL_RE.test(char)
            ? ""
            : char
          : sanitizePasted(stripPasteMarkers(char));
      if (clean) {
        field.insert(clean);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={viewport}>
        {selection ? (
          visible.map((row, i) => {
            const absRow = win.start + i;
            const plain = stripAnsi(row);
            // Ink measures an empty <Text> as 0x0, so blank separator rows
            // would collapse and shift the transcript up. A single space keeps
            // every row at height 1 (the grid trimEnd()s it back to "").
            const display = row === "" ? " " : row;
            const line = row === "" ? " " : plain;
            const range = rowSelectionRange(selection, absRow, plain.length);
            if (!range) {
              return <Text key={i}>{display}</Text>;
            }
            const [c0, c1] = range;
            return (
              <Text key={i}>
                {line.slice(0, c0)}
                <Text inverse>{line.slice(c0, c1)}</Text>
                {line.slice(c1)}
              </Text>
            );
          })
        ) : (
          <Text>{visible.join("\n")}</Text>
        )}
      </Box>

      <Box marginTop={1}>
        {permission.pending ? (
          <PermissionPrompt
            req={permission.pending}
            options={permission.choices.map((c) => c.label)}
            selected={permission.selected}
            cwd={cwd}
            columns={columns}
          />
        ) : st.running ? (
          <Box flexDirection="column" width={columns}>
            <Thinking
              since={
                st.reasoning && st.reasoningStartedAt !== null
                  ? st.reasoningStartedAt
                  : (st.turnStartedAt ?? Date.now())
              }
              label={st.reasoning ? "thinking…" : "working…"}
            />
            {queued.map((q, i) => (
              <Text key={`q-${i}-${q}`} dimColor wrap="truncate-end">
                ⏳ {q}
              </Text>
            ))}
            <Box
              width={columns}
              borderStyle="round"
              borderColor="gray"
              borderLeft={false}
              borderRight={false}
            >
              <LineInput
                value={field.value}
                cursor={field.cursor}
                placeholder="Queue a task…"
                maxRows={MAX_INPUT_ROWS}
              />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" width={columns}>
            {paletteOpen ? (
              <CommandPalette commands={paletteCommands} selected={commandSel} columns={columns} />
            ) : null}
            <Box
              width={columns}
              borderStyle="round"
              borderColor="gray"
              borderLeft={false}
              borderRight={false}
            >
              <LineInput
                value={field.value}
                cursor={field.cursor}
                placeholder={INPUT_PLACEHOLDER}
                maxRows={MAX_INPUT_ROWS}
              />
            </Box>
          </Box>
        )}
      </Box>

      <StatusBar
        model={model}
        cwd={cwd}
        tokens={st.sessionTokens}
        contextTokens={st.lastTurnTokens?.prompt ?? 0}
        contextWindow={contextWindow}
        columns={columns}
        scrolledUp={scrolledUp}
        hiddenAbove={hiddenAbove}
        expandAll={expandAll}
        autoApprove={permission.autoApprove}
      />
    </Box>
  );
}
