<!--
The spawn-time brief for an agent that draws an HTML mockup (iPhone app or Mac
TUI). Its counterparts: EXECUTOR-BRIEF.md, REVIEWER-BRIEF.md. Why it exists:
docs/feat/mobile-mockup-kit.md.
-->

# Mockup brief

You are drawing a mockup for **`<slug>`**. A mockup the owner judges must show
the REAL app wherever it shows a current screen. So you do not redraw the app:
you compose the kit, `tools/mockup-kit/`, whose every value is generated from
`apps/mobile/src` and `packages/tui/src`.

1. **Look first.** Open the catalogue: `bun scripts/mockup-kit.ts inline
   tools/mockup-kit/index.html` → open `tools/mockup-kit/index.inline.html` in a
   browser (do not commit it). Every component, every state, light/dark/petrol,
   with motion and a Reduce Motion toggle.
2. **Compose only `K.*`.** Work in `.tentacle/tmp/<slug>/mockups/`. `<link>` the
   kit's CSS (`generated/tokens.css`, `generated/tui-tokens.css`, `frame.css`,
   `kit.css`, `tui.css`) and `import { K } from ".../tools/mockup-kit/kit.js"`
   by relative path. Mount with `K.screen(el, { theme, font, reduceMotion }, [...])`.
3. **Anything new is «nuovo».** Build it with `K.extend(name, builder)`, using
   `var(--…)` tokens only. A value that is not a token must be justified in that
   extension's «nuovo» note. Never a new hex, size or timing literal outside an
   extension. The owner reviews with `?nuovo=1`.
4. **An existing TUI screen is rendered, not drawn.** Capture a real frame
   (ink-testing-library, the `packages/tui/test/app.test.tsx` pattern) and show
   it with `K.tui.fromAnsi(frame)`.
5. **Every frame in light AND dark** (petrol + Figtree too when the beta is in
   scope).
6. **Never meaning by hue alone** (the owner is colour-blind): a glyph, a shape,
   text or a position carries it first; colour only reinforces.
7. **Minimal taste:** no rounded inset cards (E2 bands are square), no pure
   black, thin icons (SF Symbols light/regular, never bold glyph icons).
8. **Hand over an inlined snapshot.** `bun scripts/mockup-kit.ts inline <your.html>`
   → give the owner the `.inline.html` (self-contained, stamped with the kit's
   sha), never a page with relative links: those re-style when the kit changes.
9. **If you believe the kit is wrong, report it** (what, where, the code's
   `file:line`). Do not patch around it in the mockup.
