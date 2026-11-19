# fix/mobile-foreground-jump — A return from another app never moves the transcript

> **Status:** execution done — awaiting Review
> **Branch:** `fix/mobile-foreground-jump`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Opus exec + standard Review (with frames)
> **Changelog:** `changelog.d/mobile-foreground-jump.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-19*

`docs/fix/mobile-qa-1118.md` (bug 4) removed the foreground scroll LOOP. The
simulator QA of 2026-11-18 afternoon (`.tentacle/tmp/mobile-qa-1118b/REPORT.md`
row 7, `shots/27 → 29`, `28-foreground-return.mp4`) still saw, on the FIRST
return from another app, one jump of the transcript (~244 pt toward the end)
and the "Jump to latest" pill turning into a spurious **"New messages"**; a
second return was still. The QA suspected the resync rebuilding rows that
differ from the live ones (the vanishing Thought rows, since fixed by
`docs/fix/thought-placeholder.md`).

**Owner's rule (2026-11-18):** on return the conversation stays EXACTLY where it
was — no scroll, and no pill unless there really are new messages.

**Repro (2026-11-19, simulator, `main` 0bde7175).** Own simulator (iPhone 17 Pro
Max 0B43D716…, iOS 26), `bun apps/mobile/e2e/run.ts --ios 26 --udid … --only
01-shell --hold` (Release build, real `serve` on an ephemeral port — 59474 —
mock model). Each return: `simctl launch com.apple.Preferences`, 6 s, `simctl
launch so.tentacle.app`, recorded (`simctl io recordVideo`), with the row
bounds read from `maestro hierarchy` before and after (`fgh.sh`, `rows.py` in
`.tentacle/tmp/mobile-foreground-jump/`). Session Alpha:

| case | 1st return | 2nd return |
|---|---|---|
| short session (fits the screen), thinking turn done | still | still |
| ~5 screens, at the end | still | still |
| ~5 screens, scrolled up | still | still |
| ~5 screens, live TOOLROWS29 turn (thoughts) then scrolled up | still | still |
| ~5 screens, THINKHOLD turn RUNNING, its rows on screen | still | still |
| **~20 screens (10 more SHOWCASE turns), scrolled up 1 screen** | **jump + "New messages"** | still |

So after `thought-placeholder` the live and the reloaded rows agree (a pure
check — `livereload.ts` — shows the same kinds in the same order; only the
never-stored reasoning TEXT differs) and that alone moves nothing. What every
case shows is that **each return re-keys every row**:

```
BEFORE: row-r46[0,-64][440,374] row-r48[0,374][440,429] … row-r57[0,755][440,815]
AFTER : row-r75[0,-64][440,374] row-r76[0,374][440,429] … row-r85[0,755][440,815]
```

and on a session long enough that rows sit outside the list's render window
(`FlatList` default `windowSize` 21 ⇒ ~10 viewports above), the re-key moves
the visible rows:

```
BEFORE: row-r455[0,53][440,108]  row-r456[0,108][440,547] … jump-latest(Jump to latest)
AFTER : row-r516[0,-2][440,52]   row-r517[0,52][440,491]  … jump-latest — pill reads "New messages"
```

(`shots/b-long1-cmp.png`: the "SHOWCASE more" bubble at y 575 before, 519
after — 56 pt toward the end — and the pill flips to "New messages". The QA's
244 pt was the same mechanism with its own row sizes.)

Pure repro (`repro.ts`): a history replace with IDENTICAL messages

```
keys before: r1,r2,r3,r4,r5,r6
keys after:  r7,r8,r9,r10,r11,r12
same rows array: false
content equal mod keys: true
```

**Root cause (one sentence):** `withHistory` (`apps/mobile/src/transcript.ts:398`)
minted a fresh key for every row on each replace, so the `FlatList`
(`keyExtractor={(row) => row.key}`, `SessionScreen.tsx:1266`) lost the measured
frames of the cells outside its render window, re-estimated the spacer above
the viewport, moved the visible rows, and reported a content-size change that
`contentGrew` (`follow.ts`) — not following — marks `unseen` ("New messages").

## Implementation

*— claude-opus-5-5, 2026-11-19*

### Load-bearing assumption

**The list's cell measurements are keyed by the row key**, so a row that keeps
its key keeps its measured height. Proven empirically, not from RN source: the
same session, the same rows, only the keys changed → the jump (above); a second
return after the first is still. Verified again after the fix (Execution).

### Preconditions (verified)

- Every resync path (foreground, pull, Retry, Reopen) lands its history as a
  `history` input with `reason: null` → `applyHistory` → `withHistory`
  (`transcript.ts:411-425`).
- `append` mints keys from `state.seq`, which only grows (`transcript.ts:208`),
  so a fresh key never equals any key ever used.
- Row-keyed screen state (`openSteps`/`fullSteps`, `SessionScreen.tsx:1313-1322`;
  notice `looks`; `layout.cells`) is a projection of the rows by key: keeping a
  key for the same slot keeps that state (an opened step stays open) — the
  owner's "exactly where it was".

### Design

`withHistory` builds the rows exactly as before, then `keepKeys(old, fresh)`:
walking from the top, while each new row is the **same slot** as the old row at
that index, it takes the old key — and the old row OBJECT when the two are
deep-equal (so an unchanged row is not even re-rendered). From the first
mismatch on, rows keep their freshly minted keys. If every row is reused and
the count is equal, the old rows array itself is returned.

Same slot = same kind, plus: `user`/`notice` → same text; `tool` → same call id;
`assistant`/`reasoning` → kind only (a live reasoning body is never stored and
a cut stream's text may differ; their place, after an all-matching prefix, does
not). A matched row whose content changed keeps the key but shows the NEW
content (the history is the truth).

No change to `follow.ts`: with stable keys nothing changes size, so no
measurement reaches `contentGrew` and no pill flips. A real change still does —
that is the "new messages" the owner wants kept.

### Files

| file | change |
|---|---|
| `apps/mobile/src/transcript.ts` | `withHistory` → `keepKeys` (:409), new `keepKeys` (:422), `sameSlot` (:437), `rowEqual` |
| `apps/mobile/test/transcript-resync-keys.test.ts` | new (7 tests) |

### Failure modes

- **A different history** (`/clear`, a fresh session): row 0 mismatches → every
  key fresh (test "no key survives"; the existing "keys never repeat an old one"
  in `transcript.test.ts` still passes).
- **A row gone in the middle** (a dropped call): keys kept only up to it, fresh
  after — never a neighbour's key on a different call (test).
- **Duplicate keys**: impossible — reused keys are a prefix of the old (unique)
  keys, and every other key is minted above `seq` (test asserts uniqueness).
- **Longer history** (a laptop turn arrived while away): shared prefix kept, new
  rows fresh → content grows → the pill says "New messages" (correct).
- **Same slot, new content** (a cut answer completed): key kept, content new → the
  cell re-renders in place.

### Tests

`apps/mobile/test/transcript-resync-keys.test.ts`: identical history → identical
keys and the same row objects; repeated resyncs; LIVE-folded rows (thought, two
tools, answer) keep their keys under the history of that turn; longer history;
different history; a row gone in the middle; a changed row in the prefix.

## Execution

*— claude-opus-5-5, 2026-11-19*

As planned, no drift.

**Red** (`main`, before the edit):

```
(fail) … identical messages → identical keys, and the very same row objects
(fail) … a second and a third resync change nothing either
(fail) … rows folded LIVE keep their keys when the history of that turn replaces them
(fail) … a longer history: the shared rows keep their keys, the new ones are fresh
(fail) … a row that is gone in the middle: keys survive only up to it
(fail) … a changed row in the shared prefix keeps its key but shows the NEW content
 1 pass   (the guard: a different history keeps no key)
 6 fail
```

**Green:** `7 pass · 0 fail`. `bun test apps/mobile/test/`: 3766 pass, 0 fail.

**Mutations** (each reverted):

- `keepKeys` never matches (`if (true || …)`) → `1 pass · 6 fail`;
- `keepKeys` never reuses the old object (`return kept`) → the "very same row
  objects" test fails (`6 pass · 1 fail`).

**Frames after** (same harness, Release build WITH the fix, serve on an
ephemeral port — 49386 — same recipe; `still.py` = mean abs pixel diff of the
transcript band, before vs after the return):

| case | keys before → after | rows' bounds | pixels changed |
|---|---|---|---|
| main, ~20 screens, scrolled up, 1st return (`b-long1`) | r453… → r516… | moved 55 pt | **8.83 %**, pill → "New messages" |
| main, same, 2nd return (`b-long2`) | re-keyed | same | 0.00 % |
| fix, ~20 screens, scrolled up, 1st return (`a-long1`) | r57… → r57… | identical | **0.00 %**, pill stays "Jump to latest" |
| fix, same, 2nd return (`a-long2`) | identical | identical | 0.00 % |
| fix, live TOOLROWS29 turn (thoughts, tools) then scrolled up, 1st return (`a-tr1`) | r161…r169 kept | identical | 0.00 % |
| fix, at the end, return (`a-end1`) | kept | identical | 0.00 % |

Shots: `.tentacle/tmp/mobile-foreground-jump/shots/{b,a}-long1-cmp.png`, videos
`*.mp4` beside them.

**Not verified:** a return while a laptop turn really added rows (the pill must
then say "New messages") — covered only by the pure test "a longer history"
(fresh keys for the new rows ⇒ the list grows ⇒ `contentGrew` marks `unseen`).

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` clean (2104 files) · `bun test`: **15510 pass · 5 skip · 0 fail**
(the skips are opt-in suites; this task adds none).
