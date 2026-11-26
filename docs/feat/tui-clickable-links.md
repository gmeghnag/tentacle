# feat/tui-clickable-links — underline + click-to-open http(s) links and presented artifacts

> **Status:** implementation (APPROVED — owner delegated the details, 2026-11-26)
> **Branch:** `feat/tui-clickable-links`
> **Size:** M · **Blast:** cross-module (TUI render + mouse + markdown) · **Suited:** Sonnet executes, fresh-context Opus review
> **Changelog:** `changelog.d/tui-clickable-links.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

Owner, 2026-11-26 ~14:45 (TODO.md): «su tentacle TUI sottolinea i link http/https e
gli artefatti presentati e rendili cliccabili per aprirli nell'app predefinita per il
formato». In the transcript, http(s) URLs (assistant text, tool output, markdown links)
and presented artifacts should be underlined, and a click should open them with the OS
default handler on the machine running the TUI.

**What exists today (verified):**

- The TUI owns the mouse (SGR 1006). `mouse-stream.ts:dispatchMouse` (`:264-354`)
  recognises a click (`tool-expand.ts:nextClick`, press + release on the same cell). It
  resolves the click to a tool-call id with `tool-hit.ts:toolCallAtViewport` (`:91-101`).
  Any other click is a zero-length selection, so **a click on a URL does nothing**.
- A **presented artifact already opens on a click** on its `● Present <title>` header
  (`docs/feat/tui-present-row.md`; `mouse-stream.ts:320-324` → effect `openArtifact` →
  `App.tsx:2085-2114 runArtifact`). That path reads the bytes over RPC
  (`session.readArtifact`), so the client has the file in every runtime: laptop worker,
  `serve`/`connect`, and pod `run`/`attach` (pod-origin bytes ask first:
  `artifact-open.ts:artifactStep`). The bytes are written to a per-process `0700` temp
  dir and given to `open`/`xdg-open` through ONE argv spawn with quiet stdio
  (`os-open.ts:74-105`). **What is missing for artifacts is only the underline:** nothing
  shows that the title is a control (`render-lines.ts:1015-1019`).
- **Latent defect found while planning (OSC 8, owner terminals).** `marked-terminal`
  7.1.0 turns every markdown link into an OSC 8 hyperlink when
  `supports-hyperlinks.stdout` is true (`node_modules/marked-terminal/index.js:319-326`).
  That flag is decided once from the environment at module load: iTerm ≥ 3.1, Ghostty,
  WezTerm, VS Code ≥ 1.72, VTE ≥ 0.50, Alacritty, `FORCE_HYPERLINK`
  (`supports-hyperlinks@3.2.0/index.js:88-123`). In those terminals:
  (a) the href is HIDDEN behind the link text;
  (b) **any scheme** reaches the terminal (`file:`, `javascript:`, `vscode:`; the
  `sanitize` option is off);
  (c) the escape bytes survive `render-lines.ts:stripAnsi` (`:143-145`, which strips SGR
  only), so a copied selection containing a link carries `ESC]8;;…BEL` garbage.
  The test env is not a TTY, so no test has ever seen this path.

**Repro** (2026-11-26, run from `.tentacle/tmp/tui-clickable-links/` against the `main`
checkout; the branch is `main` + one TODO commit):

`probe-osc8.ts`:
```ts
// supports-hyperlinks reads env at module load: set it BEFORE the dynamic import.
process.env.FORCE_HYPERLINK = "1";
process.env.FORCE_COLOR = "3";
const { renderMarkdown } = await import("../../../packages/tui/src/markdown.ts");
const { stripAnsi } = await import("../../../packages/tui/src/render-lines.ts");
for (const md of [
  "A [docs](https://example.com/d) link",
  "A [x](file:///etc/passwd) and [y](javascript:alert(1)) and [z](vscode://cmd)",
  "Visit https://example.com/x, then.",
]) {
  const out = renderMarkdown(md, "dark");
  console.log("MD:", JSON.stringify(md));
  console.log("  =>", JSON.stringify(out));
  console.log("  stripAnsi =>", JSON.stringify(stripAnsi(out)));
}
```
```
MD: "A [docs](https://example.com/d) link"
  => "\u001b[0mA \u001b[34m\u001b]8;;https://example.com/d\u0007\u001b[34m\u001b[4mdocs\u001b[24m\u001b[39m\u001b[34m\u001b]8;;\u0007\u001b[39m link\u001b[0m"
  stripAnsi => "A \u001b]8;;https://example.com/d\u0007docs\u001b]8;;\u0007 link"
MD: "A [x](file:///etc/passwd) and [y](javascript:alert(1)) and [z](vscode://cmd)"
  => "… \u001b]8;;file:///etc/passwd\u0007 … \u001b]8;;javascript:alert(1)\u0007 … \u001b]8;;vscode://cmd\u0007 …"
  stripAnsi => "A \u001b]8;;file:///etc/passwd\u0007x\u001b]8;;\u0007 and \u001b]8;;javascript:alert(1)\u0007y\u001b]8;;\u0007 and \u001b]8;;vscode://cmd\u0007z\u001b]8;;\u0007"
MD: "Visit https://example.com/x, then."
  => "\u001b[0mVisit \u001b[34m\u001b]8;;https://example.com/x\u0007\u001b[34m\u001b[4mhttps://example.com/x\u001b[24m\u001b[39m\u001b[34m\u001b]8;;\u0007\u001b[39m, then.\u001b[0m"
  stripAnsi => "Visit \u001b]8;;https://example.com/x\u0007https://example.com/x\u001b]8;;\u0007, then."
```
Without the forced env (the test env and non-OSC-8 terminals) the same input renders
`A docs (https://example.com/d) link`, and a bare URL renders as itself. Also a
cosmetic bug: a GFM autolink with `&` renders twice, `https://e.com/s?a=1&b=2#frag
(https://e.com/s?a=1&b=2#frag)`. Marked's link text is HTML-escaped (`&amp;`), so
marked-terminal's `text !== href` check (`index.js:315`) is true.

`probe.ts` (Ink 5.0.1 + wrap-ansi 9.0.2 with OSC 8): Ink passes OSC 8 through and
appends an extra `ESC]8;;BEL` close at the end of the line
(`"see \u001b]8;;https://example.com/a\u0007…\u001b]8;;\u0007 ok\u001b]8;;\u0007\nnext"`).
wrap-ansi re-emits the OSC 8 open/close on every wrapped row.

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

**`wrapLines` only INSERTS row breaks.** For one logical line, the SGR-stripped wrapped
rows concatenate back to the stripped, tab-expanded, NFC-normalised line. That lets a
plain-text offset found on the logical line be mapped to an exact (row, cell) on screen,
across wraps.

- Source: `wrapLines` wraps each logical line on its own (`render-lines.ts:1438-1458`)
  with `wrapAnsi(text, w, { hard: true, trim: false, wordWrap: true })`. With
  `trim: false`, wrap-ansi keeps every space. The `fitsUnchanged` fast path is the
  identity, and `carryColor` adds only SGR codes.
- Proof (2026-11-26, `probe-wrap.ts`): 7 lines × 4 widths (7, 12, 20, 33) → **28/28 OK**.
  The lines cover a long URL hard-split mid-URL, runs of spaces, existing underline +
  colour SGR, CJK + an IDN host, TABs, an unbreakable 85-char word, and trailing spaces.
  Sample at width 20:
  `["  see ","https://example.com/","a/very/long/path/tha","t/wraps?q=1&r=2 and ","more words here ok"]`.
  ```ts
  import { expandTabs } from "../../../packages/tui/src/input-view.ts";
  import { stripAnsi, wrapLines } from "../../../packages/tui/src/render-lines.ts";
  // for width of [7,12,20,33], line of cases:
  //   rows = wrapLines([line], width); joined = rows.map(stripAnsi).join("")
  //   want = stripAnsi(expandTabs(line)).normalize(); print joined === want
  ```
- It is pinned by a property test (Tests T3). If it ever fails for a line, the mapper
  produces **no link for that line**: a missing link, never a wrong one.

### Preconditions

- **Transcript rows start at screen column 1.** The viewport `Box` has no padding
  (`AppView.tsx:104-130`), so an SGR report's `x - 1` is the 0-based CELL column of the
  row. A row's `y` maps to `win.start + y - 1`, bounded to the viewport, exactly as
  `toolCallAtViewport` does (`tool-hit.ts:91-101`).
- **Per-item row cache + derived arrays.** `itemRows` caches wrapped rows per item
  identity × width × slot (`render-lines.ts:1593-1631`). The blink OFF phase
  (`offPhaseRows`, `:1549`) and the harness hang (`hangRows`, `:1578`) build NEW arrays
  that swap one equal-width glyph, so their cell geometry is identical to the source.
- **`LaidItem` is THE hit-test index** (`render-lines.ts:1652-1673`). It carries `id`
  and `toggleRows` precisely so that a cache hit cannot leave a second index stale
  (`tool-hit.ts` header). Links ride the same object.
- **Toggle rows are controls.** A tool's header (and a shell call's `$` rows)
  toggle/open on a click (`tool-hit.ts:toolCallAt`, `:67-72`; `toggleRowsOf`,
  `render-lines.ts:1113`). Header subtitles are CUT (`fitSubtitle` with `…`,
  `render-lines.ts:1017-1018`), so a URL there may be truncated.
- **Some producers pre-wrap their own text** before `itemRows`' final wrap: user
  messages (`messageRows`, `:148-150`), sub-agent rows (`:476`, `:638`), expanded
  command/target rows (`:821`, `:833`), shell `$` rows (`:1241`). A long URL there is
  split across LOGICAL lines, so per-line detection would see fragments.
- **The opener seam exists.** `os-open.ts` spawns via an injectable `deps.spawn(argv,
  QUIET_STDIO)` (`Bun.spawn([...argv])`: argv, never a shell; all stdio ignored, so no
  byte reaches Ink's terminal, AGENTS §7) and picks `open` on darwin, else `xdg-open`
  (`:96`). `startTui` passes the real one (`run.tsx:220`); tests pass a spy
  (`test/app-artifacts.test.tsx:281`).
- **Notices are the inline failure channel** (`MouseHost.pushNotice`, `useMouse.ts:62`).
  A notice moves the view to the tail (`useMouse.ts:140-142`), so success stays
  SILENT, as artifact opens and copies already do.
- `marked` 12.0.2's renderer override takes positional `link(href, title, text)`
  (`node_modules/marked/lib/marked.d.ts:184`). A later `.use({ renderer })` overrides an
  earlier extension's method.
- One session path: this is pure TUI presentation + a local spawn. No RPC, no protocol,
  no daemon change, and the same code runs for every runtime (AGENTS §7).

### Design

**1. One pure module, `links.ts`: detection, validation, geometry, decision.**

- `findUrls(plain: string): { start: number; end: number; url: string }[]` (UTF-16
  offsets into `plain`):
  - A candidate starts at `https?://` (case-insensitive) with a non-word char (or the
    start) before it. It runs until whitespace, a control char, or one of `<>"'` and
    backtick, `{}|\^`, and `…`.
  - **Trailing-punctuation rule (GFM-like):** repeatedly strip a trailing
    `.,:;!?*_~'"`. Strip a trailing `)` / `]` / `}` only while it is unbalanced inside
    the candidate. So `(see https://e.com/p_(x))` → `https://e.com/p_(x)` and
    `https://e.com/x,` → `https://e.com/x`.
  - **Truncation rule:** a candidate immediately followed by `…` is DROPPED. It is a cut
    URL (`fitSubtitle`, `truncateCells`, cli-table3), and opening its prefix would open
    the wrong page.
  - Each survivor must pass `normalizeUrl`.
- `normalizeUrl(s): string | null`: `new URL(s)` must parse. The protocol must be
  exactly `http:` or `https:` and the hostname non-empty. The input must be ≤ 2048 code
  units with no char < 0x21 or 0x7f. It returns `url.href`, the WHATWG serialisation
  (percent-encodes space, `"`, `<`, `>`, backtick), which is the ONLY string ever handed
  to the opener.
- `sourceUrls(item: DisplayItem): ReadonlySet<string>`: `findUrls` over every string
  leaf of the item, collected recursively, depth ≤ 4, total ≤ 1 MiB scanned, keeping the
  raw candidate text. **A rendered candidate becomes a link only if its text is in this
  set.** The target is therefore always a URL that literally appears in the item's own
  data. This one rule kills the wrong-target class: a fragment of a pre-wrapped URL, a
  table-cut URL, or a marked re-escape is a missing link, never a wrong one.
- `linkRows(logical: string, rows: readonly string[], allowed, firstRow, skipRows):
  LinkSpan[]` maps one logical line's candidates onto its wrapped rows.
  - `LinkSpan = { row; col; width; url }`: `row` is item-relative, `col`/`width` in
    CELLS (`cells.ts:cellWidth`), `url` normalised. A URL wrapped over N rows yields N
    spans with the same `url`.
  - If the stripped rows do not concatenate to the stripped logical line (the
    load-bearing assumption broken), it returns `[]`.
  - Spans on rows `< skipRows` (toggle rows) are not produced.
- `underlineRow(row: string, segs: {from; to}[]): string` inserts `ESC[4m` at each
  segment's start and `ESC[24m` at its end. It maps plain UTF-16 offsets → ANSI string
  indices by skipping `ESC[…m`. Inside a segment, after any SGR that drops underline
  (params `""`, `0`, `24`), it re-emits `ESC[4m`, so marked's own `href` style
  (`chalk.blue.underline`, `marked-terminal/index.js:43`) cannot end ours early.
  Applied **after** the wrap, per row: wrap points are never affected, and the stripped
  rows stay byte-identical (Test T4).
- `linkOpenStep(url, opener: { ssh: boolean } | undefined)`:
  - `{ kind: "notice", text }` when there is no opener (`No link opener in this
    session.`), or when `ssh` is true (`Not opened: this TUI runs over SSH, so a browser
    would open on the remote host — <url>`).
  - `{ kind: "open", url }` otherwise.
  - `linkOpenError(url, error)` is the one failure notice:
    `Couldn't open <url ≤ 120 cells, middle-cut>: <reason ≤ 200>`. ENOENT is spelled as
    `no <opener> on this machine`.

**2. `render-lines.ts` records spans next to rows, and underlines.**

- `itemRows` wraps through `wrapLinkedLines(lines, width, sourceUrls(item), skipRows)`
  in place of `wrapLines(...)`. It calls `wrapLines([line], width)` per logical line
  (identical output, since `wrapLines` is per-line), then `linkRows` + `underlineRow`.
  `skipRows` = `toggleRowsOf(item, opts)` for a tool, else 0. A URL in a header subtitle
  is therefore neither underlined nor clickable (underline ⇔ clickable).
- The spans are stored in `linkCache: WeakMap<readonly string[], readonly LinkSpan[]>`,
  keyed by the cached row array. `offPhaseRows` and `hangRows` copy their source's entry
  onto the swapped array, since the geometry is identical.
- `layoutTranscript` sets a new `LaidItem.links = linkCache.get(rows) ?? NO_LINKS`, an
  O(1) lookup per item per frame. No new per-frame allocation.
- The inner pre-wraps (`messageRows` etc.) are untouched. A URL that fits one of their
  rows is linked; one split by them is not (the source-set rule).
- **Present title:** in `toolLines`' header (`:1019`), when `tool.name === "present"`
  and `tool.detail?.kind === "artifact"` (exactly when `artifactOfCall` returns a meta,
  i.e. when the click opens), the fitted subtitle is
  `theme.subtle(chalk.underline(fitted))`. Expanded (Ctrl+O), the header drops the
  subtitle (`:1018`), so nothing is underlined there; the header click still opens
  (`mouse-stream.ts:324` precedes the `expandAll` guard).

**3. `markdown.ts`: one deterministic link renderer, both modes.** After
`markedTerminal(...)`, `.use({ renderer: { link(href, title, text) } })` renders:
- `text (href)` when the HTML-unescaped, ANSI-stripped `text` ≠ `href`;
- `href` alone otherwise (this fixes the `&` duplication).
The styles are today's: dark `link: chalk.blue`, `href: chalk.blue.underline`
(`marked-terminal/index.js:42-43`); light `md.link` (`markdown.ts:56-57`). **No OSC 8,
ever, from markdown.** The href is always VISIBLE, so a non-http(s) target is shown as
text and never becomes clickable (`findUrls` ignores it). The terminal-specific hidden
hyperlink and the `stripAnsi` leak are gone.

**4. Hit test, in `tool-hit.ts`.** Extract the binary search into
`laidItemAt(laid, absRow)`. `toolCallAt` uses it unchanged. Add
`linkAtViewport(laid, win, x, y): string | null`. It applies the same viewport bound as
`toolCallAtViewport`, then finds the item with `laidItemAt`, its item-relative row, and
the span with `col ≤ x-1 < col+width`. It returns null on a TOOL item's rows
`< toggleRows` (defence in depth; `layoutTranscript` sets `toggleRows: 1` on every
non-tool item too, so the guard must read `id !== ""` — corrected in Execution) or
past the item's rows (a gap row).

**5. `mouse-stream.ts`:** a new effect `{ kind: "openLink"; url: string }`. In
`dispatchMouse`, on a completed click (`step.click`), AFTER the artifact and toggle
checks and independent of `expandAll`: `const url = linkAtViewport(snapshot.laid,
snapshot.win, step.click.x, step.click.y)`. If non-null, it returns
`{ state: { click, selection: null }, effects: [{ kind: "openLink", url }] }`. The
priority order in the doc comment gains "a link". `MouseSnapshot` needs nothing new:
`laid` carries the spans.

**6. Opener — `os-open.ts`:** `createLinkOpener(over?: Partial<OsOpenDeps & { env }>):
LinkOpener` with `{ readonly ssh: boolean; open(url): Promise<void> }`.
- `ssh` = `env.SSH_CONNECTION` or `env.SSH_TTY` is non-empty (default env:
  `process.env`, read once at creation).
- `open` re-checks `normalizeUrl(url) === url` (the last guard; else it rejects
  `not an http(s) link`). It then runs ONE `deps.spawn([opener, url], QUIET_STDIO)`
  (`open` on darwin, else `xdg-open`) and awaits `exited`; a non-zero code rejects.
- The spawn is never through a shell, and the URL is one argv element that cannot start
  with `-` (it starts with `http`).
- Not detached: `open`/`xdg-open` return once the handler is launched (the browser
  daemonises), and stdio is ignored, so nothing can grab Ink's TTY.

**7. Wiring:**
- `app-types.ts`: an optional `linkOpener?: LinkOpener` next to `artifactOpener`
  (`:781`).
- `run.tsx:220`: `linkOpener={createLinkOpener()}`.
- `useMouse.ts`: `MouseHost.openLink(url)` and `case "openLink"`.
- `App.tsx`: `openLink`, a stable `useCallback` (ref-backed like `openClickedArtifact`,
  `:2014-2018`), runs `linkOpenStep(url, linkOpener)` → `pushNotice(text)`, or
  `void linkOpener.open(url).catch((e) => pushNotice(linkOpenError(url, e)))`.

#### Orchestrator decisions (owner delegated; recommended option taken)

1. **OSC 8: no.** We do not emit OSC 8, and we REMOVE marked-terminal's
   environment-dependent OSC 8.
   - Why: our SGR click works in every terminal the TUI already supports.
   - OSC 8 would add terminal-specific behaviour: a possible double open when the
     terminal handles a modifier-click AND reports it. It would also add Ink's extra
     closing sequence and a new escape class that every `stripAnsi` consumer (selection
     copy, hit map) must learn.
   - Today it is a hidden-target, any-scheme channel (Context).
   - Revisit only as its own `eval`, if the owner wants native hover/Cmd-click.
2. **Markdown `[text](url)`: the visible `(url)` part is the click target; `text` is
   not.** What you click is what opens, with no hidden destination. The visible URL is
   detected like any bare URL.
3. **No confirm prompt for http(s) links, in any runtime (pod included).**
   - The effect is requested by the person's click, not by the pod.
   - The target is fully visible and validated http(s), so it is the same act as the
     terminal's own link click.
   - Pod-origin ARTIFACTS keep their confirm: they are bytes opened by local apps
     (unchanged).
   - Review must red-team this against AGENTS §7 "a pod is not trusted".
4. **Presented artifacts:** keep the existing header-click open path untouched and add
   only the underline (underline ⇔ the click opens). The grey fact row stays text
   (selectable id).
5. **SSH:** do not spawn; say so inline with the URL. Do not copy it to the clipboard:
   `clipboard.ts` uses the host's local tools, which over SSH is the remote host.
6. **Scope of detection:** every transcript item's rows, through the one final wrap.
   - Excluded: toggle rows (controls, cut subtitles), and URLs split by an inner
     pre-wrap (the source-set rule makes them a missing link, never a wrong one).
   - Panels and the status bar are out of scope.

### Files

In dependency order (TUI only; no protocol/daemon/client/cli change):

1. `packages/tui/src/links.ts`: **new**, pure (design §1).
2. `packages/tui/src/markdown.ts`: link renderer override (§3).
3. `packages/tui/src/render-lines.ts`: `wrapLinkedLines`, `linkCache`, `LaidItem.links`,
   phase/hang inheritance, present title underline (§2).
4. `packages/tui/src/tool-hit.ts`: `laidItemAt`, `linkAtViewport` (§4).
5. `packages/tui/src/mouse-stream.ts`: `openLink` effect + dispatch (§5).
6. `packages/tui/src/os-open.ts`: `LinkOpener`, `createLinkOpener` (§6).
7. `packages/tui/src/useMouse.ts`, `app-types.ts`, `App.tsx`, `run.tsx`: wiring (§7).
8. Tests (below), and `changelog.d/tui-clickable-links.added.md`:
   ```
   - **Clickable links in the TUI.** http(s) URLs in the transcript are underlined and open in your default browser with a click; a presented artifact's title is underlined (a click opens it). Markdown links always show their address (`text (url)`), in every terminal.
   ```

### Failure modes

| Case | Converges to |
|---|---|
| No `open`/`xdg-open` (ENOENT), or a non-zero exit | One inline notice (`linkOpenError`); nothing else changes |
| `linkOpener` absent (tests, embedded) | Notice `No link opener in this session.` |
| TUI over SSH | Notice with the URL; no spawn |
| Non-http(s) scheme (`file:`, `javascript:`, `vscode:`) in model text | Never detected; plain text. Markdown shows it visibly as `text (file:///…)`, unclickable |
| URL cut by `…` (subtitle, table, truncateCells) | Truncation rule + source set: no link |
| URL split by an inner pre-wrap (user message, sub-agent row) | Source set: fragment ≠ source URL → no link (known limit, stated) |
| Wrap invariant broken for some line | `linkRows` returns `[]` for that line: no link, never a shifted one |
| Click on a gap row, the input box, the status bar, or scrolled past the window end | `linkAtViewport` returns null (viewport bound + rows bound) |
| Click on a tool header / shell `$` row | Toggle/open as today; no spans exist there |
| Drag across a link | `nextClick` is not a click → selection as today |
| Resize / Ctrl+O / expand one call | New wrap → new cache slot → new spans (spans live with the rows) |
| Blinking running tool / hung harness notice | Derived arrays inherit spans (same geometry) |
| Streaming reply whose tail is a partial URL | Linked as visible (the source holds the same partial). A click opens what is shown; accepted, stated |
| Selection active | `AppView` paints plain rows (no underline) while selecting; the hit map is unchanged |
| Very long item text | `sourceUrls` scans ≤ 1 MiB per cache miss; beyond that, URLs are not linked |
| Windows | `xdg-open` is missing → ENOENT notice (TUI on win32 is out of scope, as for artifacts) |

### Tests

Red before green for each (AGENTS §9). Run the narrow file while iterating:
`bun test packages/tui/test/<file>`.

- **T1 `test/links.test.ts` (new): detection.** Each pins the exact output string:
  - bare URL; `https://e.com/x,` → no comma; `(see https://e.com/p_(x))` keeps the
    balanced paren; `[docs](https://e.com/d)` source → `https://e.com/d`;
  - `<https://e.com/a>`; `https://e.com/x…` → nothing; `ftp://`, `file://`,
    `javascript:` → nothing; `xhttps://e.com` → nothing; 2049-char URL → nothing;
  - `?a=1&b=2#f` kept whole; IDN host → `href` normalised.
- **T2 `links.test.ts`: `linkRows`.**
  - A URL wrapped over 3 rows at width 20 yields 3 spans with exact `row/col/width` and
    the same `url`.
  - A CJK prefix moves `col` by 2 cells per char.
  - A candidate not in the source set → no span.
  - `skipRows = 1` drops row-0 spans.
  - A forged mismatched rows array → `[]`.
- **T3 `render-lines.test.ts`:** the load-bearing property over the probe's corpus ×
  widths: `wrapLines([l], w).map(stripAnsi).join("") === stripAnsi(expandTabs(l)).normalize()`.
- **T4 `render-lines.test.ts`:**
  - `layoutTranscript` with one assistant item holding a long URL: stripped rows equal
    the pre-change `wrapLines` output.
  - The raw rows contain `ESC[4m` on every row the URL covers.
  - `LaidItem.links` covers exactly the URL cells.
  - A running tool's OFF phase (`blinkPhase` in the OFF half) has the same `links`.
  - A `web_fetch` header subtitle URL is neither underlined nor spanned.
  - A `present` header with an artifact card has the title underlined; without a card it
    is not.
- **T5 `tool-hit.test.ts`: `linkAtViewport`.** Hit on the first and last cell of each
  wrapped segment; miss one cell past; scrolled window (`win.start > 0`); a row below the
  viewport → null; a gap row → null; a header row → null.
- **T6 `markdown.test.ts`:**
  - `[docs](https://e.com/d)` → stripped `docs (https://e.com/d)` in both modes.
  - The `&` autolink renders ONCE.
  - **Red-first OSC 8 check:** `Bun.spawn` a child (`bun -e` importing `markdown.ts`)
    with env `FORCE_HYPERLINK=1 FORCE_COLOR=3`, and assert its stdout has no `\x1b]8;;`.
    It fails on today's code (the Repro), passes after.
- **T7 `os-open.test.ts`:** `createLinkOpener` with a fake `spawn`:
  - argv is exactly `["open", url]` on darwin and `["xdg-open", url]` on linux, with
    `QUIET_STDIO`;
  - a non-normalised or `file:` URL rejects without spawning;
  - exit 3 rejects;
  - a `spawn` that throws ENOENT rejects;
  - `ssh` is true with `env: { SSH_CONNECTION: "x" }` and false with `{}`.
  `linkOpenStep` / `linkOpenError` texts live in `links.test.ts`.
- **T8 `test/app-links.test.tsx` (new, ink-testing-library frame test):** copy the
  `press`/`release` helpers (`app.test.tsx:93-96`) and the spy-opener mount
  (`app-artifacts.test.tsx:281-322`). The scripted reply contains a URL long enough to
  wrap.
  - (a) A click (press + release) on a cell of the URL's SECOND row calls the fake
    `linkOpener.open` exactly once with the normalised URL.
  - (b) A click on plain text in the same reply → no call.
  - (c) After scrolling up (wheel), a click on the URL's new screen row still opens it
    (and one on the input box does not).
  - (d) A fake whose `open` rejects → the frame shows the `Couldn't open` notice.
  - (e) `ssh: true` → notice, `open` never called.
  - (f) A drag across the URL → no call.
  - Non-vacuity (§9): mutate `linkAtViewport` to ignore `win.start`, and confirm (c)
    fails; revert.
- Existing suites that must stay green unchanged: `tool-hit.test.ts`, `app.test.tsx`,
  `app-mouse-layer.test.tsx`, `app-artifacts.test.tsx` (the header-click open), the
  structural/snapshot suites. If a snapshot moves because a markdown link now reads
  `text (url)` in place of OSC 8, it can only be one built under hyperlink support,
  which the test env never has. Expect none; investigate any.
- Gate before done: `bun run check` (typecheck → lint → parallel test), with the lint
  baseline clean (AGENTS §6).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check, re-run on this worktree** before any edit (`probe-wrap-wt.ts`, the
Context's 7 lines × widths 7/12/20/33): `ok=28 diff=0`.

**Repro before the change** (`probe-osc8-wt.ts`, `FORCE_HYPERLINK=1`): stripped markdown
output carried `ESC]8;;…BEL` for `https:`, `file:` and a bare URL; `LaidItem` keys were
`rows,start,id,gap,toggleRows`; `rg linkOpener|openLink packages/tui/src` found nothing.
The same probe after: `A docs (https://example.com/d) link`, `A x (file:///etc/passwd)`,
the `&` autolink once, and `LaidItem` has `links`.

**As built**, in the plan's order (new modules/functions first stubbed, so every red is
an assertion failure):

| Slice | Red → green |
|---|---|
| `links.ts` (new) | `links.test.ts` 18 fail / 5 pass on the stub → 23 pass |
| `markdown.ts` link renderer | `&` autolink and the child-process OSC 8 test failed → 17 pass |
| `render-lines.ts` (+ present underline) | 6 layout tests failed → 140 pass; the T3 wrap property passed before and after (it pins an existing property) |
| `tool-hit.ts` | 4 `linkAtViewport` tests failed → 21 pass |
| `mouse-stream.ts` | the open-link dispatch test failed → 29 pass (its 3 "unchanged behaviour" tests pass on both) |
| `os-open.ts` | 6 `createLinkOpener` tests failed → 16 pass |
| wiring (`useMouse`, `App`, `app-types`, `run`) | `app-links.test.tsx` (a)(c)(d)(e)(g) failed → 7 pass ((b), (f) pass on both) |

**Mutation checks** (each applied, seen red, reverted):

| Mutation | Failed |
|---|---|
| `linkAtViewport` ignores `win.start` (the plan's target) | app (c) "scrolled up…"; tool-hit "a scrolled window maps the screen row through its start" |
| no source-set filter in `linkRows` | "a candidate that is not in the source set has no span"; "a URL split by an inner pre-wrap…" |
| `offPhaseRows` does not inherit links | "the blink OFF phase of a running call has the same links" |
| `hangRows` does not inherit links | "a hung harness line has the same links" |
| no `…` truncation rule | "a URL cut by an ellipsis is dropped" |
| no `normalizeUrl` re-check in the opener | "anything but a normalised http(s) URL is refused without a spawn" |
| `skipRows` = 0 | "a URL in a header subtitle is neither underlined nor spanned" |

**Drift from Implementation:**

1. `linkAtViewport`'s control-row guard applies to tool items only (§4 corrected above):
   as written it would have killed every link on a reply's first row
   (pinned: "a reply's FIRST row link hits").
2. `LinkSpan` also carries `from`/`to` (plain UTF-16 offsets in the row), which is what
   `underlineRow` takes; `col`/`width` stay cells.
3. Dark-mode link styles come from `tokens.dark.md.link` through `colorStyler`, not a
   literal `chalk.blue` (`theme-no-stray.test.ts` forbids it; it caught the first
   version). The dark golden bytes are unchanged.
4. `normalizeUrl` also rejects an `href` longer than 2048 (percent-encoding can lengthen
   it, and the opener re-checks the same function); it uses `URL.canParse`.
5. `createLinkOpener` rethrows a spawn `ENOENT` with `path` = the opener's name, which
   `linkOpenError` prints. The artifact opener's behaviour is unchanged.
6. `LaidItem.links` is required, so the two hand-built literals in
   `mouse-stream.test.ts` gained `links: []` (the only edit to an existing test's data).

No protocol or schema change (`protocol.json` untouched).

**Checks run** (not the full gate, which the orchestrator runs): `bun test
packages/tui/test` — first 3195 pass, 1 fail (drift 3), then on the final tree with
`--parallel` 3196 pass, 0 fail; `bunx biome check
packages/tui/src packages/tui/test` — clean; a scoped `tsc` over the touched files and
their imports — only `agent/src/harness/a2a-map.ts(520)`, an unedited file, so
attributed to the scoped config (unverified; the full typecheck decides).

Seen, not caused here: run SERIALLY, `markdown.test.ts` + `render-lines.test.ts` fail
"the shipped default is the text-only header" (theme state leaks between files). It
still fails with only the pre-existing describes selected (`-t`); `--parallel` passes.

**For Review** (not exercised or accepted limits):

- No real terminal / real `open` was driven: every open goes through a fake spawn.
  To verify: click a URL in a live TUI on macOS.
- The opened string is the WHATWG `href`, so an IDN host opens as punycode while the
  screen shows Unicode; userinfo URLs (`https://a@b/`) are allowed as planned.
- Source-set corner: if an inner pre-wrap cuts a long URL exactly where a shorter URL
  also present in the same item ends, that row links to the shorter one (the row's
  visible text is what opens).

## Review

*— <model-id>, <YYYY-MM-DD>*
