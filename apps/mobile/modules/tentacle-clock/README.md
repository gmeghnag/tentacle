# tentacle-clock

Local Expo module (iOS only), view `ClockText`: a `UILabel` that counts the time
since an event's stamp on the main thread, so the "Thinking · N s" label and a
running step's duration keep time while the JS thread is busy
(`docs/feat/mobile-ui-fluidity-s2.md`). Needs a dev build (not OTA).

Props: `since` (epoch ms), `format` (`"thinking"` | `"step"`), `fontSize` and
`lineHeight` (already scaled for Dynamic Type), `fontFamily` (the app font's face,
absent = system), `color`, `tabular`. It sets its own width.

Wired by `src/ui/ClockText.tsx`, which falls back to a JS label on a build without
the module. The format is `ios/ClockCore/ClockCore.swift`, a mirror of
`src/clock.ts`, pinned by `test/fixtures/clock-format-v1.json` on both sides
(`bun run test:swift`).
