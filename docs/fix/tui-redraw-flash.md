# fix/tui-redraw-flash — the TUI flashes while "Thinking…" (unsynchronized full-screen repaint per spinner tick)

> **Status:** implementation (approved by delegation, 2026-11-16)
> **Branch:** `fix/tui-redraw-flash`
> **Type:** fix · **Size:** S · **Blast:** cross-module (terminal I/O path: every byte Ink writes) · **Suited:** Opus executes (single slice `all`); standard Review + owner live check in their terminal
> **Changelog:** `changelog.d/tui-redraw-flash.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-16*

Owner, 2026-11-14, live: "ogni tanto quando tentacle gira vedo come un flash sul
terminale come se tutto si rerenderizzasse" — noticed while the agent is
"Thinking…" (braille spinner + elapsed timer). HIGH for daily-driver feel.

**Symptom characterization (AGENTS §1).**
- *Trigger:* a turn is running and the `Thinking` row animates. The spinner ticks
  every **80 ms** (`packages/tui/src/components/Thinking.tsx:11,20`), not every
  second, so the frame changes ~12.5×/s.
- *Magnitude:* "ogni tanto" (now and then), random. That is not a layout bug (a
  layout bug would flash on every tick, or at a fixed event). It looks like
  **tearing**: the terminal sometimes paints the screen half-way through a write.
- *Collateral:* none reported (no shifted lines, no lost content).

**Repro** (2026-11-16, `.tentacle/tmp/tui-redraw-flash/repro.ts`). It mounts the
real `App` with Ink's real, non-debug renderer. `ink-testing-library` forces
`debug: true`, which skips `log-update`, so it could not show this. The stdout is
a fake TTY (`isTTY`, `columns`, `rows`, `resize` events) that records every
`write`. A `createSession` whose `send()` never yields keeps the TUI in
"Thinking…". The script counts the escape sequences per trigger:

```ts
// core of the script (imports by absolute path into the worktree's packages/tui)
class Out extends EventEmitter { isTTY = true; columns = 100; rows = 30; writes: string[] = [];
  write = (s: string) => { this.writes.push(s); return true; }; }
// In: the ink-testing-library Stdin shape (isTTY, write → 'readable'+'data', read()).
const count = (ws: string[]) => { const all = ws.join(""); return {
  writes: ws.length,
  clearTerminal: all.split("\x1b[2J\x1b[3J\x1b[H").length - 1,   // ansiEscapes.clearTerminal
  eraseLine: all.split("\x1b[2K").length - 1,                     // eraseLines(n) = n × ESC[2K
  maxEraseInOneWrite: Math.max(0, ...ws.map((w) => w.split("\x1b[2K").length - 1)),
  linesPerWrite: [min, max of w.split("\n").length], bytes: all.length }; };
const createSession = () => ({ ...inertSession(), async *send() { await new Promise(() => {}); } });
render(h(App, { createSession, model: "qwen3", cwd: "/tmp/work", initialItems? }),
       { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
// thinking: type "hi", "\r", wait 300 ms, reset writes, wait 5000 ms, count.
```

Output (`bun .tentacle/tmp/tui-redraw-flash/repro.ts`):

| trigger | writes | clearTerminal | eraseLine | erase/write | lines/write | bytes |
|---|---|---|---|---|---|---|
| (a) Thinking 5 s, short transcript, 100×30 | 66 | **0** | 1980 | **30** | 30 | 43 890 |
| (b) Thinking 5 s, transcript > rows, 100×30 | 66 | **0** | 1980 | **30** | 30 | 59 136 |
| (c) palette `/` open + close, idle | 2 | 0 | 60 | 30 | 30 | 1 644 |
| (d) resize 100×30 → 80×24 (shrink) | 2 | **1** | 30 | 30 | 24–30 | 980 |
| (d2) resize 100×30 → 120×40 (grow) | 1 | 0 | 30 | 30 | 40 | 707 |
| (f) Thinking 5 s, tiny terminal 100×8 | 72 | **72** | 0 | 0 | 9 | 28 368 |

(`lines/write` counts `split("\n")`, so 30 means a 29-row frame plus the trailing
newline. That is `rows − 1`: the frame keeps one slack row, by design.)

**What the evidence says.**
1. The TODO's first suspect is **falsified**. At normal sizes the Thinking tick
   does not trigger Ink's `clearTerminal` path, with a short transcript or a tall
   one ((a), (b): 0). The frame is always `rows − 1` rows tall
   (`app-layout.ts:181,324`, `RESERVED_ROWS` with its slack row,
   `app-layout.ts:68-71`), so `outputHeight >= stdout.rows` is false.
2. The real mechanism: on every changed frame (about 13/s while Thinking), Ink 5's
   `log-update` writes `eraseLines(30)` followed by the **whole screen**:
   `stream.write(ansiEscapes.eraseLines(previousLineCount) + output)`
   (`node_modules/ink/build/log-update.js:17`). Ink 5.0.1 has no line diff. That
   write is about 700 B of "erase everything" followed by "draw everything". The
   terminal gets it as a byte stream, possibly in several reads (Bun's tty
   write queue, PTY buffer). If it renders a frame between the erase and the
   redraw, the screen shows blank or half-drawn for one refresh. That fits "ogni
   tanto, come se tutto si rerenderizzasse".
3. Collateral full clears exist but are not the reported trigger:
   - (d) on a shrink, Ink's `resized` handler (`ink.js:83-86`) re-renders the old,
     taller React frame before `App`'s own size state updates. Then 29 ≥ 24, so it
     takes the `clearTerminal` branch (`ink.js:121-122`) once.
   - (f) below 9 rows, `termRows = Math.max(8, sizeRows)` (`app-layout.ts:181`)
     makes the frame taller than the terminal, so **every tick** is a
     `clearTerminal` (72/72).
4. The palette and dock toggles (c) keep the frame height and do no full clear.
   Each one is still one erase-all + redraw write, like any frame.

**Constraints.** Ink 5.0.1 and React 18.3.1 are pinned (AGENTS §6; Ink 6 needs
React 19). Patching Ink in `node_modules` is not an option. AGENTS §7 "Never
write raw to the terminal while Ink owns it" applies.

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

**Each Ink frame reaches stdout as exactly ONE `stdout.write(string)` call.** If
that holds, wrapping that one write in DEC synchronized output (BSU
`ESC[?2026h` … ESU `ESC[?2026l`) makes each frame atomic on a terminal that
supports mode 2026. Such a terminal holds its paint until ESU, however the bytes
were chunked.

Evidence:
- `log-update.js:17`: the erase and the new frame go out as one write.
- `ink.js:122`: the full-clear branch is one write (`clearTerminal + static + output`).
- The only multi-write path is `<Static>` (`ink.js:126-130`), and the TUI uses no
  `<Static>` (`rg "<Static" packages/tui/src` → nothing).
- Repro: each frame is one write that starts with its 30 erases (`erase/write = 30`
  with `writes ≈ frames`).

### Preconditions

- Ink takes an injectable `stdout` in `render(tree, { stdout })`. The session
  picker already uses this (`packages/tui/src/session-picker-run.tsx:34,48`).
  The main TUI passes none, so Ink uses `process.stdout`
  (`packages/tui/src/run.tsx:169,204`).
- Ink reads only `write`, `columns`, `rows`, `on/off('resize')` from stdout
  (`ink.js:77-80,93,121`), plus `isTTY` through `useStdout` consumers. `App` reads
  `stdout.columns`/`rows` (`App.tsx:232,239-240`).
- The TUI runs on the alternate screen (`terminal.ts:20`, `ENTER_FULLSCREEN`
  written before mount, `run.tsx:128-130`). Nothing else writes to stdout while
  Ink owns it. The theme probe runs before the mount (`run.tsx:118`), and
  `LEAVE_FULLSCREEN` runs after unmount (`run.tsx:208`).
- Terminals that do not implement a DEC private mode ignore DECSET/DECRST for it
  (standard VT behaviour; mode 2026 was designed to degrade this way). *Unverified
  here on Terminal.app / tmux; Execution checks it live, see Tests T4.*

### Design

1. **New pure-ish module `packages/tui/src/sync-output.ts`:**
   - `export const BSU = "\x1b[?2026h"`, `export const ESU = "\x1b[?2026l"`.
   - `export function synchronizedStdout(stream)` returns a small delegating
     object, typed as the subset Ink uses and cast at the one call site:
     - `write(chunk, ...rest)`: a non-empty string becomes
       `stream.write(BSU + chunk + ESU, ...rest)`. Anything else is passed through
       unchanged.
     - `columns`, `rows`, `isTTY`: **live getters** on `stream`, never copied
       values, so a resize is seen.
     - `on`, `off`, `once`, `removeListener`, `addListener`: forward to `stream`
       and return the wrapper.
   - Use explicit delegation, not `Object.create(stream)`: an inherited
     EventEmitter method would write `_events` onto the wrapper and split the
     listeners.
2. **Wire it once, in `startTui`** (`run.tsx:169-205`): pass
   `{ stdin, stdout: fullscreen ? synchronizedStdout(process.stdout) : process.stdout, exitOnCtrlC: false }`.
   Only on a TTY, the same gate as the alt-screen (`run.tsx:122`). A piped or
   non-TTY stdout is unchanged.
3. **No layout change.** The resize-shrink clear (d) and the < 9-row clear (f)
   become atomic too on a mode-2026 terminal, so no flash. Their geometry stays
   as it is (Q3, Q4).
4. Not in scope: a line-diff renderer, which would rewrite only the changed rows
   (the spinner line) instead of 29. It is the only fix for terminals without mode
   2026 (Q2).

§7 check: the wrapper adds **no write of its own**. It brackets Ink's own writes,
so "never write raw to the terminal while Ink owns it" holds. Every write opens
and closes its sync, so no "sync left open" state can outlive a write. Even a
throw between writes leaves the terminal balanced. No protocol, persistence or
daemon change, so no `protocol.d/` note.

### Files

1. `packages/tui/src/sync-output.ts`: new, about 40 lines.
2. `packages/tui/src/run.tsx`: the `render(...)` options, one line plus the import.
3. `packages/tui/test/sync-output.test.tsx`: new (T1–T3).
4. `changelog.d/tui-redraw-flash.fixed.md`: `- **No more flashes while the agent works.** …`.
5. `TODO.md`: tick the entry and link this doc.

### Failure modes

- **Terminal without mode 2026 (Terminal.app, older xterm, Linux console):** it
  ignores the DECSET/DECRST, so there is no visible change and no garbage. The
  flash can remain there, because each frame is still erase-all + redraw. Q2's
  follow-up covers that. To verify live (T4): no `?2026h` text on screen.
- **tmux:** a recent tmux understands mode 2026 from the pane and syncs its own
  redraw. An older one ignores it (same as above). It never leaks to the outer
  terminal as text, because tmux parses all CSI. Live check in T4 if the owner
  uses tmux.
- **Terminal holds sync forever (lost ESU):** impossible by construction, since BSU
  and ESU travel in the same string, so a partial `write` still delivers both in
  order. Terminals also time out a sync update (about 150 ms–1 s) by spec.
- **Resize:** `rows`/`columns` are live getters and `on('resize')` reaches the real
  stream, so Ink's `resized` and `App`'s size update both fire. T2 pins this. A
  copied `rows` would freeze the layout: the classic mistake here.
- **Very small terminal (< 9 rows):** still a `clearTerminal` per tick (f), now
  atomic on 2026 terminals. It stays a flash on terminals without 2026. Accepted
  (Q4).
- **Non-TTY / piped stdout:** not wrapped (gate in Design 2), so the bytes are
  identical to today.
- **Ink writes outside a frame** (`useStdout().write`, the unmount
  `lastOutput + "\n"`, `ink.js:146-154,191`): wrapped too, which is harmless. Each
  one is a self-contained synchronized update.
- **Session picker:** not wrapped. It repaints only on a key and has no animation.
  Not worth changing its injected-stdout tests (Q5).
- **Perf:** +16 bytes per frame on top of about 700, which is negligible.

### Tests

Red before green (§9). The executor first lands the seam with **today's
behaviour**: `synchronizedStdout` as an identity pass-through, wired in
`run.tsx`. T1 must be **red** against it, and the output goes in Execution. Then
the executor implements the wrapping and shows T1 green.

- **T1 (the bug's property, red today): every frame is one complete synchronized
  update.** Mount `App` with Ink's real non-debug `render`, the repro's fake TTY,
  `stdout: synchronizedStdout(fake)`, and a hanging `createSession`. Submit a
  prompt and let "Thinking…" tick about 400 ms. Assert that every recorded write
  that contains `\x1b[2K` or `\x1b[2J` starts with `BSU`, ends with `ESU`, and
  contains exactly one of each. Also assert that at least 3 such frames were
  written, so the test cannot pass vacuously. Today (identity) every frame is
  bare, so it is red.
- **T2 (resize stays live):** through the wrapper, set `fake.rows = 24` and
  `columns = 80`, then emit `resize`. Assert the next frame (BSU/ESU and the erase prefix stripped)
  has at most 23 rows (`rows − 1`, the slack row). That means `App` re-laid out to
  the new size.
  Mutation: copy `rows` at wrap time and T2 must fail.
- **T3 (wiring pinned):** a structural assertion in the repo's `*-structure`
  style, reading `run.tsx`. The Ink `render(` options pass
  `synchronizedStdout(process.stdout)` under the `fullscreen` gate. Mutation:
  drop the wrap from `run.tsx` and T3 fails. T1 alone cannot catch that, because
  it builds its own wrapper.
- **Unit:** `synchronizedStdout` passes a non-string or empty write through
  untouched (no empty BSU/ESU pairs) and forwards `rest` (encoding/callback).
- **T4 (manual, owner/Execution, the only proof of the *visible* property):** in
  the owner's terminal (iTerm2 / Ghostty), run a long "Thinking…" turn and see no
  flash. In Terminal.app and in tmux, see no `?2026` garbage and no regression.
  Record which terminal it was. T1 proves frame atomicity, which kills the flash
  only where mode 2026 is supported. It does **not** prove the flash is gone on
  terminals without 2026, and the doc says so.

#### Owner questions

1. **Fix shape: synchronized output (BSU/ESU around each Ink frame) as the
   fix?** *Recommendation: yes.* It is one module plus one line. It attacks the
   measured mechanism (an erase-all + redraw write that can be painted half-way),
   and it is a no-op where unsupported.
2. **Line-diff renderer** (rewrite only changed rows, about 1 row per tick instead
   of 29): the only cure on terminals without mode 2026 (Terminal.app). It means
   intercepting Ink's `eraseLines(n)+frame` writes and diffing against the
   previous frame. That is fragile and larger. *Recommendation: not now.* Open a
   follow-up TODO entry, built only if the owner still sees the flash after this
   fix, or uses Terminal.app daily.
3. **Resize-shrink full clear (d):** suppress it? *Recommendation: no.* One clear
   per resize is legitimate on the alt screen, and atomic once synced.
4. **< 9-row terminals (f):** clamp the frame to `rows − 1`? *Recommendation: no,*
   because the TUI is not usable at that size anyway. Note it as debt.
5. **Session picker:** wrap it too? *Recommendation: no.* It has no animation.
6. **Kill switch** (env/config to disable mode 2026)? *Recommendation: no.* An
   unknown DECSET is ignored by spec. Add a switch only if a real terminal shows
   garbage (T4 would catch that).

#### Orchestrator decisions (owner delegated 2026-11-16)

The owner asked to get going now. Each recommendation above is adopted:

1. Q1: adopted. BSU/ESU around every Ink frame, via `synchronizedStdout` wired in `startTui` (TTY only).
2. Q2: adopted. No line-diff renderer in this task. A follow-up TODO entry is added if T4 or the owner's daily use still shows a flash (Terminal.app).
3. Q3: adopted. The resize-shrink clear stays (atomic once synced).
4. Q4: adopted. No < 9-row clamp. Recorded as debt.
5. Q5: adopted. The session picker is unchanged.
6. Q6: adopted. No kill switch.

**Implementation approved by delegation, 2026-11-16.** One slice (`all`), executed by Opus.

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*
