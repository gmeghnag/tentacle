# feat/attachments-tui-detect — drag/paste a path → an image candidate; sniff, caps, refusals

> **Status:** execution (awaiting Review)
> **Branch:** `feat/attachments-tui-detect`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** DeepSeek (executor) + standard in-context Review

<!--
Sub-task 3a of docs/feat/attachments.md (§Split row 3a). Pure modules only: the
wiring into `App` is 3b, so this task touches NO existing component.
-->

## Context

*— claude-opus-5-5, 2026-11-12*

The owner's goal (`docs/feat/attachments.md` §Promotion) is "drag a photo into
the laptop terminal and send it". Sub-task 1 (merged, `3c27bfd` → `b68cc5f` on
`feat/attachments-core`) built the wire: refs, `AttachmentSource`, provider
images, `checkAttachmentRefs`. **Nothing in the TUI can produce a ref yet.**

A terminal gives a TUI no drop event and no MIME type. What arrives is *text*:
the drag forms macOS/iTerm2/Ghostty/kitty emit (`/a/My\ Shot.png`,
`'/a/My Shot.png'`, `file:///a/My%20Shot.png`, `~/Pictures/x.png`), possibly
several at once, possibly inside a sentence the user is still typing. So 3a is
the pure layer that answers three separate questions, none of which can be
answered by looking at an extension:

1. **Which parts of this text are paths at all** — and is the whole text only
   paths (owner Q3 (a): "a paste made only of image paths becomes attachments …
   a path inside a sentence stays text")?
2. **Is it an image, and of which type** — from the bytes (magic numbers), since
   a `.png` may be a HEIC and a dropped screenshot may have no extension.
3. **May it be sent** — 15 MB per image (`MAX_IMAGE_BYTES`, owner override), and
   the per-message count cap, both **reused** from sub-task 1's constants, not
   re-declared, so the entry point and the wire can never disagree.

Constraints from the umbrella and the owner answers, all binding here:
15 MB per image, **no downscale/resize** (that is sub-task 6); input is
paste/drag of paths plus `/attach <path>`; HEIC/HEIF is **recognised and
refused with a clear text** (not "not an image"); every refusal is a sentence a
person can act on. Tests must be pure — file-system access goes through an
injected seam (`AttachmentSource`'s shape, `core/src/model.ts:158-160`).

### Repro

On the branch base `3c27bfd` (`2026-11-12`), from
`.tentacle/tmp/attachments-tui-detect/`:

```ts
import { sanitizeInsert } from "../../../packages/tui/src/paste.ts";
const dropped = "/Users/me/Desktop/Shot\\ 1.png"; // what Terminal.app sends on drop
console.log("dragged-into-input:", JSON.stringify(sanitizeInsert(dropped)));
for (const mod of ["./attachments.ts", "./image-sniff.ts", "./attach-candidates.ts"]) {
  try { await import(new URL(mod, import.meta.url).href); console.log(mod, "loaded"); }
  catch (error) { console.log(mod, "MISSING:", (error as Error).message.split("\n")[0]); }
}
```

Output:

```
dragged-into-input: "/Users/me/Desktop/Shot\\ 1.png"
./attachments.ts MISSING: Cannot find module '…/attachments.ts' imported from …/repro.ts
./image-sniff.ts MISSING: Cannot find module '…/image-sniff.ts' imported from …/repro.ts
./attach-candidates.ts MISSING: Cannot find module '…/attach-candidates.ts' imported from …/repro.ts
```

`grep -rln "MAX_IMAGE_BYTES\|attachment" packages/tui/src/` → `App.tsx` only,
and its single hit (`:3127`) is a prose comment. **The capability is missing**,
and a dropped path lands in the prompt as literal text with its backslashes.

## Implementation

*— claude-opus-5-5, 2026-11-12*

### Load-bearing assumption

**A drag-and-drop into the terminal reaches the TUI only as text, and the MIME
type must therefore come from the bytes.** Verified: the input path sanitises a
paste chunk and inserts it verbatim (`packages/tui/src/paste.ts:44-59`;
`sanitizeInsert` keeps the backslash — repro above), and no module under
`packages/tui/src/` reads the file system or any drop event
(`grep -rn "node:fs" packages/tui/src/` → no hits). If a terminal ever hands us
a real file event, that is a *new* input, not a change to this layer.

### Preconditions

- Ref/type/size truth is the protocol's: `ATTACHMENT_ID_RE`
  (`protocol/src/attachment.ts:18`), `IMAGE_MIME_TYPES` (`:25`),
  `MAX_ATTACHMENTS_PER_MESSAGE = 5` (`:29`), `MAX_IMAGE_BYTES = 15 MiB` (`:37`),
  `isKnownImageType` (`:73`), `AttachmentRefSchema.name` forbids control
  characters (`:51-59`) — so a sniffed name must be sanitised, never passed
  through raw.
- Entry-point checks and readable sizes already exist:
  `checkAttachmentRefs` (`core/src/attachments.ts:45`), `InvalidAttachmentError`
  (`:28`), `formatBytes` (`:73`), `attachmentLabel` (`:102`), all re-exported
  from `@tentacle/core` (`core/src/index.ts:9`). This task reuses them; it
  duplicates no cap.
- AGENTS §7 "logic lives in pure modules": a `.ts` module, React-free, no
  `node:fs` import, unit-tested — `paste.ts`, `editor.ts` are the pattern.
- `@tentacle/tui` already depends on `@tentacle/core` + `@tentacle/protocol`
  (via core) — `packages/tui/package.json` dependencies.

### Design

Four new files, no existing file edited (wiring is 3b).

**1. `packages/tui/src/image-sniff.ts` — bytes → a type or a refusal.**
`sniffImageType(bytes) → { kind: "image", mimeType: ImageMimeType } |
{ kind: "refused", reason } | { kind: "not-image" }`, from magic numbers only:
PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `47 49 46 38`,
WebP `RIFF….WEBP`, HEIC/HEIF `ftyp` brand in
`{heic,heix,hevc,hevx,heim,heis,hevm,hevs,mif1,msf1}`. A file whose bytes are
fewer than the signature needs is `not-image` (never a guess). The extension is
never consulted — the media type comes from the bytes.

**2. `packages/tui/src/attach-candidates.ts` — text → path candidates (pure).**
`splitPathTokens(text)` splits on newlines and on unquoted whitespace while
honouring `\ `-escaped spaces, `'…'`/`"…"` quoting, and leaving `file://` URLs
one token; `decodePathToken(token)` returns `{ path }` for a local path — a
`file://` URL percent-decoded (`fileURLToPath`), `~`/`~/…` expanded against an
injected `home`, and everything else returned as written. `attachmentCandidateText(text)`
is the pure decision the components call: `{ kind: "text" }` unless **every**
token decodes to a path (owner Q3 (a) — a path inside a sentence stays text),
`{ kind: "paths", paths }` otherwise, `{ kind: "text" }` for empty input.
`/attach <path…>` goes through the same decoder (`parseAttachCommand`).

**3. `packages/tui/src/attach-files.ts` — the I/O edge, behind a seam.**
`interface FileProbe { stat(path): Promise<{ kind: "file"|"directory"|"other", size } | null>; read(path): Promise<Uint8Array> }`
(`null` = does not exist / not statable). `inspectPath(probe, path, opts)` reads
only the first bytes it needs (44) for the sniff, then the whole file only when
it is an image within the cap, and resolves one of: `{ok: true, ref, bytes}`
(ref = sha256 of the bytes, `size`, `name` = sanitised basename), or
`{ok: false, refusal}` with a user-facing sentence. `nodeFileProbe()` is the one
place that touches `node:fs`; tests pass a fake. Caps: size `>` `MAX_IMAGE_BYTES`
→ refuse naming the image, its size and the limit (`formatBytes`);
`MAX_ATTACHMENTS_PER_MESSAGE` enforced by `collectAttachments`
(which stops at the cap with a refusal naming it, dropping nothing silently).

**4. `packages/tui/src/attach-refusal.ts` — the texts, in one place.**
`refusalText(refusal)` and the refusal union: `not-found`, `directory`,
`unreadable`, `empty`, `too-large`, `heic`, `not-image`, `too-many`. Each is one
sentence naming the subject and the remedy (e.g. "HEIC/HEIF images are not
supported yet — export it as PNG or JPEG (`sips -s format png`)").

**Not in this task** (3b, deliberately): the chip in the input view, `/attach`
routing, upload progress, `[image: name]` rows, and the daemon-side capability
check.

### Files

New, in dependency order (each is a leaf; the last two import the earlier ones):

1. `packages/tui/src/image-sniff.ts`
2. `packages/tui/src/attach-candidates.ts`
3. `packages/tui/src/attach-refusal.ts`
4. `packages/tui/src/attach-files.ts`

Tests: `packages/tui/test/image-sniff.test.ts`,
`attach-candidates.test.ts`, `attach-files.test.ts`.
Also: `CHANGELOG.md` (one `Added` bullet), and — because the modules are meant
for use by 3b — **no** `packages/tui/src/index.ts` export yet (3b adds them
when it wires them; exporting unused API is dead surface).

### Failure modes

| Case | Convergence |
|---|---|
| Nonexistent path | `not-found` refusal naming the path; nothing attached |
| Directory (a dropped folder) | `directory` refusal, names it; nothing read |
| Unreadable (permissions) | `unreadable` refusal from the `read` rejection, named |
| Empty file (0 bytes) | `empty` refusal — never `not-image`, which reads as "wrong file type" |
| Over 15 MB | `too-large`, naming the image, `formatBytes(size)` and the limit |
| HEIC/HEIF | `heic` refusal with the convert remedy — recognised, not "not an image" |
| Not an image (PDF, `.txt`, a renamed `.png`) | `not-image`, naming the sniffed-absence, never the extension |
| More than 5 candidates | `too-many` at the 6th, naming the cap; the first 5 stay |
| Text that is not only paths | `{kind:"text"}` — the sentence is never mangled into attachments |
| Path with spaces / quotes / unicode / `%20` | one candidate, decoded exactly once (no double-decode of a literal `%2520`) |
| A path whose read throws mid-way | refusal, no partial ref, `bytes` absent |
| Duplicate candidate (same path twice, or same bytes) | second is a duplicate: the sha256 is already collected → refused as "attached twice" by `checkAttachmentRefs` in `collectAttachments` |

### Tests

Red before green: the three test files fail to import on the base (no modules —
repro above), and each pins one property:

- **`image-sniff.test.ts`** — each signature sniffs to its type; a truncated
  signature is `not-image`; WebP requires `WEBP` at offset 8 (a `RIFF….WAVE`
  file is `not-image`); every HEIC brand is `heic`; **`bytes` decide, not the
  name** (a PNG's bytes named `x.heic` are `image/png`; a HEIC's bytes named
  `x.png` are `heic`).
- **`attach-candidates.test.ts`** — the five drag forms (`\ `-escaped, single
  and double quotes, `file://` with `%20`, `~`), several paths in one paste
  (newline- and space-separated), a sentence containing a path stays text, an
  empty/whitespace paste stays text, unicode and a literal `%25` decode once,
  `/attach` with no argument is not a command.
- **`attach-files.test.ts`** (fake `FileProbe`) — the happy path builds a ref
  whose id is the sha256 of the fake bytes and whose name is the basename; every
  refusal above; the cap boundary (exactly 15 MB passes, 15 MB + 1 fails); the
  6th candidate refused by `collectAttachments`; a `read` rejection is
  `unreadable`; `checkAttachmentRefs` accepts everything `collectAttachments`
  produced (the two caps agree).

Mutation checks (§9 non-vacuity), 3 targets: (1) make `sniffImageType` trust the
extension → the "bytes decide" tests must fail; (2) change `>` to `>=` in the
size cap → the 15 MB boundary test must fail; (3) make
`attachmentCandidateText` accept *any* existing path inside a sentence → the
"sentence stays text" test must fail.

## Execution

*— claude-opus-5-5, 2026-11-12*

**Repro first (as the brief requires).** Re-ran Context's repro on this branch's
base `3c27bfd`: a dropped `/Users/me/Desktop/Shot\ 1.png` reaches the prompt as
literal text with its backslashes, all three modules are absent, and
`grep -rln "MAX_IMAGE_BYTES\|attachment" packages/tui/src/` hits only an
unrelated prose comment in `App.tsx:3127`. Capability missing, as the Context
says — no STOP needed.

**As-built, in the plan's order.** Four new modules, no existing file edited
except `CHANGELOG.md`:

1. `packages/tui/src/image-sniff.ts` — `IMAGE_HEAD_BYTES = 12`,
   `HEIF_BRANDS`, `SniffResult`, `sniffImageType`. Signatures from the bytes
   only; the extension is never consulted.
2. `packages/tui/src/attach-candidates.ts` — `tokenizePaths`,
   `decodePathToken`, `attachmentCandidateText`, `parseAttachCommand`.
3. `packages/tui/src/attach-refusal.ts` — the `AttachRefusal` union and
   `refusalText`.
4. `packages/tui/src/attach-files.ts` — `FileProbe`/`ProbedStat`, `inspectPath`,
   `collectAttachments`, `refsOf`, `refusalLines`, `refName`, `sha256Hex`,
   `baseName`, and `nodeFileProbe()` as the only `node:fs` site.

Tests: `packages/tui/test/{image-sniff,attach-candidates,attach-files}.test.ts`
(68 tests), plus one `Added` bullet in `CHANGELOG.md`.

**Drift from the Implementation, with the reason:**

- **`@tentacle/protocol` is not a dependency of `@tentacle/tui`.** The plan's
  Preconditions said the caps come "from the protocol through core", and
  `@tentacle/tui` depends on `@tentacle/core` only (`packages/tui/package.json`;
  `send-now.ts:8` even notes "the TUI does not depend on it"). `attach-refusal.ts`
  imports `MAX_IMAGE_BYTES`/`MAX_ATTACHMENTS_PER_MESSAGE` from `@tentacle/core`,
  which re-exports both (`core/src/attachments.ts:20-25`) — still one constant,
  no duplicate, and no new package dependency (which would have been a real
  change to the build graph for a leaf module).
- **`SniffResult` is `{kind:"heic", brand}`**, not `{kind:"refused", reason}`
  as the plan sketched: the only refused flavour is HEIC/HEIF (sub-task 6
  converts it), and `attach-files.ts` maps it to the `heic` refusal. A general
  `refused` variant would have been a placeholder for a case that does not
  exist yet.
- **Two refusals the plan's table did not list**, both found while writing the
  failure-mode tests: `not-file` (a fifo/device/socket — reading one can BLOCK
  FOREVER, so it is refused by `stat` kind before any read) and `duplicate`
  (the same bytes twice — the wire refuses a repeated id, and catching it here
  gives a sentence instead of a thrown `InvalidAttachmentError`).
- **The clash check runs before the count check** in `collectAttachments`, and
  both are decided per candidate: the 6th image is refused while the first 5
  stay (the plan's "keeps the ones that pass" — but the order matters to which
  test pins which line).
- **`percentDecode` decodes an escape RUN, not each escape.** First red run
  showed `%C3%9C` staying `%C3%9C`: decoding 2-char escapes individually cannot
  produce a multi-byte character. Non-ASCII names are the common case on macOS
  screenshots, so the run-based form is the correct one, and the test
  "unicode survives both forms" is what caught it.
- **Inside `"…"` only `\"` and `\\` are escapes.** Shell fidelity would strip
  the separators of a Windows drag form (`"C:\Users\me\x.png"` → `C:Usersmex.png`).
  Pinned by its own test.
- **No `packages/tui/src/index.ts` export**, as the plan says: 3b adds them
  when it wires them.

**Gate (the task's own acceptance checks + AGENTS §4), on the final tree:**

- `bunx tsc --noEmit` → clean.
- `bun run lint` → `Checked 926 files. No fixes applied.` (matches the §6 clean
  baseline; the first run had 6 formatting/import errors in my own new files,
  fixed with `biome check --write`, no rule disabled).
- `bun run typecheck` → clean, **including** `tsc -p apps/mobile`, so the mobile
  deps were present in this worktree.
- `bun test` → **7230 pass, 0 fail, 3 skip** (the three opt-in skips: live-k8s,
  live-docker, real-socket keepalive — per §6, not failures). Base was 7228; my
  68 new tests account for the difference (+2 more added during review of the
  quote edge case).

**Red before green (§9).** With the four modules moved aside, the three test
files fail on the missing import (3 errors, 0 pass) — and the imports are the
*only* reason they fail, so to prove the assertions are not vacuous, 3 mutations
were run on the final code, each reverted:

| # | Mutation | Result |
|---|---|---|
| M1 | `sniffImageType` ignores its bytes and always answers `image/png` | **15 fail** (of 38 across the two files) — e.g. `text, PDF and an empty file are not images`, every HEIF brand, `WebP is RIFF + size + WEBP` |
| M2 | size cap `>` → `>=` | **1 fail**: `the size cap (MAX_IMAGE_BYTES = 15 MB…) > exactly at the cap passes` |
| M3 | `attachmentCandidateText` accepts non-path tokens when at least one token is a path | **2 fail**: `a path inside a sentence stays TEXT`, `prose with no path at all stays text` |

M3's expected target (the sentence case) did fail, and it also caught the
prose-only case — the rule is the same one, so both are the property, not a
weaker correlate.

**One thing not verified (stated per §5).** `nodeFileProbe()` is exercised
against a real temporary file (stat/read/`inspectPath` on `/…/Shot 1.png`,
removed after) but NOT against a real macOS Terminal.app drop, a `chflags`
unreadable file, or a fifo — those forms come from the documented behaviour of
the terminals and from `stat`'s kind, and 3b is where a real drop is seen end to
end. Verify by dragging a file into the TUI once 3b is wired.

## Review

*— claude-opus-5-5, 2026-11-12* (fresh context. Different model from the
DeepSeek executor, but the Context/Implementation were written by the same
model family as this reviewer.)

**Verdict: REQUEST-CHANGES.** There are 4 MEDIUM findings and no HIGH. Each is a
cheap fix, but each would reach 3b as a wire throw or a wrong state.

**Gate (as the reviewer was asked to run it):** the 3 task test files give
`68 pass, 0 fail, 159 expect()`. `bun run lint` gives `Checked 926 files … No
fixes applied.` The full `bun test`/`typecheck` was not re-run, because this
review was scoped to these 3 files + lint. The Execution reports 7230/0/3.

### Findings

1. **MEDIUM: `refName` strips only C0 + DEL, but the wire refuses all of
   `\p{Cc}`** (`attach-files.ts:68` vs `protocol/src/attachment.ts:59`).
   Scenario: a file named `x\u0085y.png` (NEL, or a C1 `\u009b` CSI) passes
   `collectAttachments` with `name: "x\u0085y.png"`, and then
   `checkAttachmentRefs` throws `a name carries no control character`. The
   throw refuses the WHOLE message, not just that image. This is the
   "entry point and wire disagree" case the Context says is designed out. Fix:
   strip `/\p{Cc}/gu`, and test with a C1 name through `checkAttachmentRefs`.
   Repro output: `C1 images: 1 … wire THROWS: invalid image references: a name
   carries no control character`.
2. **MEDIUM: the type comes from one read and the bytes from another**
   (`attach-files.ts:112` head read, `:128` full read: two separate `open`s).
   If the file changes between the reads (an editor or screenshot tool
   rewriting it, a swap), the ref carries `image/png` over bytes that are not
   a PNG. A fake probe that returns PNG first and `%PDF…` second gives `ok:
   true, mimeType image/png, bytes "%PDF-1.7"`, so "the media type comes from
   the bytes" does not hold for the bytes that are actually sent. Related
   problems on the same edge:
   - `nodeFileProbe.read` (`:223`) is a single `handle.read`, and its result
     is never compared to `stat.size`, so a short read (network/FUSE mount)
     yields a truncated image with a valid hash.
   - The stat→open gap lets a path become a fifo after `stat`, and `open`
     then blocks.

   Fix: sniff the FULL buffer, loop the read to EOF or the cap, compare it
   with the size, and ideally `fstat` the open handle (`O_NONBLOCK`) instead
   of a path `stat`.
3. **MEDIUM: the cap and the duplicate check are per call, but 3b's chips
   accumulate across pastes** (`attach-files.ts:177-201`).
   `collectAttachments` takes no already-attached refs. Dropping 3 images and
   then 3 more yields 6 `ok` images, and `checkAttachmentRefs` then throws
   `Array must contain at most 5 element(s)`. The same holds for the same
   image dropped twice across two pastes. Also, `too-many` reports `count:
   images.length + 1`, so 8 given ⇒ three identical refusals of "(6 were
   given)" (`:191`). Fix: take `existing: readonly AttachmentRef[]` (or a
   count + id set), and emit one `too-many` with the real total.
4. **MEDIUM: "only image paths" is not what `attachmentCandidateText`
   decides, and the fallback to text is unspecified**
   (`attach-candidates.ts:169,188-205`). The owner's rule (core doc Q3 (a)) is
   "only **image** paths → chips; same **at submit**". But `"/help"`,
   `"/clear"`, `"/etc/hosts"` and a dragged `"/Users/me/Desktop/main.ts "` all
   classify as `{kind:"paths"}` (repro), and a non-image or missing path then
   becomes a `not-image`/`not-found` *refusal*. So at submit a slash command is
   a path candidate. Dragging a source file to put its path in the prompt (the
   most common terminal drag) would be refused with "not a PNG, JPEG…" instead
   of staying text. The 3a API/tests leave 3b with no pinned rule for which
   refusals mean "this was text, insert it" (not-found / not-image / directory
   / not-file) and which mean "an image that failed" (too-large / heic /
   unreadable / empty). That is exactly where a path gets silently dropped.
   Fix: give `collectAttachments` a per-candidate disposition (or a pure
   `keepsAsText(refusal)`), and test a mixed paste (1 PNG + 1 `.ts`) and a
   slash command.

### Mutations (§9), each reverted; tree clean after (`git status` empty, 68/0)

| Mutation | Result |
|---|---|
| `isWebp` drops the `WEBP` check | 1 fail: `RIFF container that is not WEBP (WAVE)` |
| `collectAttachments` duplicate check disabled | 1 fail: `the same file twice is refused as a duplicate` |
| `inspectPath` `kind === "other"` branch disabled | 1 fail: `a fifo/device is refused by kind, never read` |

The executor's M1–M3 (sniff, `>`→`>=`, sentence rule) were not repeated. The
mutations above cover different properties, and all were non-vacuous.

### Attacks tried

- **Drag forms.** Terminal.app `\ `, iTerm2/Ghostty quotes (incl. `'it'\''s'`
  concatenation), kitty/VS Code `file://` + `%C3%9C`/`%2520`, the trailing space
  Terminal.app appends, `\r\n` lists. All handled by `tokenizePaths`; nothing
  found.
- **Prose wrongly turned into an attachment.** A sentence with a path, an
  unclosed quote, a bare word: stays text. But see finding 4 (slash commands,
  non-image paths).
- **Sniff gaps.** PNG/JPEG/GIF/WebP/HEIF brands are correct, and too few bytes
  ⇒ not-image. AVIF with major brand `mif1` reads as "HEIC" (wording only, not
  reported).
- **TOCTOU / fifo:** finding 2. **Caps vs wire:** the constants are shared (no
  duplicate), but they are enforced per call (finding 3) and the name rule
  differs (finding 1).
- **API for 3b:** findings 3 and 4.

### What holds

The modules are pure, and only `nodeFileProbe` touches `node:fs` (§7). The
caps are the protocol's own constants via core. Refusals are complete
sentences, and no half-built ref is returned on any refusal path. HEIC is
recognised and refused, not reported as "not an image". The tokenizer is
careful (Windows `"C:\…"`, run-based percent decoding).

**How the executor behaved:** disciplined. It ran a repro first, recorded its
drift honestly (dependency on `@tentacle/core`, not `@tentacle/protocol`; the
`not-file`/`duplicate` refusals it added; the percent-decoding fix found by a
red test), and its mutation table reproduces. One inaccuracy: Execution says
"the clash check runs before the count check", but the code checks the count
first (`attach-files.ts:190` vs `:194`).

### Fix round 1

*— claude-sonnet-5-5, 2026-11-12*

**State inherited.** The previous round was cut by an ECONNRESET mid-way; its
partial edits were committed as `7c386ad` (`wip … PARTIAL`). It had rewritten
the `FileProbe` seam (one `read` call instead of `stat`+`read`), added
`ATTACHMENT_NAME_RE` + `sanitizeAttachmentName` to protocol/core, wired
`refName` to it, dropped `not-file` refusal handling onto the handle's kind and
added `refusalMeansText` to `attach-refusal.ts`. **The tests were still on the
old API and the new code was not type-clean**: 22 of the file's tests failed
(`probe.stat is not a function`, `ProbedStat` gone), `O_RDONLY`/`O_NONBLOCK`
were used without importing `node:fs`'s `constants`, and `sniffImageType` read
`file.bytes` for a directory handle (which the partial seam collapsed into
`not-file`, losing the `directory` refusal). So this round **finished** the
seam and then closed the 4 findings.

**M1 — `refName` sanitises with the wire's own rule (FIXED).**
`protocol/src/attachment.ts:46` now exports `ATTACHMENT_NAME_RE = /^[^\p{Cc}]*$/u`
and the schema at `:69` uses it (one regex, one rule).
`core/src/attachments.ts:53 sanitizeAttachmentName` applies it per code point
(`[...raw]`, so a capped name never ends in half a surrogate pair), caps at the
wire's 255 and returns `undefined` when nothing usable is left; `core` re-exports
the regex so an entry point needs one import. `attach-files.ts:84 refName` is now
a one-line delegation — the C0+DEL filter is gone. Tests:
`helpers > M1: a C1 control character (NEL) is dropped by the WIRE's own rule`
(`x\u0085y.png` → `xy.png`, `x\u009by.png` → `xy.png`, a name that is only a
control char → `undefined`) and `the entry point and the wire agree (M1) > a C1
name never reaches Session.send` — `collectAttachments` on a `x\u0085y.png`
produces a ref it feeds to `checkAttachmentRefs`, which no longer throws.

**M2 — one open, one buffer, whole-file read (FIXED).**
`FileProbe` is now ONE call (`read(path, cap) → {kind, size, bytes} | null`), so
the type and the bytes cannot come from different reads by construction
(`attach-files.ts:47`). `inspectPath` opens once and sniffs **that** buffer
(`:170`); `size` and `id` are the buffer's own length and sha256 (`:177`), never
`stat.size`, so a short read or a file that grew is described honestly.
`nodeFileProbe` (`:395`) opens with `constants.O_RDONLY | constants.O_NONBLOCK`
**once**, `fstat`s the handle (`handle.stat()`), and refuses a non-regular file on
the handle before reading (`:412`) — a fifo cannot block the render thread.
`readToEof` (`:434`) loops `handle.read` until EOF **or** the cap, so a short read
is never taken for a whole file, and the cap passed by `inspectPath` is
`MAX_IMAGE_BYTES + 1`, so an over-cap file is caught, not buffered. Tests:
`inspectPath — one read, one buffer (M2)`: ONE open per candidate, a swapped file
never becomes a PNG ref, a short read yields the bytes it got (ref size 64 despite
a claimed 5000), a growth past the cap is `too-large`; and `nodeFileProbe`: a
real FIFO returns `{kind:"other"}` instead of hanging (`mkfifo` + the call
returning), plus the directory case now yields `{kind:"directory"}`.

**M3 — caps and duplicates across calls (FIXED).**
`collectAttachments` takes `options.existing: readonly AttachmentRef[]` (what 3b's
chips hold, `attach-files.ts:170`), counts its length toward
`MAX_ATTACHMENTS_PER_MESSAGE` and seeds the id set from it. Two bugs in the
partial code were found by the new tests and fixed: a **duplicate was reported as
`too-many`** (`ids.has` shared one branch with the count check) — now its own
`duplicate` refusal that does not consume a slot (`:222`); and the per-file
`too-many` spam is now **ONE** refusal `{count, dropped}` for the whole paste
(`:240`), with over-cap candidates recorded as an `over-cap` outcome instead of a
refusal. Tests: `the cap holds across paste for the WHOLE message` (3 + 3 → 2
attach, composed with the first paste it passes `checkAttachmentRefs`), `8
candidates give ONE refusal, not three identical ones` (count 8, dropped 3), `the
same image dropped in a SECOND paste is a duplicate`.

**M4 — the paste decision is image-bytes-only, and typed for 3b (FIXED).**
`attach-files.ts:249 AttachmentDecision = {kind:"attachments", refs, images,
refusals} | {kind:"text", refusals}`; `attachPaths` (`:270`) is the rule and
`decideAttachment` (`:315`) takes `attachmentCandidateText`'s result directly, so
a `{kind:"text"}` candidate never touches the disk (tested: zero probe calls).
The rule: if **any** candidate's refusal means "never an image" (missing,
directory, special file, non-image bytes — via `refusalMeansText`,
`attach-refusal.ts:79`) the WHOLE paste stays text with **no** refusal shown, so
`/help`, `/clear`, a dragged `main.ts` and a mixed PNG+`.ts` paste are inserted as
plain text (`attachPaths` returns `text, refusals: []`). A candidate that IS an
image by its bytes never collapses the paste: its failure (`heic`, `too-large`,
`duplicate`, `too-many`) is a refusal shown beside the images that passed — so a
pasted `shot.png` + `IMG.HEIC` attaches the PNG **and** explains the HEIC, never
silently dropping it. `{explicit: true}` (`/attach <path…>`) shows every failure,
including `not-found` and `not-image`. Tests: `attachPaths — the paste rule (M4)`
(only-images → attachments; mixed → text with no refusal; a `.ts` alone → text,
never "not a PNG"); `refusals for files that ARE images by their bytes (M4)`
(HEIC, over-cap, unreadable/empty image vs non-image, duplicate, `too-many`);
`decideAttachment (M4)` (text candidate reads nothing; `/attach` refuses a
missing path and a non-image).

**Drive-by fix, M2/M4 adjacent.** `ProbedFile.kind` regained `directory` (the
partial seam folded a directory into `other`, so `inspectPath` answered `not-file`
for a folder); `nodeFileProbe` maps `EISDIR`/`isDirectory()` to it.

**Mutations (§9, each reverted; script
`.tentacle/tmp/attachments-tui-detect/mut-r1-followup.sh`, tree restored).**

| # | Mutation | Result |
|---|---|---|
| M2a | the sniff reads bytes OTHER than the carried buffer | **8 fail**, incl. `a file that changed under us is never a PNG ref over non-PNG bytes` |
| M2b | the ref/size come from a 12-byte head | **8 fail**, incl. `a short read … never a hole` and both cap tests |
| M4a | `not-image` means "show a refusal" | **2 fail**: the mixed paste and the dragged `.ts` |
| M4b | image failures (`heic`/`too-large`/…) mean text | **5 fail**, incl. `one good PNG + one HEIC … no silent drop` |
| M4c | the "any non-image ⇒ all text" rule removed | **1 fail**: the mixed paste (the `.ts` is dropped) |
| M1 | names filtered by C0+DEL only | **2 fail**: both M1 tests |
| M3a | `existing` not counted toward the cap | **2 fail**: the cross-paste cap test |
| M3b | one `too-many` per dropped file | **4 fail**: incl. `8 candidates give ONE refusal` |
| M3c | duplicates not recognised | **3 fail**: incl. the second-paste duplicate |

**Gate (`bunx tsc --noEmit`, `bun run lint`, `bun test`), final tree:**
`tsc --noEmit` clean; `biome check .` → `Checked 926 files … No fixes applied.`
(§6 clean baseline; the first pass had 4 formatting errors in my own test file,
fixed with `biome check --write`); `bun test` → **7257 pass, 3 skip, 0 fail**
(the three opt-in skips of §6). The task's 3 files: **94 pass, 0 fail** (the
attach-files file alone is 54).

**Unverified (per §5).** One full-suite run had a single failure in
`packages/tui/test/connect-model-error.test.tsx` (a 2023 ms timing test that
imports none of these modules); it passes alone (3/3, twice) and in the final
full run. Treated as a timing flake, not caused by this change — worth watching if
it recurs. A real Terminal.app drop, a `chflags`-unreadable file and a real HEIC
from Photos are still only covered by fakes plus one real FIFO/tmp file; 3b is
where a real drop is seen end to end.

### Round 2

*— claude-opus-5-5, 2026-11-12* (same fresh reviewer context; diff `7a3d096..HEAD`)

**Verdict: REQUEST-CHANGES**: one new MEDIUM, in the typed result 3b consumes.
Findings 1–4 are fixed.

**Gate.** The 3 task files + `packages/core` + `packages/protocol` give `543
pass, 0 fail`. `bun run lint` is clean (926 files). `bun run typecheck` was not
run here (the command needed a permission approval that was not given), so the
reviewer did not verify it. Tree clean after the mutations.

**Round-1 findings, re-checked with the round-1 repros (`r2.ts`), on real files where they matter:**

| # | Status | Evidence | Mutation |
|---|---|---|---|
| 1 C1 name | **fixed** (`sanitizeAttachmentName`, wire's own `ATTACHMENT_NAME_RE`) | `x\u0085y\u009b.png` → name `xy.png`, `checkAttachmentRefs` OK | filter back to C0+DEL → 2 fail (`M1: a C1 control…`, `a C1 name never reaches Session.send`) |
| 2 two reads / short read / fifo | **fixed** (one `open(O_NONBLOCK)`, `fstat` on the handle, one buffer sniffed + hashed, `readToEof`) | real fs: `Shot 1.png` → png, a real `mkfifo` → `not-file` in 1 ms (no hang), dir → `directory`, missing → `not-found`. A type/bytes swap is no longer possible (one buffer). | `readToEof` reduced to ONE read → **0 fail**: the short-read loop is untested (the fake probe bypasses `nodeFileProbe`). This is a test gap, not a bug (the loop reads correctly). |
| 3 per-call cap | **fixed** (`existing` option; one `too-many {count, dropped}`) | 3 + (3 + dup + re-drop of an attached one) → 5 refs, `checkAttachmentRefs` OK, refusals `duplicate, duplicate, too-many{6,1}` | `existing` ignored → 2 fail (`M3: the cap holds across paste…`, `…SECOND paste is a duplicate`) |
| 4 only image paths | **fixed per the orchestrator rule** (`refusalMeansText`, `attachPaths`/`decideAttachment`) | `/help`, `/clear`, `/etc/hosts`, `PNG + dir`, `PNG + missing` → text with no refusal; a lone dragged PNG → attachments | early text-return disabled → 3 fail (mixed paste, duplicate-is-text, too-many) |

**New finding:**

5. **MEDIUM: `AttachmentDecision.kind: "text"` means two different things**
   (`attach-files.ts:263`, returned at `:316`). The type documents `text` as
   "the paste stays plain text". But it is also returned, *with* refusals, when
   every candidate WAS an image by its bytes and none could be attached:
   - a lone 15 MB+ PNG paste → `{kind:"text", refusals:[too-large]}`
   - a HEIC-only drop, or the same image dropped again → `{kind:"text",
     refusals:[duplicate]}`, pinned by test `a duplicate image refused; the
     paste is text`
   - every failed `/attach` → `{kind:"text", refusals:[not-found]}`, pinned by
     test ``/attach is EXPLICIT``

   A 3b that follows the documented contract inserts the dragged path into the
   prompt next to "already attached". After a failed `/attach /nope.png`, it
   puts the literal command back in the input, ready to be sent to the model.
   This also contradicts the orchestrator rule ("text" only when some token is
   NOT an image by its bytes). Today 3b would have to infer "insert?" from
   `refusals.length === 0`, an unpinned side channel. Fix: a third variant
   (e.g. `{kind:"refused", refusals}`: nothing attached, do NOT insert the
   text), with `text` meaning "insert, no refusals" only. Re-pin the 3 tests
   above.

**Not blocking (noted only):**
- `sanitizeAttachmentName` (`core/src/attachments.ts:59`) still cuts in UTF-16
  units, so `254×"a" + 😀` ends in a lone surrogate (repro: `true 255`). Its
  comment claims the opposite. Display only: the wire accepts it.
- 3a now edits `protocol` and `core`: an additive export plus a shared regex,
  with no wire change and no version bump needed. The blast stays acceptable,
  but the metadata line still says `contained`, new `packages/tui` files only.

**Executor behaviour:** it addressed all four findings at the root (one open
for TOCTOU, the wire's regex instead of a copy, and the `existing` seam), each
with a test that fails under mutation. The only gaps are the untested
`readToEof` loop and the overloaded `text` variant.
