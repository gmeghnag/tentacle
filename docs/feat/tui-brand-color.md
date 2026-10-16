# TUI brand/accent colour → cyan

## Problem

For the public MIT release the TUI accent must drop the Anthropic trade-dress
orange and become a distinctive, on-brand cyan. Today the brand colour is:

- **Orange `#d77757`** (Anthropic "claude" orange) — assistant bullets and most
  component accents.
- **Blue `#6377ff`** — the permission-dialog frame (and `theme.accent`), barely
  visible on a dark terminal.

…and it is **hard-coded in 6 places** plus two separate theme tokens, so a colour
change today means editing many files and the value drifts. Decision (recorded):
unify to **ONE** accent token, **cyan `#06b6d4`** on dark terminals (contrast
7.5:1), light-terminal variant **`#0891b2`** (3.3:1 on white).

## Preconditions (verified against the source)

- **Two colour-consumption paths**, which is why the value is scattered:
  1. **chalk stylers** in `theme.ts` (`theme.claude`/`theme.accent`), consumed by
     `render-lines.ts` (e.g. `theme.claude("⏺")` at `:66`, `theme.accent("◆")` at
     `:239`, `theme.accent("⏺")` at `:288`) — these build **styled strings**.
  2. **Ink `<Text color={hex}>` props** with hard-coded hex in components:
     `components/LineInput.tsx:13` (`CLAUDE = "#d77757"`),
     `components/Thinking.tsx:11` (`CLAUDE = "#d77757"`),
     `components/CommandPalette.tsx:11` (`ACCENT = "#d77757"`),
     `components/StatusBar.tsx:94` (`color="#d77757"` inline),
     `components/PermissionPrompt.tsx:6` (`ACCENT = "#6377ff"`).
  > The recorded decision's file list was **incomplete** — it missed
  > `CommandPalette.tsx` and `StatusBar.tsx`. All six sites are listed here.
- A chalk styler (`theme.accent`) is a **function**, not a hex string, so it
  cannot be passed to an Ink `color=` prop. Both paths therefore need a **shared
  raw hex constant** as the single source of truth.
- **No dark/light detection exists.** `theme.ts`'s header says it is "tuned for a
  dark terminal"; there is no terminal-background probe anywhere.
- **Colour is not frame-observable in tests.** chalk auto-disables when stdout is
  not a TTY, and the ink-testing-library harness strips SGR — so the TUI tests
  assert text/structure, never colour. (Same constraint we hit with the cursor
  inverse.) Correctness is verified by the resolved-token value + a no-stale-hex
  check + a manual soak, not by frame assertions.
- The config stack already threads scalar options end-to-end
  (`contextWindow`: `config/src/schema.ts:28`, `resolve.ts:158`,
  `load.ts:44,187`) — a new `theme` option follows the same shape.
- The TUI entry `run.tsx` calls Ink's `render()` (`:56`); anything that must own
  the raw terminal (an OSC-11 probe) runs **before** that, per AGENTS §7 ("never
  write raw while Ink owns the screen").

## The one load-bearing assumption

> There must be **one source of truth** for the accent hex that *both* the chalk
> path and the Ink-`color=` path read. Otherwise the colour re-scatters and the
> next change reopens this same problem. Everything below funnels both paths
> through a single exported constant in `theme.ts`.

## Design (phased — ship the safe part first)

### Phase 1 — centralise + swap to cyan (dark), low risk

1. In `theme.ts`, define the single source:
   ```ts
   export const ACCENT_DARK = "#06b6d4";
   export const ACCENT_LIGHT = "#0891b2";
   export const accentHex = ACCENT_DARK; // Phase 1: dark only
   ```
2. Collapse the two brand tokens into **one**: `theme.accent = chalk.hex(accentHex)`;
   **remove `theme.claude`**. In `render-lines.ts` the assistant bullet (`:66`,
   was `theme.claude`) now uses `theme.accent`, matching the in-progress glyph.
   *(Consequence: the assistant bullet and the in-progress/sub-agent glyph become
   the same cyan — a deliberate flattening to one brand colour; confirm it reads
   well.)*
3. Point the 6 component sites at the shared constant: replace each hard-coded
   `"#d77757"`/`"#6377ff"` with `import { accentHex }` and `color={accentHex}`
   (drop the per-file `CLAUDE`/`ACCENT` consts).

That alone delivers the release-ready cyan and the maintainability win (one token,
zero hard-coded hex), with no new runtime machinery.

### Phase 2 — dark/light selection (OSC-11 + config), higher risk

4. Add a `theme` config: `"auto" | "dark" | "light"` (default `"auto"`), threaded
   through `config` (`schema.ts`/`resolve.ts`/`load.ts`) like `contextWindow`.
5. `theme.ts` becomes mode-aware: instead of a static `accentHex`, a one-time
   `initTheme(mode)` (or `createTheme(mode)`) picks `ACCENT_DARK`/`ACCENT_LIGHT`.
   Everything still reads one resolved value; components read it after init.
6. `"auto"` resolution: in `run.tsx`, **before** `render()`, probe the terminal
   background with **OSC 11** (`ESC ] 11 ; ? BEL`), parse the `rgb:…` reply,
   decide dark/light by luminance, with a **~150 ms timeout → fallback dark** and
   full restore of stdin state. Explicit `dark`/`light` skips the probe. This is
   the only piece that touches raw terminal I/O and must obey AGENTS §7 (done and
   cleared before Ink mounts; no raw writes once Ink owns the screen).

Phase 2 is separable and can land later; Phase 1 is the release blocker.

## Files to change

Phase 1:
- `packages/tui/src/theme.ts` — add `ACCENT_DARK`/`ACCENT_LIGHT`/`accentHex`;
  `accent = chalk.hex(accentHex)`; remove `claude`; refresh the header comment.
- `packages/tui/src/render-lines.ts` — `theme.claude` → `theme.accent` (`:66`).
- `packages/tui/src/components/LineInput.tsx`, `Thinking.tsx`,
  `CommandPalette.tsx`, `StatusBar.tsx`, `PermissionPrompt.tsx` — use `accentHex`,
  drop the local hex consts.

Phase 2 (deferred):
- `packages/config/src/{schema,resolve,load}.ts` — `theme: auto|dark|light`.
- `packages/tui/src/theme.ts` — `initTheme(mode)`.
- `packages/tui/src/run.tsx` + a new `osc11.ts` (pure parse + injectable probe).
- wiring to pass the resolved mode into `initTheme` before mount.

## Tests

- **Phase 1:** a `theme.test.ts` asserting `accentHex === "#06b6d4"`, `theme.accent`
  is defined and `theme.claude` is gone (type/compile guard); a repo check that no
  `#d77757`/`#6377ff` remains under `packages/tui/src` (grep guard — colour isn't
  frame-testable, so this is the regression net). Existing TUI tests must stay
  green (they assert structure, not colour).
- **Phase 2:** pure unit tests for the OSC-11 reply parser (`rgb:` string →
  dark/light by luminance; malformed → fallback), the timeout path (injected slow
  terminal → dark), and config precedence (explicit `light` beats `auto`; `auto`
  with no reply → dark). The terminal query is injected/faked — no real TTY.

## Validation

`bun run check` green. Manual soak on a **dark** terminal (Phase 1): assistant
bullets, in-progress glyph, input prompt, command palette, status bar and the
permission frame are all the new cyan and readable; `grep -rn "d77757\|6377ff"
packages/tui/src` returns nothing. Phase 2: repeat on a **light** terminal and
confirm `auto` picks `#0891b2`, and that the OSC-11 probe leaves the terminal
clean (no stray escape, input not swallowed) because it completes before Ink
mounts.

## Notes / debt

- Contrast (recorded): `#06b6d4` 7.5:1 on dark; `#0891b2` 3.3:1 on white. Reason
  for cyan: distinctive/on-brand (cephalopod/deep-sea), outside the
  red/green/yellow semantic band, strong on dark (the typical dev/SRE case).
- Flattening `claude`+`accent` into one token means the assistant bullet is no
  longer a distinct colour from the in-progress glyph. If we later want two brand
  shades, reintroduce a second token from the same source constant — don't
  re-hard-code.
- Phase 2's OSC-11 auto-detection is the only risky part; shipping Phase 1 alone
  (dark cyan, centralised) is a complete, safe release step on its own.
