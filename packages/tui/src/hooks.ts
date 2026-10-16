import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  EMPTY_EDITOR,
  type EditorState,
  deleteBack as editorDeleteBack,
  insert as editorInsert,
  moveCursor as editorMove,
  moveLine as editorMoveLine,
  moveVertical as editorMoveVertical,
  moveWord as editorMoveWord,
  setValue as editorSet,
} from "./editor.ts";

/**
 * Seconds elapsed since `since`, re-rendering twice a second so a live timer
 * (e.g. the thinking indicator) stays current.
 */
export function useElapsed(since: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

export interface PaintScheduler {
  /** Coalesce rapid updates: repaint at most once per `frameMs` (streaming text). */
  scheduleFlush(): void;
  /** Repaint now, cancelling any pending throttled flush (discrete events). */
  flushNow(): void;
}

/**
 * Decouples *when the screen repaints* from *when state changes*. The transcript
 * is mutated into a ref (not React state) to avoid a render per streamed token;
 * this forces the repaint — throttled for the hot text stream, immediate for
 * discrete events — so render cost never couples to token arrival rate.
 */
export function usePaintScheduler(frameMs: number): PaintScheduler {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    bump();
  }, []);
  const scheduleFlush = useCallback(() => {
    if (timer.current) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      bump();
    }, frameMs);
  }, [frameMs]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return { scheduleFlush, flushNow };
}

export interface LineEditor extends EditorState {
  insert(text: string): void;
  deleteBack(): void;
  /** Move by `delta` chars; `extend` selects (Shift) instead of moving. */
  moveCursor(delta: number, extend?: boolean): void;
  /** Jump one word; `extend` selects (Shift+Option/Ctrl). */
  moveWord(dir: -1 | 1, extend?: boolean): void;
  /** Home/End within the current logical line; `extend` selects. */
  moveLine(edge: "start" | "end", extend?: boolean): void;
  /** One logical line up/down preserving the column; `extend` selects. */
  moveVertical(dir: -1 | 1, extend?: boolean): void;
  /** Replace the whole value (cursor defaults to the end). */
  set(value: string, cursor?: number): void;
  /** Clear to empty. */
  reset(): void;
}

/**
 * The prompt line's editable text, as state plus the pure `editor.ts`
 * operations. All editing routes through here so no control key can leak into
 * the buffer (see `editor.ts`).
 */
export function useLineEditor(): LineEditor {
  const [state, setState] = useState<EditorState>(EMPTY_EDITOR);
  const insert = useCallback((text: string) => setState((s) => editorInsert(s, text)), []);
  const deleteBack = useCallback(() => setState((s) => editorDeleteBack(s)), []);
  const moveCursor = useCallback(
    (delta: number, extend = false) => setState((s) => editorMove(s, delta, extend)),
    [],
  );
  const moveWord = useCallback(
    (dir: -1 | 1, extend = false) => setState((s) => editorMoveWord(s, dir, extend)),
    [],
  );
  const moveLine = useCallback(
    (edge: "start" | "end", extend = false) => setState((s) => editorMoveLine(s, edge, extend)),
    [],
  );
  const moveVertical = useCallback(
    (dir: -1 | 1, extend = false) => setState((s) => editorMoveVertical(s, dir, extend)),
    [],
  );
  const set = useCallback(
    (value: string, cursor?: number) => setState(editorSet(value, cursor)),
    [],
  );
  const reset = useCallback(() => setState(EMPTY_EDITOR), []);
  return { ...state, insert, deleteBack, moveCursor, moveWord, moveLine, moveVertical, set, reset };
}
