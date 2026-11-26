# feat/browser-extension-store — Prepare the tentacle Chrome extension for the Chrome Web Store

> **Status:** review
> **Branch:** `feat/browser-extension-store`
> **Size:** M · **Blast:** cross-module (extension + native host + site) · **Suited:** Opus plan (research) → exec, Opus review
> **Changelog:** `changelog.d/browser-extension-store.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

The owner wants the tentacle Chrome extension on the Chrome Web Store (TODO.md, owner 2026-11-26 ~15:30: «sì prepara tutto»). Everything is prepared here except the owner's developer account, the upload and the submit. Today the extension exists only as an unpacked copy. `tentacle browser install` writes it to `<configDir>/browser/extension` from the table embedded in the binary (`packages/cli/src/browser-extension-assets.ts:42`), and the user loads it with Developer mode → Load unpacked. Its id is pinned by the manifest `key` (`apps/browser-extension/manifest.json`, U7 in docs/feat/browser-inspect.md). The native host accepts only that one origin: `packages/cli/src/browser-host.ts:53` on main, `originAllowed` compares argv[1] with ONE id, and `packages/cli/src/browser-install.ts:73` on main writes ONE `allowed_origins` entry.

Five deliverables (TODO item): (1) a store ZIP built from the same source the CLI embeds, (2) native-host support for the store-assigned id next to the dev id, (3) an evaluation of moving `debugger` and other strong permissions to `optional_permissions`, (4) an extension privacy policy page, (5) the listing pack (copy, permission justifications, data disclosure, icon, screenshots).

**Repro (capability missing, 2026-11-26, main 7f42d6b3):** `rg -n "allowed_origins" packages/cli/src/browser-install.ts` gives `allowed_origins: [`chrome-extension://${extensionId}/`]`, a single origin. A store copy, whose id differs because the store zip cannot carry the dev key (see R2), would be refused by the host: `browser host: refusing an unexpected caller origin`. Packing script: `ls scripts | grep -i pack` gives nothing. Privacy page: `.tentacle/site/www/privacy/` holds only the apps-host notice.

### Verified Chrome Web Store rules (checked online 2026-11-26)

- **R1 — `debugger` CANNOT be optional.** The permissions API page lists the permissions that cannot be declared optional: `debugger`, `declarativeNetRequest`, `devtools`, `geolocation`, `mdns`, `proxy`, `tts`, `ttsEngine`. `chrome.permissions.request` must run "from inside a user gesture, like a button's click handler". Source: https://developer.chrome.com/docs/extensions/reference/api/permissions
- **R2 — `key` on upload.** The `key` manifest page documents the key for development only. To keep one id between dev and store, you upload first, then copy the dashboard's public key into `key`. It says nothing about uploading a zip that already carries a `key`: https://developer.chrome.com/docs/extensions/reference/manifest/key. Developers report that a first upload with a `key` fails with «key field is not allowed in manifest», and that the store wants the PRIVATE key (`key.pem`) on a first upload to keep an id: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/x_NBS6_-NKs. We hold only the public key, so the store id WILL differ from the dev id. → The store zip drops `key`.
- **R3 — package format.** Manifest in the zip root: https://developer.chrome.com/docs/webstore/prepare. Each upload needs a higher `version` than the last. Publishing steps (Package / Store listing / Privacy / Distribution / Test instructions tabs, Submit for review, up to 30 days to publish after approval, optional deferred publishing): https://developer.chrome.com/docs/webstore/publish
- **R4 — single purpose and minimum permissions.** "An extension must have a single purpose that is narrow and easy to understand". "Request access to the narrowest permissions necessary". Do not request permissions for features not built yet. Limited Use: data only for the disclosed single purpose. A privacy policy is required if the item handles any user data. Source: https://developer.chrome.com/docs/webstore/program-policies/policies. Web browsing activity may be collected only for a user-facing feature described prominently in the listing and the UI. The site must affirmatively state Limited Use compliance (example wording given): https://developer.chrome.com/docs/webstore/program-policies/limited-use
- **R5 — Privacy practices tab.** It asks for a single-purpose description, a justification for EACH permission ("remove any permissions you don't use, then upload a new version"), the remote-code declaration (MV3 cannot load remote code), data-usage checkboxes plus certifications, and the privacy policy URL: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy. Disclosure is required "even when data is processed or stored locally": https://developer.chrome.com/docs/webstore/program-policies/user-data-faq. The public docs do not list the data-category names. The listing pack uses the dashboard's labels, which the owner must confirm on the form.
- **R6 — images.** Icon 128×128 PNG, with the art at 96×96 and 16 px transparent padding per side. Screenshots 1280×800 or 640×400, 1 to 5 of them, full bleed, square corners. Small promo tile 440×280; marquee 1400×560. Source: https://developer.chrome.com/docs/webstore/images
- **R7 — review.** Review takes longer for "broad host permissions or sensitive execution permissions", for new developers and for new extensions. Most reviews finish "within a few days, but it can take up to a few weeks"; contact support after 3 weeks pending: https://developer.chrome.com/docs/webstore/review-process
- **R8 — account.** It needs a one-time registration fee and the developer agreement, and the account email cannot be changed later: https://developer.chrome.com/docs/webstore/register. The page does not state the amount; it has historically been US$5.

## Implementation

*— claude-opus-5-5, 2026-11-26*

### Load-bearing assumption

The store copy reaches the SAME native host only if Chrome's host-manifest `allowed_origins` lists its id AND the host's own argv[1] check accepts it. Two gates, both must change together. Proven on main: `browser-install.ts:73` writes the manifest, Chrome refuses unlisted origins (F1/F5 in browser-inspect.md), and `browser-host.ts:53` rechecks argv[1] in `browserHostMain` (`:381` on main, `:384` now), called from `main.ts:747`. A shared function `browserExtensionIds()` in `@tentacle/browser` feeds both, so they cannot drift.

### Preconditions

- The embedded table is the single source of the extension's files and is pinned byte-equal to `apps/browser-extension/{manifest.json,src,icons}` (`packages/cli/test/browser-install.test.ts`, «B5: the EMBEDDED table…»). The pack script reads that table, so pack, install and disk stay one set.
- AGENTS §7 (a pod is not trusted; laptop surfaces): the extension and native host run only on the laptop. Nothing here changes who may dial the hub (the socket is still the user's 0700 dir). Adding the store id widens the trusted origins from one to two ids, and both are ours. There are no wildcards: Chrome forbids them and a test checks for `*`.
- The extension never uses `chrome.storage`. `rg "chrome\.storage" apps/browser-extension/src` finds nothing, yet the manifest declared `storage`. Per R4/R5 an unused permission must go.
- How the permissions are used: `debugger` at `ops.js:264` (full network trace and background-tab screenshot), `captureVisibleTab` at `ops.js:176` (needs host access), `tabGroups` at `ops.js:101,403`, and dragging a tab out of the group takes it back via `takeBack` at `ops.js:152,346`. `webRequest` is used at `background.js:53`, filtered to session tabs at `ops.js:335`; `connectNative` at `background.js:25`.

### Design

1. **Pack** (`scripts/browser-extension-pack.ts`, `bun run browser-extension:pack`). It reads `EXTENSION_ASSETS`, rewrites only `manifest.json` (drops `key`, validates `version` against Chrome's 1–4 integers of 0–65535) and writes `dist/tentacle-browser-extension-<version>.zip`. The zip has the manifest first and the rest sorted, uses deflate and a fixed DOS timestamp, so its bytes are deterministic. It prints the sha256. A small zip writer/reader is included (no new dependency); the reader is used by the tests, and `unzip -t` was used once by hand.
2. **Two ids.** `packages/browser/src/link-schema.ts` defines `BROWSER_EXTENSION_STORE_ID: string | undefined = undefined`, a **placeholder**, plus `isExtensionId` (`^[a-p]{32}$`) and `browserExtensionIds(storeId)`, which returns the dev id first and the store id when set. A malformed id **throws**; it is never silently dropped. `originAllowed`, `browserHostMain`, `installBrowser`/`manifestJson`, and `nativeHostInstalled` (exact list equality, so a manifest written before the store id existed reads as «stale — run install») all default to it. When the store id is known, `install` also prints the store URL and «keep only one of the two copies enabled».
3. **Optional permissions: not adopted. `storage` removed.** `debugger` cannot be optional (R1), and it is the permission that drives the strongest warning and the longer review (R7). Making the others optional would not shrink the install warning, which `debugger` + `<all_urls>` already set. It would also break the product. Every request comes from the model over native messaging, with no user gesture (R1). `tabGroups` is the user's revocation path, since dragging a tab out of the group takes it back. Without `webRequest` or host access, session tabs could not be read or traced. Only the popup has a gesture, which would turn "first use" into a mandatory pre-step. So the evaluation's outcome is to keep the set required, justify each permission, and remove the unused `storage`. A test now pins the exact permission set and asserts each is reached by its API in `src/`. The manifest `version` goes 0.1.0 → 0.2.0, and the `description` (the store summary, ≤ 132 characters) now says what the extension does, including tabs the user gives it.
4. **Privacy page** `.tentacle/site/www/privacy/extension/index.html`, written in the style of `/privacy`. The extension sends only to the local app. It has no server, no analytics and no remote code. It reads only the session's tabs, and only on request. It states honestly that tentacle (not the extension) sends the conversation to the model provider the user configured and keeps the history on the user's computer. It covers retention and includes the Limited Use statement (R4). Not uploaded: the orchestrator publishes it.
5. **Listing pack** in `.tentacle/tmp/webstore/` (gitignored): `listing.md`, the zip, `icon-128.png` (the manifest icon), `store-icon-128.png` (padded per R6), and three 1280×800 screenshots. The screenshots show the REAL `popup.html`/`popup.js` under a stubbed `chrome`, inside a drawn Chrome window, rendered by headless Chrome, with the `build/` sources next to them.

### Files

`packages/browser/src/link-schema.ts` → `packages/cli/src/browser-host.ts`, `browser-install.ts`, `browser-status.ts` (type only) → `apps/browser-extension/manifest.json` → `scripts/browser-extension-pack.ts`, `package.json` (script) → tests: `packages/browser/test/extension-ids.test.ts` (new), `packages/cli/test/browser-install.test.ts`, `packages/cli/test/browser-host.test.ts`, `apps/browser-extension/test/manifest.test.ts`, `scripts/test/browser-extension-pack.test.ts` (new) → `changelog.d/browser-extension-store.added.md`. Outside git: the privacy page and the listing pack.

### Failure modes

- **The owner pastes a wrong id** (typo, the dev id, uppercase). `browserExtensionIds` throws, and the test «the shipped store id is unset, or a valid id different from the dev id» fails before any build ships it. Pasting the dev id itself collapses to one id.
- **Store id set, but the user keeps an old host manifest** (dev id only). `tentacle browser status` and `browser/status` report «stale — run install», because the comparison is exact list equality. The dev copy keeps working meanwhile, because Chrome checks the old manifest, which still lists the dev id.
- **Both copies installed and enabled.** They are two extensions, and each dials the host. The second host finds the hub held and exits («another Chrome profile already holds the hub», `browser-host.ts:390`). That copy's worker reconnects with backoff and its popup says «not linked». Install prints «keep only one of the two copies enabled». This is not silent: the losing popup shows it.
- **A store update with the same version** is refused by the store (R3). The script prints the reminder to bump `manifest.json` first, and the zip name carries the version.
- **A first upload that still has `key`** is not possible: the test pins that the zip's manifest has no `key`.
- **A new file added to the extension but not to the embedded table.** The install test fails (table ≠ disk), and the zip equals the table, so the zip cannot silently miss it.
- **Version skew between dev and store copies.** They run the same code from the same table. The hub protocol has its own `BROWSER_LINK_VERSION`, unchanged here.

### Tests

- `extension-ids.test.ts`: dev only; dev + store; dedup; malformed refused; alphabet; the shipped constant valid. Red first: the module was missing.
- `browser-install.test.ts`: the manifest lists both origins, with no wildcard; the store line appears only with a store id; a manifest from before the store id, with an extra origin, or with the wrong second origin is stale. Red first: 3 tests.
- `browser-host.test.ts`: argv[1] is accepted for dev and store and refused for others, including a missing trailing slash. Red first.
- `manifest.test.ts`: the exact permission set, each permission used by its API, no `optional_permissions`, `<all_urls>`, description ≤ 132. Red first: `storage`.
- `browser-extension-pack.test.ts`: the zip's file set equals `EXTENSION_ASSETS` with the manifest at the root; every other file is byte-equal; the manifest equals the embedded one minus `key`; the zip name and deterministic bytes; bad versions refused; a missing manifest refused; the crc32 vector; a zip round-trip and a corrupted entry refused.

## Execution

*— claude-opus-5-5, 2026-11-26*

Done in plan order, each slice red then green:

1. Ids: `extension-ids.test.ts` red (missing exports), then `link-schema.ts`, green 6/6. The CLI tests were red (3 fails), then `browser-host.ts`/`browser-install.ts`/`browser-status.ts`, green.
2. Manifest: the permission test was red on `storage`. `storage` was removed and the version went to 0.2.0, green. The description was rewritten (115 characters), with a test for the 132 cap.
3. Pack: the test was red (module missing), then the script, green 8/8. `bun run browser-extension:pack` → `dist/tentacle-browser-extension-0.2.0.zip`, 12 files, and `unzip -t` reported «No errors detected».
4. Install store line: red, then green.
5. **Non-vacuity by mutation** (each reverted). M1, keeping `key` in the zip, fails the pack test. M3, a host that accepts only `ids[0]`, fails the host test. M2, a status check of only the first origin, at first SURVIVED: the length guard caught every case. I added the «same count, wrong second origin» case, and M2 now fails. M4, dropping `src/popup.js` from the embedded table, does not fail the pack test, because the zip equals the table by design. It fails the install test (table ≠ disk), which is the layer that owns that property.
6. Privacy page and listing pack written. Screenshots were rendered with headless Chrome (`--blink-settings=preferredColorScheme=1`) and LOOKED at. Two fixes came from looking. The stylesheet was first served as `text/plain` and did not apply. In shot 1, the tab being handed over was already inside the group, so it was moved out. The page uses `.example` domains and no real brands.

**Drift from the TODO item:** the TODO lists `activeTab` among the permissions, but the manifest never declared it: `tabs` + `<all_urls>` cover what it would. Nothing was added. «Version bumped» became 0.1.0 → 0.2.0, because the permission set changed.

**Gate:** see Review.

## Review

*— claude-opus-5-5, 2026-11-26* (self-review in the same context. A fresh-context review by the orchestrator is still expected, AGENTS §10.)

**Gate (worktree, install `--filter '!@tentacle/mobile'`):**
- `bun test apps/browser-extension packages/cli/ packages/browser packages/tools/test/browser* scripts/test/browser-extension-pack.test.ts scripts/test/task-doc-signatures.test.ts scripts/test/changelog-guard.test.ts`: **3151 pass, 2 skip (opt-in), 0 fail**, 215 files.
- The prescribed glob `packages/cli` without a slash also matches `packages/client`. There, `packages/client/test/chart-args-roundtrip.test.ts` fails with `Cannot find module '@tentacle/core' from apps/mobile/src/transcript-history.ts`, because the mobile deps are not installed. It fails the same way with this diff stashed: it is environmental, not this task.
- `bun run typecheck`: exit 2 with **23 errors, IDENTICAL with and without this diff** (`diff` of the sorted `error TS` lines is empty). They are `apps/mobile/src/highlight.ts` (highlight.js not installed by the filtered install), plus `URL`/`RequestInfo` lib-type errors in `packages/agent` and `packages/cli/test/{a2a-wiring,serve-mcp-e2e}`. None is in a file this task touches. The first run DID show new errors in `scripts/browser-extension-pack.ts` (`Buffer` vs `Uint8Array<ArrayBufferLike>`). The zip code was rewritten on `Uint8Array`/`DataView`, and the zip bytes stayed identical (same sha256 before and after).
- `bun run lint`: clean (2711 files).

**Adversarial pass:**
- *Could the store id be widened by accident?* It is a compile-time constant in `@tentacle/browser`, not config or an env var, so no pod, file or model can add an origin. The id format is enforced. Allowed origins stay exact, with no wildcard (tests).
- *Does the dev path still work before the store id exists?* `browserExtensionIds()` is `[dev]`, so the manifest JSON is byte-identical to main's (the existing test «names ONLY the pinned origin» now asserts it via `browserExtensionIds()`, with `[0]` pinned to the dev id).
- *Status false positive?* After the owner sets the store id, every existing user's status reads «stale» until `tentacle browser install`. This is intended, since only reinstalling lets the store copy connect. The dev copy keeps working in the meantime.
- *Does removing `storage` break anything?* No `chrome.storage` call exists, and a test now ties every declared permission to an API use.
- *Is the zip really the embedded set?* Proved by the file-set equality test. Mutation M4 shows the embedded-set-vs-disk property is owned by the install test.
- *Privacy claims vs code:* only the local host — `connectNative` is the only channel and `rg "fetch\(|XMLHttpRequest|eval\(|new Function|import\("` over `src/` finds nothing. Session tabs only: `onWebRequest` returns early off-session (`ops.js:335`), and debugger events are dropped unless the tab is traced. The content script on every page keeps only JS errors in memory (`page.js` B4 ring). Password values are stripped (browser-inspect B3). The page also states that tentacle sends the session to the user's model provider, so it does not overclaim «stays local».
- *Not verified:* a real upload, so the store's actual reaction to the zip (`key` absent, warnings) is unknown. The store copy has not run in a real Chrome. The data-category labels in the listing come from the dashboard, which the public docs do not list (R5). The registration fee amount is not on the official page (R8).

**Model behaviour:** it researched before designing (R1 changed deliverable 3 from "implement" to "remove `storage`, justify the rest"). It wrote tests red first for every slice, and ran mutations, one of which exposed a weak test that was then fixed. One self-inflicted typecheck regression was caught by the gate and fixed.
