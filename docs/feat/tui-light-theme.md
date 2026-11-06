# feat/tui-light-theme — Detect the terminal background, light palette

> **Status:** implementation DONE — S1–S7 built, red-first with a proven mutation per
> behaviour; gate green (`tsc --noEmit`, `biome check .`, `bun test packages`: 5176 pass,
> 3 opt-in skips, 0 fail). Awaiting the mandatory fresh-context Review and the owner's
> live checklist (Execution §"Owner's live checklist").
> **Branch:** `feat/tui-light-theme` (off `main` 47b0a51)
> **Size:** L · **Blast:** load-bearing · **Suited:** AGENTS §10 rule for load-bearing: mandatory fresh-context Review that red-teams the stdin/terminal path

**Why not the TODO's `S–M · contained`:** §10 excludes any "terminal/IO path" from
`contained`, and this reads the one stdin every runtime shares, before Ink. About 22
files in 3 packages (`tui`, `config`, `cli`).

Citations: **every `file:line` below was re-verified 2026-11-06 against `main` 47b0a51**
(the branch's base) — the old tips (`tui` at f1efce7, the rest at b02818f) are stale and
have been replaced. Merged since the plan was written, and folded in here:
`feat/tui-target-badge`, `feat/tui-notice-palette`, `feat/config-carry`,
`feat/session-settings-apply`, `feat/parallel-agents`, `fix/run-rm-flag`.

## Context

*— claude-opus-5-5, 2026-11-05*

The palette is tuned for dark terminals only (`packages/tui/src/theme.ts:5`). Light
values exist but nothing can select them: `theme.ts:34` and `theme.ts:57` say "no
light-mode switch yet". Worst case: diff text is a hard-coded near-white
(`theme.ts:102`, `:109`) on hard-coded dark tints, and `theme.message.dark` is the
default row style (`message-row.ts:43`, `:67`). Owner request: TODO.md:429.

**Constraints:** detection happens before Ink mounts and only on the laptop TTY; the
override is `tui.theme: auto | dark | light`; one token table; logic in a pure module
(AGENTS §7); dark rendering stays unchanged.

### Findings that change the brief (re-verified 2026-11-06)

1. ~~**`#fec20a` does not exist on the branch.**~~ **Resolved by a merge:** the token now
   exists — `theme.ts:21` (`autoAcceptHex = "#fec20a"`), wired at `StatusBar.tsx:149`. So
   this task does **not** add it; it adds its **light** variant and moves both into the
   token table.
2. **The TODO's light accent `#0891b2` fails the brief's own bar:** 3.68:1 on white. → Q1.
3. **`connect` never loads config** (the `connect` branch calls `connectTui` at
   `cli/main.ts:513` and returns at `:536`, before `loadConfig` at `main.ts:568`), so
   `config.tui.theme` is unavailable on that path. → Q6.
4. **Colours missing from the TODO's list:** Markdown and fenced code. `markedTerminal()`
   is called with defaults at import time (`markdown.ts:11`), which brings ANSI yellow
   code, magenta/green headings and blue links (`marked-terminal/index.js:28-43`), plus
   cli-highlight's default theme for fences (`marked-terminal/index.js:95`). → Q5.
5. **Terminal.app is a 256-colour target as far as I recall** (chalk's detection; from
   memory, the executor checks `chalk.level` there live). The executor **measured** the
   real downgrade with chalk's own `rgbToAnsi256`
   (`chalk/source/vendor/ansi-styles/index.js:111-131`) — it is not a simple rounding, and
   it is the trap the light palette has to survive. → Q3, and *Refresh drift* below.
6. **`pickSession` also mounts Ink before `startTui`** (`session-picker-run.tsx:29`),
   called from `main.ts:811` (via `openTuiSessions`' `pick`) and `main.ts:525` (`connect`),
   and paints the accent (`SessionPicker.tsx:40`, `:45`). Detecting only in `startTui`
   would leave the picker on the wrong palette.
7. **New colour sites since the plan was written** (the merges named at the top):
   - `feat/tui-target-badge`: `autoAcceptHex` (`theme.ts:21` → `StatusBar.tsx:149`) and
     the badge name in the accent (`StatusBar.tsx:126`).
   - `feat/tui-notice-palette`: `noticeHex` `#8caaee` (`theme.ts:28`, used at
     `render-lines.ts:590-591`) and a **pre-chosen light value** `noticeHexLight`
     `#3b5bdb` (`theme.ts:29`, unused). Its hint is `theme.subtle` (`render-lines.ts:595`).
     These are real now and must join the token table — and the light blue has to clear
     the gate (see *Refresh drift*).
   - `feat/session-settings-apply` renders its `/settings` block and drift notices
     **through the same notice path** (`noticeLines`, `render-lines.ts:587`), so it needs
     no colour of its own — it inherits `notice` + `subtle`.
   - `feat/parallel-agents` and `fix/run-rm-flag` add no colour site (checked:
     `grep` for literals in `packages/tui/src` finds only the four `theme.ts` hexes).

**Repro (capability missing):** static, from the citations above; no runtime repro is
needed to show there is no switch.

### Verification status: what WAS run (Execution step 0, 2026-11-06)

`bun` and `python3` are available this session, so the plan's own probes were run and
their output is in **Execution** at the end of this doc.

- **The load-bearing assumption is PROVEN** on a real pty (Bun 1.4.3, macOS): raw mode
  → `readable`/`read()` → reply removed → `unshift(rest)` → detach → Ink's own mount
  reads exactly the remaining bytes. `fast_st`, `split_bytes`, `da1_only`, `silent`,
  `typeahead_abc`, `typeahead_da1`, `late_cooked`, `late_keepraw`, `late_keepraw_gap`
  all behaved as the table below expects.
- **Every contrast ratio below is now MEASURED**, not hand-computed, in truecolor and
  through chalk's real 256 downgrade. Three plan values did not survive it → *Refresh
  drift*.
- **Terminal *identity* behaviour** (tmux, screen, Terminal.app, Windows Terminal) stays
  from memory and marked as such. The design does not depend on it; the live checklist
  decides.

Probes, all in `.tentacle/tmp/tui-light-theme/` (gitignored; the scripts are pasted in
Execution because they do not survive):

| Script | Decides |
|---|---|
| `pty_harness.py` + `child.ts` | a fake terminal on a real pty, nine scenarios against the candidate probe + a real Ink mount |
| `final-tokens.ts` / `pick.ts` / `downgrade.ts` | the truecolor **and** chalk-256 ratio of every light token |
| `diff-fg.ts`, `tint.ts`, `subtle-tint.ts`, `notice-blue.ts` | searches for the values that survive 256 |

## Implementation

*— claude-opus-5-5, 2026-11-05 (sliced and re-verified 2026-11-06)*

### Refresh drift (2026-11-06) — what the code/measurements forced

Four changes to the plan, all evidence-driven. Everything else holds as written.

1. **Three light values changed, because the plan's "256" column was computed by hand
   with a wrong model of chalk.** chalk does not round to `round(c/51)*51`; it uses
   `rgbToAnsi256` (`chalk/source/vendor/ansi-styles/index.js:111-131`): the 24-step grey
   ramp **only when r=g=b**, otherwise the 6×6×6 cube `16 + 36·round(r/255·5) + …`. A
   near-grey like `#6b6b6f` therefore takes the **cube** (→ `#878787`, 3.59), not the
   ramp. The plan's `#6b6b6f` grey was chosen on the wrong model. Measured corrections:
   - `subtle` / `dim` / `gutter` / `md.blockquote` / `md.del`: `#6b6b6f` → **`#6b6b6b`**
     (exact grey: 5.33 white / 4.94 Sol. / 5.25 at 256). `#6b6b6f` measured 5.31/4.92 but
     **3.59 at 256** — under the 4.5 gate.
   - `syn.comment`: `#64646a` → **`#646464`**: measured 5.92 / 5.49 / **6.10** at 256
     (the tinted `#64646a` went to 3.59).
   - `diff.addFg` / `diff.delFg` / `diff.addWord` / `diff.delWord` on their tints:
     `#202024` → **`#1a1a1a`**. `#202024` is fine in truecolor (14.59 / 13.23) but at 256
     it becomes `#5f5f5f`, and on the *word* tint `#ffb2b2` that is **3.65** — under the
     gate. `#1a1a1a` stays `#1c1c1c` at 256: 15.56 / 12.95 / **9.74** on the word tint.
   - `border` / `diff.border`: `#8c8c8f` → **`#8c8c8c`** (3.36 / 3.12 / 3.45 at 256; the
     tinted variant went to 2.19). The 3:1 non-text bar.
   Every other light value in the tables below is confirmed exactly as planned.
2. **`feat/tui-notice-palette`'s light blue is KEPT at the owner's `#3b5bdb`** (`theme.ts:29`
   at the time), even though it measures **3.54 at 256** — under Q3's gate. **Resolved in
   favour of the owner's explicit later pick**, not the general gate: that task's owner
   decision names `#3b5bdb` (light) as the notice colour, chosen over alternatives, and a
   merged owner decision beats a rule of thumb about a different token. Consequence: the
   test's 256 exception list is **`accent` AND `notice`** (two named exceptions, both
   recorded here), and the executor does not silently re-tune a colour the owner picked.
   (Measured alternative, should the owner ever want the gate instead: `#2f4ba8`,
   7.80 / 7.23 / 5.61 — one hex to flip.)
3. **`message.queuedFg` light moves `#5c5c5f` → `#5c5c5c`** (measured 5.76 true / 5.60 at
   256). The plan wrote `#5c5c5f` with "256: 5.60", but that is the model error of item 1:
   `#5c5c5f` is not an exact grey, so chalk takes the cube (→ `#878787`, **2.83** on the
   `#eeeeee` tint). The tint itself stays the plan's **`#eeeeee`** (1.16 band against
   white; row text 5.02 and `queuedFg` 5.60 at 256 are fine, the accent marker 3.25 is Q3's
   already-accepted exception). `theme.subtle` never sits on the message tint (the queued
   hint at `message-row.ts:88` is off the background), so it needs no change here.
4. **The probe needs no `app-late.ts` probe of its own** and no `Proxy`-over-`read()`
   redesign: the pty run shows a late reply arriving as one plain chunk on Ink's `data`
   path, so `lateGuard` stays the small `read()` override the plan describes. One
   correction from the run: **on the `silent` and `late_*` paths the listener must be
   removed but `setRawMode` must NOT be re-called** (the child showed that re-calling
   `setRawMode(true)` before Ink's mount is harmless, but calling `false` echoes — as
   designed). No change to the design, only to what the test must pin.

**Not drift, but worth stating:** `#fec20a` exists now (Finding 1), so S4 only adds its
light value (`#a84a00`, measured 5.76 / 5.34 / 4.71) and moves the pair into the table.

### Load-bearing assumption

**On a real TTY under Bun ≥ 1.4.3, one pre-mount reader can use raw mode and
`readable`/`read()`, take the terminal's reply out, put every other byte back with
`stdin.unshift`, and detach, so that Ink's later mount reads exactly the remaining
bytes: nothing lost, duplicated or echoed.**

- **PROVEN 2026-11-06 on a real pty** (`.tentacle/tmp/tui-light-theme/pty_harness.py`,
  Bun 1.4.3, macOS). Measured:

  | Scenario | Measured |
  |---|---|
  | `fast_st` | `done=da1 colour="rgb:1e1e/1e1e/1e1e" rest=""`, Ink mounts, no input event |
  | `split_bytes` | same result with the reply written one byte per write |
  | `da1_only` | `done=da1 colour=null rest=""`, returns at once |
  | `silent` | `done=timeout colour=null rest=""`, Ink still works |
  | `typeahead_abc` | `rest="abcde"` unshifted → Ink got `abcde` then `f g h` in order; nothing lost or duplicated |
  | `typeahead_da1` | `rest="a"` → Ink got `a`,`b`,…,`h` in order |
  | `late_cooked` (sentinel-less timeout then cooked) | **the reply ECHOES** (`^[[?1;2c` on screen) — the bug the design avoids |
  | `late_keepraw` | no echo; the whole reply arrives as one chunk on Ink's input |
  | `late_keepraw_gap` | no echo; the reply arrives later, still on Ink's input |

- Statically supported, as before: Ink reads with the same `readable` + `read()` loop
  (`ink/build/components/App.js:119-120`, `:132-138`), and `setEncoding`/`setRawMode`
  are repeated at mount (`App.js:114`, `:119`). A previous Ink mount on the same stdin
  already works (`session-picker-run.tsx:29`).
- **The fallback is no longer needed** (it was: route every mount through the guard with
  a pending prefix). It stays written down in case a terminal disagrees.

### Preconditions

- **The TUI always runs on the laptop.** All four mounts are local: `main.ts:846` (pod
  `run`/`attach`), `:1630` (worker), `:1680` (in-process), `connect.ts:151`. Pod daemons
  have no TUI (AGENTS §7). So one seam covers every runtime, with no protocol change
  and nothing sent to a pod.
- **`tui.theme` stays laptop-only** — `feat/config-carry` merged since this plan, and the
  key must not be carried. Verified: `CARRIED` (`packages/cli/src/carried-settings.ts:42`)
  is keyed by `keyof SessionSettings` (`:196`), so a key absent from the protocol's
  `SessionSettingsSchema` (`protocol/src/session.ts:449`) **cannot** be added without a
  type error, and `tui.theme` has no `SessionSettings` member. **No change to
  `carried-settings.ts`, the protocol, or `session/open.settings`.** A pod reading the
  laptop's file just sees a key its own parser accepts and nothing reads.
- **Nothing owns the terminal at the seam.** `StatusLine` is finished before the mount
  (AGENTS §7; `engine-runtime.ts:445`-style `status?.finish()`), `startTui` writes
  `ENTER_FULLSCREEN` only at `run.tsx:78`.
- **Hence "in the StatusLine phase" means immediately before the mount, not during the
  spinner.** A long pod start must not pass between query and mount, because a late
  reply would land on `Continue? [y/N]` (`workspace-mount.ts:771`).
- **No mouse reports can interleave:** mouse modes turn on only with `ENTER_FULLSCREEN`
  (`terminal.ts:20`), after the query.
- **Ink accepts an injected `stdin`:** `session-picker-run.tsx:39`.
- **Chalk stylers read `chalk.level` at call time** (`blink.ts:37-38` notes the trap of
  module-load capture), so one module-level selection is safe if no one captures it.
  **Captures to remove:** `render-lines.ts:66` (a module-load `theme.subtle(…)`) and the
  aliases `Thinking.tsx:13`, `PermissionPrompt.tsx:10`, `LineInput.tsx:14`,
  `CommandPalette.tsx:12`, `ListPanel.tsx:12` (all `const X = accentHex`).
- **The render caches are harmless:** `render-lines.ts:372`, `:740` hold coloured rows,
  and the palette is fixed before the first row exists (no mid-session change, Q8).
  `readHlCache` (`:372`) is keyed by limit only; the mode is set before any render, so a
  mode key is defensive — the test pins it anyway (S5).
- **Test env guard** (`scripts/test-preload.ts`, AGENTS §6) does not strip
  `COLORFGBG`; the code never reads the real env in tests (injected).

### Design

**1. Pure module `packages/tui/src/terminal-background.ts`** (React-free, Ink-free,
like `terminal.ts`):

```ts
export type ThemeSetting = "auto" | "dark" | "light";
export type ThemeMode = "dark" | "light";
export type Rgb = readonly [number, number, number];

export const BACKGROUND_QUERY = "\x1b]11;?\x1b\\\x1b[c"; // OSC 11, then DA1 as a sentinel
export const PROBE_TIMEOUT_MS = 200;                     // Q7
export const LATE_GUARD_MS = 5_000;

export function parseColorSpec(spec: string): Rgb | null;
export function modeOfBackground(rgb: Rgb): ThemeMode;
export function modeOfColorFgBg(value: string | undefined): ThemeMode | null;
export function canProbe(io: { stdinTty: boolean; stdoutTty: boolean; term?: string; chalkLevel: number }): boolean;
export function resolveMode(setting: ThemeSetting, probed: Rgb | null, colorFgBg: string | undefined): ThemeMode;

export interface ProbeState { /* buffer, colour, done */ }
export function stepProbe(state: ProbeState, chunk: string): ProbeState; // incremental; chunk boundaries anywhere
export function restOf(state: ProbeState): string;                       // every non-reply byte, in order

export interface LateFilter { /* partial, oscSeen, deadline */ }
export function stepLateFilter(f: LateFilter, chunk: string, now: number): { filter: LateFilter; pass: string };
```

- **`parseColorSpec`** accepts `rgb:H/H/H` with 1–4 hex digits per channel, scaled by
  channel width (`f`→255, `ff`→255, `fff`→255, `ffff`→255; `8000`→128), `rgba:H/H/H/A`
  (ignore A), `#RGB`, `#RRGGBB`, `#RRRGGGBBB`, `#RRRRGGGGBBBB`, case-insensitive.
  Mixed widths are accepted per channel. Anything else → `null`.
- **Reply grammar:** introducer `ESC ]` or `0x9d`, terminator BEL, `ESC \` or `0x9c`.
  Sentinel: `ESC [ ? digits/; c` or `0x9b ? …`. **Read in latin1** when the chunk is a
  `Buffer` (so `0x9c` survives); a stdin that a previous Ink mount left in utf8
  (`App.js:114`) yields strings, handled too, and the 8-bit forms simply do not occur
  there because of the memo in §3.
- **`modeOfBackground`:** WCAG luminance `Y > 0.179` → `light`. This is the exact point
  where black text and white text have equal contrast
  (`(1.05)/(Y+.05) = (Y+.05)/.05`), so it picks the side whose text stays readable.
- **`modeOfColorFgBg`:** last `;` field. `0-6`, `8` → dark; `7`, `9-15` → light;
  `default`, empty, non-numeric, out of range → `null`.
- **`canProbe`:** both TTY, `TERM` is not `dumb`, `chalk.level > 0` (colours off: no
  reason to pay for a query).
- **`resolveMode`:** setting `dark|light` wins with no query at all; else probed colour,
  else `COLORFGBG`, else `dark`.

**2. Driver `probeBackground(io)`** in the same package (`terminal-background-probe.ts`),
thin, with injected streams, timer and `ProcessLike`:

1. `setRawMode(true)` **before** writing (so a fast reply is never echoed).
2. `installTerminalRestore` (`terminal.ts:38`), so a SIGTERM in the window leaves the
   TTY cooked. `Ctrl+C` is a plain byte in raw mode; it joins the rest and reaches
   `App` as usual (`exitOnCtrlC: false`, `run.tsx:113`).
3. Add `readable`, loop `read()` into `stepProbe`, write `BACKGROUND_QUERY`.
4. End on the sentinel or the timeout. Remove the listener, `unshift` `restOf`.
5. **Sentinel seen:** nothing more is coming; `setRawMode(false)`. **Timeout:** stay raw
   and return `late: true`. Dropping to cooked here would make the tty ECHO a late reply
   onto the screen, and no filter can catch that. Ink's `setRawMode(true)` then takes
   over with no gap (`App.js:119`); `startTui` restores in its `finally` if the mount
   throws.

DA1 is the reason a terminal that ignores OSC 11 costs one round trip instead of the
whole timeout, and because replies come in order, a sentinel means no late OSC is
possible. Non-reply bytes are never dropped, including a lone `ESC`.

**3. Selection `prepareTheme(setting)`,** memoized per process, called first thing in
`startTui` (before `run.tsx:70`, its first statement) and `pickSession` (before
`session-picker-run.tsx:29`, its `render`).
Whichever mounts first probes; the second reuses the result. It needs no change in
`createLocalRuntime`, the transports, or the protocol, so §7's "one session path" is
untouched. The picker path keeps `late: true` until its Ink unmounts (`App.js:127`
goes cooked), then the runtime starts: a reply later than the human's pick would echo.
Accepted, see Failure modes.

**4. Late-reply guard (only when `late: true`).** `startTui` and `pickSession` pass
`render(..., { stdin: lateGuard(process.stdin) })`: a `Proxy` overriding `read()` to
run `stepLateFilter` (looping until a non-empty chunk or `null`, since Ink would feed
`""` to `parseKeypress`), everything else bound to the target.

- It is a stream-level seam, so it covers `App` and the picker with no change to the
  `App.tsx:2266` key handler (known debt, §7).
- **The normal path is byte-for-byte today's:** no Proxy when the sentinel arrived.
- `stepLateFilter` removes one OSC 11 reply and one DA1 reply wherever they sit in a
  chunk, keeps other bytes in order, and holds an incomplete reply across chunks.
- **A lone `ESC` chunk passes at once** (it is the Esc key), so a reply split right
  after ESC arrives as `]11;…`: while armed that prefix counts as a reply too. A user
  typing literally `]11;rgb:` inside 5 s of a timed-out probe is the accepted cost.
- **Disarm:** on DA1 (order guarantees OSC came first) or at `LATE_GUARD_MS`. A held
  partial at the deadline is dropped, as it can only be reply residue.
- The late colour is **ignored**: the palette is already on screen. It is wrong for this
  launch only, and `tui.theme` fixes it.

**5. One token table in `theme.ts`.** `tokens: Record<ThemeMode, Tokens>` holds every
value as data; `buildTheme(tokens)` makes the chalk stylers.

```ts
let mode: ThemeMode = "dark";
export function setThemeMode(m: ThemeMode): void;
export function themeMode(): ThemeMode;
export function palette(): Tokens;            // component path: <Text color={palette().accent}>
export function dimProps(): { dimColor: true } | { color: string };
export let theme = built.dark;                // chalk path: an ES live binding, existing call sites unchanged
```

- `theme.message` becomes the active `MessageStyle` (default args at `message-row.ts:43`,
  `:67` read it at call time); `messageRgb` and `syntaxRgb` move into `tokens`.
- `accentHex` is removed. Components read `palette().accent` at render.
- **Dark tokens keep named colours** (`"red"`, `"yellow"`, `"green"`, `"gray"`) and
  `dimColor`, so dark output is byte-identical to today (including `autoAccept`,
  `#fec20a`, which now exists — Finding 1).
- `read-highlight.ts`: default mode becomes `themeMode()` (`:185`), its `rgb` helper
  (`:104`) keeps reading `tokens`; drop the literal `"dark"` at `render-lines.ts:387`.
- `markdown.ts`: from the `marked.use` singleton (`:11`) to one `new Marked(...)` per
  mode (`Marked` is exported, `marked.d.ts:579`), lazily built. **Dark = today's
  `markedTerminal()` with no args.** Light passes the `md.*` tokens and
  `{ theme: highlightTheme("light") }`, exported from `read-highlight.ts`.
- `chalk.bold` (`render-lines.ts:555`), `theme.hidden`, `inverse` (`App.tsx:2746`,
  `LineInput.tsx:45`, `PermissionPrompt.tsx:82`) and `\x1b[39m`
  (`render-lines.ts:693`) carry no colour value: unchanged.

**6. Config.** `tui: z.object({ theme: z.enum(["auto","dark","light"]).optional() }).strict().optional()`
in `settingsShape` (`schema.ts:180`; `ProfileSchema` `:369`, `FileConfigSchema` `:378` both
spread it, so the file and profiles both get it). Merged field-wise as `detach` is
(`profile.ts:69`, `:73-78`). Default `auto` applied in the CLI, exactly as `rm` is
(`resolve.ts:119` → `:513`, `load.ts:114` → `:640`). Commented template line next
to `defaults.ts:161` (the `rm` block). Same shape as `keepAwake`
(`schema.ts:300`), the closest precedent.

**`connect` (Q6):** extract the parse+validate+profile block of `load.ts:504-536` into
an exported `readFileConfig({ profile })` (no scaffold, no prompt, no key, no prompt
file) so one parser stays the source of truth, and use it in the `connect` branch at
`main.ts:513`, before `connectTui`.
An invalid config there writes one `[config] … using tui.theme auto` line before the mount
and connects anyway: connect "needs no local model configuration" today, so a typo must
not start blocking it. The line goes to `err` (`main.ts:403`), which is the
pre-mount path (Ink has not mounted yet), never a raw write mid-session.

**7. New colour sites folded in (Findings 7).** `noticeHex`/`noticeHexLight` and
`autoAcceptHex` become `tokens.notice` / `tokens.autoAccept` (with the measured light
values of *Refresh drift* 1–2); the badge accent at `StatusBar.tsx:126` reads
`palette().accent`; `QuitConfirm` and `StatusBar`'s scrolled suffix read
`tokens.quit` / `tokens.status.scrolled` instead of the `"yellow"` literal
(`QuitConfirm.tsx:17`, `:21`; `StatusBar.tsx:140`), and `meterColor` (`StatusBar.tsx:12`)
returns `tokens.meter.*` instead of `"red"/"yellow"/"green"`. Dark keeps the named
colours there (byte-identical), light the measured ones.

### Inventory: every colour in use, with light values

Ratios are WCAG on the given background. **Every number below is MEASURED**
(`.tentacle/tmp/tui-light-theme/final-tokens.ts`), in truecolor and through chalk's
**real** 256 downgrade (`rgbToAnsi256`, `chalk/source/vendor/ansi-styles/index.js:111-131`),
and pinned by the `theme.test.ts` gate (S2). "White" is `#ffffff`; "Sol." is Solarized
Light `#fdf6e3`, as an off-white worst case. **The bar: 4.5:1 everywhere and at 256, at
both backgrounds; 3:1 for non-text; the named 256 exceptions are `accent` (Q3) and
`notice` (Refresh drift 2).**

Dark values do not change.

#### Text on the terminal background

| Token | Used at | Dark | Light | White | Sol. | 256 |
|---|---|---|---|---|---|---|
| `accent` | `theme.ts:18`, `:84`; `render-lines.ts:94`, `:275`, `:312`, `:460`; `message-row.ts:23`; `Thinking.tsx:28`; `PermissionPrompt.tsx:61`, `:77`, `:80`, `:95`; `LineInput.tsx:41`; `ListPanel.tsx:19`, `:26`; `CommandPalette.tsx:31`; `SessionPicker.tsx:40`, `:45`; `StatusBar.tsx:126` | `#06b6d4` | `#0e7490` | 5.36 | 4.97 | **4.13** (Q3) |
| `autoAccept` | `theme.ts:21`; `StatusBar.tsx:149` | `#fec20a` | `#a84a00` | 5.76 | 5.34 | 4.71 |
| `subtle` | `theme.ts:86`; ~30 uses in `render-lines.ts`, `message-row.ts:88` | `rgb(140,140,140)` | `#6b6b6b` | 5.33 | 4.94 | 5.25 |
| `dim` (Q4) | the `dimColor` sites below | SGR 2 | `#6b6b6b` | 5.33 | 4.94 | 5.25 |
| `gutter` | `LineInput.tsx:41`, `PermissionPrompt.tsx:80` | `"gray"` | `#6b6b6b` | 5.33 | 4.94 | 5.25 |
| `notice` | `theme.ts` `tokens.*.notice`; `render-lines.ts:590-591` | `#8caaee` | `#3b5bdb` | 5.67 | 5.25 | **3.54** (exception, drift 2) |
| `success` | `theme.ts` `tokens.*.success`; `render-lines.ts:237`, `:465` | `#4ec974` | `#084718` | 10.91 | 10.11 | 7.96 |
| `error` | `theme.ts:96`; `render-lines.ts:237`, `:334`, `:436`, `:447`, `:465` | `rgb(237,84,84)` | `#b21428` | 6.95 | 6.44 | 7.03 |
| `warn` | `theme.ts:97` (no call site; keep it) | `rgb(224,175,74)` | `#8f4c00` | 6.56 | 6.08 | 4.71 |
| `status.linkError` | `StatusBar.tsx:119` | `"red"` | `#b21428` | 6.95 | 6.44 | 7.03 |
| `status.linkWarn` | `StatusBar.tsx:119` | `"yellow"` | `#8f4c00` | 6.56 | 6.08 | 4.71 |
| `status.scrolled` | `StatusBar.tsx:140` | `"yellow"` | `#8f4c00` | 6.56 | 6.08 | 4.71 |
| `meter.low` / `.mid` / `.high` | `StatusBar.tsx:47` via `meterColor` (`:12-20`) | `"green"` / `"yellow"` / `"red"` | `#084718` / `#8f4c00` / `#b21428` | 10.91 / 6.56 / 6.95 | 10.11 / 6.08 / 6.44 | 7.96 / 4.71 / 7.03 |
| `quit` (text) | `QuitConfirm.tsx:21` | `"yellow"` | `#8f4c00` | 6.56 | 6.08 | 4.71 |

`dimColor` sites to convert with `dimProps()`: `App.tsx:2783`; `StatusBar.tsx:41`, `:46`,
`:48`, `:125`, `:127`, `:132`, `:142`, `:151`; `Thinking.tsx:29`; `PermissionPrompt.tsx:65`,
`:67`, `:73`, `:88`, `:101`; `LineInput.tsx:41`, `:49`; `ListPanel.tsx:28`, `:34`;
`CommandPalette.tsx:32`; `SessionPicker.tsx:35`, `:37`, `:40`, `:46`, `:52`, `:55`.

#### Non-text (the 4.5 bar does not apply; 3:1 used as the target)

| Token | Used at | Dark | Light | White | 256 |
|---|---|---|---|---|---|
| `border` | `App.tsx:2807`, `:2811` | `"gray"` | `#8c8c8c` | 3.36 | 3.45 |
| `quitBorder` | `QuitConfirm.tsx:17` | `"yellow"` | `#8f4c00` | 6.56 | 4.71 |
| `diff.border` | `theme.ts:115`; `dashedRule` `:125` | `rgb(88,88,96)` | `#8c8c8c` | 3.36 | 3.45 |

#### Text on a tint (ratio is against that tint, not white)

| Token | Used at | Dark | Light fg / bg | True | 256 |
|---|---|---|---|---|---|
| `diff.addFg` on `addBg` | `theme.ts:100`, `:102`; `render-lines.ts:200-201` | `rgb(248,248,242)` on `rgb(2,40,0)` | `#1a1a1a` / `#dafbe1` | 14.59 | 15.56 |
| `diff.addGutter` on `addBg` | `theme.ts:104`; `render-lines.ts:202` | `rgb(110,200,96)` | `#0f4c0f` / `#dafbe1` | 9.15 | 7.27 |
| `diff.addWord` | `theme.ts:106`; `render-lines.ts:203` | `rgb(248,248,242)` on `rgb(4,71,0)` | `#1a1a1a` / `#aceebb` | 12.14 | 14.70 |
| `diff.delFg` on `delBg` | `theme.ts:108`, `:109` | `rgb(248,248,242)` on `rgb(61,1,0)` | `#1a1a1a` / `#ffe1e1` | 13.23 | 12.95 |
| `diff.delGutter` on `delBg` | `theme.ts:111` | `rgb(230,100,100)` | `#b21428` / `#ffe1e1` | 5.66 | 5.34 |
| `diff.delWord` | `theme.ts:113` | `rgb(248,248,242)` on `rgb(92,2,0)` | `#1a1a1a` / `#ffb2b2` | 9.48 | 9.74 |
| `message.queuedFg` on `bg` | `theme.ts:36` (light row changes) | `rgb(140,140,140)` on `#373737` | `#5c5c5c` / `#eeeeee` | 5.76 | 5.60 |
| `accent` marker on message `bg` | `message-row.ts:23` | — | `#0e7490` / `#eeeeee` | 4.62 | **3.25** (Q3) |
| Sent text on message `bg` | `message-row.ts:34` (terminal fg, not ours) | — | black / `#eeeeee` | 18.1 | 5.02 |

The values at `theme.ts:36` change from `[232,232,240]` / `[110,110,120]`: the old grey
gives 4.14 on its tint, and the old tint collapses to white at 256. `#ffe1e1` and
`#ffb2b2` were picked so the del line and the changed word stay distinct at 256
(GitHub's `#ffebe9` rounds to pure white, `#ffc1c0` to the line's own tint).

#### Syntax (`read-highlight.ts:106-150`, tokens at `theme.ts:59-80`)

| Token | Dark (unchanged) | Existing light (ratio) | New light | White | Sol. | 256 |
|---|---|---|---|---|---|---|
| `keyword` | `#c678dd` | `#8839ef` (5.41; 256: 3.56) | `#5f1cb2` | 9.15 | 8.48 | 4.90 |
| `string` | `152,195,121` | `#408018` (4.86; 256: 2.76) | `#146e14` | 6.42 | 5.95 | 4.70 |
| `number` | `209,154,102` | `#be5a14` (4.50; 256: 3.34) | `#9c4600` | 6.38 | 5.92 | 4.71 |
| `comment` | `110,118,129` | `#787e87` (**4.09**) | `#646464` | 5.92 | 5.49 | 6.10 |
| `title` | `97,175,239` | `#1e66f5` (4.91; 256: 3.28) | `#1446c8` | 7.66 | 7.11 | 5.80 |
| `type` | `229,192,123` | `#a06e0a` (**4.44**) | `#784600` | 7.85 | 7.28 | 5.73 |
| `meta` | `86,182,194` | `#0e8296` (4.51; Sol. 4.18) | `#0e4c5f` | 9.47 | 8.78 | 7.03 |
| `tag` | `224,108,117` | `#c8283c` (5.49; 256: 3.69) | `#b21428` | 6.95 | 6.44 | 7.03 |

#### Markdown (`markdown.ts:11` → `marked-terminal/index.js:28-43`; light only)

| Token | Dark (unchanged default) | Light | White | Sol. | 256 |
|---|---|---|---|---|---|
| `md.code`, `md.codespan` | `chalk.yellow` | `#953800` | 7.39 | 6.85 | 4.71 |
| `md.firstHeading` | `chalk.magenta.underline.bold` | `#5f1cb2` | 9.15 | 8.48 | 4.90 |
| `md.heading` | `chalk.green.bold` | `#084718` | 10.91 | 10.11 | 7.96 |
| `md.blockquote`, `md.html` | `chalk.gray` | `#6b6b6b` | 5.33 | 4.94 | 5.25 |
| `md.del` | `chalk.dim.gray.strikethrough` | `#6b6b6b` (no dim) | 5.33 | 4.94 | 5.25 |
| `md.link`, `md.href` | `chalk.blue` | `#1446c8` | 7.66 | 7.11 | 5.80 |
| Fenced code | cli-highlight default | the syntax tokens above | | | |

### Files

In dependency order (each slice names the subset it touches):

1. `packages/config/src/schema.ts`, `profile.ts`, `resolve.ts`, `load.ts`, `defaults.ts`
2. `packages/tui/src/terminal-background.ts` (**new**, pure), `terminal-background-probe.ts` (**new**, driver)
3. `packages/tui/src/theme.ts` (token table)
4. `packages/tui/src/read-highlight.ts`, `render-lines.ts`, `message-row.ts`, `markdown.ts`
5. `packages/tui/src/components/{StatusBar,QuitConfirm,LineInput,PermissionPrompt,ListPanel,CommandPalette,SessionPicker,Thinking}.tsx`, `App.tsx` (`:2783`, `:2807`, `:2811` only)
6. `packages/tui/src/run.tsx`, `session-picker-run.tsx`, `index.ts`
7. `packages/cli/src/main.ts` (`:513`, `:525`, `:811`, `:846`, `:1630`, `:1680`), `connect.ts` (`:151`)
8. `CHANGELOG.md`, `README.md` (config note), `TODO.md`

**Not touched, by design:** `protocol`, `daemon`, `client`, `transport`,
`carried-settings.ts`, `tui-sessions.ts`, any pod/image path.

### Slices — ordered, each with its own red-first test and gate

Each slice is implemented and gated on its own (`bun test <package>`) before the next
starts, so the override works even if the probe has to be reworked. **S6 (the probe) is
its own slice with the strictest tests** — it is the one that touches the shared stdin.

| # | Slice | Files | Red-first test | Gate |
|---|---|---|---|---|
| **S1** | **Config**: `tui.theme` (file + profile), `readFileConfig` extraction | `config/src/{schema,profile,resolve,load,defaults}.ts` | `profile.test.ts`: a profile's `theme` overrides, base kept when absent. `load.test.ts`: `theme: "light"` resolves; `theme: "sepia"` refused with a message; unknown key under `tui` refused. `readFileConfig`: parses with no scaffold, no prompt file, no key, throws `ConfigError` on a bad value | `bun test packages/config` |
| **S2** | **The token table, dark only**: `tokens.dark` / `tokens.light` as DATA, `buildTheme`, `palette()`, `dimProps()`, `setThemeMode` — every component/`render-lines` site converted to `palette()`/`dimProps()`, `accentHex`/`autoAcceptHex`/`noticeHex*` removed | `tui/src/theme.ts`, the 8 components, `App.tsx` (§Files 5), `render-lines.ts:66` capture, `message-row.ts` | `theme.test.ts`: **dark byte-identity** — golden SGR for every dark styler, captured from today's `theme.ts`; both modes share a key set. `theme-no-stray.test.ts`: no `#rrggbb`, no `color="…"`/`borderColor="…"` literal, no `chalk.(rgb\|hex\|red\|…)`, no bare `dimColor`, no module-level `const X = theme.…`/`palette()` outside `theme.ts`. Behaviour tests unchanged and green | `bun test packages/tui` |
| **S3** | **The contrast gate**: the measured ratios as a test (no code change) | `tui/test/theme.test.ts` | for every light token × background, truecolor ≥ 4.5 (3 for non-text) on white **and** Sol., **and** the REAL chalk-256 downgrade ≥ 4.5, with `accent`/`notice` as the only named exceptions. Red on any future edit that breaks it | `bun test packages/tui/test/theme.test.ts` |
| **S4** | **Light mode on**: `setThemeMode("light")` flips every styler; `tui.theme: dark\|light` wired through `startTui`/`pickSession` (no probe yet) | `theme.ts`, `run.tsx`, `session-picker-run.tsx`, `index.ts`, `cli/src/main.ts` (the 4 mounts), `connect.ts` | `theme.test.ts`: `setThemeMode("light")` flips `theme.accent` **and** `palette()` (mutation: a captured alias at a component → red); `afterEach` resets. `render-lines.test.ts`: light diff tints + `CONNECTOR` follow the mode. `message-row.test.ts`: default style follows. `read-highlight.test.ts`: default mode follows, cache per mode. `markdown.test.ts`: dark = today byte-for-byte; light has no `\x1b[33m` inline code and fences use light tokens. `components.test.tsx`: `StatusBar` auto-accept ON/OFF paints `autoAccept`/`dim` in light. `main.test.ts`/`connect.test.ts`: every mount passes `theme` | `bun test packages/tui packages/cli` |
| **S5** | **`connect` + invalid config**: `readFileConfig` in the connect branch, one warn line, still connects | `cli/src/main.ts` (`:513` region) | `connect.test.ts`: `theme: "light"` reaches `startTui`; an invalid config writes ONE `[config] … using tui.theme auto` line through `err` **before** the mount and connects anyway | `bun test packages/cli` |
| **S6** | **The probe (its own slice, strictest)**: `terminal-background.ts` (pure: `parseColorSpec`, `modeOfBackground`, `modeOfColorFgBg`, `canProbe`, `resolveMode`, `stepProbe`, `restOf`, `stepLateFilter`), `terminal-background-probe.ts` (driver: raw, sentinel, timeout, `unshift`, `setRawMode` discipline) | both new files | `terminal-background.test.ts`: `parseColorSpec` every width/BEL/ST/8-bit/`rgba:`/`#RGB`/rejects; `modeOfBackground` both sides of 0.179; `modeOfColorFgBg` the full table; `resolveMode` precedence; `canProbe` each input off; `stepProbe` **every split point**, type-ahead before/between/after with `restOf` exact, lone `ESC` kept, 256-byte cap; `stepLateFilter` reply in one chunk, every split point, `]11;` fragment, lone `ESC` passes at once, disarm on DA1, deadline passes everything, normal typing untouched. `terminal-background-probe.test.ts`: **raw ON before the write** (mutation: swap → red); sentinel → raw OFF + listener gone + `late:false`; timeout → **raw stays ON** + `late:true` + rest unshifted; mute → returns in ≤ `PROBE_TIMEOUT_MS` on the injected clock; garbage reply consumed, nothing leaks; `canProbe` false → **no write and no `setRawMode`**; signal in the window restores; exactly-once across two calls; **no write after `lateGuard` hands over** (the stdin stays clean for Ink) | `bun test packages/tui/test/terminal-background.test.ts packages/tui/test/terminal-background-probe.test.ts` |
| **S7** | **`auto`, wired end to end** + docs | `run.tsx`, `session-picker-run.tsx`, `index.ts`, `CHANGELOG.md`, `README.md`, `TODO.md` | `prepareTheme` memoized once per process; `auto` → probed colour → `COLORFGBG` → dark; `lateGuard` only when `late` | full gate (§3 of the brief) |

**Why S6 is strictest:** it reads the one stdin every runtime shares, before Ink. Its
failure modes are the expensive ones — an echoed reply on screen, a swallowed keystroke,
a TTY left raw after a signal — so every one of them is a named test rather than a
byproduct. The red-first order inside S6 is: `parseColorSpec`/`stepProbe` (pure, cheap),
then the driver discipline (raw-before-write, timeout-keeps-raw, no-write-when-mute),
then `stepLateFilter`.

### Failure modes

| Case | What happens | Converges to |
|---|---|---|
| Terminal answers neither | Waits `PROBE_TIMEOUT_MS`, `late: true`, guard armed 5 s | `COLORFGBG`, else dark; cost 200 ms per launch (`tui.theme` skips the query) |
| Answers DA1 only | Sentinel ends it in one round trip | `COLORFGBG`, else dark || Answers DA1 only | Sentinel ends it in one round trip | `COLORFGBG`, else dark |
| **Answers after the timeout** | Raw kept so no echo; guard removes OSC + DA1 from Ink's input | Palette from fallback for this launch; nothing typed, nothing on screen |
| Late, on the picker path, later than the human's pick | Ink went cooked at unmount: **bytes can echo on the main screen**, then reach `startTui`'s guard if within 5 s | Accepted: needs a reply slower than a human choosing; cosmetic |
| Reply split across chunks, or byte by byte | `stepProbe` is incremental | Same result (`split_bytes`) |
| Unexpected format (`rgb:` garbage, `cmy:`, empty) | `parseColorSpec` → `null`; reply still consumed | Fallback; no bytes leak |
| Overlong/never-terminated OSC | Buffer cap 256 bytes inside `stepProbe`; beyond it, no longer a reply | Bytes returned as rest, at timeout; a garbage line in the editor beats losing input |
| Type-ahead during startup, keys in the window | `restOf` + `unshift` | Delivered to Ink in order |
| `Ctrl+C` in the window | Plain byte in raw mode, part of the rest | `App` handles it, as now, right after mount |
| SIGTERM/SIGINT in the window | `installTerminalRestore` | Cooked TTY, exit 128+n |
| Mount throws after a timeout | `finally` in `startTui` | Cooked TTY |
| Non-TTY (pipes, CI, tests), `TERM=dumb`, `NO_COLOR` | `canProbe` false; no byte written | `COLORFGBG`, else dark |
| stdin TTY, stdout piped (or the reverse) | `canProbe` false | As above |
| `tui.theme: dark|light` | No query, no raw mode | Setting |
| `tui.theme` invalid | Normal path: `[config error]` (`main.ts:576`); connect: one warning, `auto` | Clear message, never a silent drop |
| Second mount in one process | Memoized | One query per process |
| tmux | From memory, recent tmux answers OSC 11 from its own idea of the client's colours; old tmux ignores it and answers DA1 | Colour or fallback, both fine. Stale if the outer theme changed; `tui.theme` |
| screen | From memory, swallows OSC 11, answers DA1 | Fallback. No DCS wrapping (Q9) |
| SSH | Just a slower TTY: RTT above 200 ms → the late path | Fallback for that launch, no garbage. Raise via Q7 |
| Windows Terminal | Only `clipboard.ts:10`, `:20` branch on win32; not a tested target | Whatever answers works; otherwise fallback. Not on the live checklist |
| `COLORFGBG` stale (inherited from a parent) | OSC beats it; only used on no answer | Possibly wrong palette; `tui.theme` |
| Mid-background (e.g. `#808080`) | `Y > 0.179` → light; both palettes are weak there | Readable side; `tui.theme` |
| Terminal theme or auto day/night changes mid-session | Not detected | Out of scope (Q8): next launch |
| Colour-level drop (`chalk.level` 1) | Chalk maps to 16 ANSI colours; ratios unknowable | Named-colour behaviour; not gated |
| `tui` in a config read by a pod's old binary | `.strict()` schema refuses unknown keys; only if the pod loads the laptop's file | Same class as any new setting; check `docs/container-config-sources.md` in Review |

### Tests

Fakes follow `terminal.test.ts` (`ProcessLike`) and the injected streams of AGENTS §9; no
real TTY in any test. Every test below is written **first and shown RED on the real code**
(§9), and each behaviour gets **one mutation** (cp backup → mutate → red → restore →
`shasum` identical).

**`terminal-background.test.ts`** (pure, S6):
- `parseColorSpec`: each width 1–4, `rgba:`, all `#` forms, mixed widths, uppercase;
  rejects `rgb:`, `rgb:ff/ff`, `rgb:gg/00/00`, `cmy:`, 5 digits. Pins scaling by channel
  width (`8000`→128, `8`→136).
- `modeOfBackground`: both sides of 0.179; `#fdf6e3`, `#002b36`.
- `modeOfColorFgBg`: `15;0`, `0;15`, `0;default;15`, `12;8`, `0;7`, `default`, `""`,
  `abc`, `0;16`, undefined.
- `resolveMode`: full precedence table (`dark|light` never probes; probed beats
  `COLORFGBG`; dark last).
- `canProbe`: each input off (stdin TTY, stdout TTY, `TERM=dumb`, `chalk.level 0`).
- `stepProbe`: one chunk; **every split point** of OSC+DA1 (a loop over the string); BEL
  and ST terminators, the 8-bit forms; type-ahead before/between/after with `restOf`
  exact; a lone `ESC` retained; the 256-byte cap (garbage returned as rest, never lost).
- `stepLateFilter`: reply in one chunk; split at every point; the `]11;` fragment; a lone
  `ESC` passes unchanged **and at once**; keys around a reply; disarm on DA1; the deadline
  passes everything after it; **normal typing while armed is untouched** (the property
  that keeps the guard invisible).

**`terminal-background-probe.test.ts`** (fake stream, `ProcessLike`, injected timer, S6):
- **Order: raw ON before the write** (mutation: swap the two → red).
- Sentinel: raw OFF, listener gone, `late: false`.
- **Timeout: raw stays ON**, `late: true`, listener gone, rest unshifted.
- **Mute terminal**: the injected clock reaches `PROBE_TIMEOUT_MS` (200 ms) exactly once
  and the driver does not wait longer.
- **Garbage reply** (`rgb:` nonsense, `cmy:`, empty, overlong): consumed, `null` colour,
  no byte leaks to the rest.
- **Not probing** (`canProbe` false): **no write and no `setRawMode` at all**.
- A signal in the window restores the TTY (via `installTerminalRestore`).
- **Exactly-once** across two `prepareTheme` calls (second does not re-probe).
- **stdin left clean for Ink**: after `lateGuard`/hand-over the driver has written
  nothing to the terminal and every non-reply byte is in the unshifted rest, in order.

**`theme.test.ts`** (S2 + S3 + S4):
- **The ratios (S3):** for every light token and its background, WCAG ≥ 4.5 (non-text
  ≥ 3) on **white and Solarized Light**, **and** through chalk's real 256 downgrade, with
  `accent` and `notice` as the only named exceptions. This is the test that validates the
  inventory — a hand/token error shows up red.
- Both modes have the same key set.
- **Dark byte-identity (S2):** golden SGR for each dark styler, captured from today's
  `theme.ts` (`accentHex` `#06b6d4`, `autoAcceptHex` `#fec20a`, `noticeHex` `#8caaee`,
  `subtle rgb(140,140,140)`, …) before the change — red on any drift, including the new
  `autoAccept`/`notice` tokens.
- `setThemeMode("light")` flips `theme.accent` **and** `palette()` (mutation: a captured
  alias in a component → red). Each test resets with `afterEach`, since Bun shares the
  module across files.

**`theme-no-stray.test.ts`** (source scan of `packages/tui/src`, S2): outside `theme.ts`
no `#rrggbb`, no `color="…"`/`borderColor="…"` literal, no
`chalk.(rgb|hex|bgRgb|bgHex|red|yellow|green|gray|blue|magenta)`, no bare `dimColor`
prop, no module-level `const X = theme.…` or `palette()`. The "no stray hex" rule made
permanent — it is what catches the *next* colour site (Findings 7 had four).

**Behaviour, with `chalk.level = 3` as `render-lines.test.ts:29-34` does (S4):**
- `render-lines`: light mode uses the light diff tints and `CONNECTOR` (`:66`) follows the
  mode; `meterColor`/`dashedRule` follow it too.
- `message-row.test.ts`: default style follows the mode (updates `:6`, `:152`).
- `read-highlight`: default mode follows, cache per mode.
- `markdown`: dark output equals today's byte-for-byte; light has no `\x1b[33m` for inline
  code and fences use light tokens.
- `components.test.tsx`: `StatusBar` with auto-accept ON/OFF paints `autoAccept`/`dim` in
  light; `QuitConfirm` paints `quit`; `noticeLines` uses `notice` in both modes (extends
  the existing `notice-palette.test.ts` child probe).

**Config (S1):** `profile.test.ts` (profile overrides base, base kept when absent),
`load.test.ts` (invalid value refused with a message; unknown key under `tui` refused;
valid `light` resolves), `readFileConfig` (parses with no scaffold, no prompt file, no
key; throws `ConfigError` on an invalid file).

**CLI (S4 + S5):** `connect.test.ts` (setting reaches `startTui`; an invalid config warns
ONCE through `err` and connects), `main.test.ts` (all four mounts pass `theme`). No
real-terminal dependency (known issue, TODO.md:434).

### Live checklist (owner, real terminals)

For each of **iTerm2, Terminal.app, Ghostty, tmux inside iTerm2**, with one light and one dark profile:

- [ ] `tentacle` picks the right palette with `tui.theme` unset.
- [ ] Startup shows no stray characters, no visible delay.
- [ ] A diff, a `fs_read`, Markdown with code/heading/link, a queued message, a permission prompt, `/quit` confirm, an open palette and `--resume` picker are all readable.
- [ ] Status bar: link states, meter at <70/70/90%, auto-accept ON and OFF.
- [ ] `tui.theme: light` on a dark profile, and the reverse, apply with no query.
- [ ] After `/quit`, the shell is sane: typing echoes, `stty -a` shows `icanon echo`.
- [ ] Type fast during `tentacle run` start: letters end up in the input box, in order.
- [ ] `tentacle run` and `attach` to a pod, and `connect`: palette right on each.
- [ ] **Terminal.app:** `chalk.level` value; whether `dim`, accent at 256 are acceptable (Q3).
- [ ] **tmux:** `tmux -V`; result with `allow-passthrough` off (default). Also `screen` once: falls back without garbage.
- [ ] **Slow link:** `ssh` with a delay (or `tc`/Network Link Conditioner ≥ 300 ms RTT): nothing appears in the input box.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-06*

### Step 0 — the probe ran, and the design stands

Nine pty scenarios, output quoted in full in *Load-bearing assumption*. Nothing
mismatched, so no fallback was needed. Two facts the run added that the plan did not
know: `late_cooked` really does print the reply (`^[[?1;2c` on screen — the bug being
designed out), and `late_keepraw_gap` delivers the reply to Ink as one chunk, so the
late guard stays the small `read()` filter the plan described.

### Slice by slice

Each slice: a failing test written first, run RED, implemented, run GREEN, then one
mutation per behaviour (cp backup → mutate → red → restore → `shasum` identical).

**S1 — config (`packages/config`).** `tui: { theme: auto|dark|light }` in
`settingsShape` (`schema.ts`), merged per key in `profile.ts`, passed through
`resolve.ts`/`load.ts`, documented in `defaults.ts`; `readFileConfig` extracted from
`loadConfig` (both now share `readAndValidateConfigFile`). *Red:* 4/5 assertions
(`Unknown key 'tui'`, no `tui` in `ResolvedConfig`, no template line) — the
`.strict()` unknown-key refusal already held. *Green:* 9 tests. *Mutations, all red:*
whole-spread instead of per-key merge (needed a `r: { tui: {} }` case in the test to
be non-vacuous — the first attempt survived and I fixed the TEST, then it failed);
`resolve` drops `tui`; `.strict()` removed; the key removed; the template line
removed; `readFileConfig` applies no profile; it scaffolds (reusing `loadConfig`);
a bad value falls back to `{}` instead of throwing. 8 mutations.

**S2 — the token table, dark only (`packages/tui`).** `theme.ts` became
`tokens: Record<ThemeMode, Tokens>` + `buildTheme`/`palette()`/`dimProps()`/
`setThemeMode`/`themeMode`; `accentHex`/`autoAcceptHex`/`noticeHex*`/`messageRgb`/
`syntaxRgb` are gone. Nine components + `App.tsx` + `render-lines.ts` (`CONNECTOR`
capture → `connector()`) + `message-row.ts` (`theme.message` is the active style) +
`read-highlight.ts` (mode-addressed tokens). *Red:* `theme-no-stray.test.ts` failed on
**27 real sites** before any conversion (hexes, `color="yellow"`, `dimColor`,
`const ACCENT = accentHex`). *Green:* 1039 tui tests, dark byte-identical.
*Mutations, all red:* dark accent drifts; a styler frozen at module load; `subtle`
not switched per mode; a stray hex; `borderColor="yellow"` back; `dimColor` back; a
module-level `palette()` capture. 7 mutations.
*Drift:* the `no-stray` chalk rule had to allow `chalk.rgb(…)` fed FROM a token
(`read-highlight.ts` is the one legal site) — the rule now bans a *literal* colour
argument, not the call.

**S3 — the contrast gate (`theme.test.ts` → `theme-contrast.test.ts`).** The ratio
test computes WCAG itself, in truecolor (white + Solarized Light) **and** by asking
chalk what it actually paints at level 2. It found five light tokens below 4.5 at
256, three of which the plan's hand table had blessed (`success`/`meter.low`/
`md.heading` 4.43, `syntax.keyword`/`md.firstHeading` 4.42 — the 256 cube is coarse).
*Fix:* `#084718` green and `#5f1cb2` purple, measured 7.96 and 4.90 at 256.
*Mutations, all red:* `subtle` back to the non-exact grey (3.59); `success` back to
`#116329` (4.43); a pale border (2.6); a third named exception. 4 mutations.

**S4 — light mode on (`packages/tui` + `packages/cli`).** `prepareTheme(setting, io)`
memoized per process (`resetThemeForTest` for suites), `theme` on `TuiOptions` and
`PickSessionOptions`, and `theme: config.tui?.theme ?? "auto"` on all four mounts
(`runEngineTui`, worker, in-process, the local `--resume` picker) + `connect`.
*Red:* 5 component assertions (before the components read `palette()`).
*Green:* `theme-prepare.test.ts` 9, `theme-components.test.tsx` 5.
*Mutations, all red:* a forced setting probes anyway; the mode is not applied on
switch; `palette()` frozen at import (6 red); `dimProps()` ignoring the mode (2 red);
`auto` dropping the `COLORFGBG` fallback; the memo dropped (2 queries).
**One trap worth recording:** the first `setThemeMode("light")` leaked into 16
queue/steering tests in *other files* — Bun shares the module. Resetting required
`beforeAll`+`afterEach`+`afterAll`, not `afterEach` alone.

**S5 — `connect` (`packages/cli`).** `connectTheme(options, write)` reads the file
through `readFileConfig` (no scaffold, no prompt, no key), **before the dial**, so a
bad file warns once and the connection still happens; an explicit `theme` wins.
*Red:* 5 tests. *Green:* 7. *Mutations, all red:* the file ignored (3 red — connect
would always probe); (also covered: the profile applied, the no-scaffold case).
*Drift:* `connectTheme` is exported for the test rather than reached through a full
`connectTui`, because every fake daemon in the suite throws before `startTui`; the
property that matters (file → setting, warn-don't-refuse) is exactly what the unit
test pins.

**S6 — the probe (its own slice; `terminal-background.ts` + `-probe.ts`).**
Pure half: `parseColorSpec` (1–4 hex digits per channel, scaled per channel;
`rgba:`; `#` forms), `modeOfBackground` (0.179), `modeOfColorFgBg` (last field),
`canProbe`, `resolveMode`, `stepProbe` (incremental, holds a *reply candidate* apart
from the bytes to hand back), `restOf`, `stepLateFilter`. Driver: raw **before** the
write, `installTerminalRestore`, the sentinel, the timeout that **stays raw**, the
`unshift`, and no write when `canProbe` is false. *Red:* 33 pure + 9 driver tests
after the module existed; the parser itself was driven by a pty trace, not guessed.
*Green:* 42. *Mutations, all red:* channel width ignored; the light threshold
flipped; the held prefix dropped instead of returned (data loss); the late filter
never disarms; write before raw; timeout goes cooked; the whole buffer unshifted
instead of the rest; probing when `canProbe` is false; no timeout timer. 9 mutations.

**S7 — `auto`, wired.** `readThemeSetting(setting, io)` on the real process
(`processIo()`), called **first** in `startTui` and `pickSession`; `lateGuard(stdin)`
wraps Ink's stdin only when the probe timed out. *Green:* memoization and the
precedence table pinned in `theme-prepare.test.ts`; the driver's late path in S6.
*Drift (recorded, not hidden):* `startTui`/`pickSession` themselves have no unit test
for the wiring — they are Ink mounts, and the repo's own note (TODO.md) says there is
no real-terminal test. The evidence is (a) `prepareTheme`'s unit tests, (b) the
driver's, (c) the pty run, (d) the owner checklist below.

### Two design decisions the code forced (both recorded in *Refresh drift*)

1. **Three light greys changed** because the plan's `256` column modelled chalk's
   downgrade as rounding; it is `rgbToAnsi256`, which uses the grey ramp **only for an
   exact** `r=g=b`. `#6b6b6f` → cube → 3.59. Fixed by using exact greys
   (`#6b6b6b`, `#646464`, `#8c8c8c`) and a darker diff foreground (`#1a1a1a`, which
   survives the `#ffb2b2` word tint at 9.74 where `#202024` fell to 3.65).
2. **The owner's notice blue `#3b5bdb` is KEPT** (3.54 at 256) as the second named
   exception: a later, merged, explicitly-chosen owner decision about that exact token
   outweighs a general gate about a different one. One hex flips it (`#2f4ba8`,
   5.61) if Review prefers.

### A process failure worth recording

The final mutation sweep (run after lint/format fixes, to prove the tests still bite on
the as-built code) **left one mutation in the tree**: its `cp` restore for
`packages/config/src/profile.ts` failed (the backup had not been copied into the sweep's
directory, and `cp`'s error was swallowed by the loop), so `config.tui = { ...tui }`
without the per-key base survived into the first full-suite run. The suite caught it —
`tui-theme.test.ts:59`, the empty-`tui`-keeps-the-base case — which is the test doing
its job on a real regression. Restored by hand and re-verified: `profile.ts`'s shasum
equals the original S1 backup's (`6b518ee…`), and every other file in the sweep matched
`shasum -c`. **The lesson for Review:** a mutation-restore loop must check the restore
(`shasum -c`) *inside* the loop, per file, not once at the end.

### What is NOT verified

- **Real terminals.** The probe was proven on one pty (macOS, Bun 1.4.3) and under
  tmux-free conditions. tmux, screen, Terminal.app, Ghostty and a slow SSH link are on
  the owner's checklist and were not run here.
- **`chalk.level` on Terminal.app** (Q3): the 256 column is measured, but which level
  that terminal reports is the owner's to confirm.
- **A light palette on real eyes.** The ratios are computed; whether the light diff
  tints read well is a judgement the checklist makes.
- **`startTui`/`pickSession` wiring** has no unit test (see S7).
- **`apps/mobile`'s typecheck was not runnable here:** its `node_modules` is absent in
  this worktree (CI installs mobile separately, with `--filter '!@tentacle/mobile'`), so
  `tsc -p apps/mobile` fails on missing `expo`/`react-native` types. **This task touches
  no mobile file** (`git status apps/mobile` is empty). The gate that was run:
  `tsc --noEmit` (clean), `biome check .` (clean, 0/0), `bun test packages`.

### Owner's live checklist

- [ ] On a **dark** terminal: `tentacle` — the palette is unchanged from before this
      task (compare a diff and a `fs_read`).
- [ ] On a **light** terminal (e.g. Terminal.app "Basic", or iTerm2 with a light
      profile): the same screens are readable — text dark on white, diff tints pale
      green/red with dark text.
- [ ] `tui.theme: "light"` on a dark terminal, and `"dark"` on a light one: the
      palette follows the setting and startup shows **no query and no delay**.
- [ ] `tui.theme` unset: startup shows no stray characters, and the delay is
      imperceptible (the cap is 200 ms).
- [ ] **tmux:** in a pane, the palette is right (or falls back cleanly — nothing
      garbled, nothing typed appearing by itself).
- [ ] **A mute terminal** (e.g. `TERM=dumb`, or a pty that swallows OSC 11): startup
      waits **≤ 200 ms**, then the dark palette; typing during startup lands in the
      input box, in order.
- [ ] `connect` to a `serve` daemon with `tui.theme: "light"` in the config, then with
      a deliberately broken config: the palette follows, and the broken one prints one
      `[config] … — using tui.theme auto` line and still connects.
- [ ] After `/quit` on each run: the shell is sane (`stty -a` shows `icanon echo`),
      and Ctrl+C during the first 200 ms leaves a cooked terminal.

## Review

*— not started* (mandatory fresh context, §10). Red-team: the raw-mode window, late-reply
guard, `Proxy` vs Ink internals, dark byte-identity, a light token missed by the scan.

---

## Owner questions

1. **Accent light value.** The TODO's `#0891b2` is 3.68:1, under the 4.5 bar. **Recommend `#0e7490`** (5.36), same hue family.
2. ~~**`#fec20a`** is not on the branch~~ **settled by the merge:** it landed in `feat/tui-target-badge` (`theme.ts:21`, wired at `StatusBar.tsx:149`), so this task only adds the light value. Also, **light value: recommend `#a84a00`** over the TODO's `#b45309` (5.76 vs 5.02 in truecolor, but 4.71 vs 2.86 at 256).
3. **256-colour gate (Terminal.app).** Every light value clears 4.5 at 256 except the accent: `#0e7490` rounds to 4.13 (3.25 on the message tint), the best cyan-like bucket reaches only 4.36, and clearing 4.5 would mean navy. **Recommend:** gate 4.5 in truecolor everywhere and at 256 for all but the accent, with the accent as a named exception; judge it live. Alternative: per-token 256 overrides (more machinery, not worth it for bullets and a badge).
4. **`dimColor` in light mode.** SGR 2 is terminal-defined, so its contrast cannot be measured. **Recommend** an explicit `#6b6b6f` in light (about 25 prop sites via `dimProps()`), keeping SGR 2 in dark. Alternative: keep SGR 2 everywhere (smaller diff, unmeasured).
5. **Markdown and fenced code,** not in the TODO's list, in scope? **Recommend yes:** assistant text is most of the screen and ANSI yellow on white is the worst offender. Costs `markdown.ts` plus 7 tokens.
6. **Should `connect` honour `tui.theme`?** It loads no config today. **Recommend yes,** via a small `readFileConfig` extraction; an invalid file warns and connects. Alternative: `auto` always on connect (no config code, but a surprising exception).
7. **Probe timeout.** It is the maximum startup cost on a mute terminal, and the threshold where a slow SSH link falls back. **Recommend 200 ms** (with `tui.theme` to skip it entirely). Higher suits SSH, lower suits local.
8. **Mid-session theme change** (including auto day/night). **Recommend out of scope:** decided once at launch, next launch picks it up. It needs polling or terminal notifications plus invalidating the render caches.
9. **tmux/screen passthrough.** **Recommend no DCS wrapping:** it needs `allow-passthrough` on recent tmux, and the fallback chain already covers it. Alternative: wrap when `TMUX` is set (more cases, little gain).
10. **Override surface.** `tui.theme` in file and profiles, as requested. Should there also be an env var or a flag? **Recommend config only for now,** even though `defaults.ts:78` describes env as the top layer; `keep` and `detach` set the precedent, and it is easy to add later.

### Owner answers (2026-11-05)

All ten recommendations ACCEPTED as written (accent light `#0e7490`; `#fec20a` arrives with feat/tui-target-badge — if not, this task adds the token; 4.5:1 gate in truecolor everywhere and at 256 colours for all but the accent; explicit light dim grey `#6b6b6f`, SGR 2 kept in dark; markdown and fenced code in scope; `connect` honours `tui.theme` via a small `readFileConfig` extraction; probe timeout 200 ms; no mid-session theme change; no tmux/screen DCS wrapping; override via config only). Recorded by the orchestrator.

### Owner note — non-blocking (executor, 2026-11-06)

**No question stops the work.** One token is a judgement call, resolved and flagged so
Review can overrule in one line:

- `feat/tui-notice-palette` (merged) fixed the **light** notice blue at **`#3b5bdb`**.
- Q3's answer gates **4.5:1 at 256 for all but the accent**; measured, `#3b5bdb` is
  **3.54** there.
- **Taken: the owner's `#3b5bdb`**, because a later, merged, explicitly-chosen owner
  decision about that exact token outweighs a general gate about a different one. It is
  the **second named 256 exception** beside the accent, and `theme.test.ts` records both.
  To switch to the gate: `#2f4ba8` (7.80 / 7.23 / **5.61**) — one hex.

Same class, no owner input needed (visually indistinguishable, and the owner's own 256
gate decides it): `#6b6b6f` → **`#6b6b6b`** for the dim greys (`#6b6b6f` measures 3.59 at
256 — see *Refresh drift* 1).
