# feat/resume-picker — choose which session `--resume` resumes

> **Status:** done — merged by the owner without a fresh-context Review (2026-10-20, "committa e merge")
> **Branch:** `feat/resume-picker`
> **Type:** feat · **Size:** M · **Blast:** cross-module (`openTuiSessions` is the one pre-mount seam of `tui`/`run`/`attach`; a second, short-lived Ink instance on the terminal before the main one) · **Suited:** strong model executes; fresh-context Review recommended (terminal/IO path)

## Context

*— claude-opus-5-5, 2026-10-20*

`tentacle --resume` with no uid always resumes the **newest** session of this
folder (`store.latest()`, `packages/cli/src/session-resume.ts:80`). With several
sessions per project (now scoped per folder, `docs/fix/session-store-per-project.md`)
the only way to reach an older one is to find its UUID on disk and pass
`--resume <uid>`. Owner request (2026-10-20): a selector to choose which one.

Owner decisions (2026-10-20):

1. **`--resume` (no uid) opens the picker.** A new **`--continue`** keeps
   today's behaviour (newest session, no prompt), same split as Claude Code.
   With no terminal (stdin/stdout not a TTY) `--resume` falls back to the newest
   session and says so.
2. **Startup only.** The picker runs before the runtime starts and serves
   `tui`, `run` and `attach` alike. An in-TUI `/resume` (switch session while
   running: the runtime must re-open a session) is a separate, later task.

**Repro** (`.tentacle/tmp/resume-picker/repro.ts`, run on `main` @ `2f3fce4`,
2026-10-20):

```ts
// `--resume` (no uid) today: always the newest session — no way to choose among the others.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { resolveResume } from "../../../packages/cli/src/session-resume.ts";

const dir = await mkdtemp(join(import.meta.dir, "store-"));
const store = new JsonSessionStore(dir);
const mk = (id: string, title: string, updatedAt: number) => ({
  id, cwd: "/work/p", model: "m", createdAt: updatedAt, updatedAt, title,
  messages: [{ role: "user" as const, content: title }],
});
await store.save(mk("aaaaaaaa-0000-4000-8000-000000000001", "refactor the parser", 1000));
await store.save(mk("aaaaaaaa-0000-4000-8000-000000000002", "fix flaky test", 2000));
await store.save(mk("aaaaaaaa-0000-4000-8000-000000000003", "quick question", 3000));
await store.drain();
console.log("listed:  ", (await store.list()).records.map((r) => r.title));
const r = await resolveResume(store, undefined);
console.log("resumed: ", r.record?.title, "| lines:", r.lines);
```

```
listed:   [ "quick question", "fix flaky test", "refactor the parser" ]
resumed:  quick question | lines: [ "[resume] aaaaaaaa-0000-4000-8000-000000000003 — quick question\n" ]
```

Three sessions exist; `--resume` takes the newest, with no way to pick another.

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**A short-lived Ink `render()` can own the terminal, read keys, unmount, and a
second `render()` (the main TUI) then reads keys normally on the same stdin.**
If raw mode or the stdin listener leaked from the first instance, the main TUI
would get no (or doubled) input.

Proven empirically on a real pty (`.tentacle/tmp/resume-picker/two-renders.ts`,
Ink 5.0.1, under `script -q /dev/null`, keys `\r` then `x` piped in):

```ts
const keys: string[] = [];
const a = render(h(Step, { name: "picker", onKey: (k) => keys.push(`A:${k}`) }), { exitOnCtrlC: false });
await a.waitUntilExit();
const b = render(h(Step, { name: "main", onKey: (k) => keys.push(`B:${k}`) }), { exitOnCtrlC: false });
await b.waitUntilExit();
process.stderr.write(`RESULT ${JSON.stringify(keys)} rawAfter=${process.stdin.isRaw}\n`);
```

```
RESULT ["A:<enter>","B:x"] rawAfter=false
```

Each key reached exactly one instance, the second instance read input, and raw
mode was released at the end.

### Preconditions

- **One pre-mount seam for all three runtimes.** `openTuiSessions`
  (`packages/cli/src/tui-sessions.ts:36`) resolves `--resume` before anything
  starts. `main.ts` calls it for `run` (`main.ts:388`), `attach` (`:433`) and the
  TUI (`:474`), always **before** the runtime/pod starts (`:392`, `:487`). So
  the chosen record reaches `startWorkerRuntime` / `startPodRuntime` as
  `resume` unchanged, with no change to the runtime, protocol or daemon.
- **Ink does not own the terminal yet** at that point: `startTui` enters the
  alt screen and mounts later (`packages/tui/src/run.tsx:43-61`). The resume
  lines are already written there today (`tui-sessions.ts:57`). So a picker at
  that point does not break the §7 "never write raw while Ink owns it" rule.
- **The list exists.** `JsonSessionStore.list()` returns valid records
  newest-first plus the unreadable files (`packages/agent/src/session-store.ts:437-461`).
  `latest()` is `list()[0]` (`:464-470`).
- **Args are declared once.** `ARGS.tui|run|attach` (`packages/cli/src/flags.ts:65-79`)
  plus the `COMMANDS` entry words (`:279-288`) and the usage strings (`:366-371`, `main.ts:64-70`).
- **TUI layering rule (§7):** the logic goes in a pure module, and the `.tsx` only renders.

### Design

**CLI flags (`flags.ts`).** Add a `continue: {}` bool to `tui`, `run`, `attach`.
Add `"--continue"` to `COMMANDS` so `tentacle --continue` enters the TUI like
`--resume`. Passing both `--resume` and `--continue` is an argument error
(`--continue resumes the newest session; --resume picks one — use one`).

**Resolution (`session-resume.ts`).** `resolveResume(store, request, scope?)`,
where `request` is:

- `{ uid }`: unchanged.
- `{ latest: true }`: `--continue`, or `--resume` with no terminal. This is
  today's no-uid path, unchanged.
- `{ pick }`: `--resume` on a terminal. `pick` is an injected
  `(choices: SessionChoice[]) => Promise<string | null>` (the chosen id, or `null` = cancelled):
  - `list()`; the warnings for skipped files are computed as today;
  - 0 records → today's "no saved sessions … starting fresh" (picker not shown);
  - 1 record → resumed directly (nothing to choose; same line as today);
  - ≥2 records → `pick(choices)`; an id → that record (normal `[resume] <id> — <title>`
    line); `null` → a new `cancelled` outcome (`[resume] cancelled\n`, nothing starts).

`ResumeResolution` gains `cancelled: boolean`. `openTuiSessions` returns
`TuiSessions | { readonly exit: number }`: `1` for today's fatal cases, `0` when
cancelled. The three `main.ts` call sites become `if ("exit" in sessions) return sessions.exit;`.
`openTuiSessions` takes the `pick` function as a dependency. `main.ts` passes
`pickSession` only when `process.stdin.isTTY && process.stdout.isTTY`. Without
it, `--resume` takes the `latest` path and first writes
`[resume] no terminal for the picker; resuming the newest session\n`.

**Picker (`@tentacle/tui`), split per §7:**

- `session-picker.ts` (pure, React-free). `SessionChoice = { id, title, updatedAt, messageCount }`
  (the CLI maps from `SessionRecord`, so `tui` does not import `agent`).
  `pickerView(choices, selected, now, height)` returns the visible window of rows
  (`title`, relative age `just now|5m ago|3h ago|2d ago|<date>`,
  `N msgs`, `selected`), plus "↑ n more" / "↓ n more" counts. `movePicker(selected, delta, count)` clamps.
  `pickerKey(input, key)` maps keys to `up|down|choose|cancel|none` (↑/↓, `k`/`j`,
  Enter, Esc, Ctrl+C).
- `components/SessionPicker.tsx` (renders only): a header
  `Resume a session (↑↓ choose · Enter resume · Esc cancel)`, then the rows,
  styled like `CommandPalette` (accent `❯` row, the rest dimmed, `wrap="truncate"`).
- `pickSession(choices, opts?)` (in `session-picker-run.tsx`, exported). It
  `render()`s on the **main** screen (not the alt screen) with `exitOnCtrlC: false`,
  resolves the id or `null`, then `clear()`s its frame and unmounts. Only the
  `[resume]` line stays in the scrollback. `stdin`/`stdout` and `now` are injectable for tests.

### Files

1. `packages/tui/src/session-picker.ts` (new, pure) and `packages/tui/test/session-picker.test.ts`.
2. `packages/tui/src/components/SessionPicker.tsx` and `packages/tui/src/session-picker-run.tsx` (new). Export from `packages/tui/src/index.ts`.
3. `packages/cli/src/flags.ts`: `continue` bool, `COMMANDS`, conflict check, usage.
4. `packages/cli/src/session-resume.ts`: the request union, the pick path, `cancelled`.
5. `packages/cli/src/tui-sessions.ts`: the `pick` dependency, the no-TTY line, `{ exit }`.
6. `packages/cli/src/main.ts`: the three call sites, passing `pickSession` when on a TTY, and the help text (`:64-70`).
7. Tests: `packages/cli/test/session-resume.test.ts`, `tui-sessions.test.ts`, the flags test.
8. Docs: `README.md` (`--resume`/`--continue`, if it documents them) and `TODO.md` (mark done).

### Failure modes

| Case | Behaviour |
|---|---|
| No sessions in this folder | No picker. "no saved sessions for <cwd> yet; starting fresh" (unchanged). |
| Only unreadable files | Same, plus the skipped-file warning (unchanged, pre-mount line + in-TUI notice). |
| Exactly one session | Resumed directly, no picker (nothing to choose). |
| Esc / Ctrl+C in the picker | `[resume] cancelled`, exit 0. No pod is created and no worker started (the picker runs before both). |
| Not a TTY (stdin or stdout piped) | No picker. Newest session, with an explicit line saying so (never a silent fallback). |
| `--resume` + `--continue` | Argument error, exit non-zero (strict args, like `fix/cli-strict-args`). |
| `--resume <uid>` | Unchanged. The picker is never shown. |
| Many sessions / short terminal | The list is windowed to the terminal height, with "↑/↓ n more" counts. Long titles are truncated, never wrapped. |
| The picker throws (render error) | Caught in `openTuiSessions`: `[resume] picker failed: <msg>; not starting`, exit 1. Never a silent fallback to another session. |
| Keys typed while the runtime starts after a pick | Cooked mode echoes them until the TUI mounts. Cosmetic, same as today's startup gap. |
| SIGKILL during the picker | Same as today for any Ink app: the terminal may be left in raw mode (`reset`). Not a new class of problem. |
| `run --continue <word>` | `<word>` is the pod name (positional), exactly as `run <name>` today. Documented, not special-cased. |

### Tests

Red before green: every new-behaviour test is run on `main`'s code first and fails.

- **`session-picker.test.ts`** (pure): age formatting at the boundaries
  (59 s/60 s, 59 m/60 m, 23 h/24 h, >7 d → date); `movePicker` clamps at both
  ends; windowing keeps the selected row visible and reports the correct
  above/below counts (selected at the top, middle and bottom; height ≥ count);
  `pickerKey` mapping, including Ctrl+C → cancel.
- **`SessionPicker` via `ink-testing-library`** (the `app.test.tsx` pattern):
  `↓ ↓ Enter` resolves the third id; `Esc` resolves `null`; `Ctrl+C` resolves `null`;
  the rendered frame shows the newest first and the `❯` on the selected row.
- **`session-resume.test.ts`:**
  - `{ pick }` with 3 records calls `pick` with choices newest-first and resumes the returned id;
  - `null` → `cancelled`, `record: null`, not `fatal`;
  - 0 and 1 records → `pick` is **not called** (spy);
  - `{ latest: true }` never calls `pick`;
  - `{ uid }` unchanged.
- **`tui-sessions.test.ts`:**
  - no `pick` with `--resume` → the newest record plus the "no terminal" line;
  - cancel → `{ exit: 0 }`, and the saver never saves;
  - a `pick` that throws → `{ exit: 1 }` plus the "picker failed" line.
- **Flags test:** `--continue` is accepted by `tui`/`run`/`attach`;
  `cliMode(["--continue"])` is `"tui"`; `--resume --continue` is an error.
- **Non-vacuity (§9):** mutate `resolveResume` to ignore `pick` (always
  `latest`) and confirm the pick tests go red; mutate `movePicker` to wrap and
  confirm the clamp test goes red.
- **Manual on a real terminal:** `tentacle --resume` in a folder with ≥2
  sessions: choose the second one, check that the TUI shows that transcript,
  Esc exits cleanly, and the terminal is usable afterwards.

## Execution

*— claude-opus-5-5, 2026-10-20*

Implementation approved by the owner (2026-10-20, "si"). Done in this order:
tests first (red), then the `tui` pure module → component → runner, then the
`cli` resolver → `openTuiSessions` → flags → `main.ts`.

**Red on the old code:** 14 of the new tests failed before any source edit
(the two new `tui` modules missing; in `cli`: the picker path ignored, no
`--continue`, no `{ exit }`). The ones that already passed on `main` pin
behaviour that must NOT change (0/1 session, explicit uid, `--continue` =
newest). Their non-vacuity is shown by the mutations below.

**Drift from Implementation (and why):**

1. `resolveResume(store, uid, scope?, pick?)`: a 4th optional `pick` instead
   of a request union. Same semantics (no `pick` = newest), and the existing
   tests and call sites stay as they are.
2. `ResumeResolution.cancelled?: true` is optional, present only when
   cancelled, so the existing exact `toEqual` assertions still hold.
3. Added: an id returned by the picker that is not in the list is **fatal**
   (`the picker returned an unknown session`), never a silent fallback.
4. "Picker failed" covers **only** the picker's own throw: the `pick` call is
   wrapped. A store error during `list()` propagates as before, instead of
   being mislabelled.
5. Found on a real pty: `script`'s pty reports `columns = 0`, so `0 ?? 80`
   collapsed the title column. `pickSession` now treats 0 as unknown
   (`|| 80`, `|| 24`).
6. `ArgSpec` gained a generic `conflicts` list (rather than a one-off check);
   `--resume`/`--continue` is its only entry. `cliMode` needed no change: any
   leading `-…` already enters the TUI. Only `COMMANDS` (for `--profile`
   ordering) and the usage strings changed.
7. Also adapted `packages/cli/test/session-projects.test.ts`, which was not in
   the Files list. Its bare `{ wanted: true }` meant "newest" and is now
   `latest: true`, and `null` became `{ exit }`.
8. `README.md` does not document `--resume`, so it was not touched. The
   `--help` text was updated (`main.ts`).

**As built:**

- `packages/tui/src/session-picker.ts`: `SessionChoice`, `SessionPick`,
  `pickerAge`, `movePicker` (clamps), `pickerView` (centred window + hidden
  counts), `pickerKey`.
- `packages/tui/src/components/SessionPicker.tsx`: `SessionPicker` (renders
  only) and `SessionPickerApp` (selection state; answers once, then renders
  `null` so the frame is erased, then `exit()`).
- `packages/tui/src/session-picker-run.tsx`: `pickSession`, an Ink `render`
  on the main screen with `exitOnCtrlC: false`.
- `packages/tui/src/index.ts`: exports `pickSession` plus the two types.
- `packages/cli/src/session-resume.ts`: the pick path (≥2 records), `toChoice`
  (message count excludes the system prompt), `cancelled`.
- `packages/cli/src/tui-sessions.ts`: `ResumeRequest{wanted, uid?, latest?}`,
  the `pick` dependency, the "no terminal" line, `{ exit: 0|1 }`.
- `packages/cli/src/flags.ts`: `--continue` on `tui`/`run`/`attach`, `conflicts`, usage.
- `packages/cli/src/main.ts`: the three call sites (`"exit" in sessions`);
  `pickSession` passed only when stdin and stdout are TTYs; the help text.

**Mutations (§9), each one temporarily applied, then reverted
(`.tentacle/tmp/resume-picker/mutate.py`):**

```
RED  ignore pick: 5 fail
RED  picker for 1 session: 1 fail
RED  --continue -> picker: 2 fail
RED  no 'no terminal' line: 1 fail
RED  cancel starts: 1 fail
RED  no conflict check: 1 fail
RED  movePicker wraps: 1 fail
RED  Ctrl+C ignored: 2 fail
RED  Enter -> first row: 1 fail
RED  frame not cleared: 1 fail
```

**End to end on a real pty** (`script` + `stty cols 100 rows 30`, a seeded
3-session store under an isolated `TENTACLE_CONFIG_DIR`, the real
`packages/cli/src/main.ts`, worker runtime):

```
# --resume, ↓, Esc
Resume a session (↑↓ choose · Enter resume · Esc cancel)
❯ quick question       1m ago · 2 msgs
  fix flaky test       3h ago · 2 msgs
  refactor the parser  2d ago · 2 msgs
  …(↓)…
[resume] cancelled
EXIT=0

# --resume, ↓, Enter, then type /exit in the main TUI
[resume] aaaaaaaa-0000-4000-8000-000000000002 — fix flaky test
› MARK-fix flaky test              ← the chosen session's transcript
❯ /exit                            ← the main TUI reads keys after the picker
EXIT=0

# --continue
[resume] aaaaaaaa-0000-4000-8000-000000000003 — quick question
EXIT=0

# --resume --continue
[error] --resume and --continue cannot be used together
EXIT=1
```

**Gate:** `bun run check`: typecheck clean, lint clean (319 files, no fixes),
`1282 pass · 2 skip · 0 fail` (the two opt-in skips of the baseline).

**Not verified:** `run`/`attach` against a real cluster with the picker. They
go through the same `openSessions` call before the pod is created
(`main.ts` run/attach sites), so the chosen record seeds `startPodRuntime`
exactly like `--resume <uid>`. To verify: `tentacle run --image <ref> --resume`
with ≥2 sessions, choose an older one, and check that its transcript appears.

## Review

*— claude-opus-5-5, 2026-10-20*

**Fresh-context Review not run:** the owner asked to commit and merge straight
after Execution (2026-10-20, "committa e merge"). The doc only recommended it
(cross-module, not load-bearing, so §10 does not make it mandatory). What
stands in for it is the in-context evidence in Execution: red-before-green, 10
of 10 mutations red, the real-pty end-to-end runs, and a green gate.

**Open points a reviewer should attack first:**

- `run`/`attach` with the picker against a real cluster (not exercised, see
  Execution "Not verified").
- Keys typed between the picker's unmount and the main TUI's mount are echoed
  in cooked mode (cosmetic, accepted in Failure modes).
- SIGKILL while the picker is up can leave raw mode on, as with any Ink app.

**Follow-ups:** an in-TUI `/resume` (switching session while running: the
runtime must re-open a session; a separate, larger task, owner decision 2). Typing to filter the
picker's rows once the lists grow long.
