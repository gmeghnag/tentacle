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

*(standard in-context Review, per §10 `contained`/S)*
