/**
 * The session plumbing every TUI run shares (worker, in-process, pod
 * `run`/`attach`): open the store + notice hub + saver and resolve `--resume`
 * before Ink mounts; afterwards tear the runtime down and ALWAYS drain the
 * pending saves — even if the teardown throws — printing only once Ink has
 * unmounted (AGENTS §7). One tested copy instead of three in `main.ts`.
 */
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord, projectKey } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import type { NoticeFeed, SessionPick } from "@tentacle/tui";
import { NoticeHub } from "./notice-hub.ts";
import { findInOtherProjects } from "./session-projects.ts";
import { resolveResume } from "./session-resume.ts";
import { type DrainOptions, SessionSaver } from "./session-saver.ts";

export interface TuiSessions {
  readonly notices: NoticeHub;
  readonly saver: SessionSaver;
  /** The session to resume, or null for a fresh one. */
  readonly resume: SessionRecord | null;
}

/** The `startTui` options this plumbing owns — spread into every call. */
export interface TuiSessionOptions {
  readonly notices: NoticeFeed;
  readonly resumeMessages?: readonly ChatMessage[];
}

/** What the command line asked: `--resume [uid]`, or `--continue` (`latest`). */
export interface ResumeRequest {
  readonly wanted: boolean;
  readonly uid?: string | undefined;
  /** `--continue`: the newest session, never the picker. */
  readonly latest?: boolean;
}

/**
 * Open the sessions of one TUI run. Resume lines are written now (pre-mount);
 * resume warnings are ALSO queued as in-TUI notices (the alternate screen would
 * hide the lines until exit). `{ exit }` = don't start, the reason written:
 * 1 when the requested session is unreadable, its uid invalid or the picker
 * failed; 0 when the user cancelled the picker. `pick` is given only on a
 * terminal (docs/feat/resume-picker.md); without it `--resume` takes the newest
 * session and says why. `startup` notices (a config setting that does
 * nothing, e.g. `titleConfigNotice`) are queued for the TUI, never written.
 */
export async function openTuiSessions(
  where: { readonly root: string; readonly cwd: string },
  resume: ResumeRequest,
  write: (line: string) => void,
  pick?: SessionPick,
  startup: readonly string[] = [],
): Promise<TuiSessions | { readonly exit: number }> {
  // One directory per project (docs/fix/session-store-per-project.md): the
  // resume AND the saver use it, so this folder's sessions are the only ones
  // offered. Old flat files at the root are ignored (no migration, pre-v0.1.0).
  const key = projectKey(where.cwd);
  const store = new JsonSessionStore(join(where.root, key));
  const notices = new NoticeHub();
  for (const text of startup) {
    notices.notify(text);
  }
  const saver = new SessionSaver(store, (text) => notices.notify(text));
  if (!resume.wanted) {
    return { notices, saver, resume: null };
  }
  const choosing = resume.uid === undefined && resume.latest !== true;
  if (choosing && !pick) {
    write("[resume] no terminal for the picker; resuming the newest session\n");
  }
  // Only the picker's own failure is reported as such; a store error propagates.
  let pickFailed: { readonly error: unknown } | undefined;
  const guarded: SessionPick | undefined =
    choosing && pick
      ? async (choices) => {
          try {
            return await pick(choices);
          } catch (error) {
            pickFailed = { error };
            return null;
          }
        }
      : undefined;
  const resolved = await resolveResume(
    store,
    resume.uid,
    { cwd: where.cwd, key, elsewhere: (uid) => findInOtherProjects(where.root, key, uid) },
    guarded,
  );
  if (pickFailed) {
    const { error } = pickFailed;
    write(
      `[resume] picker failed: ${error instanceof Error ? error.message : String(error)}; not starting\n`,
    );
    return { exit: 1 };
  }
  for (const line of resolved.lines) {
    write(line);
  }
  if (resolved.cancelled) {
    return { exit: 0 };
  }
  if (resolved.fatal) {
    return { exit: 1 };
  }
  for (const text of resolved.notices) {
    notices.notify(text);
  }
  return { notices, saver, resume: resolved.record };
}

/**
 * Run the TUI (`start`, given the session options to spread into `startTui`),
 * then `teardown` (dispose the runtime), then drain the saves and print what
 * is not on disk. The drain runs even when `start` or `teardown` throws; the
 * error still propagates afterwards.
 */
export async function runSessionTui(
  sessions: TuiSessions,
  run: {
    readonly start: (options: TuiSessionOptions) => Promise<void>;
    readonly teardown: () => void | Promise<void>;
    readonly write: (line: string) => void;
    readonly drain?: DrainOptions;
  },
): Promise<void> {
  const options: TuiSessionOptions = {
    notices: sessions.notices,
    ...(sessions.resume ? { resumeMessages: sessions.resume.messages } : {}),
  };
  try {
    await run.start(options);
  } finally {
    try {
      await run.teardown();
    } finally {
      const lines = await sessions.saver.drain({
        onSlow: (ids) => run.write(`[session] still saving ${ids.join(", ")}…\n`),
        ...run.drain,
      });
      for (const line of lines) {
        run.write(line);
      }
    }
  }
}
