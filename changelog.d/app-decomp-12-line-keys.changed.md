- **The TUI's line editing is a pure key layer, and `App.tsx`'s key handler has
  no inline logic left.** What a keypress does to the input line after every
  layer above passed it — history recall and its no-op guard, DOWN's walk from
  the draft slot into the background dock, Backspace's "empty input removes the
  last chip" rule, and the 14 editing actions — is now
  `packages/tui/src/keys/line-layer.ts`: React-free, it returns effects as data
  that run through the same `executeEffects`/`KeyHost` port as the 13 routing
  layers. The ONE `useInput` still runs it last, and only when the mouse layer
  passed. The palette highlight's wrap is `paletteStep` (`commands.ts`), which
  returns 0 for an empty list instead of `NaN`. This removes the last of the
  key-handler debt named in AGENTS §7. No user-visible behaviour changes.
