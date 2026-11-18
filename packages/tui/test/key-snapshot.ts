/**
 * The ONE snapshot builder for key-layer tests: a quiet App (idle, no panel, no
 * dialog, nothing running), with whatever a test needs overridden.
 *
 * It lives outside any `*.test.ts` because more than one suite routes the same
 * chunk (the order pin here, and `voice-layer.test.ts`'s F6/F7 pins), and a test
 * file may not export (Biome `noExportsInTest`). Adding a field to
 * `KeySnapshot` therefore breaks THIS file once, not every suite.
 */
import type { Key } from "ink";
import type { KeySnapshot } from "../src/keys/snapshot.ts";

export const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

/** A snapshot of a quiet App: idle, no panel, no dialog, nothing running. */
export function snap(
  over: Partial<KeySnapshot> = {},
  char = "",
  key: Partial<Key> = {},
): KeySnapshot {
  return {
    char,
    key: { ...NO_KEY, ...key },
    quitConfirm: () => null,
    artifactConfirm: () => null,
    dock: () => ({ focus: { kind: "input" }, drafts: {}, sent: {} }),
    chord: () => ({ armedAt: null }),
    running: () => false,
    compacting: () => false,
    pasteBuffer: () => null,
    replyMaxChars: 0,
    dockIds: () => [],
    othersOnSession: () => 0,
    sessionId: () => "s1",
    switching: () => false,
    panelGen: () => 0,
    abortable: () => false,
    uploadInFlight: () => false,
    exitPending: () => false,
    subagents: () => [],
    jobRows: () => [],
    panel: null,
    paletteOpen: false,
    paletteNames: [],
    commandSel: 0,
    fieldValue: "",
    permission: {
      pending: null,
      choices: [],
      selected: 0,
      mode: () => ({ mode: "menu" }),
      shownAt: () => 0,
    },
    sessions: undefined,
    detachOnQuit: false,
    voice: () => "idle",
    voiceKey: () => "ctrl+r",
    ...over,
  } as KeySnapshot;
}
