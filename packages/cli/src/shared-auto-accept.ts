/**
 * A detached run's auto-accept, per SESSION and shared by every TUI on it
 * (docs/fix/detach-live.md B3, owner D3): the laptop file
 * `<runDir>/auto-accept/<sessionId>`, one word. Never the pod, never the
 * daemon: no frame, wire field or activity reaches it, so a pod cannot turn it
 * on. A TUI applies its own flip at once and writes it; the others see it
 * within one poll (a poll, not `fs.watch`: deterministic, injectable, the
 * same on every filesystem). Only a MISSING file falls back: nobody flipped it
 * yet, or it was deleted under a live TUI (the current value stands). A file
 * that exists and cannot be trusted (unreadable, malformed) is OFF, never ON: a
 * person's OFF must survive its damage. A write that fails is said and stays
 * this TUI's.
 */
import { readFile } from "node:fs/promises";
import type { AutoAcceptFeed } from "@tentacle/tui";
import { autoAcceptPath, parseAutoAccept, writeAutoAccept } from "./run-state.ts";

/** How often a TUI looks at the shared state. */
export const AUTO_ACCEPT_POLL_MS = 250;

/** The file seam: `read` rejects when the file is missing or unreadable. */
export interface AutoAcceptFs {
  read(path: string): Promise<string>;
  write(path: string, text: string): void;
}

export interface SharedAutoAccept extends AutoAcceptFeed {
  /** The TUI moved to another session (`/clear`): its file from now on, the value carried over. */
  use(sessionId: string): void;
  /** No more polls. */
  stop(): void;
}

const realFs: AutoAcceptFs = {
  read: (path) => readFile(path, "utf8"),
  write: (path, text) => writeAutoAccept(path, text === "on"),
};

const missing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ENOENT";

/** A timer that never holds the process open. */
function every(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Open the session's shared state: its file if it says (a session turned OFF
 * stays OFF), else `fallback` — the run's `--auto-accept`, from the laptop's
 * `owner.json` only (D2).
 */
export async function openSharedAutoAccept(deps: {
  readonly dir: string;
  readonly sessionId: string;
  readonly fallback: boolean;
  readonly fs?: AutoAcceptFs;
  readonly every?: (fn: () => void, ms: number) => () => void;
  readonly pollMs?: number;
  /** A flip that could not be written (said through the notice hub). */
  readonly onWriteError?: (text: string) => void;
}): Promise<SharedAutoAccept> {
  const fs = deps.fs ?? realFs;
  let key = autoAcceptPath(deps.dir, deps.sessionId);
  /** The file's text as last read or written by this TUI: a change is a flip from elsewhere. */
  let seen: string | null = null;
  let on = deps.fallback;
  try {
    seen = await fs.read(key);
    on = parseAutoAccept(seen) ?? false;
  } catch (error) {
    // No file: nobody flipped it yet, the run's bit. Anything else: OFF.
    if (!missing(error)) {
      on = false;
    }
  }
  /** Bumped by each flip here and each `use`: a read begun before it is stale. */
  let generation = 0;
  let reading = false;
  const listeners = new Set<(on: boolean) => void>();
  const apply = (next: boolean): void => {
    if (next !== on) {
      on = next;
      for (const listener of listeners) listener(on);
    }
  };
  const poll = async (): Promise<void> => {
    if (reading) {
      return;
    }
    reading = true;
    const began = generation;
    const path = key;
    try {
      const text = await fs.read(path);
      if (began !== generation || text === seen) {
        return;
      }
      seen = text;
      apply(parseAutoAccept(text) ?? false);
    } catch (error) {
      // Missing: the current value stands. Unreadable: OFF, and the next good
      // read applies, even its same text.
      if (!missing(error) && began === generation) {
        seen = null;
        apply(false);
      }
    } finally {
      reading = false;
    }
  };
  const stop = (deps.every ?? every)(() => void poll(), deps.pollMs ?? AUTO_ACCEPT_POLL_MS);
  return {
    current: () => on,
    set: (next) => {
      generation += 1;
      on = next;
      const text = next ? "on" : "off";
      try {
        fs.write(key, text);
        seen = text;
      } catch (error) {
        deps.onWriteError?.(
          `⚠ auto-accept ${text} only in this terminal: the shared state could not be written (${
            error instanceof Error ? error.message : String(error)
          }).`,
        );
      }
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    use: (sessionId) => {
      generation += 1;
      key = autoAcceptPath(deps.dir, sessionId);
      seen = null;
    },
    stop,
  };
}
