import type { Agent } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import { render } from "ink";
import {
  App,
  type AutoAcceptFeed,
  type AutoAcceptSharedFeed,
  type HopFeed,
  type NoticeFeed,
  type RunQuit,
  type SessionController,
  type SessionDirectory,
  type TargetFeed,
} from "./App.tsx";
import type { ChartGlyphs } from "./chart-lines.ts";
import { lineDiffEnabled, lineDiffStdout } from "./line-diff.ts";
import type { LinkFeed } from "./link-status.ts";
import type { McpServerView } from "./mcp-panel.ts";
import { createArtifactOpener, createLinkOpener } from "./os-open.ts";
import { messagesToItems } from "./resume.ts";
import { synchronizedStdout } from "./sync-output.ts";
import type { TargetBadge } from "./target-view.ts";
import { lateGuard, readThemeSetting } from "./terminal-background-probe.ts";
import {
  ENTER_FULLSCREEN,
  LEAVE_FULLSCREEN,
  type ProcessLike,
  installTerminalRestore,
  restoreTerminalOnExit,
} from "./terminal.ts";
import { type ThemeSetting, themeProbeWasLate } from "./theme.ts";
import type { VoiceConfig } from "./voice-session.ts";

export interface TuiOptions {
  readonly model: string;
  /**
   * The name to PAINT for the model, when it is not `model` itself: a `connect`
   * session's daemon runs its own model, and the TUI learns it at `initialize`
   * (docs/fix/connect-model-error-drops-connection.md round 2). `model` stays
   * the semantic value (`"remote"` still means "the daemon's"), which the error
   * hint and every other decision read.
   */
  readonly modelLabel?: string;
  readonly cwd: string;
  /**
   * This tentacle's release version, for the startup header's first line
   * (docs/feat/tui-mascot.md D5). Absent (a test, an unwired host) → `tentacle`
   * alone.
   */
  readonly version?: string;
  readonly contextWindow?: number;
  /** In a container/pod: the status bar's badge (`engine-runtime`'s laptop-side facts). */
  readonly target?: TargetBadge;
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
  /** Auto-wake on a background-job exit (default true in the App). */
  readonly autoWakeOnJobExit?: boolean;
  /** `subagents.twoWay`: a child's message may wake this TUI (docs/feat/agent-message-two-way.md). */
  readonly subagentsTwoWay?: boolean;
  /** A detached run's relay handed over a job's exit no turn has flushed. */
  readonly wakePending?: boolean;
  /** The wake was HANDED OVER by a relay (it owns it): a refused continuation is retried once. wakePending alone (the open reported unflushed exits) is never retried: another TUI may serve it. */
  readonly wakeHanded?: boolean;
  /** Session factory (e.g. a remote session); overrides the local `agent`. */
  readonly createSession?: () => SessionController;
  /** Prior conversation to show on start (a resumed session's history). */
  readonly resumeMessages?: readonly ChatMessage[];
  /** Host notices shown live in the transcript (e.g. a failed session save). */
  readonly notices?: NoticeFeed;
  /** The runtime's link status, shown in the StatusBar while it is not up. */
  readonly link?: LinkFeed;
  /** The daemon's MCP servers, probed live (`/mcp`). */
  readonly mcpStatus?: () => Promise<readonly McpServerView[]>;
  /** The daemon runs in a pod (`runEngineTui` only): spilled output is "saved in the pod". */
  readonly daemonInPod?: boolean;
  /** Quitting only detaches (`connect`): `/exit` leaves at once, even mid-turn. */
  readonly detachOnQuit?: boolean;
  /** The daemon's sessions for `/sessions` (`connect` only). */
  readonly sessions?: SessionDirectory;
  /**
   * Voice dictation settings (docs/feat/voice-dictation.md). Absent: the TUI's
   * own defaults (`VOICE_DEFAULTS`) — OFF, Ctrl+R, no auto-stop.
   */
  readonly voice?: VoiceConfig;
  /**
   * Where the helper's log and `<configDir>/voice/bin` live. The CLI passes its
   * config dir; absent, no log is opened and only the binary's sibling is tried.
   */
  readonly voiceConfigDir?: string;
  /** A detached run's TUI (`attach <name>`): `/quit` closes the session for all. */
  readonly runQuit?: RunQuit;
  /** The session's auto-accept feed: a detached run's shared file, or the routing feed (docs/feat/session-auto-accept.md D5). */
  readonly autoAccept?: AutoAcceptFeed;
  /**
   * The session's shared auto-accept, when the feed routes to one (the worker,
   * `connect`): a flip from ANOTHER device adds one transcript notice naming
   * it (docs/feat/session-auto-accept.md D5). Absent → the feed has no remote
   * flips to report.
   */
  readonly autoAcceptShared?: AutoAcceptSharedFeed;
  /** `/move` (docs/feat/session-hop.md D3): present only on a hop-capable origin (D8). */
  readonly hop?: HopFeed;
  /** Where the session is, live (the badge and `daemonInPod` follow a hop). */
  readonly targetFeed?: TargetFeed;
  /** `run "<prompt>"`: sent once at mount as the first message, raw text (never a `/command`). */
  readonly initialPrompt?: string;
  /**
   * The palette (`tui.theme`): `auto` (default) reads the terminal's background
   * before Ink mounts, `dark`/`light` force one. Decided once per process, so the
   * `--resume` picker and the runtime share the answer.
   */
  readonly theme?: ThemeSetting;
  /**
   * A chart's plot glyphs (`tui.chartGlyphs`, docs/feat/model-charts.md D5):
   * `braille` (default) or `blocks` for a font without braille. LAPTOP-ONLY.
   */
  readonly chartGlyphs?: ChartGlyphs;
}

/**
 * Launch the Ink TUI and resolve when the user exits.
 *
 * Runs on the terminal's alternate screen so the app fully owns the viewport:
 * our own scroll buffer (mouse wheel, ↑/↓, PgUp/PgDn) is then the authoritative
 * way to move through history, instead of fighting the terminal's native
 * scrollback. Mouse reporting is enabled for wheel scrolling (hold Option/Fn to
 * select text normally). Both are restored on exit; use `/save` to keep the
 * transcript.
 */
export async function startTui(agent: Agent | null, options: TuiOptions): Promise<void> {
  // The palette, FIRST: before ENTER_FULLSCREEN and before Ink owns anything
  // (docs/feat/tui-light-theme.md). A forced setting never queries; `auto` may
  // spend up to 200 ms on a mute terminal. Memoized, so a picker that already
  // decided shares this launch's answer.
  await readThemeSetting(options.theme ?? "auto");
  const fullscreen = Boolean(process.stdout.isTTY);
  const restore = (): void => {
    if (fullscreen) {
      process.stdout.write(LEAVE_FULLSCREEN);
    }
  };
  if (fullscreen) {
    process.stdout.write(ENTER_FULLSCREEN);
  }
  // Safety net: restore the terminal on normal exit AND on SIGINT/SIGTERM (a
  // signal kill never fires "exit", which would otherwise leave the alt-screen
  // and mouse reporting on). Removed in the `finally` below.
  const uninstallRestore = installTerminalRestore(process as unknown as ProcessLike, restore);
  // A timed-out probe left the tty raw and a reply may still arrive: guard Ink's
  // input, or the reply is parsed as keystrokes. Otherwise Ink gets the real stdin.
  const stdin = themeProbeWasLate() ? lateGuard(process.stdin) : process.stdin;
  /**
   * The terminal, usable again: the alt-screen off and, after a timed-out probe,
   * the tty COOKED (the probe deliberately stays raw so a late reply is not
   * echoed, and a mount that throws never reaches Ink's own unmount). The
   * decision itself is pure and tested in `terminal.ts` (Review LOW 5).
   */
  const restoreTerminal = (): void => {
    uninstallRestore();
    restoreTerminalOnExit(
      {
        write: (text) => void process.stdout.write(text),
        // BOUND, not `process.stdin.setRawMode`: the unbound extractor loses `this`,
        // and Bun's `setRawMode` throws `Cannot access property of undefined or
        // null` when called unbound (measured on a real pty, docs §Fix round 2
        // LOW 3) — silently, because `restoreTerminalOnExit` catches it, so the tty
        // stayed RAW.
        setRawMode: (enabled: boolean) => process.stdin.setRawMode?.(enabled),
      },
      { fullscreen, probeWasLate: themeProbeWasLate() },
    );
  };
  // `render()` is INSIDE the try on purpose: Ink reconciles synchronously, so a
  // component that throws throws HERE, before any `waitUntilExit` — with the call
  // outside, the `finally` never ran and the tty stayed raw (measured on a real
  // pty, docs §Fix round 2 LOW 3). `messagesToItems` is inside it for the same
  // reason: a malformed resumed transcript throws before Ink is even called.
  try {
    const initialItems =
      options.resumeMessages && options.resumeMessages.length > 0
        ? messagesToItems(options.resumeMessages)
        : undefined;
    const instance = render(
      <App
        {...(agent ? { agent } : {})}
        {...(options.createSession ? { createSession: options.createSession } : {})}
        model={options.model}
        {...(options.modelLabel !== undefined ? { modelLabel: options.modelLabel } : {})}
        cwd={options.cwd}
        {...(options.version !== undefined ? { version: options.version } : {})}
        {...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {})}
        {...(options.target ? { target: options.target } : {})}
        {...(options.permissions ? { permissions: options.permissions } : {})}
        {...(options.jobs ? { jobs: options.jobs } : {})}
        {...(options.autoWakeOnJobExit !== undefined
          ? { autoWakeOnJobExit: options.autoWakeOnJobExit }
          : {})}
        {...(options.subagentsTwoWay !== undefined
          ? { subagentsTwoWay: options.subagentsTwoWay }
          : {})}
        {...(options.wakePending ? { wakePending: true } : {})}
        {...(options.wakeHanded ? { wakeHanded: true } : {})}
        {...(initialItems ? { initialItems } : {})}
        {...(options.notices ? { notices: options.notices } : {})}
        {...(options.link ? { link: options.link } : {})}
        {...(options.mcpStatus ? { mcpStatus: options.mcpStatus } : {})}
        {...(options.daemonInPod ? { daemonInPod: true } : {})}
        {...(options.detachOnQuit ? { detachOnQuit: true } : {})}
        {...(options.sessions ? { sessions: options.sessions } : {})}
        {...(options.voice ? { voice: options.voice } : {})}
        {...(options.voiceConfigDir ? { voiceConfigDir: options.voiceConfigDir } : {})}
        {...(options.runQuit ? { runQuit: options.runQuit } : {})}
        {...(options.autoAccept ? { autoAccept: options.autoAccept } : {})}
        {...(options.autoAcceptShared ? { autoAcceptShared: options.autoAcceptShared } : {})}
        {...(options.hop ? { hop: options.hop } : {})}
        {...(options.targetFeed ? { targetFeed: options.targetFeed } : {})}
        chartGlyphs={options.chartGlyphs ?? "braille"}
        {...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {})}
        artifactOpener={createArtifactOpener()}
        linkOpener={createLinkOpener()}
      />,
      {
        stdin,
        // Each Ink frame as ONE synchronized update (DEC mode 2026), TTY only: the
        // erase-all + redraw write can no longer be painted half-way
        // (docs/fix/tui-redraw-flash.md). Before that, Ink's frame is cut down to the
        // rows that changed (docs/fix/tui-line-diff-render.md) — the cure where mode
        // 2026 is ignored; `TENTACLE_TUI_FULL_REDRAW=1` turns that off.
        stdout: fullscreen
          ? ((lineDiffEnabled(process.env)
              ? lineDiffStdout(synchronizedStdout(process.stdout))
              : synchronizedStdout(process.stdout)) as unknown as NodeJS.WriteStream)
          : process.stdout,
        exitOnCtrlC: false,
      },
    );
    await instance.waitUntilExit();
  } finally {
    restoreTerminal();
  }
}
