# eval/local-relay — always-on local session process (decided: NO-GO for now)

> **Type:** eval · **Decision (owner, 2026-11-14 23:30): NO-GO now.** Do not build the local relay; `/detach` (feat/tui-detach) is parked. The mobile app targets `tentacle serve` / `connect` as originally designed. Follow-ups: `remove-in-process` (fix, queued); revisit the relay only with real usage data for `/detach`. Plan kept on branch `feat/local-relay` (a369cb6b), its Fable review and the /detach design history on branch `feat/tui-detach`.

# Eval — feat/local-relay: GO / NO-GO

*— claude-opus-5-5, 2026-11-14* · input: `docs/feat/local-relay.md` (a369cb6b) + `design-review.md` (Fable, REVISE)

## Sintesi per il proprietario (italiano semplice)

**Verdetto: NO-GO adesso** per il relay completo. Riconsiderarlo solo se un uso reale di `/detach` lo giustifica.

- **Cosa compra davvero.** Quasi tutto il valore è `/detach`: chiudere il terminale e lasciare il lavoro in corsa. Il resto pesa poco senza `/detach`:
  - accesso dal telefono alle sessioni locali: NON è nel v1 (piano D13);
  - più terminali sulla stessa sessione: caso di nicchia;
  - "un solo modello di sessione": il piano in realtà aggiunge un secondo regime di salvataggio (due scrittori).
- **Cosa costa.**
  - 13 slice (LR0–LR11, LR5 diviso in due) più circa 3 slice per le correzioni di Fable, tutte su `load-bearing`.
  - Cambia il percorso più usato in assoluto: ogni `tentacle` normale.
  - Fable ha trovato 5 difetti HIGH. Sono tutti correggibili, ma due toccano il daemon e le regole dei permessi.
- **Pulizia.**
  - Oggi: zero file, zero socket, zero processi extra. Il worker è un thread e muore con la TUI.
  - Con il relay: per ogni sessione un processo in background, una cartella `local/<id>/` (record, log, socket, lock, presenze, auto-accept), a volte un socket in `$TMPDIR` e un `caffeinate`.
  - Restano cartelle "lost" fino a 24 h, e un relay vecchio sopravvive a un `tentacle update` o a una modifica del codice. Per chi sviluppa tentacle con tentacle questo è attrito quotidiano.
- **Fluidità.** Si aggiunge un secondo processo Bun all'avvio. Va misurato (ricetta al §4). Soglia: +50 ms di mediana al massimo, altrimenti è NO-GO come default.
- **Sicurezza.** Oggi la decisione sui permessi non è raggiungibile da fuori. Con il socket, gli strumenti dell'agente (stesso utente) potrebbero rispondere da soli ai permessi (Fable M1).
- **Alternativa che esiste già.** `tentacle serve` + `tentacle connect` sullo stesso Mac danno oggi, su scelta esplicita, quasi tutto: uscire stacca senza chiudere, più terminali, telefono, la sessione sopravvive al crash della TUI. Le lacune vere sono tre: lo storico sta nello store del daemon e non in `--resume`, niente `/move`, hooks-trust. Chiudere quelle lacune costa molto meno del relay.
- **`--in-process`.** NON è deprecato oggi (`main.ts:2065-2069`, fallback a `:2159`), ma tu l'avevi già deciso il 2026-11-07 (`TODO.md:458`, `remove-in-process`). Consiglio: rimuoverlo e trasformare il fallback silenzioso in un errore chiaro. È indipendente dal relay.
- **Cosa fare:** (1) non costruire il relay ora; (2) `remove-in-process` come piccolo fix; (3) un `eval` "local serve come sessione staccabile" se vuoi `/detach` o il telefono; (4) rivalutare il relay solo con dati d'uso.

---

## 1 · VALUE (ranked)

| # | Benefit | Needs `/detach`? | Real today? | Weight |
|---|---|---|---|---|
| 1 | **`/detach`**: give the terminal back, the turn, jobs and sub-agents keep running (contract, plan :21-26) | — | no (`rg '"/detach"' packages/tui/src` → none, plan :80) | **High if used.** Usage is unknown, which is the owner's doubt |
| 2 | **Crash / window-close isolation**: closing the window or an Ink crash no longer kills the turn | no | no: the worker is a thread in the TUI process (`local-runtime.ts:1354`), so it dies with it | Medium. Today the session is saved per round and `--resume` recovers it (the turn in flight is lost). Fable M5: after a crash the asks must *wait* (safe default), so the value is "the turn finishes", not "it keeps approving" |
| 3 | **Mobile reaching LOCAL sessions** | no | no: the mobile link exists only on `serve` (`serve.ts:224-280`); the worker has no device route (`mobile-relay.md:375` F20) | **Zero in v1.** Plan D13 (:420-429) is "a seam, nothing binds to it": it needs a further bridge task |
| 4 | **Multiple TUIs on one local session** | no | only via `serve`+`connect` | Low (niche) |
| 5 | **One session model** (local = detached run) | no | — | Negative in practice: it adds a 2-writer persistence regime (D4) and a 2-broker policy (D3). It does **not** remove `--in-process`, the real second session path (plan :342-343). The real "one path" win is `remove-in-process`, which does not need the relay |

**Without `/detach`:** only #2 matters (medium); #3 needs more work after the relay, #4 is niche, #5 is not a win. **The relay is justified only by `/detach` usage.**

## 2 · COST

**Size.** 13 slices: LR0, LR1, LR2, LR3, LR4, LR5a, LR5b, LR6–LR11 (plan :433-447). Fable adds a passive-attachment daemon option (H1), a separate `local-policy.ts` (H3), a per-uid claim plus a sessions list (H5), and a launcher dial-retry (M3). That makes about 15–16 slices, **8 marked `load-bearing`** after the fixes. New files: `local-daemon.ts`, `session-listen.ts`, `local-runs.ts`, `local-relay.ts`, `local-relay-state.ts`, `local-policy.ts`, `tui/commands/detach.ts`. Modified: `worker.ts`, `pod-resident.ts`, `relay.ts`, `main.ts`, `local-runtime.ts`, `session-host.ts`, `connection.ts` (H1), `kept-cmd.ts`, `hop-runtime.ts`, `run-state.ts`, `process-group.ts`, `config`, `flags.ts`, `explain.ts`, `tui-sessions.ts`. Size estimate: about 2–3k lines including tests (not measured). The base it reuses is 6.5k lines (`relay.ts` 877, `local-runtime.ts` 1411, `pod-resident.ts` 826, `attach-run.ts` 744, `run-state.ts` 594, …). The closest precedent class (detach-live hand-over) took about 2,400 lines of fixes (plan :252-253).

**Risk on the most-used path.** After LR9 every plain `tentacle` TUI changes in five ways:

- startup: a second process;
- permissions: freeze/thaw across 2 brokers;
- persistence: 2 writers;
- quit semantics: `ifLast` (H1);
- signals: LR1.

Today that path is `main.ts:2069-2157` with no process, file or socket. Every bug lands on 100% of sessions, not on the opt-in `run --detach` users.

**Fable findings: is each one cheap to fix?**

| ID | Issue | Fix | Cheap? |
|---|---|---|---|
| H1 | The relay's permanent attachment turns every `ifLast` into "detach only" (`local-runtime.ts:899-903`, `connection.ts:796-803`). `/clear` stops closing, so sessions and jobs pile up; a lone `/quit` does not close | A passive `Connection` option excluded from `attachedCount` | **Medium**: daemon change in a load-bearing seam, S plus a mutation test |
| H2 | The follow client saves a foreign turn only at its end (`local-runtime.ts:693-698`), so an hour-long detached turn is unsaved until `turn_end` | Per-round flush option on foreign turns | **Cheap** (S). Must also enter LR0(b) |
| H3 | "Two writers already normal" / "freeze as is": no precedent (`relay.ts:540-545` stops saving at hand-over; `relay-policy.ts:26-33`, `:91-93`) | Own pure `local-policy.ts`; reword the plan | **Cheap–medium** (S–M) |
| H4 | The flip (LR9) is gated on a live row that needs `/detach` (LR10) | Reorder | **Free** |
| H5 | `<id>` from the first uid plus a single `sessionId` leads to a wrong join or split brain after `/clear` | Random id, `sessions[]`, per-uid claim lock | **Medium**: one more lock file type (cleanliness cost) |
| M1 | The socket exposes the permission decision to same-uid tools/MCP (`hosted-session.ts:22-31`, no auth, `connection.ts:185`). The ptrace argument is false on macOS | Secret file plus env strip plus attach log | **Mitigable, not removable.** Same uid can read the secret file. A security regression vs today: needs an owner decision |
| M2 | Fallback to the worker can seed a second host of a live uid (`relay.ts:857-876`, 60 s timeout) | Fall back only if no record claims the uid and the own child is confirmed dead | Cheap, but turns fallbacks into refusals (less fluid) |
| M3 | The reused 100 ms `owner.json` poll (`relay.ts:873`) eats the latency budget | Dial with 5–10 ms retry | Cheap |
| M4 | After the 60 s idle exit, the printed `local-<id>` no longer resolves; exit/attach race | Keep an `ended` record plus exit under lock | Cheap, but **one more lingering file** |
| M5 | Window close equals detach (auto-accept keeps approving with no terminal); hooks-trust asker lost at `/detach`; `/dev/tty` prompts (ssh/sudo/git creds) fail in a tty-less relay | Owner question plus probe | Decisions are cheap. The tty point is **unverified** (today a `/dev/tty` prompt would fight Ink anyway): one LR0 probe |
| M6 | Restart only on `PROTOCOL_VERSION`, so an old relay keeps running after `update` / a code edit | Restart on `appVersion`/build id plus log `schemaVersion` | Cheap; **essential for the owner's dev loop** |

## 3 · CLEANLINESS (inventory)

| Artifact | Where | Created | Removed | Orphan path |
|---|---|---|---|---|
| Relay process (`tentacle __local-relay`) | own session (setsid), `ps`-visible | each new local session chain (D2) | `/quit` right away; idle 60 s after the last TUI leaves (D7); `rm local-…` | SIGKILL / crash: record stays `lost` |
| Run dir `<configDir>/local/<id>/` | configDir | relay start | clean exit (D6 :289) — **but M4 asks to keep an `ended` record** | `lost` dirs pruned at the *next relay start* if >24 h (D9 :367); never if no relay starts again |
| `owner.json` | run dir | relay start, rewritten on state change | with the dir | as above |
| `relay.log` (capped, `run-state.ts:550-594`) | run dir | relay start | with the dir: **a clean exit deletes the log** | kept in `lost` dirs |
| `session.sock` | run dir, **or** `$TMPDIR/tentacle-<uid>/<id>.sock` if the path is too long (`control-socket.ts:132-170`) | listen | dir removal; the `$TMPDIR` fallback is **not in the dir and the plan names no unlink**: gap | stale socket unlinked only when the *same path* is bound again (`pod-resident.ts:300`) |
| Lock file | run dir | relay start | with the dir | dead-holder takeover (`acquireResidentLock`) |
| `attach/<pid>` presence files | run dir | each TUI attach | TUI `/detach`/`/quit` | TUI crash: stale until read as a dead pid |
| `auto-accept/<sessionId>` | run dir | TUI toggles | with the dir | — |
| `claims/<uid>` lock (Fable H5) | `local/claims/` | launch race | after listing | **new, not designed yet** |
| Run secret (Fable M1) | run dir, 0600 | relay start | with the dir | — |
| `caffeinate -i -w <pid>` | process | while busy (`relay.ts:186-192`) | dies with the pid | none |
| MCP servers | children of the relay | relay start | relay exit | SIGKILL of the relay: same as a SIGKILLed TUI today |
| Background job groups | own process groups | jobs | exit net `killAll` (P5) | SIGKILL: orphaned (debt, plan :572) |

**Stale builds.** A relay keeps its old image across `tentacle update` (D9 :363) and across `git pull`/edits when run from source. As planned it restarts only on a `PROTOCOL_VERSION` mismatch (M6). Without the build-id fix, the owner's daily "edit, run `tentacle`" can silently join old code.

**Today.** The worker is a thread: nothing on disk, nothing in `ps`, nothing in `$TMPDIR`. `/quit`, the window close and a crash all clean up by construction. The only leftover is SIGKILL-orphaned job groups, which the relay does not change. **The relay cannot match "no leftovers"; it can only bound them** (24 h prune, `rm`).

## 4 · FLUIDITY — measurement recipe (the orchestrator RUNS this)

Everything lives in `.tentacle/tmp/local-relay/lat/` (no product code, no tracked file). Use a temp `HOME`/config with one provider entry (never called), `mcpServers: {}`, and a scratch cwd. Build first: `bun scripts/build.ts` → `dist/tentacle`.

1. **TTFF today, end to end** (`ttff.ts`).
   - `Bun.spawn(["script","-q","/dev/null", BIN])`, with `BIN` = `dist/tentacle`, then `bun packages/cli/src/main.ts`.
   - Take t0 before the spawn. Read stdout until the first frame contains a fixed marker (the configured model name shown by the StatusBar); that is t1. Then send `\x03\x03` and kill.
   - 5 discarded runs, then 30 warm runs per binary.
   - Cold runs: 5, each after `sudo purge`.
   - Report the median and p90 of `t1 - t0`.
2. **The part the relay replaces: the worker handshake** (`worker-cost.ts`).
   - Load a config, `new PermissionBroker(undefined,{holdUntilSet:true})`, a no-op saver, then time `await startWorkerRuntime(config, …)` (`local-runtime.ts:1334-1411`) and dispose it.
   - Run 30 times, each in a fresh `bun` process.
   - Result: `T_worker`.
3. **What replaces it: spawn + listen + dial + initialize** (`relay-proto.ts` + `relay-child.ts`).
   - The child reads the config as JSON on stdin, then `import { workerSessionHost } from ".../packages/cli/src/worker.ts"`. That is the same module graph as the worker; its top-level side effects are inert outside a Worker, which the probe asserts.
   - It builds the host and listens on a unix socket under the lat dir.
   - Each accept gets `new Connection(streamChannel(sock), host, …, {exposeInternalErrors:true})`.
   - The parent takes t0, then `spawn(execPath, [child], {detached:true, stdio:["pipe",log,log]})`. It writes the JSON, closes stdin, and dials with a 5 ms retry. Then it runs `createLocalRuntime({channel: streamChannel(sock), …})` with the same options as the worker path; `initialize` resolves at t1.
   - Variants:
     - **(a)** dial-retry (the M3 fix);
     - **(b)** the planned 100 ms `owner.json` poll, to show its cost;
     - **(c)** the child compiled with `bun build --compile relay-child.ts`, as a proxy for the compiled-binary path.
   - 30 runs each. Result: `T_relay`.
4. **Projected relay TTFF** = TTFF_today − T_worker + T_relay, per percentile. Also report **re-attach** (step 3 with the child already running, i.e. dial + initialize only), which should beat today.
5. Optional sanity: time to first token unchanged (1 run, fake provider).

**Pass threshold (recommended, stricter than plan D12's +100/+200 ms, because the owner asked for maximum fluidity and this is every launch):**

- compiled binary, warm: **Δmedian ≤ 50 ms and Δp90 ≤ 100 ms**;
- cold: Δmedian ≤ 150 ms;
- re-attach < today.

| Δmedian | Verdict |
|---|---|
| ≤ 50 ms | pass |
| 50–150 ms | acceptable only with "mount Ink first, hold the send until linked" (D12 option 1), which must be designed before LR6 (Fable M3) |
| > 150 ms | NO-GO as default; opt-in only |

## 5 · ALTERNATIVES

| Option | Value | Cost | Leftovers | Verdict |
|---|---|---|---|---|
| **(a) Do nothing now** | none new | 0 | 0 | **Recommended for the relay.** Pair it with `remove-in-process` (§6) |
| **(b) Mobile ↔ local sessions only** (the prompt's text was cut after "via"; read as **via a local `serve`**, the only daemon with a mobile link, `serve.ts:224-280`) | Already works opt-in today: `tentacle serve` on the laptop plus `tentacle connect`. Quit only detaches (AGENTS §7 "quitting only detaches"; `connect-sessions.md:16`), multi-TUI, mobile, job-exit wake (`serve-autowake`), survives a TUI crash. Gaps (plan :577-581): history in `<configDir>/daemon/…` not in laptop `--resume`/`/sessions`, no `/move`, laptop hooks-trust | An `eval` to close the gaps, likely M. **Unverified:** a single-laptop `serve`+`connect` live check end to end (1 run) | One process **the user started on purpose** (lock, record, logs in the daemon store) | **Recommended next step** if mobile or detach matters: it reuses a path that is already persistent, trusted and mobile-linked |
| **(c) Full relay** | `/detach` + #2 for every session by default | ~15–16 slices, 8 load-bearing, 5 HIGH to fix first | §3 table | **NO-GO now.** Revisit with usage data (e.g. how often the owner uses `serve`+`connect` or `run --detach`) and a passing §4 |
| **(d) "Suspend trick" for `/detach`** (tui-detach's rejected (b): SIGSTOP + external SIGCONT, `feat/tui-detach:docs/feat/tui-detach.md:660`; or the headless-in-place life of revs 4–5) | `/detach` only, no new architecture, no files when unused | S–M | A helper process for SIGCONT; the job stays in the shell's job table. **Breaks contract line 1** ("no job left in the shell's table", plan :23); zsh warns or HUPs at exit, and piped MCP children die at hangup (H0, plan :35-38) | **No**: rejected by the owner before, and it violates the binding contract |

**Recommendation:**

1. (a) now.
2. Do `remove-in-process` as an S fix.
3. If the owner wants `/detach` or the phone on local work, open (b) as an `eval`: "local `serve` as the detachable session", closing the store, `/move` and hooks-trust gaps.
4. Re-open (c) only if (b) proves the demand and §4 passes.

## 6 · `--in-process`

- **Fact.** It is not deprecated.
  - Opt-out flags: `main.ts:2065-2069`; help: `main.ts:267`.
  - Silent fallback: `main.ts:2159`, fed by `startWorkerRuntime` returning `null` on a spawn or handshake failure (`local-runtime.ts:1360-1363`, `:1406-1409`). Its only notice is one `err` line before Ink mounts.
  - The fallback path is a second session path: `main.ts:2162-2208`, `inProcessSessions`. It has no `/move` hop (the facade exists only on the worker path, `:2079-2110`) and no sub-agent writes (`useDock.ts:407-413`), and `/clear` takes a separate branch (`tui/src/clear-command.ts:8`).
- **Owner already decided removal** on 2026-11-07 (`TODO.md:458`, `remove-in-process`: "the only second session path … every persistence/steering/hooks change has to be handled twice. A worker that fails to start → a clear error"). It is still open, so the owner's belief was a decision, not code.
- **Recommendation: remove** the flags, the `:2162-2208` path and the fallback. A worker failure becomes a clear pre-mount error naming the log, never a silent downgrade to a less capable session.
  - Independent of the relay. Size S–M, blast cross-module. It touches `main.ts`, `session-jobs.ts`, the in-process clear branch and the tests that pin `inProcessSessions`.
  - Check first that nothing else needs the in-process path, e.g. a test harness: `rg inProcessSessions`.
  - If the relay is ever built, its "fallback to the worker" (D8.6) should get the same treatment (Fable M2).


## Appendix — Fable design review of the plan

Verdict: REVISE

Design review of `docs/feat/local-relay.md` (plan at `a369cb6b`, code at base `fcd9138f`).
Fresh context, adversarial. Only HIGH / MEDIUM. Paths are under `packages/`.

What holds (checked against the code): detach never cancels with `servesModel: false`
(`daemon/src/connection.ts:184`, `:221-227`); the worker binds one trusted `Connection`;
`spawnRelayProcess` is `detached: true`, stdio on the log, env-only spec
(`cli/src/relay.ts:785-809`); the exit net exits 143 on SIGTERM with no save
(`exec/src/process-group.ts:121-128`), so LR1 is needed; the "new entry, not a mode flag
through `runRelay`" decision is right. The direction (option D) is sound. The plan is not
approvable because several "As is" reuse rows are wrong in ways that break the contract.

---

## HIGH

### H1 · The relay's permanent attachment breaks every `ifLast` close: `/clear` and a lone `/quit` never close the session
- **Evidence.** `shared: true` makes EVERY close of the runtime `session/close{ifLast}`,
  `/clear` included (`cli/src/local-runtime.ts:899-903`, `:988`, `:1006-1011`). `ifLast`
  is decided daemon-side from the attachment count: `live.attachedCount > own` → only
  detach (`daemon/src/connection.ts:796-803`). The plan gives the relay a follow client
  that is attached to every session for its whole life (D2.4) and passes `shared: true`
  to the TUI (D8.3).
- **Consequence.** With the relay attached, a TUI's `/clear` never closes the old session:
  it stays live in the host with its background jobs (today `/clear` ends them,
  `cli/src/main.ts:2162-2163`), the relay never "sees it closed", and live sessions pile
  up per `/clear`. `quit` without `closeForAll` is `ifLast` too (`local-runtime.ts:1210-1212`),
  so "alone → close → the relay exits" (D7 row 3, D8.5) only works if the lone quit is
  forced to `closeForAll`; the plan does not say so. D2.4's sentence "TUIs decide from the
  presence files, never from the attachment count" is not what the code does: the daemon
  counts attachments.
- **Fix.** Make "passive" a real daemon concept, not prose: an in-process `Connection`
  option (e.g. `passive: true`) whose attachments are excluded from `attachedCount` for
  `ifLast`, `session/list.attached` and the detached cap, but still receive asks and
  `session/log` (the split `daemon/src/watchers.ts:6-11` already documents for watchers,
  which cannot be used here because a watcher never answers an ask). Add it to LR5b's
  files with a red test: TUI + passive relay, `/clear` → old session CLOSED and its job
  group killed; lone `/quit` → `closed: true`. Mutation: drop the exclusion → the test fails.

### H2 · The follow client does NOT save "every committed round": a turn the TUI started is saved by the relay only at its end
- **Evidence.** Per-round saving is tied to the turn's own event stream
  (`local-runtime.ts:536-559`, `tool_result` → `flush`). For a turn another client started,
  the controller saves at the turn's end only (`local-runtime.ts:693-698`, `:134`, `:159`,
  `:1190`: "a foreign turn is saved only at its end"). Every turn typed in a TUI is
  foreign to the relay.
- **Consequence.** The contract's main case: `/detach` mid-turn with auto-accept on, the
  turn runs for an hour. After the TUI's last read-back nothing reaches disk until
  `turn_end`. A relay crash / SIGKILL / power loss / forced logout loses every round since
  the detach. Today's worker TUI saves each round. D2.4 ("saves every committed round, as
  a TUI does") and the load-bearing assumption ("holds every committed round") are false
  as written, and LR5b's convergence test (TUI saves 1–2, relay saves 3) passes without
  noticing because round 3 ends the turn.
- **Fix.** In LR5b the relay's controller must flush on a foreign turn's committed round
  (the watch activity's commit / `tool_result`, same coalesced `flush`), behind an option
  only the relay sets. Red test: TUI starts a 4-round turn, disconnects after round 1,
  the relay is killed after round 3 with no `turn_end` → the log holds rounds 1–3.
  Add the same case to LR0(b), otherwise the probe proves a weaker property (AGENTS §2).

### H3 · "Two laptop writers are already normal" and "freeze/thaw as is" cite a precedent that does not exist for relay + TUI
- **Evidence.** The detached-run relay never saves or decides beside a TUI: at hand-over it
  calls `runtime.stopSaving()` and logs `handed over` (`cli/src/relay.ts:540-545`;
  `local-runtime.ts:1016-1018`, `:1222-1224`). The only concurrent-writer precedent is two
  TUIs, both mid-session joiners. `freeze` is documented and built for the short prepare
  window of a hand-over (`cli/src/relay-policy.ts:26-33`), and an ask enters `held` only if
  it was raised while frozen (`:91-93`).
- **Consequence.** (a) seeder + joiner saving for hours is new behaviour, yet D1 lists the
  saver "As is" and Context says "already normal"; (b) the policy "polled after" claim
  (D3) is not implementable as is: an ask raised while THAWED with auto-accept off is not
  in `held`, so a later flip of the shared file to ON never re-decides it; (c) `autoAccept`
  is a static option (`relay-policy.ts:37`, `:64-65`) and `owns` defaults to "nothing"
  (`:41`), so the "all turns" scope needs an explicit test that `hooks_trust` /
  `session_hop` stay excluded (`tui/src/permission-ui.ts:59-61`).
- **Fix.** Reword Context/D1 honestly (two rows become **Seam**, not "As is"). Write a
  separate `local-policy.ts` (pure) instead of threading options through the pod policy
  whose header forbids the wider test (`relay-policy.ts:14-15`): every undecided ask is
  kept in one set and re-decided on thaw AND on a file flip. Tests: flip ON while an ask
  waits thawed → allowed once; TUI answers a frozen ask → the held entry is gone (no
  second decision at thaw); `hooks_trust` never auto. Keep LR0(b) as the gate, extended
  per H2.

### H4 · Slice order: the live check that gates the default flip needs `/detach`, which lands after the flip
- **Evidence.** LR9 flips `localRelay: true` "after the owner's live row". Steps 1 and 4 of
  that row are `/detach`. `/detach` is LR10, "After: LR9".
- **Consequence.** The gate cannot be run as written; the default would flip on an
  unmeasured path, which is exactly what the brief forbids.
- **Fix.** Reorder: LR10 (`/detach`, behind the flag) before the flip; the flip becomes the
  last local slice (LR7, LR8, LR10 → live row + latency → flip → LR11). Mandatory
  fresh-context Review before the flip.

### H5 · Run identity: `<id>` from the first uid + one `owner.json.sessionId` gives a wrong join and a split brain
- **Evidence (plan only).** D6: `<id>` = first 8 hex of the relay's FIRST session uid, kept
  across `/clear`; `owner.json.sessionId` names "the session the TUIs are on" (D2.5); the
  race rule is "the loser of the lock of `local/<id(X)>` waits and joins" (Failure modes).
- **Consequence.** (a) Relay started on X, `/clear` → now on Y, dir is still `local/<id(X)>`.
  `tentacle --resume X` in another terminal: no record says X is live, it tries to launch
  on `local/<id(X)>`, loses the lock and "joins" a relay that hosts Y, not X (or seeds X
  into it by accident). (b) Two TUIs on one relay on different sessions (one did `/clear`,
  the other stayed; or `/sessions` seeded a second uid): one `sessionId` field cannot name
  both, so `--resume` of the unnamed one starts a second host of a live uid — the split
  brain D6 promises to prevent.
- **Fix.** `<id>` is random (minted by the launcher), never derived from a uid. The owner
  record carries `sessions: string[]` (every live uid in the host, rewritten on
  open/close by the relay only). `findLocalRun(uid)` matches on that list. The launch
  race is serialised on a per-UID claim (`local/claims/<uid>` lock held from find to
  "listed in a record"), not on the run dir. Tests in LR4/LR7: the two cases above.

---

## MEDIUM

### M1 · The socket puts the permission decision within reach of the agent's own tools
- **Evidence.** Each socket is a full trusted `Connection` (`exposeInternalErrors: true`),
  first answer wins (`daemon/src/hosted-session.ts:22-31`), no authentication
  (`principal` defaults to `{kind:"token"}`, `connection.ts:185`). Shell tools and MCP
  servers run as the same uid as children of the relay. Today the local broker lives in
  the TUI process and is not reachable over any socket. The plan's argument "any same-uid
  process can already ptrace the TUI" is not true on macOS (task-port access needs root or
  an entitlement). AGENTS §7 accepts this takeover only for the POD session, because the
  laptop gates; here the laptop gate itself is exposed.
- **Fix.** State it as an owner question with the trade-off, and at least: (1) strip the
  socket path from the env given to tools/MCP and never print it; (2) a per-run secret
  from the bootstrap (stdin), stored 0600 beside the record, required at `initialize`, so
  a client must read a tentacle file on purpose; (3) log every attach (pid, proc) in
  `relay.log` and show a notice in attached TUIs when another client joins. Add a row to
  Failure modes; the Review after LR6 red-teams it.

### M2 · Fallback to the worker can create a second host of a live uid
- **Evidence.** D8.6 falls back to the worker on "spawn failure, timeout, version refusal
  it cannot resolve". `launchRelay` returns 0 on timeout with the child still starting
  (`cli/src/relay.ts:857-876`, `LAUNCH_TIMEOUT_MS = 60_000`, `:91`). The Failure-modes
  table says the opposite for the older-TUI case ("no fallback"), so the plan contradicts
  itself.
- **Consequence.** `--resume X`: the relay is slow or its socket is unreachable, the TUI
  falls back and seeds X in a worker while a relay holds or is about to hold X: two hosts,
  two savers, diverging logs set aside.
- **Fix.** Fallback only when (a) no live record claims the uid AND (b) the launcher
  confirmed its own child is dead (it kills the child it spawned on timeout, by pid +
  start time, and waits). Otherwise refuse before Ink with the `attach` / `rm` hint. The
  relay also exits if no client attached within a short bound after start. Use a local
  launch timeout (a few seconds), not the pod one. Tests in LR6 for both branches.

### M3 · Startup latency: the reused launch loop cannot meet the stated target
- **Evidence.** The wait is a poll of `owner.json` every 100 ms (`relay.ts:873`), so it adds
  about 50 ms on average and up to 100 ms before the dial even starts, on top of a second
  Bun process loading the whole CLI bundle. Target is median ≤ +100 ms (D12).
- **Fix.** Do not reuse the poll for the local path: the launcher dials the socket with a
  short retry (5–10 ms backoff) or the relay signals readiness on an inherited pipe/fd.
  Keep `owner.json` for `ps` only. LR0(a) must prototype THIS path (real `selfCommand()`
  binary, compiled build too, since the worker path differs there) or the measurement
  does not cover what ships. Decide D12's option 1 (mount Ink first) before LR6, since it
  changes `startRelayRuntime`'s shape.

### M4 · Idle exit vs the contract's `attach local-<id>`, and the exit/attach race
- **Evidence.** D6/D7: at a clean idle exit the run dir is removed, and an unknown id is an
  error. The contract says a detached session "ends by itself after the idle grace" and
  that `tentacle attach local-<id>` re-enters. After 60 s of idle the name printed by
  `/detach` no longer resolves. Also nothing orders "idle exit decided" against "a TUI
  wrote its presence and is dialing".
- **Fix.** Keep a small final record (`state: ended`, `sessions`) so `attach local-<id>`
  resumes the uid from disk; hide ended rows from `ps`, prune them with the 24 h rule.
  Take the exit decision under the run lock with one fresh read of presences
  (the `exitPlan` pattern), and let a dial that hits a closing socket retry as
  "relay gone → seeded resume". Tests in LR5a (pure) and LR7.

### M5 · Behaviour changes that nobody was asked about
- Closing the window or a TUI crash now means "detach": with shared auto-accept on, the
  agent keeps running and approving with no terminal anywhere (D3 thaw on crash). The
  contract covers `/detach` only. **Fix:** owner question 7; the safe default is: thaw
  with auto-accept only after an explicit `/detach`; after a crash/hangup asks wait.
- A turn in flight at `/detach` loses its hooks-trust asker: `hooks/trust` goes to the
  prompting connection (`connection.ts:835-853`) and a drop is "declined". **Fix:** say it
  in Failure modes and in the `/detach` line, or re-route to an attached TUI.
- The relay has no controlling terminal, so a tool that prompts on `/dev/tty` (ssh, sudo,
  git credentials) fails where today it reaches the terminal. **Fix:** a row in Failure
  modes plus one LR0 probe.

### M6 · Upgrade: "same protocol, different `appVersion` → attach" keeps an old agent loop alive silently
- **Evidence (plan).** D9 restarts only on a `PROTOCOL_VERSION` mismatch. Most releases do
  not bump it, and on-disk formats are versioned separately (AGENTS §7): an old relay can
  keep writing the laptop log while a newer build has moved the log header forward (it
  would then refuse the file).
- **Fix.** Apply the idle → restart / busy → dim note rule on `appVersion` inequality too,
  and compare the log `schemaVersion` at attach: a relay with an older one is restarted
  when idle and refused when busy. Dev builds: include a build id in `appVersion`
  comparison or document `--no-relay` for work on tentacle itself. Test in LR7.
