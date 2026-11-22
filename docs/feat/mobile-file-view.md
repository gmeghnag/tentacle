# feat/mobile-file-view — coloured file content in tool rows + per-session trust for HTML scripts (iPhone)

> Type: feat · Size: M · Blast: load-bearing (part 2 touches the artifact sandbox and the pod-trust rule, AGENTS §7) · Suited: DeepSeek executes, Opus fresh-context review MUST red-team part 2 (pod exclusion, network untouched)
> **Branch:** `feat/mobile-file-view` · **Changelog:** `changelog.d/mobile-file-view.added.md`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22 — owner decisions, verbatim intent*

Two owner requests, bundled by the owner into one job.

### Part 1 — file content coloured by file type in Read / Edit / MultiEdit / Write rows

Today the phone shows a tool's file content as flat grey monospace, with the raw tool header
(`⎿ [file lines 1–147 of 521]`). On a MultiEdit the file name shows four times and `+78 −30`
three times. The TUI colours a read by the file EXTENSION (`packages/tui/src/read-highlight.ts`,
cap `READ_HIGHLIGHT_CAP` 2000 lines / 200 KB). The app already ships highlight.js core with 14
grammars (`apps/mobile/src/highlight.ts`), used today only by chat code blocks
(`apps/mobile/src/ui/CodeBlock.tsx`, `scopeColor`).

**Spec = the mockup** `docs/feat/mobile-file-view-mockup.html`, **variant B** (chosen 22/11):

1. **Language from the extension only** (never auto-detect); unknown extension → plain, as
   today. Same size cap as the TUI → plain above it.
2. **`.html` IS coloured, including the JavaScript inside `<script>` and the CSS inside
   `<style>`** (owner: "sì coloriamolo"). The phone may do more than the TUI here; leave the TUI
   untouched.
3. **One line-number column** (variant B): the new number, or the old one for a removed line.
   Not two columns.
4. **Header said once.** The step row carries `<Tool> <path> · N modifiche  +A −D` (no
   duration for Read/Edit/Write, per earlier decisions). The body opens with ONE light line:
   Read → `righe A–B di N · LANG`; Edit/MultiEdit → `righe A–B · LANG` instead of `@@ … @@`;
   Write → `LANG · nuovo file`. Remove the `⎿ edited … with N edits` line and the repeated
   file card / counts inside the body.
5. **Preview + full view:** the collapsed body shows the first lines and `… altre N righe ·
   tocca per vedere tutto`; tap shows everything (existing full-view mechanism if there is one).
6. Diff lines keep the `+` / `−` sign column and the add/del backgrounds (never colour alone —
   the owner is colour-blind). Syntax colours inside diff lines.
7. Reuse the existing scope→colour mapping (`scopeColor`) so chat code blocks and tool bodies
   look the same; extend it only for the scopes html needs (tag name, attribute).

### Part 2 — "run scripts always in this session" for HTML artifacts

Today scripts in an HTML artifact are OFF, and every open needs a "Run scripts" tap
(`apps/mobile/src/artifact-viewer.ts:30-70` `viewerFor`, `scripts: false`;
`apps/mobile/src/screens/artifacts/HtmlViewer.tsx:45-70`). Rationale (docs/feat/model-artifacts.md
Owner Q5/Q5b, risk table line ~541): CSP cannot block a WebRTC beacon, so a page with scripts
can leak its own content; "per open, never remembered".

**Owner decision (22/11), final:**
1. The scripts confirm gets a second action: **«Esegui sempre in questa sessione»** (keep
   «Esegui» = this open only, and «Annulla»).
2. The trust is **per session only**, remembered for that session (persist it the way other
   per-session phone settings are persisted, or in memory if none — say which), and it can be
   **revoked from the session info sheet**.
3. **Network stays off and stays per-open**, exactly as today — trust covers scripts only.
4. **Never offered for a session that runs in a pod/container** (`run`/`attach`, detached
   runs): HTML there may come from untrusted code, and AGENTS §7 forbids a pod-originated thing
   getting a lasting approval. If the app cannot tell reliably whether a session is pod-backed,
   it does NOT offer the option (safe default) — prove which signal you use, `file:line`.
5. While a trusted session's page runs scripts, the viewer's thin bar says
   «script attivi · sessione fidata» (text, not colour).
6. Update the Q5 notes in `docs/feat/model-artifacts.md` with a dated owner amendment.

## Implementation

*— deepseek-v3.2, 2026-11-22 — written before coding, each claim re-verified against the source.*

### Load-bearing assumptions (proved first)

**Part 1 — `spansOf` can see html's sub-language wrappers.** `packages/tui/src/read-highlight.ts`
is irrelevant here: the phone's path is `highlight.ts` → `spansOf` (`apps/mobile/src/highlight.ts:158`),
which only recognises `<span class="hljs-`. Probed on the worktree (`bun` over the real modules,
`.tentacle/tmp/mobile-file-view/probe-leak.ts`) with a `.html` body:

```
label: html lines: 6
"<style><span class=\"language-css\">"     <- the wrapper leaks as TEXT
":root { --bg: #eee; }"                    <- coloured, but the marker is drawn too
"<script><span class=\"language-javascript\">"
```

So `.html` is *not* merely uncoloured — going through `spansOf` it is **corrupted** (raw
`<span class="language-css">` printed into the code). The `xml` grammar does emit the
sub-languages (`node_modules/highlight.js/lib/languages/xml.js:164,177` `subLanguage: 'css'` /
`'javascript'`), and the inner tokens are ordinary `hljs-*`. **The fix is in `spansOf`: treat a
`class="language-<x>"` wrapper as a TRANSPARENT scope** (push `""`, which `pushText` already
renders as the parent's scope) instead of text. This also fixes chat code blocks, which today
would print the same markers for a ```` ```html ```` fence — a bug the spec did not name.

**Part 2 — the wire carries no host kind.** The phone never learns whether its daemon is a pod:
`initialize`'s `agentInfo` (`packages/daemon/src/connection.ts:850-860`) carries `version`,
`model`, `contextWindow` only, though the daemon KNOWS (`DaemonIdentity.kind`,
`packages/daemon/src/version-mismatch.ts:10-14`). The one structural signal on the wire is the
attachment policy: `daemonDocumentPolicy("pod")` (`packages/cli/src/image-policy.ts:53-57`) is
wired unconditionally for a pod host (`packages/cli/src/serve.ts:1322`) and `"host"` for
`serve`/worker (`serve.ts:800`, `worker.ts:170`), advertised as
`agentCapabilities.documents.input` (`connection.ts:840-848`) — `"client"` ⇔ pod, `"upload"` ⇔
host. `images.input === "client"` is the same fact for the `--model-proxy` pod
(`image-policy.ts:35-44`). Rule, **fail closed**: a daemon that proves neither ⇒ treated as
pod-backed ⇒ the option is not offered.

Two supporting facts: a device route exists only on a host `serve` — `startWsServer` with a
`devices` authority is started in one place (`serve.ts:975`), a pod daemon is hosted over stdio
(`serve.ts:1375-1380`) — and the phone already relies on exactly this (`connection.ts:60-66`,
"the phone reaches a `serve` on the user's own host and nothing else"). The phone declares no
`hop` (`connection.ts:63-82`), so a phone session is never moved into a workload
(`protocol/src/session.ts:263-270`), which is what makes a once-pod session unreachable.

### Design — part 1

Pure first (AGENTS §7). New `apps/mobile/src/file-body.ts`:

- `FILE_TOOLS` = `fs_read | fs_write | fs_edit | fs_multi_edit`.
- `fileBodyView(row, full)` → `null` for anything else, for a non-`ok` row (an error/denial
  keeps today's plain output — never a coloured body hiding the failure), and for a row with no
  content yet. Otherwise `{ language, header, lines, hidden, sign }`:
  - **language** from the EXTENSION only (`pathExtension` + the existing `languageOf` alias table,
    `highlight.ts:96`), never auto-detection; above `FILE_HIGHLIGHT_CAP` (2000 lines / 200 KB,
    the TUI's) → `language: null` = plain.
  - **Read** (`fs_read`): parse the `[path lines A-B of N]` header (`packages/tools/src/builtins.ts:137`),
    strip it, one line per source line; `header` = `lines A–B of N · LANG` (from the header), or
    `N lines · LANG` for a whole-file read.
  - **Edit/MultiEdit** (`fs_edit`, `fs_multi_edit`): `diffView(row.diff)` (`diff-view.ts:99`),
    hunks flattened, `header` = `lines A–B · LANG` where A/B are the first hunk's start and the
    last hunk's end — replacing `@@ … @@`, which is dropped.
  - **Write** (`fs_write`): its diff with no removal line ⇒ `header` = `LANG · new file`, else the
    Edit header. (A Write over an existing file is a real diff and says so.)
  - **ONE number column** (variant B): the new number, else the old one for a removed line.
  - **Preview**: more than `FILE_BODY_PREVIEW` (12) lines → the first `full ? all : 12`, `hidden`
    = the rest, drawn as `… N more lines · tap to see all`; `full` is the screen's existing
    show-all seam (`step.onShowAll`, `tool-steps.ts:341`).
- `stepRowView` (`tool-steps.ts:338`): for a file tool — `command: []` (the step line already
  says the path), `output: null` (drops `⎿ edited … with N edits` / `wrote N bytes` and the
  duplicated counts), and a new optional `file: FileBodyView`; `tappable` stays true.
- `DiffView` keeps its `diff-<callId>` testID role by moving it onto the new body's wrapper (an
  e2e flow asserts it, `apps/mobile/e2e/flows/08-call-id.js`) — the component itself stays for
  no other caller today, so `TranscriptRow` stops rendering it for file rows.

Render: `apps/mobile/src/ui/FileBody.tsx` (dumb): the light header line, a horizontal
`ScrollView`, one row per line = number gutter (`sec`) · `+`/`−` sign · coloured spans, the
row tinted `addBg`/`delBg`. `scopeColor` moves from `CodeBlock.tsx:28` to a pure
`apps/mobile/src/syntax-color.ts` so chat blocks and tool bodies cannot drift, extended for the
scopes html needs (`tag`, `name`, `attr`).

**Copy language:** the spec quotes the mockup's Italian; the app has no i18n layer and every
string is English (`… +N more lines`, `more lines not shown`). Shipped copy is English —
`docs/fix/mobile-step-rail.md` made the same call for `«Thinking»` → `Thinking`.

### Design — part 2

Not implemented in this pass (see Execution): the design is `sessionTrust` (pure,
`apps/mobile/src/session-trust.ts`): `podBacked(init)` = the fail-closed rule above;
`scriptsAllowed(init)` = trust offered only when `!podBacked`; a per-`sessionKey(computerId,
sessionId)` record (`artifact-seen-store.ts` is the pattern: versioned `SecureKV`, unknown `v`
refuses writes), `grant` / `revoke` / `isTrusted`, and `scriptsBarLabel(trusted)` =
`scripts on · trusted session` while a trusted page runs. Wire it: `init` already rides
`ComputerLink` (`connection.ts:114`) → gallery → `ArtifactViewerModal` → `HtmlViewer`; the
confirm gains «Run always in this session»; Session info's sheet row revokes.

### Files to change

`apps/mobile/src/highlight.ts` (transparent sub-language wrapper + a `maxChars` argument) ·
`apps/mobile/src/syntax-color.ts` (new) · `apps/mobile/src/file-body.ts` (new) ·
`apps/mobile/src/ui/FileBody.tsx` (new) · `apps/mobile/src/ui/CodeBlock.tsx` (use the shared
colour) · `apps/mobile/src/tool-steps.ts` (`file`, empty command/output) ·
`apps/mobile/src/screens/transcript/TranscriptRow.tsx` (draw `FileBody`) · tests ·
`changelog.d/mobile-file-view.added.md`.

### Failure modes

| Case | Behaviour |
|---|---|
| Unknown / no extension | plain, exactly today (`language: null`) |
| Over the cap | plain, one build's worth of work only |
| A failed/denied file tool | no file body at all: today's plain output (the failure must stay legible) |
| Non-JSON args / no path | plain body, header without a language |
| Read with no `[path lines …]` header (whole-file read, a PDF's text) | lines shown, header `N lines` |
| Empty content / empty patch | `null` → not tappable, today's row |
| `.html` with `<script>` | coloured, no marker text (the `spansOf` fix) |
| 400-line patch | `diffView`'s own bound; the remainder is the preview's `hidden` |

## Tests (minimum, red first — AGENTS §9)

- Part 1: language by extension (incl. `.html` with script/style sub-languages), unknown →
  plain, cap → plain; header strings for Read/Edit/MultiEdit/Write; one number column for
  add/del/context lines; no repeated file name/counts in the body.
- Part 2: pure trust module: offered only for non-pod sessions; trust is per session id;
  revoke; network unaffected; a pod session never trusted even if a stale record says so.
  Mutation-check the pod exclusion.

## Validation (mandatory)

Simulator screenshots, dark AND light: a Read of an `.html` (script coloured), an Edit diff,
a MultiEdit like the mockup's, a Write; the scripts confirm with the new action; the viewer bar
in a trusted session. Save under `docs/feat/mobile-file-view/`. End with
`SCREENSHOTS: <paths>` and `READY` or `NOT READY: <why>`.

## Execution

*— deepseek-v3.2 (slices 1–3, stopped by the watchdog at 251 tool calls) + claude-opus-5-5 (resume: verification, mutations, this section), 2026-11-22*

**Part 1 — DONE (code + tests). Part 2 — NOT STARTED** (the approved Implementation scoped
it out: "Design — part 2: not implemented in this pass"; its files are not in *Files to
change*, so the resume did not touch them). **Validation (simulator screenshots) — NOT DONE.**

As built, in the plan's order:

1. `apps/mobile/src/highlight.ts` — `spansOf` treats `<span class="language-…">` as a
   transparent scope (pushes `""`; `pushText` maps `""` → parent/plain); `highlight()` gains
   `maxChars` (default `HIGHLIGHT_MAX_CHARS`, so chat blocks are unchanged).
2. `apps/mobile/src/syntax-color.ts` (new) — `scopeColor` moved out of `ui/CodeBlock.tsx`
   verbatim, plus `doctag`, `regexp`, `symbol`, `section`, `function`, and the html scopes
   (`tag`/`selector-*` → `sec`, `name`/`attr`/`attribute` → `kw`). `CodeBlock.tsx` imports it.
3. `apps/mobile/src/file-body.ts` (new) — `fileBodyView(row, full)` per the Design (ext-only
   language, `FILE_HIGHLIGHT_CAP` 2000 lines / 200 000 chars, Read/Edit/MultiEdit/Write
   headers, one number column `newNo ?? oldNo`, preview 12 + `hidden`).
4. `apps/mobile/src/tool-steps.ts` — `StepRowView.file?`; when present `command: []`,
   `output: null`, `tappable: true`.
5. `apps/mobile/src/ui/FileBody.tsx` (new, dumb) + `ui/StepNode.tsx` (`StepBody` `file` slot) +
   `screens/transcript/TranscriptRow.tsx` (FileBody for a file row, `DiffView` otherwise; the
   `diff-<callId>` testID moves onto `FileBody`).
6. Tests: `test/file-body.test.ts`, `test/file-body-render.test.ts`, `test/syntax-color.test.ts`
   (new); `test/highlight.test.ts`, `test/tool-step-view.test.ts` (extended).
7. `changelog.d/mobile-file-view.added.md`.

**Drift from Implementation:** none in part 1. `scopeColor` got a few non-html scopes too
(`doctag`, `regexp`, `symbol`, `section`, `function`) — mapped to the colours their siblings
already use; chat blocks change only for those scopes. Diff lines are highlighted **per line**
(a hunk is fragments; a multi-line construct split across lines may colour imperfectly —
documented in `file-body.ts`). A permission-pending Edit row is not `ok`, so it keeps the old
`DiffView` (and `diff-<callId>`) until it completes — the `08-permission` flow is unaffected.

**Load-bearing re-check (resume, on the fixed code)** — `.tentacle/tmp/mobile-file-view/probe2.ts`
highlights an html body with a `<style>` and a `<script>`:

```
label: xml leak: false roundtrip: true
scopes: tag,name,plain,selector-pseudo,attr,number,keyword
```

(The pre-fix leak is the Implementation's probe above: `<span class="language-css">` as text.)
Red-first: DeepSeek's run did not record red output; the resume substitutes the mutation table
below (each target reverted after its run, tree verified unchanged).

**Mutations** (`.tentacle/tmp/mobile-file-view/mutate.ts`, the 5 narrow test files):

```
M1 sub-language wrapper read as text: 4 fail — .html IS coloured, script and style included | an html <style> body is coloured, and no marker text is emitted
M2 number column old-first: 1 fail — ONE number column: the new number; a removed line keeps its old one
M3 failed row gets a body: 2 fail — a FAILED file tool keeps today's plain output | a denied file tool
M4 cap ignored: 1 fail — over the line cap
M5 raw output kept: 1 fail — a file step carries its coloured body and NO raw result line
M6 language auto-detected for unknown ext: 4 fail — an unknown extension is plain… | no extension at all is plain
M7 preview never cuts: 2 fail — collapsed: the first lines, and the rest counted | `full` reaches the file body's preview
M8 write-new header lost: 1 fail — a created file says `LANG · new file`
```

**Local checks:** narrow files 99 pass / 0 fail; `apps/mobile/test/` 4371 pass / 0 fail;
`tsc -p apps/mobile` clean; `biome check` on the 13 touched files clean. Full gate: left to the
orchestrator's script.

**Open (decision needed):** part 2 (session script trust) is designed above but unbuilt and
unapproved for code — the owner bundled it into this job, so either approve its Files list for
a follow-up executor or split it into its own task. Validation screenshots need a simulator run.
NOT READY: part 2 not built; no screenshots.

## Review

*— claude-opus-5-5, 2026-11-22 (fresh context; same model as the Execution resume, different from the DeepSeek executor)*

**Verdict: REQUEST-CHANGES**

Findings (HIGH/MEDIUM only):

1. **HIGH — a spilled `fs_read` is drawn as file content with false line numbers.**
   `apps/mobile/src/file-body.ts:288-305` ignores `row.spill`. A read over
   `maxInlineOutputChars` arrives as `[large fs_read output …]\n<head>\n…[N characters omitted]…\n<tail>`
   (`packages/agent/src/result-pipeline.ts:89-104`). Repro (`.tentacle/tmp/mobile-file-view/review.ts`):
   header `4 lines · TypeScript`; line 1 = the banner, line 3 = the omission marker, the
   file's last line numbered 4. The body lies about the file (§8: synthesised data from
   truncated input). Fix: a row with `spill` gets no file body (or a plain one without numbers/
   line-count header) + a test.
2. **HIGH — a diff over `DIFF_MAX_LINES` (400) silently loses its tail.** `file-body.ts:194-218`
   drops `diffView(...).hidden`; `preview` counts only the 400 rendered rows. Repro: a 600-line
   Write, `full=true` → 400 lines, `hidden 0`, no marker; the old `DiffView` said
   `N more lines not shown` (`screens/transcript/DiffView.tsx:126`). The Failure-modes row
   "400-line patch → the remainder is the preview's `hidden`" is FALSE. Fix: carry
   `view.hidden` into the body (a "not shown" line) + a test.
3. **HIGH (scope) — Part 2 is not built, Validation screenshots not taken.** The task bundles
   part 2 (the load-bearing reason for this review); nothing to red-team on §7 pod trust because
   no code exists. Either split part 2 into its own task (doc + TODO) or build it before merge.
4. **MEDIUM — an append-only overwrite by `fs_write` is labelled `LANG · new file`.**
   `file-body.ts:281` infers "created" from `removed === 0`; `ToolDiffDetail` has no created
   flag (`packages/tools/src/builtins.ts:42`), so overwriting a file with only added lines
   claims a new file. Use the hunk start (`@@ -0,0`) instead.

Gate (re-run): 5 touched test files 99 pass / 0 fail; `bun run lint` clean (2264 files);
`bun run typecheck` clean. Full `bun test` not re-run here.
Mutation: removing the `status !== "ok"` guard → 3 fail (file-body + tool-step-view); reverted,
tree byte-identical (`git status` clean). Executor's M1–M8 table not re-run.

Attacks tried: spilled read (found #1); >400-line patch (found #2); >200 KB patch → `hunks: []`
→ `null` → old `DiffView` with its marker (holds); failed/denied row keeps plain output (holds,
mutation-proved); `packages/*` diff = test-fixture type casts only, no behaviour (holds);
part-2 pod exclusion (no code — #3).

Executor behaviour: DeepSeek stopped at the watchdog without red-first evidence; the resume
substituted a mutation table and was honest about part 2 / screenshots. The Failure-modes table
overstated the 400-line case without a test behind it.
