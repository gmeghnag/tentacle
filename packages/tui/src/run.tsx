import type { Agent } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import { render } from "ink";
import {
  App,
  type AutoAcceptFeed,
  type NoticeFeed,
  type RunQuit,
  type SessionController,
  type SessionDirectory,
} from "./App.tsx";
import type { LinkFeed } from "./link-status.ts";
import type { McpServerView } from "./mcp-panel.ts";
import { messagesToItems } from "./resume.ts";
import type { TargetBadge } from "./target-view.ts";
import { lateGuard, readThemeSetting } from "./terminal-background-probe.ts";
import {
  ENTER_FULLSCREEN,
  LEAVE_FULLSCREEN,
  type ProcessLike,
  installTerminalRestore,
} from "./terminal.ts";
import { type ThemeSetting, themeProbeWasLate } from "./theme.ts";

export interface TuiOptions {
  readonly model: string;
  readonly cwd: string;
  readonly contextWindow?: number;
  /** In a container/pod: the status bar's badge (`engine-runtime`'s laptop-side facts). */
  readonly target?: TargetBadge;
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
  /** Auto-wake on a background-job exit (default true in the App). */
  readonly autoWakeOnJobExit?: boolean;
  /** A detached run's relay handed over a job's exit no turn has flushed. */
  readonly wakePending?: boolean;
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
  /** A detached run's TUI (`attach <name>`): `/quit` closes the session for all. */
  readonly runQuit?: RunQuit;
  /** A detached run's TUI: its session's shared auto-accept. */
  readonly autoAccept?: AutoAcceptFeed;
  /** `run "<prompt>"`: sent once at mount as the first message, raw text (never a `/command`). */
  readonly initialPrompt?: string;
  /**
   * The palette (`tui.theme`): `auto` (default) reads the terminal's background
   * before Ink mounts, `dark`/`light` force one. Decided once per process, so the
   * `--resume` picker and the runtime share the answer.
   */
  readonly theme?: ThemeSetting;
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
  const initialItems =
    options.resumeMessages && options.resumeMessages.length > 0
      ? messagesToItems(options.resumeMessages)
      : undefined;
  const instance = render(
    <App
      {...(agent ? { agent } : {})}
      {...(options.createSession ? { createSession: options.createSession } : {})}
      model={options.model}
      cwd={options.cwd}
      {...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {})}
      {...(options.target ? { target: options.target } : {})}
      {...(options.permissions ? { permissions: options.permissions } : {})}
      {...(options.jobs ? { jobs: options.jobs } : {})}
      {...(options.autoWakeOnJobExit !== undefined
        ? { autoWakeOnJobExit: options.autoWakeOnJobExit }
        : {})}
      {...(options.wakePending ? { wakePending: true } : {})}
      {...(initialItems ? { initialItems } : {})}
      {...(options.notices ? { notices: options.notices } : {})}
      {...(options.link ? { link: options.link } : {})}
      {...(options.mcpStatus ? { mcpStatus: options.mcpStatus } : {})}
      {...(options.daemonInPod ? { daemonInPod: true } : {})}
      {...(options.detachOnQuit ? { detachOnQuit: true } : {})}
      {...(options.sessions ? { sessions: options.sessions } : {})}
      {...(options.runQuit ? { runQuit: options.runQuit } : {})}
      {...(options.autoAccept ? { autoAccept: options.autoAccept } : {})}
      {...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {})}
    />,
    { stdin, exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    restore();
    uninstallRestore();
  }
}
