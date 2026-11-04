# feat/run-prompt — `tentacle run … "<prompt>"`: the positional is the first prompt

> **Status:** execution (owner answers 2026-11-04 recorded below; they supersede the Design items they contradict)
> **Branch:** `feat/run-prompt`
> **Type:** feat · **Size:** M · **Blast:** cross-module · **Suited:** a mid-strength model; standard in-context Review (no §7 invariant is changed — see Preconditions; the TUI seam is one prop + one mount effect)

## Context

*— claude-sonnet-5-5, 2026-11-04*

Owner decision 2026-11-04:

- `tentacle run [...] "<prompt>"`: the positional becomes the FIRST PROMPT. Interactive: the TUI opens and sends it at once as the first message. With `--detach`: no TUI, it is the detached run's prompt (same as `--prompt`).
- The container/pod name moves to `--name <n>`; absent → the automatic name (today's random path).
- `--prompt <text|->` stays as an alternative, now also WITHOUT `--detach` (`--prompt -` = stdin). A positional AND `--prompt` → error.
- `attach <name>` / `rm <name>` keep the positional name.
- Pre-public (AGENTS §7): no compat shim for `run … <name>`; a helpful error for a likely-old usage if cheap.

**Today (verified).**

- `run` takes `0..1` positional = the workload NAME (`flags.ts:117-131`, `positional: { min: 0, max: 1 }`); the name is read at `main.ts:853` (`const name = runPos[0]`) and passed as `workloadDeps.name` (`main.ts:939`) → `provisionWorkload` (`engine-runtime.ts:329`: `deps.name ?? tentacle-<8 uuid chars>`).
- `--prompt` exists only with `--detach`: `detachFlagProblem` (`flags.ts:179-197`) returns `--prompt needs --detach` / `--detach needs --prompt …` / `--detach cannot resume…` / `--auto-accept needs --detach`. `--prompt -` reads stdin only when `detach` (`main.ts:827-834`), refusing a TTY stdin.
- The interactive path never has a first prompt: `runEngineTui` (`main.ts:763-797`) → `startTui` with no prompt option (`TuiOptions`, `tui/src/run.tsx:22-51`).
- A bare `tentacle "<prompt>"` (`cliMode` → `"prompt"`, `flags.ts:629-645`) is the one-shot plain mode, NOT the TUI — not a seam for this.
- The TUI sends a message through ONE function: `run(text, opts)` in `App.tsx:1234-1278` (stored in `runRef`, `App.tsx:1279`; typed input reaches it at `App.tsx:2006`, `void run(text)`). A plain failure of a send (`failTurn`, `App.tsx:1190`) keeps the message as the user's bubble with the error under it; only a lost slot or a successor restores the text to the input (`restoreInput`, `App.tsx:1181/1188`) — *corrected in round 2 (the first version of this line claimed a restore)*.

**Repro (the capability is missing)**, from the repo root, 2026-11-04:

```sh
bun run packages/cli/src/index.ts run --image x --name box   # → [error] unknown option --name
bun run packages/cli/src/index.ts run --image x --prompt hi  # → [error] --prompt needs --detach
```

(The executor re-runs these in `.tentacle/tmp/run-prompt/` on `main` and pastes the output into Execution.)

## Implementation

*— claude-sonnet-5-5, 2026-11-04*

### Load-bearing assumption

The interactive TUI can take a first prompt through the SAME path as a typed one — `run(text)` (`App.tsx:1234`) — with nothing else changing: the session is created lazily (`makeSession`, `App.tsx:596`; the daemon opens its session "at the first prompt", `daemon/src/connection.ts:242`, `client/src/remote-client.ts:424`), and a permission request arriving before the user types is held by the broker (`new PermissionBroker(undefined, { holdUntilSet: true })`, `main.ts:1006`) until the TUI's prompt mounts. So sending at mount is the same as the user pressing Enter the instant Ink is up. Verify first in the TUI test (see Tests, T4): a fake `createSession` whose `send` logs the prompt, mounted with `initialPrompt`, must log it exactly once.

### Preconditions

- Single session path / single broker (§7): unchanged. The prompt goes through `RemoteClient` ↔ `Connection` like any typed message; `runEngineTui` keeps passing the one `permissions`.
- No protocol change: the prompt is a normal `session/prompt` (`remote-client.ts:911`). No `PROTOCOL_VERSION` bump, no persisted-format change. The detached path already carries `prompt` in its run spec (`main.ts:988`, `run-state.ts:352`) — untouched.
- `parseArgs` supports `--` to end options (`flags.ts:228`), so a prompt starting with `-` is `run … -- "-x"`; a lone `-` is a word (`flags.ts:256`).
- `-n` is `--namespace`'s short (`flags.ts:120`), so `--name` has NO short form.
- Interactive Ink needs a TTY stdin (see Q6).

### Design

1. **Flags (`flags.ts`).** `ARGS.run.values` += `name: {}`. `positional` stays `{min:0,max:1}` but now means the prompt. Replace `detachFlagProblem`'s prompt rules with a pure `resolveRunPrompt({positional, promptFlag}): {prompt?: string} | {error}`: both given → error `give the prompt once: positional or --prompt`; whitespace-only (`""`) → error (Q4). `detachFlagProblem` keeps: `--detach needs a prompt (positional, --prompt <text>, or --prompt -)`, `--detach cannot resume`, `--auto-accept needs --detach`; it LOSES `--prompt needs --detach`. `USAGE.run` becomes `… [--name <n>] [--resume [uid]|--continue] [--detach [--auto-accept[=true|false]]] [--prompt <text|-> | "<prompt>"]` .
2. **`main.ts` run path (`:809-853`).** `const nameFlag = runFlags.get("name")` replaces `runPos[0]` (`:853`, used at `:939`). `--prompt -` reads stdin whatever `detach` (`:829` drops `detach &&`) — subject to Q6. `prompt` = `resolveRunPrompt(...)`. The detached branch (`:957`) already takes `prompt`; unchanged otherwise. Interactive: pass `prompt` to `runEngineTui(runtime, permissions, sessions, undefined, prompt)` → `startTui(…, { initialPrompt })` (`:773`), spread only when defined.
3. **Old-usage helper (Q2).** If a lone positional looks like a workload name (`/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/`, no space) print one line before anything is created: `[kubernetes] note: "mypod" is taken as the first prompt; the workload name is --name mypod`. Warn, don't refuse (a one-word prompt like `fix` is legitimate). Pure `looksLikeName(word)` next to `resolveRunPrompt`.
4. **TUI seam.** `TuiOptions.initialPrompt?: string` (`run.tsx`) → `AppProps.initialPrompt` (`App.tsx:292`). One `useEffect(() => {…}, [])` guarded by a `sentFirstRef`: calls `void runRef.current?.(initialPrompt)` once at mount; a `/clear` (new session, `App.tsx:1412`) or a re-render never resends. The send is raw text, like the detached prompt (Q5).
5. **Resume (Q3).** Interactive `--resume`/`--continue` + prompt is allowed: the history is shown (`resumeMessages`), the prompt is the next message. `--detach` still refuses resume (`flags.ts:194`).
6. **Docs/help.** Update every quote of `run … [<name>]`: `README.md:90-95` (3 commands + the detach paragraph), `main.ts:139` and `:144` (HELP), `main.ts:280` (`Pod execution (…[<name>])`), `flags.ts:652` (USAGE). `attach`/`rm` lines unchanged. Legacy docs under `docs/feat|fix/detached-*`, `pod-exec-attach.md`, `docker-engine-cli.md` etc. quote the old form historically — NOT rewritten (they are decision records); `TODO.md` item gets ticked at merge.

### Files

In dependency order: `packages/cli/src/flags.ts` (spec, `resolveRunPrompt`, `looksLikeName`, `detachFlagProblem`, `USAGE.run`) → `packages/cli/src/main.ts` (HELP ×3, run path, `runEngineTui` signature) → `packages/tui/src/run.tsx` (`TuiOptions.initialPrompt`) → `packages/tui/src/App.tsx` (prop + mount effect) → `README.md`. Tests: `packages/cli/test/args.test.ts` (update `:295-298`, the `mypod` cases), `packages/cli/test/main.test.ts` (new run cases), a new `packages/tui/test/initial-prompt.test.tsx`.

### Failure modes

- **Both positional and `--prompt`** → exit 1 before anything is created, with usage.
- **Empty/whitespace prompt** → exit 1 (Q4); `--detach` with none → today's error, reworded.
- **`--prompt -` on a TTY stdin** → today's error (`main.ts:830`); on a pipe in interactive mode → Q6.
- **Old usage `run --image x mypod`** → runs with `mypod` as the prompt + the note (Q2); with `--detach` it would run a detached turn "mypod" — same note, visible in the started line.
- **First send fails** (link down, daemon refuses) → exactly as a typed message (owner, round 2): the prompt STAYS in the conversation as the user's message with the error under it (`failTurn`, `App.tsx:1190`); the input stays empty; nothing is resent by itself. Nothing is lost: the text is on screen and the user retypes it. Pinned by `initial-prompt.test.tsx` (mutation: restore into the input → fails).
- **Permission ask before the user touches anything** → held by the broker, shown on mount (Preconditions).
- **TUI never mounts** (`startTui` throws) → the prompt was never sent; no state to converge (the workload follows today's teardown).
- **Resume + prompt**, session picker cancelled → no TUI, prompt unused, exit as today.
- **`/clear` or session swap** → `sentFirstRef` keeps it once.
- **Prompt that is a slash command** (`/clear`) → sent raw to the model (Q5).

### Tests

(Red before green, §9; each pins one property.)

- T1 `args.test.ts`: `run --image x "hello world"` parses `positional=["hello world"]`; `run --image x --name box` has `flags.name="box"`; `run --image x --name box "p"` both; the old `mypod` cases (`:295-298`) now assert the prompt/name split.
- T2 `resolveRunPrompt` pure unit: positional only, flag only, both → error, whitespace-only → error, neither → none; `looksLikeName("mypod")` true, `"fix the bug"` false, `"Fix"` false.
- T3 `main.test.ts` (existing fakes `io.startEngineRuntime`, `io.startTui`, `io.provisionWorkload`, `io.readStdin`, `io.spawnRelay`): interactive positional → `startTui` receives `initialPrompt` and the workload name is the random one; `--name box` → `workloadDeps.name==="box"`; `--prompt -` with `readStdin` fake → `initialPrompt` is the stdin text; both → exit 1, nothing provisioned; `--detach "p"` → relay spec `prompt:"p"`, no `startTui`; `--detach` without prompt → error; `--auto-accept` without `--detach` → error; `--resume` + prompt (interactive) → both reach `startTui`; `--resume --detach` still refused; the lone-word note is written.
- T4 `initial-prompt.test.tsx` (copy the `send-now-app.test.tsx:53` fake-session pattern): mount with `initialPrompt:"go"` → `log.sends` is `["go"]` after a tick; re-render and a session swap do not resend; a `send` that throws leaves `go` restored in the input (property that lets the failure mode hold).
- Non-vacuity: temporarily drop the `sentFirstRef` guard (T4 must fail on the swap case) and the `--name` plumbing (T3 must fail).
- Gate: `bun run check`.

### Owner answers (2026-11-04) — these decide; the Design above is amended accordingly

- **Q1:** error when both the positional and `--prompt` are given.
- **Q2: (a) NO warning** for a name-shaped one-word prompt → Design item 3 and `looksLikeName` are DROPPED.
- **Q3: (b) REFUSE** `--resume`/`--continue` together with a prompt (positional or `--prompt`), for now, with a clear error → Design item 5 is reversed.
- **Q4: (a)** empty/whitespace prompt → error.
- **Q5: (a)** a prompt starting with `/` is raw text to the model, never a TUI command.
- **Q6: (a)** `--prompt -` only with `--detach`; without it a clear error. (A streaming one-shot `run` is a separate future task.)
- **Q7 (round 2, replaces the first answer):** `--auto-accept[=true]` WITHOUT `--detach` is ALLOWED — the TUI starts with auto-accept ON (the state Shift+Tab toggles; Shift+Tab turns it off); `=false` is accepted and changes nothing. With `--detach`, unchanged.
- **Q8: (a)** no up-front `--name` validation. **Q9:** no short flag. **Q10:** out of scope.

### Open questions for the owner (each with a recommendation) — answered above

1. **Q1 — both positional and `--prompt`.** Decided: error. (Listed for completeness.)
2. **Q2 — likely-old usage `run --image x mypod`.** (a) silent: it becomes the prompt; (b) warn with a note, still run; (c) refuse a lone name-shaped word unless `--prompt`/`--`. **Recommend (b):** one-word prompts are legitimate, (c) breaks them, (a) hides a surprise (a model turn run on "mypod").
3. **Q3 — `--resume`/`--continue` + prompt.** (a) allow interactive (history shown, prompt is the next message); (b) refuse. **Recommend (a)** (natural: "continue and say X"); `--detach` + resume stays refused as today.
4. **Q4 — empty or whitespace-only prompt (`run … ""`).** (a) error; (b) ignore, open an empty TUI. **Recommend (a):** an explicit empty prompt is a mistake (mirrors today's `--detach` rule).
5. **Q5 — a first prompt starting with `/` (`"/clear"`).** (a) raw text to the model, like the detached prompt; (b) through the TUI's slash-command handler like typed input. **Recommend (a):** simplest, identical for detached and interactive; no hidden command execution from argv.
6. **Q6 — `--prompt -` without `--detach`.** Reading stdin to EOF leaves stdin a closed pipe, and Ink needs a TTY stdin for keys — the TUI would open dead. (a) refuse in interactive mode with a clear message (`--prompt - needs --detach: the TUI needs the terminal as stdin`) and keep `-` = stdin only for `--detach`; (b) allow, reopen `/dev/tty` for Ink (new terminal-IO work, an extra platform seam, Windows gap). **Recommend (a)** — it deviates from "also without `--detach`" for `-` only; the text form works everywhere. If you want (b), it is a separate S task.
7. **Q7 — `--auto-accept` without `--detach`.** (a) keep refusing (as today); (b) allow it in the interactive TUI. **Recommend (a):** the interactive auto-accept is Shift+Tab in the TUI; extending it is a different feature.
8. **Q8 — validate `--name` up front** (DNS-1123 label, before any I/O). (a) no, the engine rejects a bad name as today; (b) yes. **Recommend (a)** here (scope); a `fix` if bad names prove confusing.
9. **Q9 — `--name` short flag.** `-n` is `--namespace`. **Recommend none.**
10. **Q10 — `attach <name> "<prompt>"`** (send a message on attach). **Recommend out of scope**; `attach` keeps its single positional.

## Execution

*— claude-sonnet-5-5, 2026-11-04*

**Order (red first each time).** (1) Tests written first: `packages/cli/test/run-prompt-args.test.ts` (new: `--name`/positional parse, `resolveRunPrompt`, `detachFlagProblem`), a `run <prompt>` describe nested in the `run --detach` describe of `main.test.ts` (fake `startEngineRuntime`/`startTui`/`provisionWorkload`/`readStdin`), `packages/tui/test/initial-prompt.test.tsx` (new). Run against the old code: the TUI file 4 of 5 red (the "no initialPrompt" case is green by nature), the `main.test.ts` new cases red, the new args file red on the missing `resolveRunPrompt` export. (2) `flags.ts`: `--name` value flag, `resolveRunPrompt`, `detachFlagProblem` rewritten, `USAGE.run`. (3) `main.ts`: run path (prompt from positional/`--prompt`, `name` from `--name`, `runEngineTui(…, initialPrompt)` → `startTui`), HELP ×3. (4) `tui/run.tsx` `TuiOptions.initialPrompt` → `App.tsx` prop + one mount effect (`sentFirstRef`) that calls `runRef.current` — the same `run` a typed message uses. (5) README `:90-100`.

**Drift from Implementation.**
- Q2 (warning) dropped, Q3 reversed to REFUSE, Q6 as recommended — per the owner answers above; `looksLikeName` was never written.
- Error texts changed: `--detach needs --prompt <text>…` → `--detach needs a prompt: …`; a blank prompt, detached or not, is now `the prompt is empty` (one rule, Q4). `--prompt needs --detach` is gone (allowed now). Existing tests that asserted the old texts were updated.
- Existing tests that used the positional as the workload name now use `--name` (`main.test.ts` ×3: the two R12 `box` cases and `p1` in the TENTACLE_ENGINE test). `args.test.ts` `run … mypod` cases stay as they are (they only assert the POST path, which still holds with `mypod` as the prompt); no edit there.
- `--prompt -` on a TTY stdin (`main.ts` check) kept, now reached only with `--detach`.
- The ARGS tests live in a new file instead of `args.test.ts` (a heredoc append was blocked by the sandbox).
- Docs: README only. `AGENTS.md`/`ARCHITECTURE.md` do not quote `run … <name>`; the legacy docs under `docs/feat|fix|architecture/` (`detached-relay.md`, `F4-pod-execution.md`, …) are historical records and are NOT rewritten. `TODO.md` entry not ticked (the merge step).

**Mutations** (one per behaviour, applied, narrow tests run, reverted; `shasum` of `flags.ts`/`main.ts`/`App.tsx` identical to before the round — checked after the last revert): M1 TUI never sends → 4 fail · M2 name from the positional → 5 fail · M3 prompt not passed to `startTui` → 4 fail · M4 positional+`--prompt` allowed → 3 fail · M5 `--prompt -` without `--detach` → 2 fail · M6 resume+prompt allowed → 4 fail · M7 blank prompt allowed → 4 fail · M8 `--auto-accept` without `--detach` → 3 fail. NOT covered by a mutation: the `sentFirstRef` guard (the effect's `[initialPrompt]` dep already fires once; the guard is defence against a re-run, and the `/clear` + re-render test passes with or without it). A script (`mut.sh`) was not allowed to run, so the mutations were done by hand with Edit.

**Gate** (after `biome check --write` reformatted 3 files — two test files and `flags.ts`; `flags.ts`'s shasum therefore differs from the mutation round, formatting only): `bunx tsc --noEmit` clean · `bunx biome check .` clean (0 errors, 0 warnings) · `bun test packages` → **4235 pass / 3 skip / 0 fail** (main baseline 4209 / 3 / 0; +26). `apps/mobile` typecheck (`tsc -p apps/mobile`) was not run (not in the requested gate; nothing there touches these files).

**Not verified live:** the real TUI against a real pod/container (the first prompt is proven through the fake session in the Ink harness and through the `startTui` options in `main`, not a live `run`).

## Review

*— claude-opus-5-5, 2026-11-04* (fresh context; a different model family from the executor, claude-sonnet-5-5 — same vendor, so some blind spots may be shared)

**Verdict: FIX (REQUEST-CHANGES)** — one MEDIUM finding (a vacuous test + a false failure-mode claim). The behaviour itself is correct; every owner answer is implemented exactly.

**Gate (re-run by the reviewer):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (613 files, 0 errors/warnings) · `bun test packages` → **4235 pass / 3 skip / 0 fail** (4238 tests, 288 files) — matches Execution.

**Findings**

1. **MEDIUM — T4 "a failed first send puts the prompt back in the input box" is vacuous, and its premise is false.** `packages/tui/test/initial-prompt.test.tsx:76-86`, Context ("A failed first send already restores the text … `App.tsx:1181`") and Failure modes ("First send fails … restores the text into the input box"). In `streamTurn`'s catch (`App.tsx:1168-1191`) an own turn with no `successor` gets `{kind:"fail"}` (`:1169-1171`); `lostSlot` is only `TurnInProgress` (`turn-feed.ts:122-124`), so a plain error (link down, daemon refusal) goes to `failTurn` (`:1190`): the user bubble stays with the error, the input is **not** restored. The test passes only because it counts `retry me` ≥ 1 in the whole frame, which the bubble satisfies. Reviewer mutation: `restoreInput(failed.text, failed.notice)` (`App.tsx:1188`) → `void failed` ⇒ the file stays **5/5 green**. Nothing is lost (the prompt is visible in the transcript, the error is shown — same as a typed message, so §7 parity holds), but the doc states a guarantee that does not exist and the test pins nothing. Fix: rename/rewrite the test to pin the real contract (sent once, bubble + error shown, no automatic resend) and correct Context/Failure modes; or, if the owner wants restore-to-input, that is a behaviour change (see Q-A).
2. **LOW — the `sentFirstRef` guard (`App.tsx:1290-1297`) is covered by no mutation** (disclosed in Execution). The effect's `[initialPrompt]` dep already fires once for a constant prop; the guard only matters if the prop changes — no caller does that (`run.tsx:104`, one Ink `render`). Acceptable as defence; a test re-rendering with a *different* `initialPrompt` would pin it.
3. **LOW — `--auto-accept=false` without `--detach` is refused** (`main.ts:857`, `runFlags.has("auto-accept")`). Pre-existing, consistent with Q7; noting only.
4. **NIT —** the HELP line says `["<prompt>" | --prompt <text>]` while USAGE says `[--prompt <text|->] ["<prompt>"]`; both correct, slightly different shapes.

**Owner answers vs code (all TRUE, checked by running the CLI in `.tentacle/tmp/run-prompt/review/`, `TENTACLE_CONFIG_DIR` there, `DOCKER_HOST` dead):**

| Answer | Evidence |
|---|---|
| positional = first prompt | `main.ts:838-853` → `runEngineTui(…, prompt)` `:1042` → `startTui{initialPrompt}` `:790` |
| `--name` | `flags.ts:123`, `main.ts:872`; random name otherwise (`engine-runtime.ts` unchanged; T3 asserts `tentacle-` name) |
| both given (Q1) | `[error] give the prompt once: either "<prompt>" or --prompt, not both` |
| empty (Q4) | `""`/`"  "`/`--prompt "  "`/stdin `"   "` + `--detach` → `[error] the prompt is empty` |
| resume/continue + prompt (Q3) | `--continue hi`, `--resume --prompt hi`, `--resume "fix the bug"` → `[error] --resume/--continue cannot be combined with a prompt`; `--detach --resume hi` → the old detach refusal |
| `--prompt -` w/o `--detach` (Q6) | `[error] --prompt - needs --detach (the TUI needs the terminal as its stdin)` |
| `--auto-accept` w/o `--detach` (Q7) | `[error] --auto-accept needs --detach` |
| `--detach` w/o prompt | `[error] --detach needs a prompt: …` |
| `/…` raw (Q5) | `run()` (`App.tsx:1240-1284`) has no slash dispatch (that is in the submit handler `:1970`); T4 `/clear` case |
| `attach`/`rm` unchanged | `attach a b` → `unexpected argument "b"`; `runEngineTui` callers `:1310`/`:1368` pass no prompt |

**Attacks tried**
- *Exactly once — re-render / `/clear` / reconnect / handover:* one Ink `render` (`run.tsx:83`); a reconnect is below `RemoteClient`, the App does not remount; the attach/handover call sites (`main.ts:1310`, `:1368`) never pass a prompt. Holds.
- *Session not ready at mount → silent drop:* `run()` returns early on `!sessionRef.current` (`App.tsx:1243-1245`), but `sessionRef` is filled synchronously during the first render (`:602-603`), before any effect. Holds.
- *Mounted before sent:* `useEffect` runs post-commit; no StrictMode in `run.tsx`. Holds.
- *One session path (§7):* same `run` → `streamTurn` → `session.send` as typed input (`:2024`); no new RPC, no protocol bump needed. Holds. The typed path's `running`/`compacting` checks are skipped, but nothing can be running in a brand-new `run` session at mount.
- *Detached path unchanged:* relay spec carries the positional (`main.test.ts:939-942`) and `--prompt -` stdin (`:771`). Holds.
- *Failed first turn:* finding 1.

**Mutations** (narrow tests, then reverted; shasum of all 9 touched files identical before/after):
- M2 (re-run) name from the positional → 7 fail in `main.test.ts` (incl. `--name is the workload's name`, `TENTACLE_ENGINE …`, the R12 `box` cases). Caught.
- M5 (re-run) `--prompt -` allowed without `--detach` → `resolveRunPrompt > --prompt - is stdin only with --detach` + the `main` case fail. Caught (run together with M2; failures attributable by name).
- R1 (reviewer's) drop `restoreInput` in the failed-send branch → **0 fail** — finding 1.

**How the executor behaved:** followed the owner answers precisely, red-first, honest drift list (texts, new test file, uncovered guard, mobile typecheck not run, no live run). The one miss: it asserted a restore-on-failure property from a code citation without checking which catch branch a plain error takes, and wrote a test loose enough to pass either way — the §9 "prove the exact property" trap.

**Owner-level questions**
- **Q-A:** a failed *first* prompt (plain error, not a lost slot) stays as a user bubble with the error, NOT in the input — same as a typed message. Keep parity (reviewer's recommendation) or restore it into the input for the initial prompt only?
- **Q-B:** should `--auto-accept=false` without `--detach` be accepted as a no-op (it is refused today, pre-existing)? Recommend leave as is.
- No other open question: Q1–Q10 are all answered and implemented.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

Owner answers/additions after the Review (verdict FIX). Q-A: parity kept (the first prompt behaves exactly like a typed one). Q-B and Q7: `--auto-accept` is now ALLOWED without `--detach`. Plus two exit-output items and a grey look. Each item red-first, one mutation each, reverted.

**1 — failed first send = a typed message.** Doc fixed (Context line, Failure modes, above). `initial-prompt.test.tsx`: the vacuous test is replaced by one that pins the real contract (exactly ONE "retry me" in the frame — the user's message — with "link down" under it, `sends` is `["retry me"]`: no restore, no resend) and a new guard test (prop changed `a`→`b` on a re-render: only `a` was sent). Mutations: restore into the input on a plain failure → the failed-send test fails; `sentFirstRef` guard removed → the guard test fails. `App.tsx` shasum identical after both (`0762a870…`).

**2 — `--auto-accept` without `--detach`.** No new TUI mechanism: `run-ui.ts` `localAutoAccept(initial)` is a plain in-memory `AutoAcceptFeed`, handed to `startTui` as `autoAccept` (the existing feed Shift+Tab and the broker already read — `permission-ui.ts:175`), started ON for `--auto-accept` / `=true`; `=false` / absent: no feed, state unchanged. `detachFlagProblem` lost its `autoAccept` input and the "needs --detach" rule; `--detach` is untouched (relay spec). HELP + `USAGE.run` + README updated. Tests: `main.test.ts` (flag, `=true`, `=false`, absent, `set(false)` = Shift+Tab off), `run-ui.test.ts`; the two old "refused" cases were removed. Mutations: feed not passed → fails; `=false` treated as on → fails.

**3 — `run` exit output.**
- *Why the line printed twice:* `provisionWorkload` logged the kept line pre-mount (`engine-runtime.ts`, kept deliberately: it survives a signal exit, which runs no `dispose`) AND `removeUnlessKept()` at `dispose` logged it again (the old test even pinned "once before the TUI, once after dispose"). After a quit the main screen shows both. Fix: a pre-mount line sets `announced`; `dispose` does not repeat it. One line remains (visible after the quit, and after a signal).
- *New wording* (no "kept", no `--engine`, no `# workspace`): `[<noun>] <name> still running · tentacle attach <name>`; `<noun>` = `pod` (kubernetes) / `container` (docker, podman). Variants with information, same short style: detached `--keep=false` run: `[<noun>] <name> still running · removed when the run ends · tentacle attach <name>`; its start failed (relay never runs): `[<noun>] <name> stays up: the run never started · tentacle attach <name> · tentacle rm <name>`; the kept-index write failed (`warning: <name> is not in \`tentacle ps\`…` is unchanged and printed once): the attach command is then the FULL `keepHint` (engine, place), because without an index entry `attach <name>` cannot find it. The `not saved — workload kept: tentacle rm <name>` texts are detached-relay RECORD notes in `ps`/`relay.ts`/`attach-run.ts`, not the exit line: unchanged.
- *Daemon stderr only when abnormal:* `startEngineRuntime` flushes the buffered daemon stderr at dispose only if `abnormal` — the link went `reconnecting`/`stopped` (other than our own close, reason `"closed"`) or the laptop saw an RPC error (`onPeerError`). A startup failure still flushes (unchanged catch path). Tests (`engine-runtime.test.ts`, "daemon stderr on exit"): normal quit → no "daemon stderr"/"bridge: no resident"; a dropped link → printed; a startup failure → printed. Existing tests on the old wording updated (`engine-runtime`, `engine-docker`, `main`). Mutations: reprint at dispose → the one-line test fails; unconditional flush → fails; never flush → fails. `engine-runtime.ts` shasum identical after (`09548d8c…`).
- Not touched: `attach`'s own dispose still flushes stderr unconditionally (`engine-runtime.ts`, the attach path) — see questions.

**4 — grey.** `run-ui.ts` `styleStatus(line, colour)` (pure): one whole `[pod …]`/`[container …]` single line ending in `\n`, with no escape sequence, and not an error/warning/refusal (`failed`, `warning`, `error`, `stays up`, `not confirmed`, `is required`, ``not in ` ``) → `ESC[90m … ESC[39m`; everything else byte-identical. `main.ts` wraps its `write` once (`rawWrite` → `styleStatus`), so every status line of `run` and `attach` — the `resolved … →` line, the phase lines, the exit line (all through `deps.log` = `write`) — is covered. `colour` = TTY stdout and no `NO_COLOR` (a test seam `io.colour`; an injected `write` defaults to off). Tests: `run-ui.test.ts` (grey, off, errors/warnings kept, non-lines untouched) and a `main.test.ts` case through `startEngineRuntime`'s `deps.log`. Mutations: `write` not styled → fails; no error exclusion → fails; no colour gate → fails.

**Docs.** README (exit line, grey, `NO_COLOR`, stderr, `--auto-accept`); HELP/USAGE; short "superseded by feat/run-prompt" notes on the old lines in `docs/feat/docker-engine-cli.md` (×2), `docs/feat/docker-workspace-mount.md` (×2), `docs/feat/detached-relay.md` (F8) — the originals are kept as history.

**Drift / notes.**
- Mutations were done by hand (Edit) again; I first lost the "before" shasum of `main.ts`/`flags.ts` (a `tee` was blocked), so for those two the baseline is the file as restored after the first mutation pair; the `engine-runtime.ts` and `App.tsx` baselines are exact. Afterwards `flags.ts`/`main.ts` changed again (HELP/USAGE text, `biome --write`) and `run-ui.ts` changed (a lint fix: the `\x1b` moved out of the regex into `line.includes`), so those three shasums differ from the mutation round by those edits only.
- `biome` flagged `noControlCharactersInRegex` in the first `run-ui.ts`; fixed as above (the test for an escape-bearing line still passes).
- A first full `bun test packages` run stalled (>10 min, no output); the processes were killed and `bun test packages/tui`, `packages/cli`, then the whole suite ran normally. Probable cause: my own overlapping background runs/monitors (a `pgrep -f "bun test packages"` monitor matches itself). Not reproduced.

**Gate:** `bunx tsc --noEmit` clean · `bunx biome check .` clean (615 files) · `bun test packages` → **4244 pass / 3 skip / 0 fail** (4247 tests, 289 files; previous 4235 / 3 / 0, +9).

**Not verified live:** a real `run` against a docker/podman/pod (exit line, grey, auto-accept ON, the stderr rule) — covered by fakes and the Ink harness only.

**Questions for the owner** (all):
1. `attach` also prints the buffered daemon stderr at its dispose and its `[container] …` lines are now grey too: apply the "stderr only if abnormal" rule to `attach`? Recommend yes (same noise); it is a 3-line change in `attachEngineRuntime`, left out as you named `run`.
2. The exit line is printed once, BEFORE the TUI opens (so it also survives a signal exit) — after the quit it reads as the exit line, but while the TUI is starting it says "still running". Print it at quit instead (loses it on a signal kill)? Recommend keep.
3. Grey is applied to any `[pod …]`/`[container …]` whole line that is not an error/warning/refusal (by wording); a new informational line is grey for free, a new error line starting with another word would be grey too. OK, or prefer an explicit `info()` call at each emitter? Recommend keep the pure classifier.

### Review — round 2 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (fresh context per round; different model family from the executor, same vendor)

**Verdict: FIX (REQUEST-CHANGES)** — one MEDIUM: owner item 4 ("errors unchanged") does not hold for existing error lines. Items 1–3 hold.

**Gate (re-run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (615 files) · `bun test packages` → **4244 pass / 3 skip / 0 fail** (4247 tests, 289 files) — matches Execution.

**Findings**

1. **MEDIUM — the grey classifier dims real error lines.** `run-ui.ts` `NOT_INFO` recognises an error only by a leading `failed|warning|error` or a few phrases. Existing error lines of the `run` path, written through the styled `write` (`main.ts:366-370`, passed to `launchRelay` at `main.ts:1023`), do not match and turn grey. Repro (`.tentacle/tmp/run-prompt/review/grey.ts`, `styleStatus(line, true)`):
   - `[container] box: the detached run did not start` (`relay.ts:698`) → GREY
   - `[container] box: <spawn error message>` (`relay.ts:716`) → GREY
   - `[container] box: the relay has not started yet, see <log>` (`relay.ts:742`) → GREY
   - `[container] box: … — nothing was removed` (`attach-run.ts:698`, the removal-failure fate) → GREY
   - control: `[container] failed: not ready` → plain; the multi-line `daemon stderr:` block → plain (the single-line regex skips it, as it should).
   The executor's Q3 names this risk for *new* lines; it already happens for these existing ones. Fix: mark the error/refusal lines explicitly (an `info()` call at the informational emitters, or an error marker the classifier keys on), and pin each line above in `run-ui.test.ts`.
2. **LOW — "daemon stderr only if abnormal" depends on the link going non-`up` or an `onPeerError`.** A daemon-side problem that leaves the link up (e.g. an MCP server crash the daemon only logs) is now silent on a normal quit. This is what the owner asked for; noted so it is a choice and not an accident.
3. **LOW — `attach` still flushes stderr unconditionally** (disclosed, Execution Q1).

**Owner items vs code**
- (1) Failed first send = a typed message: `initial-prompt.test.tsx:76-88` now pins exactly one `retry me`, above `link down`, `sends == ["retry me"]`; guard test `:90-101` (`a`→`b` re-render, only `a` sent). Round-1 finding 1 and LOW 2 are **fixed**.
- (2) `--auto-accept` without `--detach`: `main.ts:1053` ON for the bare flag / `=true`, off for `=false` (the flag accepts only `true|false`, `flags.ts:58`). The feed is a plain in-memory `AutoAcceptFeed` (`run-ui.ts`). It goes into the existing `usePermissionBroker` (`App.tsx:477-487`), so it follows the Shift+Tab rules: own turn only, scope once, never a hooks trust ask (`permission-ui.ts:44`, `:289-290`).
- (3) Exit line: one `[<noun>] <name> still running · tentacle attach <name>` (`engine-runtime.ts:389-390`), printed before mount, `announced` stops the repeat at dispose (`:418-420`). Daemon stderr flushes at dispose only when `abnormal` (`:523-527`). The startup-failure catch flush is unchanged.
- (4) Grey on a TTY / `NO_COLOR` gate (`main.ts:368`): holds. "Errors unchanged": **does not hold**, see finding 1.

**Attacks tried**
- *Auto-accept leaking to a run the user did not flag:* the feed is built only on the interactive `run` path (`main.ts:1053-1061`). The attach call sites (`main.ts:1310` with the relay's own feed, `:1368` with none) never get it. It is not persisted and nothing else shares it (`onChange` is a no-op). Inside the same TUI it survives `/clear` and session swaps, exactly as Shift+Tab state does. Holds.
- *Single broker (§7):* the feed is only state. `permissions` is still the one `PermissionBroker` (`main.ts:1033`) passed to both the runtime and `startTui`. Holds.
- *Pod-originated lasting approval (§7):* auto-accept grants once, per request, and only for own-turn requests. A hooks trust request is excluded (`autoApproves`). No new path. Holds.
- *Our own quit vs a fault:* `stopped/"closed"` comes only from `dispose` (`remote-client.ts:1001`). A peer drop is `"disconnected"` (`:1216`), so it counts as abnormal. Holds.
- *Raw writes while Ink owns the terminal:* the `onLinkStatus` handler only sets a flag. Flushing happens in `disposeTransport` (after unmount). The exit line is written before mount. `styleStatus` only changes bytes and adds no write. Holds.
- *Grey on error lines:* finding 1.

**Mutations** (narrow files; shasum of all 17 modified/untracked files identical afterwards — `diff` of the before/after lists, empty):
- re-run: unconditional stderr flush → `daemon stderr on exit > a normal quit prints none of it` fails. Caught.
- re-run: `=false` treated as on (`runFlags.has`) → `--auto-accept[=true] without --detach … =false / absent: off` fails. Caught.
- reviewer's: link-status subscription never sets `abnormal` → `a link that dropped (abnormal) prints it at the quit` fails. Caught.

**How the executor behaved:** it fixed the round-1 finding exactly, with mutation-backed tests. It explained why the line printed twice instead of patching the symptom, and it disclosed what it did not do (attach stderr, lost shasum baseline, the stalled test run). The miss: it checked the grey classifier against its own sample lines, not against the error lines that already exist on the same `write`.

**Owner-level questions (all)**
- Q-1 (executor Q1): should `attach` get the same "stderr only if abnormal" rule? Reviewer: yes.
- Q-2 (executor Q2): keep the exit line printed before mount (it survives a signal), or print it at quit? Reviewer: keep.
- Q-3 (executor Q3, reframed by finding 1): grey by wording (a classifier) or by explicit marking at each informational emitter? Reviewer: explicit marking. The classifier already gets existing errors wrong.
- Q-4: should a daemon-side error that leaves the link up (finding 2) still print its stderr at quit? Reviewer: no (the owner's rule as given). Revisit if diagnosis suffers.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-04*

Owner decisions after Review round 2 (FIX, finding 1 MEDIUM: the wording classifier greyed existing error lines).

**1 — grey by explicit marking.** `NOT_INFO`/`styleStatus` are gone. `run-ui.ts` `styleInfo(line, colour)` (pure; grey only if `colour`, a line already carrying an escape sequence is left alone). `main.ts`: `write` is back to the raw writer and NEVER styled; a separate `info(text)` = `write(styleInfo(text, colour))` (`colour` = TTY stdout, no `NO_COLOR`, seam `io.colour`). Emitters that call `info`: the two `resolved … →` lines (`main.ts`); in `engine-runtime.ts` a new optional `info` dep on `EngineRuntimeDeps`/`EngineAttachRuntimeDeps` (absent → `log`): the non-TTY phase lines (creating/waiting/attaching/…), `… ready in …`, `… attached to …`, and the exit line. Everything else keeps `log`/`write`: errors, refusals, warnings, `warning: … is not in \`tentacle ps\``, the `stays up: the run never started` failure, the stderr block, `relay.ts`/`attach-run.ts` lines. Tests: `run-ui.test.ts` (grey, off, escape-bearing line untouched); `main.test.ts` — the `run` case feeds `deps.info` one info line and `deps.log` the review's four lines (`relay.ts:698/:716/:742`, `attach-run.ts:698` texts) plus a failure and a warning: exactly ONE grey segment, every `log` line verbatim, no escape at all with colour off; the real `attach` path with `colour:true`: `resolved …` and `attaching to …` grey, `failed: Docker engine socket not found` not; `engine-runtime.test.ts` — the exit line and phases arrive in `info`, the `not in \`tentacle ps\`` warning in `log`. Mutations: every `write` greyed → `main.test.ts` 2 fail; `info = deps.log` in `provisionWorkload` → 1 fail.

**2 — `attach` gets the stderr rule.** `createFaultWatch()` (exported, shared): `mark()` on a laptop RPC error, `watch(runtime)` on the link going `reconnecting`/`stopped` other than our own close (`"closed"`); `run` was refactored onto it and `attachEngineRuntime` uses it: the buffered daemon stderr is flushed at dispose only if `faulted()`. The startup-failure `catch` still flushes. Tests (`engine-runtime.test.ts`): attach normal quit → no `daemon stderr`; attach after a dropped link → printed. Mutation: unconditional flush in the attach dispose → 1 fail.

**3 — exit line before mount:** kept as is (owner); no change.

Mutation hygiene: three mutations, each reverted; `shasum` of `main.ts`/`engine-runtime.ts`/`run-ui.ts` identical before/after (`355bb32e…`, `237ba6bb…`, `6f087449…`).

**Gate (one foreground run, nothing in the background):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (615 files) · `bun test packages` → **4246 pass / 3 skip / 0 fail** (4249 tests, 289 files; previous 4244 / 3 / 0, +2).

**Not verified live:** a real terminal run for the grey output and a real attach/run for the stderr rule (fakes and the CLI harness only).

**Questions:** none open. (Review round 2's Q-1/Q-3 are answered by items 1–3; Q-4 stays as the owner's rule.)

### Review — round 3 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (fresh context per round; different model family from the executor, same vendor)

**Verdict: PASS** (LOW items only, listed below). Round-2 finding 1 is fixed by construction, and the stderr rule now covers `attach`.

**Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (615 files) · `bun test packages` → **4246 pass / 3 skip / 0 fail** (4249 tests, 289 files). This matches Execution.

**Checks**
1. **Grey by explicit marking. Holds.**
   - `main.ts:366` `write` is the raw writer again. `info` (`:371`) is the only styled path.
   - `launchRelay` gets `write` (`main.ts:1023`), so the round-2 error lines (`relay.ts:698/716/742`) are never grey. So is `attach-run.ts:698`, because `joinRun` gets `write`. The `stays up` failure goes to `log` (`engine-runtime.ts` `logKept(…, false)`). So do the stderr block (`createStderrSink(…, deps.log)`) and the `not in tentacle ps` warning.
   - Grey lines: the `resolved … →` lines (`main.ts:1286`, `:1354`), the exit line, and the piped phase / `ready in` / `attached to` lines.
   - No raw write while Ink owns the terminal. `info` adds no new write site: it calls `write` at the same moments as before, before mount or after unmount. `fault.watch` only sets a flag.
2. **`attach` stderr rule. Holds.**
   - `createFaultWatch` is shared by both runtimes. Both dispose flushes are gated on `faulted()`.
   - Both startup `catch` paths still flush unconditionally (the TUI never mounted).
   - A dropped or stopped link (other than our own `"closed"`, which only `dispose` produces, `remote-client.ts:1001`) or an `onPeerError` sets the fault, in `run` and in `attach`.
3. **Exit line unchanged** from round 2: `engine-runtime.ts` `keptLine`, printed once before mount, with `announced` stopping the repeat.

**Mutations** (narrow files; `diff` of the shasum lists of all 17 modified/untracked files is empty afterwards):
- re-run: unconditional flush in the attach dispose → `attach: a normal quit prints none of the daemon's stderr` fails. Caught.
- re-run (variant of "every write greyed"): the run deps' `log: info` → `grey is by explicit marking …` fails, and its received output shows all four round-2 lines greyed. Caught.
- reviewer's: `fault.watch(runtime)` removed from `attachEngineRuntime` → `attach: a dropped link prints it at the quit` fails. Caught.

**LOW / nits (no FIX)**
- L1: on a TTY the phase lines go to the transient `StatusLine` (`deps.log`), not `info`, so they are not grey while shown. They are cleared before mount, so only the persistent lines (resolved, exit) are grey on a terminal. Probably intended; noted against "every informational line".
- L2: `launchRelay`'s success line (`relay.ts:733`, `detached run started …`) and `attach-run.ts` informational lines (e.g. `session closed by another terminal`, `removed <name>`) stay plain. This is the safe direction, but it is inconsistent with item 4.
- L3: a fault that does not touch the link (an Ink/`startTui` throw, a daemon-side error the daemon only logs) prints no daemon stderr at quit. This is the owner's rule (round-2 Q-4).
- L4: not verified live (real terminal, real engine). Executor disclosed it.

**How the executor behaved:** it replaced the classifier rather than extending its word list (the right fix). It pinned the exact four lines from the review as tests and refactored `run` onto the shared watch instead of copying it. Its report was accurate, and every claim I checked held.

**Owner-level questions (all)**
- Q-1 (L2): grey the remaining informational lines (`relay.ts:733`, the `attach-run.ts` session/removal notes) too, through `info`? Reviewer: optional; a follow-up S task if wanted.
- Q-2 (L3): keep "stderr only on a link/RPC fault", or also flush when the TUI itself failed (`startTui` threw)? Reviewer: also flush on a TUI failure. It is cheap and it is a failure path.
- No other open question.

### Execution — round 4

*— claude-sonnet-5-5, 2026-11-04*

Owner decisions 2026-11-04 after a live run (run AND attach). A previous session had already left items 1–4's building blocks (`pod-stderr-log.ts` + test, `createFaultWatch`/`quitReport`, `daemonLogPath` in `main.ts`/`engine-runtime.ts`, tests); I finished and extended them. Red first per item, one mutation each, reverted (shasum of `engine-runtime.ts`/`pod-stderr-log.ts`/`workspace-mount.ts`/`status-line.ts`/`main.ts` identical after: `178d0ec0…`, `4f493596…`, `0cbeb547…`, `ab3e5383…`, `51514e9d…`).

1. **Model/turn error is not abnormal.** `createFaultWatch`: only a dropped/stopped link (not our own `"closed"`) or `markFault` (the TUI threw) is a fault; the laptop's RPC error (`[laptop rpc] …`) only goes to the log. Mutation: count `up` as a fault → `createFaultWatch` test fails.
2. **`[daemon] bridge: no resident …` never on the terminal.** All daemon stderr → file (`onStderr: stderr.onStderr`); no dump in `run`/`attach`, normal quit prints nothing about it (test "a normal quit …").
3. **`daemon.log` per run.** `pod-stderr-log.ts` `openDaemonLog` (0600, last 64 KiB, never throws). Path: the run dir (`runDirFor`) once the run is in the kept index, else `<configDir>/logs/<name>/daemon.log` (`main.ts` `recordedNames`: a setup that fails before the index record must not leave a run dir; found by a cascade in the `kept` test).
4. **Real failure = ONE dim line.** `quitReport`: `[container] <name>: daemon stopped unexpectedly · log: ~/…/daemon.log`, through `info` (dim). Startup failures: the error keeps its message, is tagged with `logPath` (`recordFailure`, non-enumerable) and the full text is written to the log; `main` prints `failedLine` (below). `withLogPath` (message suffix `(daemon log: …)`) is gone.
5. **Residual lines dim.** The exit line, phases, `ready in`, `attached to`, `quitReport`, relay start line and `removed <name>` go through `info` (round 3 + now). Left plain on purpose: `attach-run.ts` notes whose wording mixes info/error (`another terminal is closing the run`, `UNSAVED_NOTE`, `<shown> <detail>`) — not touched.
6. **Mount messages** (`workspace-mount.ts`). a) `DEFAULT_HIDE`: `~/.docker` (folder). b) y/N exactly two lines: `⚠ mount <src> (<short danger>) into the container? hidden: <names…> +N from .tentacle/hide` / `Continue? [y/N] `; `src` written `~` (the plan carries `home`), names relative to the mount, hide-file paths counted; short dangers: `your home` / `holds your home` / `inside <label>` / `a system directory`; no `hidden:` part when nothing is hidden. `hiddenSummary` and its startup line removed (and the phase line no longer carries the hidden list). c) non-interactive: `won't mount ~ (your home) without confirmation · run from a project folder, or pass --confirm-mount`. d) case refusal two lines (`won't mount <src>: <file> would be readable inside the container` / `  fix: add \`<dir>/\` to .tentacle/hide`, or `move <file> out of the folder` for the mount root, `, or pass --confirm-mount to start anyway` unless the key file); several files are listed (3, then `and N more`). `main.ts` no longer prefixes plan refusals with `failed:` (they are refusals; the gate's never had it). e) errors normal colour, the two prompt lines plain. Mutations: `config.json` default back / always offering `--confirm-mount` / `hidden:` dropped → 1 / 1 / 6 tests fail.
7. **Startup output.** a) *Cause verified by reading `status-line.ts`:* `repaint` padded every frame to `max(line, lastWidth)`, so after podman's ~210-cell `creating … in unix:///…sock (podman socket (auto-discovered))` every later frame carried ~200 spaces, wrapped on an 80/100-column terminal, and `\r` returned only to the wrapped row. Now `\r` + `ESC[2K` + the text cut to `columns-1` DISPLAY cells (`cutToCells`, wide glyphs = 2; `columns` injectable, default `process.stdout.columns`, unknown → not cut); `finish` writes `\r ESC[2K`. Tests capture the bytes at 80 and 210 columns (no padding, ≤ columns-1, a 300-cell line then a short one) + double-width + tick frames. Mutation: no cut → 2 fail. Glyphs `▓░`/braille kept (not the cause; the `columns-1` slack covers ambiguous width) — switch to ASCII if a terminal still wraps. b) phase line `creating <name> (image <ref>)` (+ ` — workspace <target> (rw)` when mounted); the engine's place (socket, discovery note) is no longer shown (not written to the log either: provisioning precedes the log; say if you want it). `attaching to <name> in <where>` left as it was. c) `provisionWorkload` takes `deferAnnounce` and returns `announce`; `startEngineRuntime` exposes `runtime.announce`; `runEngineTui` calls it right before `startTui` (after the session picker), never before a failure, never at dispose of a run whose TUI never opened. The "not in `tentacle ps`" warning is independent of it (said at setup end, also on failure). Detached `run` is unchanged (announces at ready). Mutation: always announce at ready → 2 fail. d) `[container] failed: <first line, ≤120 chars> · log: <path>` in the 3 catch sites of `main.ts` (detached provision, run, attach); full text in the log (`provisionWorkload` wrapper records any failure after the name exists). Generic first-line cut, no special "crashed in the container" wording: `tentacle --version failed (exit 134): <first stderr line>` — say if you want the exact owner example. Mutation: whole message → 2 fail.

**Drift/notes.** On a failure after the workload exists with `--keep`, nothing says it is still up any more (decision 7c): `tentacle ps` lists it. `docs/feat/docker-workspace-mount.md` gets a superseded note; `README.md` updated (stderr/log, defaults, two-line prompt/refusals, one-line failure). Not verified live (real podman/docker terminal); the 80/210-column byte capture is by a fake sink.

**Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4265 pass / 3 skip / 0 fail** (4268 tests, 290 files; previous 4246 / 3 / 0).

### Review — round 4 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (fresh context per round; a different model family from the executor, same vendor)

**Verdict: PASS.** Only LOW items remain, all listed below. Every owner decision of round 4 is implemented, and no real failure path is silent.

**Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4265 pass / 3 skip / 0 fail** (4268 tests, 290 files). Matches Execution.

**Checks**

1. **Turn/model error is not a fault.** `onPeerError` only appends `[laptop rpc] …` to the log (`engine-runtime.ts:606`). `createFaultWatch` (`:130-149`) counts only a non-`up` link (other than our own `"closed"`) or `mark` (the TUI threw, `main.ts:818`). A normal quit prints only the `still running` line. Holds.
2. **`bridge: no resident …` never reaches the terminal.** Exec `onStderr` → `openDaemonLog(...).onStderr` (`:569`, `:577`; attach `:681`). Nothing flushes daemon stderr to stdout any more. Holds.
3. **`daemon.log`** (`pod-stderr-log.ts`): created or truncated with mode 0600 plus `chmodSync`, parent dir 0700 on creation, last 64 KiB, never throws.
   - Content: exactly what the old buffer held (daemon stderr + `[laptop rpc]` messages), plus `[tentacle] failed: <message>` for setup failures. Those messages were printed to the terminal before.
   - So nothing new leaks; the log narrows exposure (a 0600 file instead of the scrollback).
4. **No failure path is silent.**
   - Setup failures of `run`, detached `run` and `attach` print `failedLine`: the first line, ≤120 chars, sanitised, plus ` · log: <~path>` when recorded (`main.ts:1023`, `:1068`, `:1410`).
   - A mid-session link drop or stop, or a TUI throw, prints `quitReport` (`[<noun>] <name>: daemon stopped unexpectedly · log: …`) at `disposeTransport`. This holds for run (`:593`) and for attach (`:933`), including the joined detached-run path via `release`/`quit`.
   - Joined-run errors keep their own `[noun] failed: …` (`attach-run.ts`).
5. **No raw write while Ink owns the terminal.**
   - `quitReport` is written from `disposeTransport`. That is reached only through `dispose`/`release`/`quit`, called from `teardown`/`finish` after `startTui` resolves (`main.ts:822`, `attach-run.ts:535`).
   - `announce()` runs right before `startTui` (`main.ts:793`).
   - Log writes go to a file. The `StatusLine` is finished before mount.
6. **Mount messages.**
   - The refusal *conditions* are byte-for-byte the same code. `planWorkspace` still refuses a case-aliased always-hidden (key) file with no override. `mountGate` still refuses other case-exposed files unless `--confirm-mount`. The non-interactive danger refusal is unchanged in logic.
   - Only the wording changed. Sanitising is kept on the `what`/file names.
   - `DEFAULT_HIDE` `~/.docker/config.json` → `~/.docker`. This is stronger when mounting `~` or an ancestor: the whole folder is masked, and the file mask's case-insensitivity refusal no longer applies. See L1 for the one corner where it is not.
7. **Startup output.**
   - Bytes captured by the reviewer (`.tentacle/tmp/run-prompt/review/status.ts`, fake sink). Each frame is `\r ESC[2K` + text cut to `columns-1` cells, no padding, no `\n`:
     - 80 cols: a 250+ char `creating …` line → 79 cells, a short line → 48, CJK → 78.
     - 210 cols: → 209 / 48 / 208.
   - `finish` writes `\r ESC[2K`.
   - `still running` comes only via `announce` before `startTui`. It is never printed on a setup failure and never at dispose of a run whose TUI never opened.

**Mutations** (narrow files; `diff` of the shasum lists of all 26 modified/untracked files is empty afterwards):
- re-run: `up` counted as a fault → `createFaultWatch: only a dropped or stopped link …` fails. Caught.
- re-run: `failedLine` prints the whole message → 2 fail (`failedLine …`, `a setup failure is ONE short line …`). Caught.
- reviewer's (mask strength): the non-overridable refusal for a case-aliased always-hidden key file removed → `R2-3 … the key file aliased → refused, never overridable` and `main … refuses — even with --confirm-mount` fail. Caught.

**LOW / nits (no FIX)**
- **L1 — cwd *inside* `~/.docker`.** The reviewer repro (`docker-mask.ts`, `planWorkspace` + `mountGate`) shows the change:

  | | Before (file default) | Now (folder default) |
  |---|---|---|
  | Mount | silent | the plan carries danger `inside ~/.docker` |
  | `config.json` | masked | readable after an explicit y / `--confirm-mount` (no mask: the mount root cannot be masked) |
  | Non-interactive | — | refused |

  This is the same rule `~/.aws`/`~/.kube` already follow, and it needs explicit consent. Still, it is the one place a secret that used to be masked can become readable. See owner question Q-1.
- **L2 — an attach truncates the run's `daemon.log`.** `openDaemonLog` writes `""` at open (`attachEngineRuntime` `:681`). So `run` fails with `log: …/daemon.log`, then `tentacle attach <name>`, and the evidence is gone. Two TUIs attached to one detached run also clobber each other's file: each rewrites the whole file from its own buffer.
- **L3 — misleading wording after a recovered reconnect.** A transient `reconnecting` that recovers still marks a fault, so a run that worked ends with `daemon stopped unexpectedly`. That is wrong wording, but it is not a silent failure.
- **L4 — `onStderr` does a synchronous `writeFileSync` of up to 64 KiB per chunk** on the laptop main (render) thread. Harmless at normal volume; a chatty daemon could cost frames.
- **L5 — a failed setup with a kept workload no longer says it is still up** (disclosed: decision 7c). Only `tentacle ps` shows it.
- **L6 — not verified live** (a real podman/docker terminal), disclosed. I checked the owner's exact y/N wording only against Execution's quote, not against the owner's original message.

**How the executor behaved:** it found the real cause of the redraw bug (padding to an earlier, wider line), not a cosmetic one, and pinned it with byte captures. It changed only the wording of the mount messages and left the refusal logic alone. It disclosed decision 7c's side effect and the parts it did not verify live. It again used one mutation per item and kept the shasum discipline.

**Owner-level questions (all)**
- **Q-1 (L1):** with `~/.docker` as a folder, running *from inside* `~/.docker` after y / `--confirm-mount` exposes `config.json`, which used to be masked. Accept it (same rule as `~/.aws`), or refuse a cwd inside a default-hidden dir outright, like `~/.ssh`? Reviewer: accept; it needs explicit consent.
- **Q-2 (L2):** `daemon.log`: truncate per run/attach (now), or append with a separator, or one file per attach? Reviewer: append, still bounded, so a crash's log survives the `attach` the user runs next.
- **Q-3 (L3):** count a reconnect that recovered as a fault? Reviewer: no; only a link that ends `stopped` (not `"closed"`) or never came back up.
- **Q-4 (L5):** after a setup failure with a kept workload, add ` · still up: tentacle rm <name>` to the one failure line? Reviewer: yes; one line, no noise.
- **Q-5 (7b, executor's):** show the engine place (socket / discovery note) somewhere, in the log or the phase? Reviewer: log only.
- **Q-6 (7d, executor's):** keep the generic first-line cause, or use a specific wording for a binary that crashed in the container? Reviewer: generic.

**Owner decisions on Review round 4 (2026-11-04):** Q-1 accept as is (cwd inside `~/.docker` is asked like `~/.aws`; no code). Q-2 `daemon.log` is APPENDED by every run/attach with a one-line separator, bounded, newest bytes kept, 0600 (code, round 5). Q-3 a recovered reconnect is not a fault (code, round 5). Q-4 a setup failure leaving a kept workload up appends ` · still up: tentacle rm <name>` (code, round 5). Q-5 socket/discovery note → log only: kept as is (the log does not exist yet at that point; no new mechanism). Q-6 generic first-line cause kept (no code).

### Execution — round 5

*— claude-sonnet-5-5, 2026-11-04*

Red first (assertions), one mutation per item, reverted (shasum of `engine-runtime.ts` `417be5d6…` and `pod-stderr-log.ts` `433cba4b…` identical after).

- **Q-2 append.** `pod-stderr-log.ts` `openDaemonLog(path, cap, label?)`: `appendFileSync` (created 0600, `chmod` 0600 on an older file), writes `--- <ISO time> <run|attach> <name> ---` at open, every chunk is appended (two live handles do not clobber), over the cap the oldest bytes are dropped. Callers: `provisionWorkload` failure and `startEngineRuntime` = `run <name>`, `attachEngineRuntime` = `attach <name>`. Mutation: truncate at open → 2 tests fail (kept earlier text, separator).
- **Q-3 recovered reconnect.** `createFaultWatch`: `reconnecting` sets `down`, `up` clears it; `stopped` other than `"closed"` and `mark` latch; `faulted() = marked || ended || down`. So a quit while still down (even via our own `"closed"`) is a fault, a recovered one is not. Mutation: latch on `reconnecting` → the fault-watch test fails.
- **Q-4 `still up`.** `removeUnlessKept(error)` tags the error (`markStillUp`, non-enumerable) when the workload is kept, exists (a failed `create` never reaches it), is not a `removedAtEnd` run (it has its own `stays up` line) and the index write succeeded; `failedLine` appends ` · still up: tentacle rm <name>` after the log part. Attach never tags (user-owned). Mutation: tag also when the index write failed → the negative test fails.

README updated. **Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4270 pass / 3 skip / 0 fail** (4273 tests; previous 4265 / 3 / 0).

### Review — round 5 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (fresh context per round; different model family from the executor, same vendor)

**Verdict: PASS.** Only LOW items remain. Since round 4, only `pod-stderr-log.ts`, `engine-runtime.ts`, their two test files, README and this doc changed (shasum diff against the round-4 list).

**Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4270 pass / 3 skip / 0 fail** (4273 tests, 290 files). This matches Execution.

**Checks**
- **Q-2, append, cap and separator.** `appendBounded` (`pod-stderr-log.ts:33-39`) appends, then keeps the last `cap` bytes.
  - Reviewer repro (`.tentacle/tmp/run-prompt/review/cap.ts`, cap 200): two live handles (`run box` and `attach box`), a 150 B chunk, then a 500 B chunk. The file ends at exactly 200 B, mode 600.
  - A third open appends `--- <ISO> attach box ---` plus its text after the earlier tail. Earlier runs survive, and the cap holds even for one chunk bigger than the cap.
  - A pre-existing file is narrowed to 0600 by `chmodSync`. Holds.
- **Q-3, recovered vs. ended reconnect.** `createFaultWatch` (`engine-runtime.ts:130-157`): `reconnecting` sets `down`, `up` clears it, and `stopped` (≠`"closed"`) and `mark` latch.
  - The union in `link-machine.ts:50-58` has exactly three states, so the `else` branch covers only `stopped`.
  - The test (`engine-runtime.test.ts:1016-1046`) pins five cases:

    | Link sequence | Fault? |
    |---|---|
    | reconnecting → up | no |
    | reconnecting → up → reconnecting | yes |
    | reconnecting → our own `closed` | yes (still down at the quit) |
    | recovered, then stopped | yes |
    | our own close alone | no |

  Holds.
- **Q-4, the `still up` suffix only when really kept.** `removeUnlessKept(error)` (`engine-runtime.ts:470-495`) tags the error only under all of these:
  - `keptLine` is set (`--keep`);
  - not `removedAtEnd` (detached `keep=false` keeps its own `stays up` line);
  - not `WorkloadRemovedError`;
  - the index write did not fail (`!notRecorded`);
  - the workload exists: a failed `host.create` throws from its own `try` (`:417-427`) before `removeUnlessKept` is reachable.

  The attach paths never call it. `failedLine` appends the suffix after the log part. The tests at `:1081-1119` cover kept, not kept, `removedAtEnd`, a failed create (kube), and a failed index write. Holds.

**Mutation (reviewer's own):** cap trim disabled (`size > cap * 1000`) → 2 fail in `pod-stderr-log.test.ts` (`over the cap the NEWEST bytes stay …`, `keeps what the daemon wrote; the file is bounded …`). Reverted. The `diff` of the shasum lists of all modified/untracked files before and after is empty.

**LOW (listed, not asked)**
- L1: two live handles over the cap race. A's append can fall between B's read and B's rewrite and be lost. The cap still holds, and it is diagnostics only.
- L2: once the file is at the cap, every chunk does a synchronous read and rewrite of 64 KiB on the laptop main thread (round-4 L4, now on every chunk). This is fine at normal daemon volume.
- L3: the byte-level trim can cut a UTF-8 sequence or the oldest separator line in half. Cosmetic.
- L4: `keepHint` set with no `recordKept` dep still gets `still up`. No production caller does this; `main` always passes both.
- Carried from round 4 (owner decided no code): L1 `~/.docker` cwd, L6 not verified live.

**How the executor behaved:** red first, one mutation per item, exact scope (only the three decisions, no drift), honest report. Its claims matched the code and the reviewer's repro.

**Owner-level questions:** none (LOW only).

### Execution — round 6

*— claude-sonnet-5-5, 2026-11-04*

Owner, live: three success-path lines removed from the terminal (run AND attach, every engine). Red first (the updated tests failed on the old code), one mutation per item, reverted (shasum of `relay.ts` `bdffb3f3…`, `main.ts` `951b9d97…`, `tui-sessions.ts` `f2249ee3…` identical after).

1. **`detached run started (pid N), …` gone.** `relay.ts` `launchRelay` returns 0 silently once the relay left `starting`; `endingOf`, `LaunchDeps.info/mounted/keepsAwake` and their `main.ts` wiring are removed (a dead `keepsAwake`/`whereOf` import too). The only output of a successful `run --detach` is the provisioner's dim `still running · tentacle attach <name>` (once; `· removed when the run ends ·` for `--keep=false`). Failure paths keep their texts (`did not start`, `stays up …`, `has not started yet, see <log>`). Info that went with it: the auto-accept policy (the spec/relay log keep it), the Mac keep-awake note and the `--keep=false` removal explanation (README keeps them). Mutation: print a started line again → 6 tests fail (relay + 4 main + sessions).
2. **`[resume] <uid> — <title>` gone on attach.** `tui-sessions.ts` `openTuiSessions`: for a `live` run's record only its warnings print; errors/refusals and the non-live (`--resume`) flow are unchanged. Mutation: ignore `live` → the `live` test fails.
3. **`resolved <name> → <engine>, <where>` gone.** Both sites in `main.ts` (attach and the joined detached run). `attaching to <name> in <where>` (phase line) still names the place; failures name the workload. Mutation: re-add it in attach → the attach test fails (grey and plain).

README updated (one sentence). **Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4266 pass / 3 skip / 0 fail** (4269 tests; five relay/main tests were folded into one, so −4 vs 4270).

### Review — round 6 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (fresh context per round; a different model family from the executor, same vendor)

**Verdict: PASS.** Only LOW items remain. Since round 5, these changed: `relay.ts`, `main.ts` and `tui-sessions.ts` (plus `tui-sessions.test.ts`, which is new to the diff), `main.test.ts`, `relay.test.ts`, README and this doc. Checked with a shasum diff against the round-5 list.

**Gate (one foreground run):** `bunx tsc --noEmit` clean · `bunx biome check .` clean (617 files) · `bun test packages` → **4266 pass / 3 skip / 0 fail** (4269 tests, 290 files). This matches Execution.

**Checks**
1. **The `detached run started` line is gone, and the error paths are intact.**
   - `launchRelay` (`relay.ts:~706`) now only drops the success write.
   - `failed()` is unchanged: `did not start`, the log tail, `stays up: \`<attachHint>\` … (log: …)`. So are the spawn-error line and `has not started yet, see <log>`. `attachHint` stays in `LaunchDeps` for them.
   - The removed `mounted`/`keepsAwake` deps fed only the started line. Keep-awake *behaviour* lives in the relay process (`relay.ts:136-180`, `config.detach.keepAwake`) and is untouched.
   - The auto-accept policy is still in the spec and the relay log. Holds.
2. **`[resume] <uid> — <title>` on a live attach.**
   - `openTuiSessions` (`tui-sessions.ts:111-116`): for a `live` run with a found record, it prints only `resolved.notices` as `[resume] <warning>`.
   - `found()` (`session-resume.ts:145-153`) builds `lines` as exactly those warnings plus the uid/title line, so only the title line is dropped.
   - Fatal, cancelled, picker-failed and the non-live `--resume` flow are unchanged (other branches; `record === null` keeps `lines`). Holds.
3. **`resolved <name> → <engine>, <place>`** is removed at both `main.ts` sites. Nothing else on those paths changed in the diff. Errors still print through `failedLine` / `attach-run.ts`. Holds (L2 below).
4. **`still running` after `run --detach`.** It is printed once by construction: `provisionWorkload` without `deferAnnounce` calls `announce()` once (`engine-runtime.ts:541-549`), the `announced` guard is in place, and the launcher adds no line (`main.test.ts:715-735` asserts that main itself writes `""`). The REAL-provision test `L12` (`engine-runtime.test.ts:1136`) checks it with `toContain`, so it does not pin "once" (L1).

**Mutation (reviewer's own):** in the non-deferred path, `announce(); announced = false; announce();` (the line printed twice) → **0 fail** across `engine-runtime`, `engine-docker`, `main` and `relay` tests (283 pass). Reverted; the shasum list diff is empty. The behaviour is correct today, but "exactly once" for a detached run is not pinned. The round-2 duplicate bug was this class (it was on the deferred/dispose path, which its own test still covers).

**LOW (listed)**
- L1: no test pins `still running` *exactly once* for `run --detach`. Tightening `L12`'s `toContain` to a count of 1 (and the same in `engine-docker.test.ts:397/948`) would catch the mutation above.
- L2: with `resolved … → <engine>, <place>` gone, an `attach` that fails after the index lookup no longer says which engine and place were dialed. On a TTY the `attaching to <name> in <where>` phase is transient, so it is cleared before the `failed:` line. That makes a wrong-engine index entry harder to diagnose; it could go into the daemon log or the failure line.
- L3: README keeps the Mac keep-awake and `--keep=false` removal explanations, which the terminal no longer repeats. This is the owner's choice, noted only.
- Carried: round-4 L1 (`~/.docker` cwd), round-5 L1–L3 (log race, synchronous I/O at the cap, byte trim), not verified live.

**How the executor behaved:** exact scope (three lines, their dead deps and imports, README sentence). It reported that tests were folded together (−4) instead of hiding it. Its claims matched the code. Its own mutations covered the three removals. The one gap is the "once" property: the owner named it, and the executor's tests check the absence of main's line, not the count of the provisioner's.

**Owner-level questions:** none (LOW only).
