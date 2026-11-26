# feat/mobile-workflows-landing — the hub lands on the workflow list, with Start · Approve · Delete per workflow

> **Status:** implementation (APPROVED — orchestrator, delegated by the owner; no owner question open)
> **Branch:** `feat/mobile-workflows-landing`
> **Size:** L (three slices S1–S3, each M) · **Blast:** load-bearing (a second way to RAISE a workflow hash approval, and a file delete on the host) · **Suited:** Opus plan → Sonnet exec per slice → mandatory fresh-context Opus review red-teaming §7 "single broker" + "a pod is not trusted"
> **Changelog:** `changelog.d/mobile-workflows-landing.changed.md` (the hub lands on the list) + `changelog.d/mobile-workflows-landing.added.md` (Approve / Delete on the phone and `/workflow approve|delete` in the TUI)

Type: feat · Size: L · Blast: load-bearing · Suited: Opus plan → Sonnet exec → Opus fresh review

## Context

*— claude-opus-5-5, 2026-11-26*

**Owner request (2026-11-26 ~00:30, with two phone screenshots: «Workflows» = an empty run list + «Start a workflow», and «Start a workflow» = cards each with an Edit pill):**
«cliccando sul bottone workflow devo atterrare subito nella schermata workflows, con i bottoni delete, start e approve presenti dove oggi sta edit, per ogni workflow».

**What happens today (verified):**

- The session hub's Workflows entry navigates to the RUN list: `App.tsx:3588-3594` (`navigation.navigate("WorkflowRuns", {computerId, name, sessionId})`).
- `WorkflowRuns.tsx` shows runs (Needs you / In progress / Finished, `WorkflowRuns.tsx:182-184`) and a «Start a workflow» pill (`:125-139`); with no runs it is an empty state with «New workflow» (`:162-181`). That is the first screenshot.
- «Start a workflow» pushes `WorkflowStart` (`App.tsx:3649-3654`), the workflow FILE list: each valid row is a rounded card (`WorkflowStart.tsx:423`, `borderRadius: 12`) with name, «✓ Approved» / «? Needs approval» (`workflow-start.ts:106-107`), description, and an **Edit** pill (`WorkflowStart.tsx:119-128`); a broken row shows its errors and Edit (`:133-174`). Tapping a row opens its detail + inputs form + Start (`:176-291`). That is the second screenshot.
- The only way to APPROVE a workflow from anywhere is to START it (the run's first wait is the hash approval, `workflow-driver.ts:1462-1488`) or to create a schedule for it (`hosted-session.ts:4449-4451`). There is no way to delete a workflow file except by hand.

**Correction to the TODO item:** `workflow/list` is not the only workflow RPC. Today there are six (`packages/protocol/src/methods.ts:184-212`): `session/workflow` (start/stop/resume/rerun_step), `session/workflow_step`, `session/workflow_catalogue`, `workflow/list`, `session/workflow_source`, `session/workflow_save`. None approves or deletes.

**Constraints:** owner taste (minimal, E2 square bands — no rounded inset cards, thin icons, never meaning by hue alone, an unusable action is dimmed with an inline label, never an empty modal); AGENTS §7 (single broker; a workflow approval is a human answer to a `workflow_approve` ask; pod sessions get no workflow driver; logic in pure modules); phone/Mac parity (the TUI gets the same two actions).

**Repro (capability missing), 2026-11-26, worktree `feat/mobile-workflows-landing` = `main` @ 0ebc3b70:**

```
$ grep -n -E '"session/workflow[a-z_]*"|"workflow/[a-z_]+"' packages/protocol/src/methods.ts
184:  Workflow: "session/workflow",
190:  WorkflowStep: "session/workflow_step",
196:  WorkflowCatalogue: "session/workflow_catalogue",
198:  WorkflowList: "workflow/list",
206:  WorkflowSource: "session/workflow_source",
212:  WorkflowSave: "session/workflow_save",
--- hub entry:
3589:                      navigation.navigate("WorkflowRuns", {
--- approve/delete methods:
0
```

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, under the owner's delegation of layout and open questions; nothing below weakens an AGENTS §7 trust rule — see *Owner questions*).

### Load-bearing assumption

**Approval today is ONE thing: a human's allow on a `workflow_approve` ask, raised by the trusted daemon through the session's ONE broker, about the CURRENT file's content hash, then stored in the host's approval store. The phone already grants it. So a phone «Approve» that RAISES that same ask (and lets the person answer it on the standard sheet) is the same trust decision, not a new one.** Proved:

1. **The store** is `<configDir>/workflow-approvals.json`, one record per project + path + hash, on the laptop / `serve` host only, never in a pod (`packages/cli/src/workflow-approvals.ts:1-10`, `:69-90`). An edited byte is a new hash, so it is simply not in it.
2. **Only an allowed ask writes it.** Every `approvals.add` in the codebase follows `answer.allowed` of a `workflow_approve` ask through `deps.request` / the step requester: `workflow-driver.ts:1158-1161` (`requestApproval`, the schedule path) and `:1485-1486` (`approveHash`, a run's first wait). A save never adds (`:917-918`, `writeWorkflowFiles` "NEVER touches the approval store", `workflow-files.ts:422`).
3. **The asker is the session's ONE broker:** the driver is wired with `request: (req, opts) => permissions.request(req, opts)` (`packages/cli/src/wiring.ts:974`), inside the block that exists only when `options.workflows === true && !tunnelled` (`:958`) — so a pod session (`run`/`attach`) has no driver at all and every workflow method answers `unavailable` (`hosted-session.ts:2905-2908`, `:2953-2960`).
4. **It is never auto-answered and never answered by a stranger:** `autoApproves` excludes `workflow_approve` (`packages/core/src/permission.ts:358-370`, the exclusion at `:362-364`); `EXTERNAL_ANSWER.workflow_approve = "owner-only"` (`:101-109`), so an A2A/MCP caller can never answer it (`daemon/src/external/asks.ts:68-75`); it is once-only on every surface (`onceOnlyAsk`, `permission.ts:378-380`).
5. **The phone already answers it:** the phone's permission sheet knows the kind (`apps/mobile/src/permission-sheet.ts:252`, `onceOnlyAsk`), and since `fix/mobile-ask-surfaces` S8 a run's hash approval is answered on the standard sheet presented over the run (`docs/fix/mobile-ask-surfaces.md:857-861`, e2e `44` "the run's hash approval is now answered on `perm-sheet`"). The phone's ONE broker is `createLinkBroker()` (`apps/mobile/src/connection.ts:234-241`), passed to the Session screen (`App.tsx:1963`).
6. **Raising an approval WITHOUT a run already exists:** `WorkflowDriver.requestApproval(name, turnId)` asks the current file's approval through the ONE requester, with agent id `approval:<name>`, origin `workflow: {name}` (no run), withdrawn after `budget.wait`, and adds to the store only on allow (`workflow-driver.ts:1117-1167`). The daemon raises it never-awaited on a schedule create (`hosted-session.ts:4449-4451`; dispatch note `connection.ts:507-511`).

Conclusion: «Approve» = a new request that calls the driver's existing approval ask (pinned to the hash the person saw). No new grant path, no new answer path, no store write outside an allowed ask. The phone may do it under §7.

### Preconditions

- **Peer not serialized (§7):** inbound requests dispatch concurrently; the workflow methods take no lock (`daemon/src/connection.ts:452-487`). The new two follow the same shape; the approve request returns BEFORE the human answers (the `ScheduleCreate` precedent, `connection.ts:507-511`).
- **Additive methods need no version bump:** the editor's two methods were added the same way — "an older daemon answers `MethodNotFound` (the client maps it to `unsupported`…), so neither moves PROTOCOL_VERSION" (`packages/protocol/src/session.ts:1124-1127`); the client mapping pattern is `remote-client.ts:1750-1763`. No new `session/update` kind is needed (the catalogue is re-read, nothing is pushed), so `UPDATE_CLASS` is untouched.
- **Trusted-daemon gate on the client:** `RemoteSession.workflow` refuses and sends nothing when `!daemonWakes` (a pod's daemon), checked before any open (`packages/client/src/remote-session.ts:1321-1326`). The new wrappers reuse that gate (UX; the daemon decides anyway, point 3 above).
- **The hash pin:** a start pins the hash the person saw and the daemon refuses `changed` otherwise (`session.ts:947-956`, `hosted-session.ts:2924-2928`). Approve and Delete pin the same way.
- **The ONE writer** of workflow files is wired beside `load`/`list` in the non-tunnelled block and nowhere else (`wiring.ts:963-967`; `WorkflowDriverDeps.save`, `workflow-driver.ts:324-334`). It resolves every path with the no-links rule and does its base check and last rename in one synchronous block (`workflow-files.ts:402-423`, base check `:463-499`). The remover joins that block.
- **One run per session:** `current()` is the run in flight (`workflow-driver.ts:659-662`); a run waiting on its hash approval has state `needs-approval` (`:1196`, `:1681`).
- **Ask presentation on the phone (S8):** an ask is presented as a SHEET only on the screen in front; over a run only that run's own ask (`apps/mobile/src/sheet-plan.ts:770-822`, `ownRunTopId`/`askPresentable`); the Session screen reads the root routes fresh each render (`docs/fix/mobile-ask-surfaces.md:872-873`) and feeds `inFront` (`SessionScreen.tsx:478-482`).
- **Runs on the phone** come from `workflow/list` (daemon-wide, every session of the computer) through `useWorkflowRuns` (`App.tsx:432-444`), sectioned by the pure `elencoSections` (`workflow-list.ts`, used at `WorkflowRuns.tsx:82-84`).
- **TUI:** `/workflow` already re-reads the catalogue on every use (`packages/tui/src/commands/workflow.ts:79-82`) and on the falling edge of a `workflow_approve` ask (`packages/tui/src/useCatalogue.ts:38-42`); its panel's catalogue section has no cursor (`panels/workflow.ts:90-95`), so new actions are subcommands, like `run` (`workflow-view.ts:666-700`).

### Design

**D1 — Two additive methods (protocol).**

- `session/workflow_approve` — params `{sessionId, name, hash, turnId}` (hash = the catalogue row's, required; `turnId` minted like a start's). Result `{ok, approved?: boolean, asked?: true, refusal?, reason?, runId?}`:
  - file gone / does not validate → `ok:false, refusal:"invalid"` (or `"gone"`), reason;
  - current hash ≠ `hash` → `refusal:"changed"` (nothing asked);
  - a run of this workflow is `needs-approval` → `refusal:"running", runId` (its own ask is the one to answer — never two asks for one hash);
  - already approved → `ok:true, approved:true` (nothing asked);
  - an approval ask for this path+hash is already open → `ok:true, asked:true` (no second ask);
  - else the ask is RAISED (never awaited) → `ok:true, asked:true`.
  - A `wake-` turn id is refused, as on `session/workflow` (`hosted-session.ts:2909-2911`). No driver → `refusal:"unavailable"`.
- `session/workflow_delete` — params `{sessionId, name, hash?}`. `hash` present (a valid row) → the file must still validate to exactly it; absent (a broken row has none) → the file must still NOT validate. Otherwise `refusal:"changed"`. File absent → `refusal:"gone"`. A run of this workflow in flight → `refusal:"running", runId`. Success → `{ok:true, path, schedules?: string[]}` where `schedules` names the workflow schedules that still start it (they fire `invalid` from now on, `workflow-driver.ts:1078-1081`; the phone and the TUI say so). Removes ONLY `.tentacle/workflows/<name>.yaml`; prompt files stay (they can be shared — `save`'s `alsoChanges` exists for that, `workflow-driver.ts:1010-1021`). Never touches the approval store.
- Both: strip schemas (§7 forward-compat), refusal = `WorkflowRefusalSchema` free word (`session.ts:993-997`). `MethodNotFound` from an older daemon → client `{unsupported:true}`.

**D2 — Driver (agent).** `WorkflowDriver.approve(name, hash, turnId)`: `prepare(name)` (`workflow-driver.ts:1307`), compare, `approvals.has`, the run-waiting check, an in-flight guard (`Set` keyed `path\0hash`, cleared in `finally`), then launch the SAME ask `requestApproval` raises — factor its body (`:1133-1166`) into a private `askApproval(prepared, turnId)` used by both, so the title/detail/origin/withdraw/store-write are one code path. Title stays `Approve workflow <name> v<version> (hash <short>)` (drop the "for its schedule" suffix only on this path). `WorkflowDriver.remove(name, hash?)`: the running check, then `deps.remove(name, expect, currentHash)` — a new OPTIONAL dep, absent → `unavailable` like `save`.

**D3 — Remover (cli).** `removeWorkflowFile(cwd, name, expect, currentHash)` in `workflow-files.ts`, beside the writer: `insideWorkflows` no-links resolution, `lstat` = regular file, `loadWorkflowSource` + `currentHash` (throws ⇒ "broken"), compare with `expect` (`{hash}` | `{broken:true}`), then `unlinkSync` — one synchronous block, no await (two deletes / a delete and a save through one daemon cannot interleave). Wired at `wiring.ts:967` as `remove: (…) => removeWorkflowFile(config.cwd, …)` — inside the non-tunnelled block, never elsewhere.

**D4 — Daemon.** `HostedSession.workflowApprove` / `workflowDelete` (beside `workflowSave`, `hosted-session.ts:3028`), dispatched in `connection.ts` next to `Method.WorkflowSave` (`:484-487`) with no lock. Delete adds `schedules` from `this.scheduleTable` (jobs whose `workflow.name` is `name`) and audits `workflow: deleted <path> <sessionId>` like `scheduleAudit` (`:4448`).

**D5 — Client.** `RemoteClient.workflowApprove/workflowDelete` (`"once"`, MethodNotFound → `{unsupported:true}`, the `workflowSave` shape `remote-client.ts:1750-1763`); `RemoteSession.workflowApprove(name, hash)` / `workflowDelete(name, hash?)` with the `daemonWakes` gate and `turnId` minting of `workflow()` (`remote-session.ts:1321-1341`).

**D6 — TUI parity.** `parseWorkflowCommand` (`workflow-view.ts:672`) learns `approve <name>` and `delete <name> [confirm]`. `approve` pins the catalogue row's hash (`catalogueRowFor`, `:851`); no row → refused "not in this project's workflows — /workflow to re-read". The ask then appears in the TUI's own permission dialog (it already renders `workflow_approve` with its scrollable step list, `permission-ui.ts:209`), and the catalogue re-reads on its falling edge (`useCatalogue.ts:38-42`). `delete <name>` without `confirm` sends NOTHING: it pre-fills `/workflow delete <name> confirm` and says `Deletes .tentacle/workflows/<name>.yaml (prompt files stay) — press enter to confirm` (the `prefill` seam, `commands/workflow.ts:52-60`). Replies via `workflowReplyNotice`-style words; `WORKFLOW_USAGE` and the catalogue section's footer note (`workflow-view.ts:920`) name the two verbs.

**D7 — Phone landing (mockup A ★).** The hub's Workflows entry navigates to `WorkflowStart` (`App.tsx:3588-3594`), which becomes the landing titled «Workflows»:
1. **Live runs on top** — only `Needs you` and `In progress` (every session of the computer, `workflow/list` via `useWorkflowRuns`), rows = glyph + word; a tap opens `WorkflowRun` as today (`App.tsx:3661-3668`).
2. **`Recent runs ›`** — one row → the existing `WorkflowRuns` screen (finished + all), which LOSES its «Start a workflow» / «New workflow» entries (`WorkflowRuns.tsx:125-139`, `:167-179`): the landing owns them.
3. **`WORKFLOWS` band** — E2 square band (no rounded card: `WorkflowStart.tsx:423`'s `borderRadius: 12` goes). Each item: name · state (glyph + word) · `›`; description; action row where Edit was: **Start · Approve · Delete** — words with thin symbols (`play`, `checkmark`, `trash`), Delete in red reinforced by its word. Approve only when `approved === false`; a broken file shows its errors and Delete only. The item body / `›` opens the editor (`WorkflowEdit`, today's Edit target `App.tsx:3715-3721`). Header `+` = New workflow. The absolute folder at the bottom (`workflow-start.ts:66-67`).
4. **Start** on the item: no input that needs a value (every input optional or defaulted) → starts at once pinned to the hash (`startParams`, `workflow-start.ts:295-309`) and opens the run; otherwise opens today's form (`Detail`, `WorkflowStart.tsx:176-291`) with Start there.
5. **Approve** → `session.workflowApprove(name, hash)`; `asked` → the item shows «Asking…»; the ask arrives on the link broker and is presented as the standard permission sheet OVER the landing (D8); on its falling edge (answered, denied, withdrawn after `budget.wait`) the catalogue is re-read and the item says «✓ Approved» or stays «? Needs approval». `approved:true` → re-read at once. Refusals: `changed` → re-read + «This workflow changed — review it again» (`workflow-start.ts:96`); `running` → open that run (`afterRefusal`, `:325-344`); else the daemon's reason.
6. **Delete** → inline confirm replacing the action row: «Delete `.tentacle/workflows/<name>.yaml`? Its prompt files stay.» `Cancel` · `Delete` (testIDs, no `Alert`: RN's new architecture exposes no native alert text to XCUITest, `ComputersScreen.tsx:12-14`). Success → re-read; `schedules` non-empty → notice «N schedules still start <name> — they will be skipped». `changed`/`gone` → re-read with the reason.
7. **Unusable actions** stay in place, dimmed, with ONE inline line saying why (owner standard): offline («Offline — reconnecting…»), an older daemon (`unsupported` → «Update tentacle on this computer to approve or delete here»), a pod session (`unavailable`), no Session screen for this session (no sheet to answer on → «Open this session to approve»), an action in flight. A dimmed tap = light haptic, nothing sent.

All of 1–7 is decided in a NEW pure module `apps/mobile/src/workflow-landing.ts` (view-model: run sections, items, per-item actions with `enabled` + `why`, confirm state) driven by the extended `workflow-start-controller.ts`; `WorkflowStart.tsx` only renders it (§7 "logic in pure modules").

**D8 — The approval sheet over the landing.** Extend S8's rule in `sheet-plan.ts` (`:770-822`): `ownWorkflowsTop(routes, owner)` = the top non-`Sheet` route is `WorkflowStart` with this `computerId`/`sessionId`; `sessionInFront(focused, sheets, ownRun || ownWorkflows)`; `askPresentable(origin, topRunId, workflowsTop)`: over the landing ONLY an ask whose origin is `workflow` with `runId === null` (a file's approval — exactly what Approve raises; agent id `approval:<name>`). Every other ask keeps today's behaviour (slim row / park). The answer goes through the sheet's own path on the ONE broker — no second resolve path (the run screen's rule, `workflow-run-controller.ts:13-17`). The landing reads the sheet through `askSourceFromSheet` on `SESSION_SCREENS` (`App.tsx:2147-2169` pattern) only to watch the falling edge; it never answers.

*2026-11-26: replaced by `docs/fix/mobile-workflows-landing-v2.md` D1 (owner).*

#### Orchestrator decisions

1. **Variant A ★** (one list: live runs on top, `Recent runs ›`, workflows below). — A run that needs you is never hidden behind a tab (B puts it one extra tap away).
2. **Action row = words with thin symbols, not pills.** — Three pills per item × N items is heavy; words keep the band minimal and still carry meaning without hue.
3. **Approve raises the standard ask; no direct «grant» RPC.** — A direct store write would be a second grant path outside the broker; the ask keeps one trust decision (LBA above).
4. **The approve request returns before the human answers (raised, never awaited).** — The `ScheduleCreate` precedent (`connection.ts:507-511`); a reply cannot be lost mid-wait, and the catalogue re-read is the truth.
5. **The ask is presented as the standard SHEET over the landing (extend S8), not inline on the item.** — S8 removed inline answering on the run screen in favour of the one sheet; the same surface everywhere.
6. **Delete confirm inline on the item (testIDs), not `Alert`.** — XCUITest cannot read native alert text (`ComputersScreen.tsx:12-14`), and it is not a modal.
7. **Delete removes only the YAML; prompt files and approval records stay.** — Prompts may be shared by other workflows; a record only matches identical bytes at that path, so it grants nothing new.
8. **Delete of a broken file is pinned by "still broken".** — It has no hash; refusing if it became valid meanwhile keeps "never act on something the person did not see".
9. **Delete refuses while a run of that workflow is in flight; Approve refuses while a run of it is `needs-approval`.** — One ask per hash, and no file vanishes under a live run's resume/rerun.
10. **Start with no input needing a value starts at once.** — The owner asked for Start per workflow; the hash pin and the hash approval still protect it.
11. **Keep the route key `WorkflowStart`** (title «Workflows»). — The editor's `popTo("WorkflowStart")` (`App.tsx:3749`) and wiring tests keep working; a rename is churn with no behaviour.
12. **`WorkflowRuns` stays as «Recent runs», minus Start/New.** — Its sectioning and push-notification uses are unchanged.
13. **TUI: subcommands, not panel keys.** — The panel's catalogue section has no cursor by design (`panels/workflow.ts:90-95`); `delete` confirms by a pre-filled `confirm` line.
14. **Additive methods, no `protocol.d/` note.** — The editor precedent (`session.ts:1124-1127`).
15. **Size L, sliced:** S1 daemon side (protocol → agent → cli → daemon → client), S2 TUI, S3 phone (landing + sheet rule + e2e). — Each slice is M and green on its own; S2 and S3 depend only on S1.

### Owner questions

None. Checked against §7: Approve does not let anyone approve who could not before (the phone already answers `workflow_approve` asks; the ask stays owner-only, never auto-accepted, on the ONE broker, written only on allow); Delete is a write of the same trust level as `session/workflow_save`, which the phone already does with no ask (`hosted-session.ts:3018-3036`), confirmed in the UI; both are unavailable in pod sessions (no driver, `wiring.ts:958`).

### Files

Dependency order; S1 = 1–5, S2 = 6, S3 = 7.

1. `packages/protocol/src/session.ts` — `WorkflowApproveParams/ResultSchema`, `WorkflowDeleteParams/ResultSchema` (after `WorkflowSave…`, `:1212`). `packages/protocol/src/methods.ts` — `WorkflowApprove: "session/workflow_approve"`, `WorkflowDelete: "session/workflow_delete"` (after `:212`) + registry rows (after `:371`); export from the package index as the siblings are.
2. `packages/agent/src/workflow-driver.ts` — `approve()`, `remove()`, private `askApproval()` shared with `requestApproval` (`:1124-1167`), in-flight set, `WorkflowDriverDeps.remove?` (`:302-335`).
3. `packages/cli/src/workflow-files.ts` — `removeWorkflowFile` (beside `writeWorkflowFiles`, `:424`). `packages/cli/src/wiring.ts` — `remove:` beside `save:` (`:967`).
4. `packages/daemon/src/hosted-session.ts` — `workflowApprove`, `workflowDelete` (beside `:3028`). `packages/daemon/src/connection.ts` — two cases beside `:484-487`.
5. `packages/client/src/remote-client.ts` (beside `:1750`), `packages/client/src/remote-session.ts` (beside `:1446`).
6. `packages/tui/src/workflow-view.ts` (`parseWorkflowCommand`, usage, section note), `packages/tui/src/commands/workflow.ts` (two cases), `packages/tui/src/app-types.ts` (the two optional session methods) and `packages/cli/src/local-runtime.ts` (the controller forwards them — added during execution: without it the TUI's runtime has neither).
7. `apps/mobile/src/workflow-landing.ts` (NEW, pure), `apps/mobile/src/workflow-start-controller.ts` (approve / delete / startNow / runs / falling-edge re-read), `apps/mobile/src/workflow-start.ts` (`needsValues(entry)` for D7.4), `apps/mobile/src/sheet-plan.ts` (`ownWorkflowsTop`, `askPresentable`, `sessionInFront`), `apps/mobile/src/screens/SessionScreen.tsx` (feed them, `:478-482`), `apps/mobile/src/screens/WorkflowStart.tsx` (render the landing), `apps/mobile/src/screens/WorkflowRuns.tsx` (drop Start/New), `apps/mobile/App.tsx` (hub → `WorkflowStart` `:3588`; landing wiring: runs, asks source, Recent runs → `WorkflowRuns`), `apps/mobile/src/routes.ts` (doc comments `:114-148`), e2e `apps/mobile/e2e/flows/34-hub-workflows.yaml`, `44-workflow-editor.yaml`, `e2e/run.ts` (they tap `workflow-runs-start`), a new flow for Approve + Delete.
8. `changelog.d/mobile-workflows-landing.changed.md`, `changelog.d/mobile-workflows-landing.added.md`.

### Failure modes

| Case | How it converges |
|---|---|
| File edited between list and Approve/Delete | Daemon compares the pinned hash (Delete: "still broken") → `changed`; phone re-reads + banner; TUI notice. Nothing asked, nothing removed. |
| File edited WHILE the approval ask is open | The ask names the hash it was raised for and the store gets THAT hash; the edited file has a new hash → not approved → asked again at its next Approve/start. Never approves bytes nobody saw. |
| Approve tapped twice / on two devices | In-flight guard → second answer `asked:true`, no second ask. |
| A run of it is already waiting on its approval | `running` + `runId` → the phone opens that run (its ask is a sheet there, S8); TUI notice names the run. |
| Ask never answered | Withdrawn after `budget.wait` (`workflow-driver.ts:1134-1135`); falling edge → re-read → still «? Needs approval», «Asking…» cleared. |
| Link drops after Approve sent | `"once"`: not re-sent; the ask is re-offered on re-attach (held broker); the landing re-reads on reconnect. |
| Phone has no Session screen for this session | No sheet can answer → Approve dimmed «Open this session to approve» (no ask raised that nobody can see). |
| Another ask (main agent) is open while on the landing | Stays a slim row / parked as today (D8 presents only run-less workflow asks over the landing). |
| Delete while a run of it is in flight | `running` + `runId`, nothing removed. |
| Delete raced by a save through the same daemon | Both are one synchronous block each: the second sees the first's result (`changed`/`gone`). |
| File already gone | `gone` → re-read; the item disappears. |
| Schedules pinned to a deleted workflow | `schedules` in the result → notice; at fire time `startScheduled` records `invalid` (`workflow-driver.ts:1078-1081`) — visible, never silent. |
| Symlinked `.tentacle` / file | `insideWorkflows` / `resolveInside` refuse (no-links rule) → `invalid` with the path; nothing outside the folder is reachable. |
| Pod session (`run`/`attach`) | Client refuses before sending (`daemonWakes`); daemon has no driver → `unavailable`. |
| Older daemon | `MethodNotFound` → `{unsupported:true}` → Approve/Delete dimmed with «Update tentacle…»; Start unaffected. |
| Empty folder | Landing: run bands + `Recent runs ›` + «No workflows in <dir>» with New workflow (mockup A·empty). |
| `wake-` turn id on approve | Refused (`hosted-session.ts:2909-2911` precedent). |

### Tests

Red first on each (§9); mutation noted where the property is easy to fake.

- **protocol** — schemas parse/strip unknown fields; `json-schema.test.ts` stays green after regeneration at merge.
- **agent** `workflow-driver` (`packages/agent/test/workflow-driver.test.ts` fakes): `approve` raises exactly ONE `workflow_approve` ask through `deps.request` with origin `{name}` and no run; allow → `approvals.add(path, hash)` with the PINNED hash; deny → no add; `changed` asks nothing (spy count 0); already-approved asks nothing; second call while open → no second ask; `needs-approval` run → `running`. **Mutation:** make `approve` call `approvals.add` directly → the "deny → no add" test must fail. `remove`: running → refused, `deps.remove` never called.
- **cli** `removeWorkflowFile` (temp dirs, like `workflow-files-write.test.ts`): hash match removes only the YAML (prompt file still there); mismatch → `changed`, file intact; broken-still-broken removes; broken-now-valid → `changed`; symlinked folder/file → refused; absent → `gone`. `workflow-wiring.test.ts`: `remove` wired only when not tunnelled.
- **daemon** (`workflow-hosted.test.ts` pattern): approve returns before the ask is answered (the request settles while the ask is still pending — proves never-awaited); no driver → `unavailable`; delete reports pinned `schedules`; `wake-` refused.
- **client**: MethodNotFound → `{unsupported:true}`; untrusted daemon → refused, nothing sent (spy).
- **TUI** `workflow-view` / command tests: `approve x` sends `{name, hash}` from the catalogue row; `delete x` sends NOTHING and pre-fills `… confirm`; `delete x confirm` sends; usage text.
- **mobile** `workflow-landing.test.ts` (pure): sections (live only on top, Recent runs count), per-item actions (Approve only when `approved === false`; broken = Delete only), every dimmed action carries a `why`; `workflow-start-controller.test.ts`: Approve → «Asking…» → falling edge → one re-read; refusals branch on the word; delete confirm two-step, Cancel sends nothing; Start-now vs form. `sheet-plan.test.ts`: over this session's landing a run-less workflow ask is presentable and a main-agent ask is not; another session's landing → not in front. **Mutation:** `askPresentable` returns true for any origin over the landing → the main-agent case fails. Wiring tests: hub navigates to `WorkflowStart`; `WorkflowRuns` has no Start.
- **e2e** (simulator gate, owner's deterministic-gates rule): hub → landing → Approve → `perm-sheet` → Allow once → item reads «✓ Approved»; Delete → confirm → item gone; flows 34/44 updated to the new entry.

**Mockups:** `.tentacle/mockups/mobile-workflows-landing/index.inline.html` (self-contained, kit-stamped; source `index.src.html`). Variant **A ★ recommended** (landing, Approve sheet, Delete confirm, offline, older daemon, empty) and variant B (tabs + pills), each in light and dark; `?nuovo=1` outlines the new parts. Kit gaps reported on the page: no compact `ScreenHeader`, no `play`/`checkmark`/`trash`/`chevron.right` symbols in `K.icon`.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check, re-run on 0c1e079a: holds.** All six points re-read in the code: `approvals.add` occurs only at the two sites after `answer.allowed` of a `workflow_approve` ask (`workflow-driver.ts:1161`, `:1486` before this change); the requester is `permissions.request` inside `workflows === true && !tunnelled` (`wiring.ts:958`, `:974`); `autoApproves` excludes the kind and `EXTERNAL_ANSWER.workflow_approve = "owner-only"`; `onceOnlyAsk` is used by the phone sheet; `requestApproval` is raised never-awaited on a schedule create. **Repro:** the Context's grep still showed six workflow methods and no approve/delete.

**As built, in order.**

- **S1 protocol.** The four schemas and two methods; `protocol.json` regenerated (`bun run schema:export`); fixtures added to `json-schema.test.ts`.
- **S1 agent.** `approve`, `remove`, private `askApproval` shared with `requestApproval`, `WorkflowDriverDeps.remove?`.
- **S1 cli.** `removeWorkflowFile`, wired beside `save`.
- **S1 daemon, client.** `workflowApprove` / `workflowDelete` + two dispatch cases; the two `RemoteClient` and `RemoteSession` methods.
- **S2 TUI.** `approve <name>`, `delete <name> [confirm]`, usage, a second note line in the catalogue section; controller forwards.
- **S3 phone.** `workflow-landing.ts` (new, pure), controller actions, `needsValues`, `ownWorkflowsTop` / `askPresentable`, the landing screen, `WorkflowRuns` titled «Recent runs» without Start/New, `App.tsx` wiring, flows 34/44/45, new flow `46-workflow-landing` with its seeded file.

**Drift from the Implementation.**

- The open-approval guard is a **count** per `path\0hash`, not a `Set`: two schedule creates can hold two asks for one hash, and a `Set` would forget the second when the first closed (tested).
- `approve` of a missing file answers `invalid` (D1 allows `invalid` or `gone`).
- A file over the loader's byte cap counts as broken for a delete, as the listing shows it.
- `RemoteSession.workflowApprove` / `workflowDelete` open the session first when it has no id (as `start` does), so the TUI's two verbs work before the first message.
- `local-runtime.ts` and `app-types.ts` were missing from *Files* (added there): the existing controller GUARD test went red without the forwards.
- The TUI's catalogue section names the verbs on a **second** note line (the folder line would cut them).
- Phone: the controller also ends «Asking…» on an approved read, a pull-to-refresh and a reconnect (an answer given while our ask was never on this sheet has no edge). The route holds `onOpenRun` in a ref so pushing the approval sheet cannot rebuild the controller. A row whose name is not a workflow name has Delete dimmed with a reason (the wire refuses such a name).
- **One** changelog fragment (`added`), not two, per the orchestrator's instruction.

**Red before green.** Shown failing first: protocol (6/6), driver (13), remover (10/10, stub), wiring `remove` (1), daemon (7/7), TUI (10 of 11), local-runtime GUARD (1), phone controller (19/19). **Not shown red:** the client test and `workflow-landing.test.ts` / the `sheet-plan` D8 cases and new wiring cases were written with or after their code; covered by the mutations below for the client gate and the sheet rule only.

**Mutations (each restored, then green).**

- `approve` calls `approvals.add` directly → 59 pass, **3 fail** (incl. «a denied ask adds nothing»).
- `askPresentable` returns `true` for any origin over the landing → 89 pass, **1 fail** (the D8 «ONLY a file's approval» case).
- `workflowWriteSession` ignores `daemonWakes` → 4 pass, **1 fail** («an untrusted daemon (a pod) is refused locally»).

**Checks run (narrow only).** Protocol + workflow tests of agent/cli/daemon/client/tui, `subagent-panel-controller`, `local-runtime`: 1106 pass, 0 fail. `apps/mobile/test/workflow*` + `sheet-plan`: 638 pass, 0 fail. `bunx tsc -p apps/mobile`: clean. `biome check` on the 41 changed code files: clean. The full gate is the orchestrator's.

**Unverified.** No simulator run: flows 34/44/45/46 and the pixels (against the mockup) are unrun — run the e2e gate. «Offline» on the landing follows the run list's `offline`, which is set when a read of it fails, not the instant the link drops. An approval sheet swiped away (parked) over the landing is reopened from the session, not from the dimmed Approve.

## Review

*— claude-opus-5-5, 2026-11-26*

**Verdict: APPROVE** (no HIGH/MEDIUM). Fresh context; same model family as the planner (Opus), different from the executor (Sonnet) — shared planner blind spots may survive.

**Gate (narrow, as asked).** The 17 touched test files: 414 pass, 0 fail. `bun run lint`: clean (2566 files). `bun run typecheck` (root + mobile + relay): clean. Full `bun run test` and the simulator e2e (flows 34/44/45/46) NOT run here — the merge gate's.

**§7 red-team.**
- *Single broker / one grant path:* `approve` reaches the store only through `askApproval` → `deps.request` → `approvals.add` after `answer.allowed` (`workflow-driver.ts:1271-1318`); the same body as `requestApproval`. No direct write.
- *Pod not trusted:* `remove:` is wired only beside `save:` in the non-tunnelled block (`wiring.ts:975-976`); no driver → `unavailable` (`hosted-session.ts:3137`, `:3172`); client refuses before any open when `!daemonWakes` (`remote-session.ts:1528`).
- *Peer not serialized:* both dispatch cases take no lock (`connection.ts:493-500`); approve answers before the ask (mutation below).
- *Hash pin:* approve compares before asking and the stored hash is the pinned one; delete compares in one synchronous block with the unlink (`workflow-files.ts:620-623`).

**Mutations (each reverted; `git status` clean after).**
1. Remover ignores the hash pin → 3 fail (`changed`, broken→valid, no-longer-valid).
2. `remove` skips the running check → 1 fail.
3. `approve` skips the open-ask guard → 2 fail (second approve; schedule's open ask).
4. `approve` AWAITS the ask → 6 fail incl. the daemon «over RPC: approve answers while its ask is still pending».
5. Phone `canAnswer` forced true → 1 fail («nothing is sent with no sheet…»).

**Attacks tried that found nothing blocking.**
- Delete while another *session* on the same `serve` runs the workflow: the running check is per-session, but a run snapshots its spec; a later `rerun` re-reads and refuses `changed` (`workflow-driver.ts:1399-1404`) — loud, not silent.
- Approve while a start's own hash ask is open (race, not `needs-approval` yet) or from another session: a second ask for one hash is possible. Harmless (both pinned to the same hash, once-only, owner-only); nit.
- TUI `delete x confirm` pins the catalogue read triggered by the preceding `/workflow` (same pattern as `run`); an edit after that read is `changed`.
- Over the landing a main-agent ask stays not presentable (S8 behaviour, as over a run); `sheet-plan` D8 mutation already shown by the executor.
- `schedules` lists only this session's jobs; a delete's cross-session schedules fire `invalid` at fire time — visible. Nit.

**Executor behaviour.** Drift is recorded honestly (count instead of Set — correct and tested; `local-runtime` forwards added). Red-before-green gaps are stated (client, `workflow-landing.test.ts`, D8 cases); mutations above cover the client gate and the phone gate.
