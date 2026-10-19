# eval/mascot — Tentacle, the project mascot and logo

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** S (terminal banner, if promoted) · **Blast:** contained (assets + a leaf TUI component) · **Suited:** any model executes; standard in-context Review.

## Context

*— claude-opus-5-5, 2026-10-19*

**The question being decided:** what is tentacle's visual identity (mark,
name, palette, where the assets live), and should the TUI show the mascot at
startup the way Claude Code does?

Constraints set by the owner:

- **CNCF-style mark**: flat, geometric, 1–3 colours, readable in a small
  square tile (reference: the logo strip on cncf.io — Helm, Harbor, Flux,
  Tekton).
- **A plain character**, not tied to pods or containers: the scope may grow
  beyond Kubernetes, and a mark that says "container" would age badly.
- **Name:** the mascot is called **Tentacle**.

How the mark was made:

1. Generated as a vector image from this prompt, first result kept:
   ```
   Minimal flat vector logo of a friendly octopus mascot, geometric and symmetrical,
   in the style of CNCF open-source project logos (Helm, Harbor, Flux, Tekton).
   Simple rounded head with two small dot eyes, eight short stylized tentacles
   arranged in a balanced radial or wave pattern below the head. Clean bold shapes,
   consistent stroke weight, no gradients, no shading, no texture, no 3D.
   Limited palette of 2-3 colors: deep violet (#5B2A86) as primary, magenta accent
   (#C2185B), teal highlight (#14B8A6), on a plain white background.
   Centered composition, generous padding, highly legible at 32px as an app icon.
   Professional, modern, approachable, not childish.
   ```
2. The result kept the violet but drifted the accents (`#FC2C56` coral,
   `#01EBE8` neon cyan). Recoloured by hand and compared at 300/48/32 px:
   all-violet (mono), the prompt palette, a violet tonal ramp, Docker/k8s
   blues, and each of these inside a violet ring.
3. Redrawn for the repo with circle arcs and straight segments on a
   600×600 canvas: transparent, ~2.6 KB.

Findings from the comparison:

- **Tonal** (`#5B2A86` / `#8E4BC4` / `#B98BE0`) keeps the depth of the
  original (the tentacles read as layered) and stays in one colour family, so
  the identity is just "tentacle = violet". It is the most legible at 32 px.
- **Mono** (`#5B2A86` only) holds up because of the gaps between tentacles.
  Every CNCF mark ships a one-colour version (print, badges, favicons).
- **Three distinct hues** (prompt palette, original) read as a toy and turn
  into a multicolour blob at 32 px.
- **Docker/k8s blues** look good but the two blues are nearly identical
  (`#2496ED` vs `#326CE5`), so the reference is invisible. They also tie the
  mark to containers (against the constraint) and borrow other projects'
  brand colours.
- **Ring** works as a badge (avatar, sticker), not as the primary mark. In the
  draft the octopus was too small inside the ring and the ring was heavier
  than the tentacle stroke.

**Terminal banner prototype** (the startup mascot, like Claude Code's): the
SVG cannot simply be downscaled to 4 terminal rows (it turns into a blob), so
a hand-drawn pixel grid is rendered with half-block characters (`▀`/`▄`,
foreground = top pixel, background = bottom pixel, 24-bit colour). The brand
violet `#5B2A86` is too dark on a dark terminal, so the banner needs a lighter
ramp. Preferred design (17×8 px → 17 cols × 4 rows):

```
.....DDDDDDD.....
....DDDDDDDDD....
....DD.DDD.DD....
....DDDDDDDDD....
.....DDDDDDD.....
...M.D.D.D.D.M...
..M..D.D.D.D..M..
.M..L..D.D..L..M.
```

Palette `light`: `D=#9D5CE0`, `M=#7C3AED`, `L=#C4A1F0` (on light terminals
the brand violet `#5B2A86` works instead). Rendered output (2026-10-19, SGR
stripped):

```
    ▄▀▀▀▀▀▀▀▄
    ▀▀▄▀▀▀▄▀▀
   ▄ ▀▀▀▀▀▀▀ ▄
 ▄▀ ▄▀ ▀ ▀ ▀▄ ▀▄
```

The prototype script lived in `.tentacle/tmp/mascot-banner/` (gitignored, so
it does not survive); its core is the half-block loop: for each pair of pixel
rows `(t, b)`, emit `▀` with fg=`t` bg=`b`; only `t` → `▀` fg=`t`; only `b` →
`▄` fg=`b`; neither → space.

Today the TUI greets with one text line, `WELCOME` in
`packages/tui/src/App.tsx:92`, seeded as an assistant entry at
`App.tsx:153-157` (and skipped on `--resume`).

## Implementation

*(empty until promoted — see Review for the shape of the follow-up `feat`)*

## Execution

*(empty — an eval carries no code)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Decided by the owner (2026-10-19):**

- Mascot name: **Tentacle**.
- Primary mark: **tonal** → `art/tentacle-tonal.svg`.
- One-colour mark: **mono** → `art/tentacle-mono.svg`.
- The README shows the tonal mark centred at the top.

**Open — proposed follow-up `feat/tui-mascot`** (Size S · Blast contained):
show the pixel mascot at startup, with the welcome text beside it.

- The grid → rows-of-coloured-cells projection goes in a pure, unit-tested
  module. A dumb Ink component renders it (AGENTS §7 "logic lives in pure
  modules").
- It renders through Ink, never `process.stdout.write` (AGENTS §7 "never write
  raw to the terminal while Ink owns it").
- Failure modes to cover:
  - no truecolor / `NO_COLOR` → text-only welcome;
  - a terminal narrower than the banner → text-only;
  - `--resume` → no banner (matches today's welcome);
  - light vs dark terminal → pick the palette, or default to the light ramp,
    which reads on both.
- Still to pick: which pixel design (the prototype had three; the one above is
  the preferred).

**Not yet done (and how to do it):**

- **Dark-mode README.** The dark violet has low contrast on GitHub's dark
  theme. Add a light variant and serve it with
  `<picture><source media="(prefers-color-scheme: dark)">`.
- **Small-size icon** (16–32 px favicon / avatar). Neither mark is optimised
  for it. Draw a reduced silhouette or a filled violet disc with a white
  octopus.

Self-review caveat: this is the author's own pass.
