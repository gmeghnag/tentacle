import type { Agent } from "@agent-harness/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@agent-harness/core";
import { render } from "ink";
import { App, type SessionController } from "./App.tsx";
import { messagesToItems } from "./resume.ts";
import {
  ENTER_FULLSCREEN,
  LEAVE_FULLSCREEN,
  type ProcessLike,
  installTerminalRestore,
} from "./terminal.ts";

export interface TuiOptions {
  readonly model: string;
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly permissions?: PermissionBroker;
  /** Background-job registry; the TUI surfaces job exits live when present. */
  readonly jobs?: JobController;
  /** Auto-wake on a background-job exit (default true in the App). */
  readonly autoWakeOnJobExit?: boolean;
  /** Session factory (e.g. a remote session); overrides the local `agent`. */
  readonly createSession?: () => SessionController;
  /** Prior conversation to show on start (a resumed session's history). */
  readonly resumeMessages?: readonly ChatMessage[];
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
      {...(options.permissions ? { permissions: options.permissions } : {})}
      {...(options.jobs ? { jobs: options.jobs } : {})}
      {...(options.autoWakeOnJobExit !== undefined
        ? { autoWakeOnJobExit: options.autoWakeOnJobExit }
        : {})}
      {...(initialItems ? { initialItems } : {})}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    restore();
    uninstallRestore();
  }
}
