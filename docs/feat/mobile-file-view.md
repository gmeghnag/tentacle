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

*(executor: write it before coding, source-verified per AGENTS §8 with `file:line`; name the
one assumption each part stands on and prove it first. Part 2's failure modes: session switch,
reconnect, a session moved between hosts, an artifact opened from the gallery outside its
session, revoke while a page is open.)*

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

## Review
