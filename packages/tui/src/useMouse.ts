/**
 * The mouse layer's STATE (docs/feat/app-decomposition.md S4): the partial SGR
 * report held across chunks, its release timer, and the click recogniser. Every
 * DECISION is `mouse-stream.ts`'s (pure); this hook owns the refs/timer and
 * executes what the pure step decided, so `App` keeps only the one `useInput`
 * that calls it (AGENTS §7: logic in a pure module, the hook owns refs, App is
 * the composition root).
 *
 * Deliberately NOT a hook "taking the layout every render" (Fable M2): the render
 * SNAPSHOT is an argument of `handleChunk`, built at the call site at the moment
 * of the event, so a coalesced chunk's reports all see the frame they landed on
 * and the decision's inputs are declared in one type.
 *
 * What does NOT move (Fable M1, frozen identifiers): the live `selection` state,
 * its ref and the scroll-anchor effect that reads it. The selection is painted
 * by the JSX and read by an effect declared ABOVE this hook, so it stays in
 * `App` and arrives here as a field of the port — no use-site edit, no reorder.
 */

import type { ArtifactMeta } from "@tentacle/protocol";
import type { Key } from "ink";
import { useCallback, useRef } from "react";
import type { DockKeyResult, DockState } from "./background-focus.ts";
import type { LineEditor } from "./hooks.ts";
import {
  type MouseEffect,
  type MouseSnapshot,
  type MouseState,
  dispatchMouse,
  stepMouseChunk,
} from "./mouse-stream.ts";
import type { OpenPanel } from "./panel.ts";
import { sliceLaid, stripAnsi } from "./render-lines.ts";
import { type Selection, extractSelection, isNonEmpty } from "./selection.ts";
import { CLICK_IDLE, type ClickState, toggleExpanded } from "./tool-expand.ts";
import type { PanelView } from "./tree-panel.ts";

/**
 * How long a partial report is held before it is read as a typed `[`. The two
 * halves of a real report arrive within the same pty read window, so 100 ms is
 * far longer than any split.
 */
export const MOUSE_HOLD_MS = 100;

/**
 * The narrow port the mouse layer executes through: the App's own setters and
 * the decisions other modules already own (`panelClick`, `clickDock`,
 * `clampOffset`). A port FIELD is ref-backed or keeps its current identity rule
 * (Fable H2); the callbacks below destructure the fields and name them in deps.
 */
export interface MouseHost {
  /** The open panel as of the last render (the hold's timer has no fresh closure). */
  readonly panelRef: { readonly current: OpenPanel | null };
  /** The dock's state ref — a click must read what the last key wrote. */
  readonly dockRef: { readonly current: DockState };
  /** The live selection (App's state + ref: painted and read above this hook). */
  readonly selectionRef: { readonly current: Selection | null };
  readonly setSelection: (next: Selection | null) => void;
  readonly field: LineEditor;
  readonly clipboard: (text: string) => Promise<void>;
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  readonly setScrollOffset: (f: (offset: number) => number) => void;
  readonly setPanel: (f: (panel: OpenPanel | null) => OpenPanel | null) => void;
  readonly setDock: (next: DockState) => void;
  readonly setExpandedIds: (f: (ids: readonly string[]) => readonly string[]) => void;
  readonly dockIds: () => readonly string[];
  /** `background-focus.ts`'s click decision (pill / row → dock state + effect). */
  readonly clickDock: (
    state: DockState,
    hit: { readonly kind: "pill" } | { readonly kind: "row"; readonly id: string },
    ids: readonly string[],
  ) => DockKeyResult;
  /** `panel.ts`'s body-row click decision. */
  readonly panelClick: (
    panel: OpenPanel,
    view: PanelView,
    bodyIndex: number,
    width: number,
  ) => OpenPanel;
  /** `scroll.ts`'s clamp. */
  readonly clampOffset: (offset: number, total: number, height: number) => number;
  /** Submit the prompt line (the restored `[`'s same-event path). */
  readonly submit: (text: string) => void;
  /** Open an artifact through the App's one artifact path (a `present` header click). */
  readonly openArtifact: (artifact: ArtifactMeta) => void;
  /** A click on a URL: open it, or say why not (`links.ts: linkOpenStep`). */
  readonly openLink: (url: string) => void;
}

export interface MouseLayer {
  /**
   * Run the mouse layer for one input chunk. Returns `"consumed"` when the layer
   * took it, or `"pass"` so the router continues (a restored `[` was already
   * inserted into the field before this returned).
   */
  handleChunk(char: string, key: Key, snapshot: MouseSnapshot): "consumed" | "pass";
  /** Release a held partial now (the unmount cleanup, and a new chunk). */
  clearHold(): void;
}

export function useMouse(host: MouseHost): MouseLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
    panelRef,
    dockRef,
    selectionRef,
    setSelection,
    field,
    clipboard,
    pushNotice,
    setScrollOffset,
    setPanel,
    setDock,
    setExpandedIds,
    dockIds,
    clickDock,
    panelClick,
    clampOffset,
    submit,
    openArtifact,
    openLink,
  } = host;

  // Partial SGR mouse report held across data chunks: some terminals/ptys split
  // one report in half (see `mouse-stream.ts`).
  const pendingRef = useRef("");
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickRef = useRef<ClickState>(CLICK_IDLE);

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
    [clipboard, pushNotice, selectionRef, setSelection],
  );

  const clearHold = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const hold = useCallback(
    (partial: string) => {
      pendingRef.current = partial;
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
      }
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        const p = pendingRef.current;
        pendingRef.current = "";
        if (p === "[" && !panelRef.current) {
          field.insert(p); // it was a typed bracket after all
        }
        // A longer p was a truncated report: drop it.
      }, MOUSE_HOLD_MS);
    },
    [field, panelRef],
  );

  /** Apply ONE report's effects, in the order `mouse-stream.ts` decided them. */
  const applyEffects = useCallback(
    (effects: readonly MouseEffect[], snapshot: MouseSnapshot) => {
      for (const effect of effects) {
        switch (effect.kind) {
          case "scroll":
            setScrollOffset((o) =>
              clampOffset(o + effect.delta, snapshot.total, snapshot.viewport),
            );
            break;
          case "panelClick":
            setPanel((p) =>
              p && snapshot.listView
                ? panelClick(p, snapshot.listView, effect.bodyIndex, snapshot.columns)
                : p,
            );
            break;
          case "dockPill": {
            const step = clickDock(dockRef.current, { kind: "pill" }, dockIds());
            if (step.state !== dockRef.current) {
              setDock(step.state);
            }
            break;
          }
          case "dockRow": {
            const step = clickDock(dockRef.current, { kind: "row", id: effect.id }, dockIds());
            if (step.state !== dockRef.current) {
              setDock(step.state);
            }
            if (step.effect.kind === "open") {
              field.set(step.effect.draftIn);
            }
            break;
          }
          case "toggleTool":
            setExpandedIds((ids) => toggleExpanded(ids, effect.id));
            break;
          case "openArtifact":
            openArtifact(effect.artifact);
            break;
          case "openLink":
            openLink(effect.url);
            break;
          case "copySelection":
            // Selection can span rows scrolled out of view, so assemble the whole
            // buffer HERE — only on release, never on the per-frame render path.
            finishSelection(sliceLaid(snapshot.laid, 0, snapshot.total));
            break;
        }
      }
    },
    [
      setScrollOffset,
      clampOffset,
      setPanel,
      panelClick,
      clickDock,
      dockRef,
      dockIds,
      setDock,
      field,
      setExpandedIds,
      openArtifact,
      openLink,
      finishSelection,
    ],
  );

  const handleChunk = useCallback(
    (char: string, key: Key, snapshot: MouseSnapshot): "consumed" | "pass" => {
      // Prepend any partial report held from the previous chunk.
      const held = pendingRef.current;
      if (held) {
        pendingRef.current = "";
        clearHold();
      }
      const step = stepMouseChunk({
        held,
        char,
        key,
        panelOpen: snapshot.panelOpen,
      });
      let state: MouseState = { click: clickRef.current, selection: selectionRef.current };
      for (const report of step.reports) {
        const one = dispatchMouse(state, report, snapshot);
        // Effects first, then the state: a release's `copySelection` still reads
        // the selection the previous report in this SAME chunk just made (which
        // no render separates), exactly as the inline handler did.
        applyEffects(one.effects, snapshot);
        state = one.state;
        if (state.selection !== selectionRef.current) {
          setSelection(state.selection);
        }
      }
      clickRef.current = state.click;
      if (step.verdict === "consumed") {
        if (step.hold !== null) {
          hold(step.hold);
        }
        return "consumed";
      }
      if (step.submit) {
        // Same-event submit: `field` is still the pre-insert closure value, so
        // append the restored bracket here instead of inserting it.
        submit(field.value + step.restored);
        return "consumed";
      }
      if (step.restored !== "") {
        field.insert(step.restored);
      }
      return "pass";
    },
    [clearHold, selectionRef, setSelection, applyEffects, hold, submit, field],
  );

  return { handleChunk, clearHold };
}
