# feat/attachments-tui — drag a photo into the TUI, the model sees it (chips, `/attach`, upload progress, `[image: …]` rows)

> **Status:** implementation — APPROVED (owner night delegation 2026-11-12)
> **Branch:** `feat/attachments-tui`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (one additive wire field `turn_start.attachments`; the TUI's one send path; `SessionController` seam used by every runtime) · **Suited:** strong model executes + **mandatory fresh-context Review** (App frames + the §7 "one session path" / "never raw stdout" invariants)

<!--
Sub-task 3b of docs/feat/attachments.md (§Split row 3b): the owner goal ships here.
Builds on attachments-core (refs, log types), attachments-upload (`RemoteClient.upload`),
attachments-prompt (`attachImage`, `imageInput`, `prompt(…, refs)`, `RemoteSession.send({attachments})`)
and attachments-tui-detect (pure `attach-candidates.ts` / `attach-files.ts` / `attach-refusal.ts`).
-->

## Context

*— claude-opus-5-5, 2026-11-12*

Owner goal (`docs/feat/attachments.md` §Promotion): drag a photo into the
laptop terminal (it pastes the path) or type `/attach <path>`; tentacle
recognises an image and the model SEES it, on every runtime (in-process worker,
`connect` → `serve`, pod `run`/`attach`).

Everything below the TUI exists and is merged on `main` (`c360c4c`):

| Seam | Where | State |
|---|---|---|
| path text → candidates | `tui/src/attach-candidates.ts:188` `attachmentCandidateText`, `:218` `parseAttachCommand` | pure, tested, **unused** |
| candidates → decision (sniff, caps, refusals) | `tui/src/attach-files.ts:344` `decideAttachment`, `:307` `attachPaths`, `:376` `nodeFileProbe` | pure behind `FileProbe`, **unused** |
| capability | `client/src/remote-client.ts:1639` `imageInput()` | `upload` / `laptop` / `off{reason}` |
| bytes → ref (upload or laptop-held) | `remote-client.ts:1661` `attachImage(sessionId, bytes, meta, {signal,onProgress})` | needs the session OPEN on the daemon |
| prompt with refs | `remote-client.ts:2006` `prompt(…, attachments)`; `remote-session.ts:932` `send(…, {attachments})` | keyed re-send carries refs |
| history display | `agent/src/compact.ts:37` writes ` [image: <attachmentLabel>]` for the summary | TUI shows nothing |

What is missing is exactly the TUI: `App`'s `SessionController.send` takes
`{skill}` only (`tui/src/App.tsx:257-261`), the paste handler inserts text
verbatim (`App.tsx:3496-3500`), `resume.ts:51` and `render-lines.ts:738` drop a
message's `attachments`, and another client's turn shows only `turn_start.prompt`
(`protocol/src/updates.ts:241-245`; daemon emit `daemon/src/hosted-session.ts:2022`).

**Repro** (2026-11-12, bun 1.4.3, branch base `main` @ `c360c4c`; run as
`bun /Users/gmeghnag/tentacle/.tentacle/tmp/attachments-tui/seams.ts`; imports
the WORKTREE's sources by relative path because the root `node_modules`
links to the main checkout):

```ts
// seams.ts (2026-11-12) — load-bearing check for feat/attachments-tui:
// can a TUI-shaped session (lazy RemoteSession) attach an image BEFORE its first
// send, and does any SessionController seam carry refs today?
import { readFileSync } from "node:fs";
// Worktree sources by path (the root node_modules links to the main checkout).
import { Agent } from "../../worktrees/attachments-tui/packages/agent/src/index.ts";
import { PermissionBroker } from "../../worktrees/attachments-tui/packages/core/src/index.ts";
import { Connection, SessionHost } from "../../worktrees/attachments-tui/packages/daemon/src/index.ts";
import { createChannelPair } from "../../worktrees/attachments-tui/packages/transport/src/index.ts";
import { RemoteClient } from "../../worktrees/attachments-tui/packages/client/src/index.ts";

const env = { id: "e", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} };
const idle = { id: "idle", async *stream() { yield { type: "done" } as never; } };
const host = new SessionHost({
  defaultCwd: "/x",
  images: { source: "store", maxBytes: 1024 * 1024 },
  createAgent: () => ({ agent: new Agent({ model: idle as never, tools: {} as never, env: env as never }), permissions: new PermissionBroker() }),
});
const [d, c] = createChannelPair();
new Connection(d, host);
const laptop = new RemoteClient(c, new PermissionBroker());
await laptop.initialize();
console.log("1 imageInput:", JSON.stringify(laptop.imageInput()));

const uid = crypto.randomUUID();
const session = laptop.newSession(undefined, uid); // what connect/local-runtime hand the TUI
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
try {
  await laptop.attachImage(uid, png, { mimeType: "image/png", name: "a.png" });
  console.log("2 attach before first send: ok");
} catch (e) {
  console.log("2 attach before first send: REJECTED", (e as Error).message.split("\n")[0]);
}
await session.openSeeded();
const ref = await laptop.attachImage(uid, png, { mimeType: "image/png", name: "a.png" });
console.log("3 attach after openSeeded: ok, held =", host.get(uid)?.uploads.holds(ref));

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const app = src("../../worktrees/attachments-tui/packages/tui/src/App.tsx");
const lr = src("../../worktrees/attachments-tui/packages/cli/src/local-runtime.ts");
console.log("4 SessionController.send opts:", /opts\?: \{ readonly skill\?: string \}/.test(app) ? "{skill} only" : "changed");
console.log("5 App mentions attachImage:", app.includes("attachImage"), "| PersistingController forwards attachImage:", lr.includes("attachImage"));
laptop.close();
process.exit(0);
```

```
1 imageInput: {"kind":"upload","maxBytes":1048576}
2 attach before first send: REJECTED unknown session: a9c2eef4-… (not open on this connection)
3 attach after openSeeded: ok, held = true
4 SessionController.send opts: {skill} only
5 App mentions attachImage: false | PersistingController forwards attachImage: false
```

Reading: *r1* the client API works and says `upload`. *r2* the session the TUI
holds is LAZY (opened by its first `send`), so an upload before the first prompt
fails — the TUI cannot just call `RemoteClient.attachImage(sessionId, …)`.
*r3* once open, the bytes land. *r4/r5* no TUI seam carries refs or uploads.

## Implementation

*— claude-opus-5-5, 2026-11-12*

### Load-bearing assumption

**The TUI can reach every runtime's image path through ONE new optional
`SessionController.attachImage` that the SESSION object implements (it opens
itself first, then calls `RemoteClient.attachImage` with its own id), plus one
new `attachments` field on the existing `send` opts — no second session path.**

Proved:

- Every RPC runtime hands `App` a `RemoteSession` (or a wrapper of one):
  `connect` passes it as is (`cli/src/connect.ts:232-236`, `track` returns the
  same object `:192-196`); `run`/`attach`/worker pass `PersistingController`,
  which wraps `inner: RemoteSession` and forwards method by method
  (`cli/src/local-runtime.ts:494-495`). So a method on `RemoteSession` + one
  forward in `PersistingController` covers worker, `connect`, pod `run`/`attach`
  (§7 "TUI always over RPC — one session path").
- `RemoteSession` is LAZY: a fresh one opens at its first `send`
  (`remote-session.ts:374-400` `createOrAttach`, memoized); an attach-only one
  opens in `open()` (`:330-352`). The daemon's `attachment/put` looks the session
  up on THIS connection (`daemon/src/connection.ts:308-310` `this.lookup`) →
  *r2* rejects an upload before the open, *r3* accepts it after. Hence the
  method must live ON the session (which can await its own open), not in `App`
  (which only knows an opaque `sessionId`, `App.tsx:422`).
- The send seam already carries refs below the controller:
  `RemoteSession.send(prompt, signal, {attachments})` (`remote-session.ts:932-940`)
  → `ActiveTurn` → `RemoteClient.prompt(…, attachments)` (`remote-client.ts:2006-2028`),
  keyed (re-sent identically after a drop). `App` only has to pass the field
  (`App.tsx:2136-2140`).
- `attachImage` picks upload vs laptop-held from the daemon's capability and
  sends zero frames when off (`remote-client.ts:1661-1700`; attachments-prompt
  D5) — the TUI never decides WHERE bytes go.

**Executor: re-run `seams.ts` first (lines 2 and 5 must still read REJECTED /
false), and `rg -n "createSession: \(\) =>|createSession = \(\)" packages/cli/src`
— a runtime that hands App something that is neither a `RemoteSession` nor a
`PersistingController` (other than `inProcessSessions`, which stays image-less,
D-decision 9) → STOP and amend this plan (AGENTS §0, §8).**

### Preconditions

| # | Fact | Source |
|---|---|---|
| P1 | Pure detection modules exist and are the ONLY place the paste rule lives: `attachmentCandidateText(text,{home})`, `parseAttachCommand(text,{home})`, `decideAttachment(probe, candidate, {existing, explicit})` → `attachments{refs,images,refusals}` / `text` / `refused{refusals}`; `refusalText` | `tui/src/attach-candidates.ts:188,218`; `attach-files.ts:272-353`; `attach-refusal.ts:30` |
| P2 | `AttachedImage = {path, ref, bytes}`: the bytes are held client-side after the decision (a re-upload needs no re-read) | `attach-files.ts:61-65` |
| P3 | `collectAttachments` counts the per-message cap and duplicates against `existing` (the chips already held) | `attach-files.ts:184-252` |
| P4 | `RemoteClient.imageInput()` → `upload{maxBytes}` / `laptop{maxBytes}` / `off{reason}`; `attachImage` throws `ImagesUnavailableError(reason)` (off), `RangeError` (size), `InvalidAttachmentError` (ref), upload errors (`UploadLinkLostError`, abort) — all before or during upload, never a silent drop | `remote-client.ts:179-184,1639-1700`, `:1564-1600` |
| P5 | The daemon refuses a bad image prompt with `DomainErrorCode.AttachmentRefused` + `data.reason` ∈ `images_off`/`invalid_ref`/`not_uploaded` BEFORE recording anything; the turn never started | `daemon/src/hosted-session.ts:1936-1972`; `protocol/src/jsonrpc.ts:57` |
| P6 | Paste paths into the MAIN input: bracketed paste `App.tsx:3487-3502`, its recovery timer `:3317-3331`, Ctrl+V `:3889-3898`. An unbracketed drop arrives as typed text (`:3925` insert action) — covered by the submit-time rule (owner Q3 (a)) | `App.tsx` as cited |
| P7 | The permission reply field takes its own paste (`App.tsx:3394-3409`) — never routed here | — |
| P8 | `inputBoxRows = inputContentLines + 2` drives the viewport, palette and status-bar mouse row (`App.tsx:1177-1178,1241,1310,4100`) — a new row inside the input box must be added THERE, once | — |
| P9 | Ink gotcha: an empty `<Text>` measures 0×0 (AGENTS §6) — an image-only user bubble must not render an empty text row | AGENTS §6 |
| P10 | A refused own prompt that never started is withdrawn and its text restored only when `opts.own.text !== ""`; `""` is treated as a wake (`App.tsx:2009-2020`) — an image-only prompt would be mistaken for one | `App.tsx:2014-2020`; `turn-feed.ts:125` `lostSlot` |
| P11 | `turn_start` is a mandatory update; payloads are strip schemas, so a new optional field is free (older client drops it) — AGENTS §7 forward-compat; the schema export + `json-schema.test.ts` drift gate needs the field | `protocol/src/updates.ts:241-245,462`; `protocol/src/index.ts:8-12` |
| P12 | Foreign turns render through `startForeign(turnId, prompt)` → `user_message{text}` (`remote-session.ts:1338-1372`); an own turn re-delivered after a reset uses `update.prompt` (`:1623-1634`); TUI state folds `user_message` into a `UserItem` (`tui/src/state.ts:581,643-645`) | — |
| P13 | Resumed/reset histories become rows via `messagesToItems` (`tui/src/resume.ts:34-56`; `state.ts:612-627`); `ChatMessage.attachments` is there but ignored | — |
| P14 | `compact.ts:37` already writes ` [image: <attachmentLabel>]` for the model's summary; `attachmentLabel` = `<name or mime> sha256:<12>` | `agent/src/compact.ts:37`; `core/src/attachments.ts:137-146` |
| P15 | `App`'s `cwd` prop is NOT the laptop's working directory under `connect` (it is the URL, `connect.ts:228`) → a relative `/attach` path must resolve against the laptop process's cwd, injected | `connect.ts:228` |

### Design

**Shape:** detection stays in 3a's pure modules; ONE new pure module owns the
draft (chips, upload phase, submit routing, the row text); `App` only executes
its decisions; the bytes go through the SESSION (`attachImage`), the refs through
the existing `send` opts. Upload happens **at submit**, not at paste
(Orchestrator decision 2): a chip is local bytes until Enter.

**D1 — protocol (one additive field, no bump).** `TurnStartSchema`
(`protocol/src/updates.ts:241`) gains
`attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional()`
— display data for OTHER clients' rows. Strip schema → an older client drops it
(P11); a malformed ref fails the frame's parse exactly like any bad
`turn_start` today. Regenerate `schema/protocol.json` (`bun run schema:export`)
and add the `json-schema.test.ts` fixture row. No `UPDATE_CLASS` change
(`turn_start` stays mandatory), no `client/mapping.ts` change (it maps
`turn_start` to `null`, `mapping.ts:343`).

**D2 — daemon.** `hosted-session.ts:2022`: `this.emit({ type: "turn_start",
turnId, prompt: text, ...(refs.length > 0 ? { attachments: refs } : {}) })`
(the `refs` `splitPrompt` already produced). `send_now`'s emit (`:2215`) is
unchanged (text-only by 2b decision 9).

**D3 — client.**
- `RemoteSession.attachImage(bytes, meta, opts?) → Promise<AttachmentRef>`:
  `await (this.attach ? this.open() : this.createOrAttach())`, then
  `this.client.attachImage(<the open id>, bytes, meta, opts)`. Same memoized
  open as the first `send`, so a send right after reuses it (no double open).
- `RemoteSession.imageInput() → ImageInput` = `this.client.imageInput()`.
- `SessionEvent.user_message` (`client/src/mapping.ts:32`) gains
  `attachments?: readonly AttachmentRef[]`; `startForeign(turnId, prompt,
  attachments?)` pushes it (`remote-session.ts:1338-1372`, called from `route`
  `:1522-1530` with `update.attachments`); the reset re-delivery (`:1633`)
  passes `update.attachments` too. A continuation (`prompt ""`, no refs) still
  pushes nothing; an image-only foreign prompt (`""` + refs) DOES push.

**D4 — cli.** `PersistingController` (`local-runtime.ts:211-245` interface,
`:494` impl) forwards `attachImage` and `imageInput` to `inner`, and its `send`
type takes `attachments` (it already passes `opts` through). `connect` needs
nothing (hands the `RemoteSession` itself). `inProcessSessions`
(`session-jobs.ts:133-166`) gets neither → images off there (decision 9).

**D5 — tui seam.** `SessionController` (`App.tsx:252`):
`send(prompt, signal?, opts?: { skill?; attachments?: readonly AttachmentRef[] })`;
optional `attachImage?(bytes, meta: {mimeType; name?}, opts?: {signal?;
onProgress?(sent, size)}) : Promise<AttachmentRef>`; optional
`imageInput?(): { kind: "upload" | "laptop"; maxBytes: number } | { kind: "off"; reason: string }`
(structural copy, the TUI does not depend on `@tentacle/client`, like
`SessionEvent`). Absent `attachImage`/`imageInput` = off with reason
"this session does not take images".

**D6 — tui pure module `packages/tui/src/attach-draft.ts` (new, React-free).**
- `interface AttachDraft { chips: readonly AttachedImage[]; upload: null | { index; count; name; sent; size } }`; `EMPTY_DRAFT`.
- `routeDecision(draft, decision, mode) → { draft; insert?: string; notices: string[] }` —
  `text` → `insert` = the pasted text (unchanged behaviour); `refused` →
  notices = `refusalText` of each, nothing inserted; `attachments` with mode
  `off` → ONE notice = `mode.reason` (+ the refusals), nothing inserted, no
  chip; `attachments` otherwise → chips appended, refusals as notices.
- `removeLastChip(draft)` (Backspace on an EMPTY input with chips).
- `submitPlan({ text, draft, running, compacting, dockOpen, mode }) →`
  `{kind:"send"; text; images}` (chips present, idle; `text` may be `""` =
  image-only) · `{kind:"convert"; paths}` (no chips, `attachmentCandidateText(text)`
  is paths: the submit-time drop rule — become chips, SEND NOTHING) ·
  `{kind:"refuse"; notice}` (chips present and a turn runs / `/compact` runs /
  the dock targets a child: draft kept, text kept) · `{kind:"text"}` (today's
  path: no chips, not only paths). `mode off` with chips → refuse with the
  reason (chips can exist only if the mode changed after the paste: a reconnect).
- `uploadProgress(draft, index, count, image, sent, size) → AttachDraft`.
- `attachRowView(draft, width) → null | { kind: "chips"; items: string[]; more: number } | { kind: "upload"; text: string }` —
  ONE row at most: chips as `name size` (`formatBytes`), truncated to `width`
  with `+N`; during upload `uploading <name> <pct>% (i/n)`. `null` when empty.
- `imageRowText(ref) → string` = `[image: <name or mimeType>]` (owner's
  `[image: name]`; the sha prefix is for the model's summary, not the eye —
  decision 6). `attachRowRows(draft) = attachRowView(...) ? 1 : 0`.
- `attachErrorText(error) → string` — maps P4/P5 errors to one sentence
  (`ImagesUnavailableError`/`RangeError`/`InvalidAttachmentError` → message;
  `AttachmentRefused` `not_uploaded` → "<label> was not on the daemon any more
  — press Enter to upload it again"; abort → "upload cancelled"). Matching is by
  `name` / `code` / `data.reason`, never by message text.

**D7 — tui state + rows.** `UserItem` (`state.ts:23`) gains
`images?: readonly string[]` (row texts, precomputed by `imageRowText`).
`startTurn(state, text, now, images?)`; `user_message` folds `attachments` into
`images`. `resume.ts:51`: a user message with `attachments` → `images`
(content `""` included). `render-lines.ts:738`: user rows = text rows (none
when `text === ""`, P9) then one subtle line per image.
`transcriptToMarkdown` writes the same `[image: …]` lines (`/save`).

**D8 — tui `App` wiring (executes D6; logic stays in D6).**
- Props: `fileProbe = nodeFileProbe()`, `home = os.homedir()`,
  `localCwd = process.cwd()` (P15), injectable for tests.
- State: `draftRef`/`setDraft` (`AttachDraft`).
- Paste (the three main-input sites, P6): `attachmentCandidateText(clean,
  {home})` → `kind:"text"` inserts synchronously (prose never touches disk);
  `paths` → `decideAttachment(fileProbe, candidate, {existing: chip refs})` →
  `routeDecision` → insert/notices/chips. One in-flight decision at a time
  (a promise chain); an unmounted App ignores a late result.
- `/attach <path…>` in `handleCommand`: `parseAttachCommand(raw, {home})`;
  relative paths `resolve(localCwd, p)`; `decideAttachment(…, {explicit: true})`
  → `routeDecision`. `/attach` alone → usage line. Added to `SLASH_COMMANDS`
  ("attach an image (or drag its file into the terminal)").
- `submit` (`App.tsx:3178`): `submitPlan` first. `send` → `sendWithImages`:
  one `AbortController` (Esc aborts it), for each chip in order
  `await session.attachImage(bytes, {mimeType, name}, {signal, onProgress})`
  updating `uploadProgress`, then `run(text, {attachments: refs, images:
  rows})`; the draft is cleared when `run` is called, and `own` carries the
  chips (bytes included) so a pre-start refusal can put them back. Any upload
  error → `restoreInput(text, attachErrorText(e))` with the chips kept. `convert` → chips from `decideAttachment(…)`, input
  cleared, notice "attached N image(s) — type your message and press Enter".
- `run` (`App.tsx:2100-2141`): `sendOpts` carries `attachments`; `startTurn`
  gets `images`; `own` carries `images` + the chips.
- `streamTurn`'s pre-start refusal branch (`App.tsx:2009-2020`): the "own
  prompt never ran" test becomes `own.text !== "" || own.images.length > 0`
  (P10), and a new `refusedBeforeStart(error, streamed)` in `turn-feed.ts`
  (`!streamed && code === AttachmentRefused`) withdraws the bubble, restores
  text + chips, and shows `attachErrorText`.
- Render: inside the input `Box` (`App.tsx:4059-4075`), above `LineInput`, ONE
  `<Text>` row from `attachRowView` (colours/glyph only); `inputBoxRows =
  inputContentLines + 2 + attachRowRows(draft)` (P8), so the viewport shrinks
  by one and the frame height is unchanged.
- No raw terminal write anywhere (§7): progress and refusals are this row and
  `pushNotice`.

### Files (dependency order)

1. `packages/protocol/src/updates.ts` (`TurnStartSchema.attachments`) · `schema/protocol.json` (`bun run schema:export`) · `protocol/test/json-schema.test.ts` fixture row
2. `packages/daemon/src/hosted-session.ts` (`turn_start` emit, one line)
3. `packages/client/src/mapping.ts` (`user_message.attachments`) · `remote-session.ts` (`attachImage`, `imageInput`, `startForeign` + reset re-delivery carry refs)
4. `packages/cli/src/local-runtime.ts` (`PersistingController`: interface + 2 forwards, `send` opts type)
5. `packages/tui/src/attach-draft.ts` (new) · `turn-feed.ts` (`refusedBeforeStart`) · `state.ts` (`UserItem.images`, `startTurn`, `user_message`) · `resume.ts` · `render-lines.ts` (+ `transcriptToMarkdown` wherever it lives) · `commands.ts` (`/attach`) · `App.tsx` (seam types, props, paste ×3, `/attach`, `submit`, `run`, `streamTurn` branch, input row, `inputBoxRows`)
6. `CHANGELOG.md` (`Added`) · `TODO.md` (3b line → this doc)

No `PROTOCOL_VERSION` bump, no persisted-format change (refs already persist as
`media_message`, core), no new dependency.

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Paste of prose containing a path | text, inserted as today, no disk access | — | T8a |
| Paste of only image paths, images ON | chips, nothing inserted | Enter sends | T8b |
| Mix (PNG + HEIC / too large / duplicate / over 5) | PNG chip(s) + one notice per refusal (3a rule) | — | T1, T8c |
| Only paths, one a source file / missing | whole paste stays text (3a rule) | — | T1 |
| Images OFF (no vision, older daemon, in-process, `client` w/o laptop provider) | decision still computed; `attachments`/`refused` → ONE notice with the reason, nothing inserted, `attachImage` never called | — | T1, T8d |
| Unbracketed drop, then Enter | `convert`: chips, input cleared, notice; nothing sent | type the question, Enter | T8e |
| Unbracketed drop + typed question in the same input | text (path inside a sentence, owner Q3 (a)) | documented; `/attach` | — |
| Enter, chips, empty text | image-only prompt (`""` + refs) | turn runs | T8f |
| Enter with chips while a turn / `/compact` runs, or dock on a child | `refuse`: notice, text + chips kept, no enqueue | send after | T1, T8g |
| Upload fails (link lost, Esc abort, over cap, store full) | `restoreInput(text, attachErrorText)`, chips kept, no bubble | Enter retries (put idempotent) | T8h |
| Daemon refuses (`AttachmentRefused`: `not_uploaded` after a `serve` restart, `invalid_ref`, `images_off`) | `refusedBeforeStart`: bubble withdrawn, text + chips back, reason | Enter re-uploads | T8i |
| Image-only own prompt loses the slot | refused prompt (not a wake), chips back | — | T8i' |
| Drop mid-prompt | keyed re-send, same refs | one turn | 2b T7 |
| Fresh lazy session | `attachImage` opens first (memoized, shared with `send`) | — | T6 |
| Attach-only session | awaits `open()` | — | T6 |
| Two pastes racing | serialized; `existing` = current chips | — | T1, T8c |
| Unmount mid-decision / upload | late result ignored; upload aborted | — | T8h |
| Chip row added | counted in `inputBoxRows`; frame height constant | — | T8j |
| Another client's image prompt | `turn_start.attachments` → `[image: name]` rows (inert) | — | T5, T6, T8k |
| Older daemon / older client | field absent / stripped: text-only rows, no crash | — | T4 |
| `--resume` / reset / snapshot with images | rows from `messagesToItems`; bytes not on disk (sub-task 4) → model placeholder | sub-task 4 | T2 |
| Hostile pod ref names | schema forbids control chars; display text only, never opened | — | T2, T4 |
| Relative `/attach x.png` under `connect` | resolved against `localCwd`, never the URL | — | T8l |
| `/attach` missing file | explicit refusal shown, nothing inserted | — | T8l |
| `/retry` after an image prompt | text only + a notice saying so | decision 8 | T8m |
| Up-arrow history | text only | documented | — |

### Tests

Property: **a dropped/pasted/`/attach`ed image path in the real `App` becomes a
chip; Enter puts its exact bytes behind a ref through the session's own
`attachImage`, and the prompt names that ref; every refusal is a visible
sentence with nothing sent and nothing lost; other clients and resumed sessions
show `[image: name]`.** "The chip renders" alone is too weak — T8b/f assert
bytes and refs at the seam. Each test written first and shown RED on the base.

| # | File | Asserts | Red because |
|---|---|---|---|
| T1 | `tui/test/attach-draft.test.ts` (new, pure) | `routeDecision` per decision × mode; `submitPlan` table; `attachRowView` `+N` / `%`; `removeLastChip`; `imageRowText`; `attachErrorText` by code/reason/name | absent |
| T2 | `tui/test/resume.test.ts` | user msg with 2 refs → 2 image rows; image-only → item, no text | ignored |
| T3 | `tui/test/render-lines.test.ts` | text rows then `[image: a.png]`; image-only has no blank row (P9); `/save` markdown has the lines | not rendered |
| T4 | `protocol/test/attachment-prompt.test.ts` | `TurnStart` with/without `attachments`; bad ref and 6 refs rejected | stripped |
| T5 | `daemon/test/attachment-prompt.test.ts` | store prompt with refs → `turn_start.attachments` deep-equals refs; text prompt → none | no field |
| T6 | `client/test/remote-session-attach.test.ts` (new, real `RemoteClient` ↔ `Connection`) | lazy session: `attachImage` before any send → host `holds`; then `send("", {attachments})` → ONE `session/open` frame total; attach-only awaits `open()`; foreign image prompt → `user_message{attachments}`; reset re-delivery too | absent (*r2*) |
| T7 | `cli/test/` PersistingController test (extend) | `attachImage`/`imageInput` forwarded (spy); `send` passes `attachments` | *r5* |
| T8 | `tui/test/attach-app.test.tsx` (new; real `App`, ink-testing-library, paste helpers from `app.test.tsx`, fake `SessionController` + fake `FileProbe`/`home`/`localCwd`) | cases a–m of the failure table: a prose stays text, probe untouched; b paste PNG path → chip, `what?` Enter → `attachImage` got the exact bytes + `{image/png, shot.png}`, `send("what?", [ref])`, rows `what?` + `[image: shot.png]`; c PNG+HEIC; d off; e unbracketed → chip, no send; f image-only; g running → no enqueue, chip kept; h upload reject → text+chip back, plus held upload shows `uploading shot.png 50% (1/1)`; i `AttachmentRefused` → bubble gone, restored; i' image-only + `TurnInProgress` → restored, no wake; j frame line count equal with/without chip; k foreign `[image: x.png]`; l `/attach rel.png` → `<localCwd>/rel.png`, missing → sentence; m `/retry` notice | no wiring |
| T9 | `tui/test/attach-connect.e2e.test.tsx` (new; `connect-functest-stack.tsx`, `model.images: true`) | real PNG under the temp root; paste its path, `what?`, Enter → endpoint body `image_url` = `data:image/png;base64,<b64 of file>`; `session/log` holds a `media_message` | no wiring |

Mutations (each must turn the named tests red; revert after):
- `RemoteSession.attachImage` skips the open → T6
- `PersistingController` drops the `attachImage` forward → T7
- `run` drops `sendOpts.attachments` → T8b/f, T9
- `inputBoxRows` ignores `attachRowRows` → T8j
- daemon omits `turn_start.attachments` → T5, T6
- `resume.ts` ignores `attachments` → T2
- `submitPlan` enqueues with chips while running → T1, T8g
- `routeDecision` inserts text when off → T1, T8d
- `streamTurn` own-test left as `own.text !== ""` → T8i'
- `refusedBeforeStart` unwired → T8i

Gate: `bun run check` green; lint baseline clean (AGENTS §4, §6). Manual (to be
recorded in Execution, not claimed): a real drag in Terminal.app / iTerm2 /
Ghostty into `tentacle connect`.

#### Orchestrator decisions (owner night delegation 2026-11-12)

Each open question decided with the recommended option; one line of reason.

1. **Blast = load-bearing, not the umbrella's cross-module** → mandatory
   fresh-context Review. *Reason:* AGENTS §10 puts any wire field and the
   one-session-path seam outside `cross-module`.
2. **Upload at submit, not at paste.** *Reason:* no bytes leave the laptop for an
   image the user removes; the session need not exist until the user sends.
3. **The upload method lives on the session (`RemoteSession.attachImage`),
   not in `App` or the runtime.** *Reason:* only the session can await its own
   lazy open (*r2*); it reuses the one session path (§7).
4. **Other clients' rows via an optional `turn_start.attachments` field, not a
   new update kind.** *Reason:* fields are free (§7); a new display kind would
   duplicate the prompt and show `unsupported` on older clients.
5. **Submit-time drop rule converts to chips and sends nothing.** *Reason:* an
   Enter after an unbracketed drag is a "done dragging" key, not "ask about
   nothing"; the bracketed path lands in the same state.
6. **Rows show `[image: <name or mime>]`, no sha prefix.** *Reason:* the owner's
   `[image: name]`; the sha is for the model's summary (`compact.ts:37`).
7. **Chips with a running turn are refused, kept, not queued.** *Reason:*
   enqueue/steer are text-only (2b decision 9); dropping the images silently is
   forbidden.
8. **`/retry` re-sends text only, with a notice.** *Reason:* keeping 5×15 MB per
   last prompt for a rare key is not worth it; the notice keeps it honest.
9. **In-process fallback (`inProcessSessions`) stays image-less (off with a
   reason).** *Reason:* no daemon, no store; the RPC runtimes are the product.
10. **Images OFF still runs the decision so the user learns WHY, instead of the
    path silently becoming text.** *Reason:* core Q5 (a) "TUI refuses before
    uploading".
11. **One chip row inside the input box, counted in `inputBoxRows`.** *Reason:*
    a fixed, single-term height change; the frame stays constant (P8).
12. **Relative `/attach` paths resolve against the laptop process cwd
    (injected `localCwd`).** *Reason:* under `connect` the `cwd` prop is a URL
    (P15); the bytes are always the laptop's.
13. **Backspace on an empty input removes the last chip; no `/detach`.**
    *Reason:* smallest control; a named sub-command would collide with a file name.

**Implementation APPROVED** (owner night delegation, 2026-11-12).

## Execution

*— deepseek, 2026-11-13*

### Load-bearing check re-run (first thing, per the plan)

`.tentacle/tmp/attachments-tui/seams.ts` on the branch (before any edit):

```
1 imageInput: {"kind":"upload","maxBytes":1048576}
2 attach before first send: REJECTED unknown session: fa4e2ad1-… (not open on this connection)
3 attach after openSeeded: ok, held = true
4 SessionController.send opts: {skill} only
5 App mentions attachImage: false | PersistingController forwards attachImage: false
```

*r2* still REJECTED and *r5* still `false | false` → the plan's assumption holds,
proceed. `rg -n "createSession: \(\) =>" packages/cli/src` → `connect.ts:232`
(a `RemoteSession`, `track` returns it) and `local-runtime.ts:894` (a
`PersistingController`), plus `session-jobs.ts:133` (`inProcessSessions`, the
documented image-less fallback, decision 9). No third shape: no STOP needed.

After the work, the same script:

```
4 SessionController.send opts: changed
5 App mentions attachImage: true | PersistingController forwards attachImage: true
```

### As built, in the plan's order

1. **protocol (D1).** `TurnStartSchema.attachments` — `z.array(AttachmentRefSchema)
   .max(MAX_ATTACHMENTS_PER_MESSAGE).optional()` (`updates.ts:238-252`).
   `bun run schema:export` regenerated `schema/protocol.json` (one `TurnStart`
   property block, `maxItems: 5`); a fixture row added to
   `json-schema.test.ts:406-412`. No `UPDATE_CLASS` / `mapping.ts` change, no
   `PROTOCOL_VERSION` bump.
2. **daemon (D2).** `hosted-session.ts:2043-2051`: the one `turn_start` emit
   spreads `attachments: refs` only when non-empty.
3. **client (D3).** `RemoteSession.attachImage` / `imageInput`
   (`remote-session.ts:379-421`): the mode is read FIRST (off ⇒ zero frames,
   `ImagesUnavailableError`), then the session opens itself (`open()` for an
   attach-only session, else the memoized `createOrAttach()`), then
   `client.attachImage(own id, …)`. `SessionEvent.user_message` gained
   `attachments?` (`mapping.ts:29-41`); `startForeign` takes them and pushes
   the bubble when `prompt !== "" || refs.length > 0`; the reset re-delivery
   (`onUpdate`) does the same through a small `hasRefs` helper.
4. **cli (D4).** `PersistingController`: `send` opts type + `attachImage` /
   `imageInput` forwards to `inner` (`local-runtime.ts:211-235`, `:494-506`).
   Nothing is saved on the forward itself — a ref only becomes history at the
   prompt.
5. **tui.** New pure `attach-draft.ts` (D6, 318 lines: `routeDecision`,
   `withChips`, `removeLastChip`, `submitPlan`, `uploadProgress`/`uploadDone`,
   `attachRowView`/`attachRowRows`, `chipLabel`, `imageRowText`,
   `attachErrorText`, `looksLikeCommand`, `NO_IMAGE_SEAM`). `turn-feed.ts`
   gained `refusedBeforeStart` (code `-32016`, only before `streamed`).
   `state.ts`: `UserItem.images`, `startTurn(state, text, now, images?)`,
   `user_message` folds refs to rows. `resume.ts` maps a message's
   `attachments` to rows; `render-lines.ts` emits the text rows (none for an
   image-only prompt, P9) then one subtle row per image;
   `commands.ts` adds `/attach` to `SLASH_COMMANDS` and the image lines to
   `transcriptToMarkdown`. `App.tsx`: the two optional seam members,
   `fileProbe`/`home`/`localCwd` props, the draft (ref + state + one in-flight
   decision chain + an unmount generation), `routeAttach` / `attachCommand` /
   `convertToChips` / `sendWithImages` / `restoreChips`, the three paste sites,
   `submitPlan` in `submit`, `images`/`attachments`/`restoreChips` through
   `run` and `StreamOpts.own`, the refusal branch in `streamTurn`, the attach
   row inside the input box (a `flexDirection="column"` wrapper), `inputBoxRows
   + attachRowRows(...)`, Backspace-on-empty, Esc aborting an upload, and the
   `/retry` notice.
6. **CHANGELOG.md** `[Unreleased] ### Added` entry (first bullet). `TODO.md`
   untouched, as instructed.

### Drift from the Implementation (and why)

- **`looksLikeCommand` was not in the plan — it is a new pure rule in D6.** The
  plan's paste path took `attachmentCandidateText(text)` at face value. In the
  running App that broke two real behaviours: `/compact` alone parses as a
  *path* candidate (so a paste would stat `/compact`), and an absolute path
  (`/tmp/a.png`) would be read as a command and never attached. The rule now
  lives in `attach-draft.ts` (pure, tested): a slash text whose first word does
  not NAME an image is a command. Red-first shown by
  `slash-skills.test.tsx` "an unknown /name (or a path)…".
- **An image-only prompt is restored on a LOST SLOT too, not only on an
  `AttachmentRefused`.** The plan's D8 covers `refusedBeforeStart`; while
  mutation-checking the plan's own target ("`streamTurn` own-test left as
  `own.text !== ""` → T8i'") the sibling path (`lostSlot`, code `-32004`) was
  found to have the identical hole — an image-only prompt read as a wake. Both
  branches now test `text !== "" || images.length > 0`, and both restore the
  chips (`restoreChips`). T8i' pins the `lostSlot` case, T8i the refusal case.
- **The protocol/daemon/client/cli tests were written before their code where
  the plan named them (T4, T5, T6, T7); T1/T2/T3/T8 were written before their
  wiring but after `attach-draft.ts` existed** in the case of T1 (the module
  and its test were created together and the module was corrected until green).
  Every target of the plan's mutation list was then verified by mutation (§
  below) — which is the proof that each test holds on the property, not on the
  order the two were written in.
- **`connect-functest-stack.tsx` gained `Stack.cwd`** (one field) so T9 can
  find the daemon's store directory (`daemonStoreDir({configDir, cwd})`). No
  behaviour change to the harness.
- **`subagent-panel-controller.test.ts`'s guard list gained `attachImage` and
  `imageInput`.** That guard is exact on purpose; the two members are wired
  (D4), so they belong on the list.
- **`attachRowView` truncation** is "as many chips as fit, then `+N`"
  (first-fit with the marker's own width reserved), and it always shows at
  least one chip. The plan said "truncated to `width` with `+N`" without
  pinning the algorithm; T1 pins the properties (`more` counts the rest, a wide
  input shows all, one row).
- **The chip row paints `📎`** and a two-space indent — presentation, in the
  component, as AGENTS §7 requires; the text is `attach-draft.ts`'s.

### Tests (red before green, and where)

| # | File | Red shown as |
|---|---|---|
| T1 | `tui/test/attach-draft.test.ts` (new, 39 tests) | module absent (created with it, corrected until green); each failure-mode row of the plan's table is one case |
| T2 | `tui/test/resume.test.ts` (+4) | `user_message` had no `images` (3 failures) |
| T3 | `tui/test/render-lines.test.ts` (+5) | image rows not rendered |
| T4 | `protocol/test/attachment-prompt.test.ts` (+2) | "Expected 8, received 1": the field was stripped; the malformed ref parsed |
| T5 | `daemon/test/attachment-prompt.test.ts` (+2) | `turn_start` carried no `attachments` |
| T6 | `client/test/remote-session-attach.test.ts` (new, 7) | `session.attachImage is not a function` |
| T7 | `cli/test/clear-fork-controller.test.ts` (+1) | `attachImage` undefined on the controller |
| T8 | `tui/test/attach-app.test.tsx` (new, 19) | 12 of 19 red on the first run (no wiring) |
| T9 | `tui/test/attach-connect.e2e.test.tsx` (new) | passes only with the whole chain; mutation 3 turns it red |

`bun test` per slice (narrow first), then the full gate.

### Mutations (the plan's ten, each run by hand, reverted after)

| Mutation | Turned red |
|---|---|
| `RemoteSession.attachImage` skips the open | T6 ×4 (LAZY, image-only, attach-only, reset re-delivery) |
| `PersistingController` drops the `attachImage` forward (and `imageInput`) | T7 |
| `run` drops `sendOpts.attachments` | T8b, T8e, T8f, **T9** |
| `inputBoxRows` ignores `attachRowRows` | T8j |
| daemon omits `turn_start.attachments` | T5 ×2, plus 6 pre-existing attachment-prompt cases |
| `resume.ts` ignores `attachments` | T2 ×3 |
| `submitPlan` enqueues with chips while running (the refuse branch removed) | T8g, T1 ×2 |
| `routeDecision` inserts text when off (the `off` branch removed) | T8d, T1 ×2 |
| `streamTurn` own-test left as `own.text !== ""` | T8i' |
| `refusedBeforeStart` unwired (`else if (false)`) | T8i |

All ten hold: each named test fails on exactly the property the plan named, and
passes again on revert (`git diff` checked after every revert).

### Gate

```
bunx tsc --noEmit          → clean (the `bun run typecheck` pair, mobile included: clean)
bun run lint               → Clean — 951 files, no fixes applied (AGENTS §6 baseline: 0/0)
bun test                   → 7503 pass · 3 skip · 0 fail (7506 tests, 537 files)
                             the 3 skips are the opt-in ones (live-k8s, live-docker, slow keepalive)
```

`schema/protocol.json` regenerated (`bun run schema:export`); the drift gate
`json-schema.test.ts` passes.

### Not verified (stated, not claimed)

- **A real drag** in Terminal.app / iTerm2 / Ghostty into `tentacle connect` was
  not performed. What IS proved is the paste FORM each emulator sends
  (bracketed paste of a path — T8, T9, both in the real App, T9 over the real
  `serve`+`connect` socket) and the decoder for the escaped/quoted/`file://`
  forms (3a's suites). The manual check remains for the owner.
- **A pod `run`/`attach` TUI with real k8s/docker**: not run here (the two
  opt-in live suites stay skipped). The seam it depends on is the same
  `PersistingController` forward pinned by T7.

## Review

*(empty — mandatory fresh-context Review, AGENTS §10)*
