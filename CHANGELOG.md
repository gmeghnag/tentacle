# Changelog

All notable user-visible changes to tentacle are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Internal and test-only
changes are left out; the git history and the task docs under `docs/` have
those.

## [Unreleased]

## [0.9.0] - 2026-11-27

### Added

- **Built-in skills (off by default).** tentacle now ships three skills, `tentacle` (commands and how-tos), `tentacle-a2a` (A2A and Agent Cards) and `tentacle-workflows`: switch one on for a session with `/skills`, load it once with `/<name>`, or keep it on with `tentacle config set skills.builtin.<name> true`.
- **Container previews on `serve` (groundwork, off by default).** With `previews.enabled`, the agent can ask to show a running Docker or Podman container's loopback-published web port to your paired devices: you approve each one, no public URL, nothing persisted. The phone viewer comes in a later release.
- **HEIC/HEIF pictures work like PNG/JPEG on macOS.** `fs_read` of an iPhone `.heic` shows the picture to a vision model (and `image_view` zooms into it), and an attached HEIC is converted to JPEG; on a host without macOS's decoder (Linux `serve`, or a Linux terminal) the read or attach is refused with a sentence saying so.
- **Local status on the relay and the apps host.** Each answers `GET /__status` on a separate loopback-only port (4101 / 4201, `--status-port`) with aggregate counters and a 24 h per-minute history.
- **A container's web port on the internet (OFF by default).** With `previews.enabled` and the new `previews.links`, a `serve` lets the agent propose a running container's loopback web port at `https://<id>.apps.tentacle.so/` (`container_share`), through a tunnel `serve` dials out. You are asked every time and choose who may open it: whoever has a secret link (the default) or anyone with the address (public). `/previews` lists them, copies a link and stops one; it lasts while the session is open. HTTP/1.1 and WebSocket only; TLS ends at the apps host, which also needs the matching update.

### Fixed

- **A session no longer opens empty on the iPhone.** Reaching a session that was already followed, for example with "Open the session" on a workflow run, showed an empty chat until you switched away and back; its history now always appears, and "Open the session" goes back to the screen you already had.
- **Workflow run screen on iPhone.** The elapsed time now ticks every second, reopening a step always shows it, and Back is no longer ignored while the run updates.

## [0.8.0] - 2026-11-26

### Added

- **`tentacle serve` speaks A2A.** `--a2a-token` / `--a2a-token-command` turn on the Agent2Agent 1.0 JSON-RPC endpoint (`POST /a2a`, public agent card at `/.well-known/agent-card.json`) on its own bearer token. Each turn is a task that streams, can be cancelled and survives a restart or archive; `--a2a-asks both` lets the caller answer tool asks, `--a2a-workflows` lets it start workflow runs (both off by default).
- **tentacle can hand a sub-task to a remote A2A agent.** Configure one under `harnesses.<name>` with `"adapter": "a2a"`, its `card` URL and an optional `tokenCommand` (a command printing the token, never the token itself); the agent can then start it as the sub-agent type `a2a:<name>`, described to the model with the remote agent's own card text (read when tentacle or `serve` starts, waiting at most 2 s; refreshed for the next session). Every send (the task, and each reply to the agent's questions) goes through the permission prompt first, with secrets masked; auto mode answers that prompt, and "always" covers that one agent for the session. Only the task text leaves the machine, and the agent's report is marked as remote content. When the remote agent asks you a question (`inputFrom: "user"`), it pops up like a permission prompt — in the terminal and on the phone, with a notification — and auto mode never answers it for you. Laptop and `serve` only: a pod never offers it. A remote agent's question reaches you as a pop-up (Answer… / Skip). The agent may also propose an A2A agent nobody configured (`a2a_add_agent`, a public `https` card that needs no credentials — private, loopback and link-local addresses are refused): you approve it once, auto mode never does, and it lasts until `/clear`; nothing is saved.
- **Agent workflows (groundwork).** A workflow run's facts (start, each step's outcome, end) are now kept in the session history, and a run a restart cut short is closed honestly as "stopped · interrupted" when the session is loaded — never resumed by itself; the wire now carries the session's runs (`workflows`) for the TUI and phone views that follow. A `run` step can now execute inside an existing Docker container (`where: { docker: <name> }`, with `workloadShell.tool` on), asked for like a `workload_shell` call on that container, so an "always" approval covers that container only.
- **Agent workflows: run notifications.** A workflow run that ends now buzzes the phone — "Workflow finished", or "Workflow stopped: <reason>" when it stopped short — and a run parked on a decision still raises the ordinary permission push, so the phone can answer a step's ask and the hash approval; a newer daemon's run kinds show the app's placeholder on an older build rather than a broken banner.
- **Scheduled workflows.** A workflow can now start by itself on a schedule (`every 2h`, `daily 03:00`, `at …`): the model's `schedule_create` takes `workflow` (+ `inputs`), and the daemon answers a new `session/schedule_create`. The schedule pins the file's current content (its hash, approved once at creation, never at 03:00); an edited file stops it with a "re-create the schedule" note instead of running new content. A fire never waits for a turn and never queues behind a running run, a fire later than 15 minutes is recorded as missed instead of running hours late, `daily HH:MM` keeps local time across DST, and a fire that could not start is pushed to the phone (`run_not_started`).
- **The Chrome extension is ready for the Chrome Web Store.** `bun run browser-extension:pack` builds `dist/tentacle-browser-extension-<version>.zip` from the same files `tentacle browser install` embeds (manifest at the root, without the dev `key`, so the store assigns the id). The native host now accepts both the unpacked copy and the store copy, once the store id is set (`BROWSER_EXTENSION_STORE_ID`). `tentacle browser install` writes both origins and links the store page. `tentacle browser status` reports a host manifest written before the store id as stale. The extension no longer asks for the unused `storage` permission (version 0.2.0).
- **Browser inspection (groundwork).** A new internal `@tentacle/browser` package holds the pure core of the upcoming "the model sees and traces your Chrome" feature: secret masking for page-derived data (headers, cookies, URLs, JSON/form bodies), the rule for which browser actions must ask first, tab ownership per session and a bounded network ring. Nothing is user-visible yet.
- **Browser extension (not yet driven by the model).** `tentacle browser install` now also unpacks a small Chrome extension (key-pinned id) that groups the tabs it opens per session, reads/outlines pages, clicks and types on request, and attaches the debugger only on demand (detached after 10 idle minutes). Nothing uses it until the browser tools land.
- **Browser host groundwork.** `tentacle browser install|status|uninstall` registers the native-messaging host Chrome will use to talk to tentacle (a hub on a private unix socket that arbitrates which session owns which tab). No extension ships yet, so nothing is user-visible until it does.
- **Browser sessions: groundwork for auto mode, clear mode and the phone's Browser page.** A session that can reach your Chrome now carries two per-session switches — *auto* (browser actions that are not a payment, password or card step are answered allow-once by your own computer, never by the session's auto-accept) and *clear* (page results shown unmasked; asks stay masked) — both off, and never restored by a resume, a `/clear`, a move or a `serve` restart. A new `browser/status` read lists the link state and the session's own tabs without claiming the browser, and the session's tab group in Chrome now follows the session's title. The switches get their TUI and iPhone controls in the next release; until then nothing changes for you.
- **The model can see and trace your Chrome (read-only, off by default).** With the tentacle extension installed (`tentacle browser install`), a session on this Mac (TUI, `serve` and its phone sessions; never a pod or a sub-agent) can turn on the `browser` tool group in `/tools` (or `tools.enabled.browser: true`) to get `browser_tabs`, `browser_open`, `browser_read`, `browser_shot`, `browser_net` and `browser_console`: it opens pages in its own tab group, reads text or an outline, takes screenshots, lists network traffic (bodies and WebSocket/SSE messages after `op: start`, which shows Chrome's debugging bar) and the page console with JS errors. Secrets (auth headers, cookies, tokens in URLs and bodies) are masked before the model sees them, every page-derived result is marked as untrusted, and every `browser_open` asks first. Chrome is started in the background if it is not running.
- **Browser controls in the TUI and on iPhone.** In the TUI, `/browser` opens a panel with the link to your Chrome, the session's tabs and three switches (browser tools, act without asking, show secrets), also as `/browser on|off|auto|ask|clear|masked`; while the browser is on, the status bar shows `◉ chrome N tabs`, plus `▲ AUTO` and `▲ SECRETS VISIBLE` while those are on, and `⊘ N tools off` no longer counts the browser tools. On the iPhone, Session info gains a Browser row opening a page with the same link, switches and tabs, and a strip above the message field says when the browser acts alone or secrets are visible, with `Change ›` to switch it back. The Chrome extension now has the tentacle icon.
- **`tentacle connect` can reach a `serve` with no open port.** Pair the laptop once (`tentacle pair` on the host, `tentacle connect --pair '<line>'` here), then `tentacle connect <name>`: direct addresses first, the relay last, end-to-end encrypted. The laptop gets a paired phone's rights on that project; `--forget <name>` drops it, `tentacle devices revoke` on the host cuts it off.
- **Coverage and test-count badges in the README, refreshed by every release.** `bun run release` (and `bun run badges` on demand) runs the suite once with coverage and rewrites two README badges: the line coverage of every source file — a file no test loads counts as uncovered, so the number is never flattered — and the count of passing tests. Polpetto at the top of the README now hops and blinks.
- **The mobile e2e gate can run on two simulators at once, from one Release build.** `scripts/e2e-gate.sh <udidA>,<udidB>` runs the same full suite on both, split by each flow's last recorded duration and keeping together the flows that share a seeded session (07 adds a turn to the session 26 renames), each half with its own `serve`, mock model and Maestro device. There is still one summary table in the same flow order and one exit code, and a flow a dead half never reported is RED rather than skipped — so the gate does not get weaker by getting faster. A Release build is now reused across runs when nothing it is built from changed (the app and package sources plus the Xcode and Bun versions, keyed by content, so a JS change rebuilds): a hit logs `app: cached <key>` and skips `prebuild`/`xcodebuild`, and `--no-app-cache` forces a rebuild. The single-simulator form is unchanged.
- **`fs_read` of a `.png` / `.jpg` / `.jpeg` now puts the picture in front of the model.** A vision session's read stores the file through the same tool-image path `image_view` already uses (the 48 MiB sub-cap, refusal without eviction, dedupe on the bytes) and answers with an `[image <name> · W×H · <format> · <size> · ref <hex> · high only]` marker, so `image_view` shows it — **`high` only** (the original bytes; `low` needs a decoder, coming with slices 3a/3b, and asking for `low` on such a ref now serves `high` with a plain note instead of the false "already ≤ 768 px"). The type comes from the bytes, never the extension, and the same bytes give the same ref. A file a provider's decoder would refuse is refused up front with one sentence rather than a 400 that stays in the history: a bad IHDR CRC or a missing `IEND`, a JPEG cut before `EOI` or with no frame header, CMYK / 12-bit / arithmetic-coded / lossless-hierarchical JPEG, or a side over the cap (8000 px on Anthropic, 1568 px on OpenAI-compatible). A file over the model's byte cap gets the shared reason line; GIF, WebP and HEIC are refused naming the type; a `.png` holding text is still read as text. Sessions without vision, pod daemons and sub-agents keep today's behaviour exactly, and a `.png` read there is still mojibake (a known debt, unchanged). No wire or store-format change.
- **image_view zooms into JPEG pictures.** A `region` of a photo or other JPEG is sent at up to the chosen detail, oriented as the photo is displayed; `low` now works for JPEG files.
- **image_view zooms into PNG pictures.** A `region` (fractions of the picture) sends just that part, at up to the chosen detail; `low` now works for PNG files and screenshots.
- **The model can look at a PDF's pictures on demand (`image_view`).** On a vision model (worker and `serve` sessions), `fs_read` of a PDF keeps each picture in the session and its marker carries a short ref (`[image p.N · W×H · ref a1b2c3d4e5f6]`); the new `image_view` tool puts exactly ONE of them in front of the model, at `low` (≤ 768 px, the default) or `high` (≤ 1568 px) detail. A picture that covers most of the page gets a hint to use `high` for small text. A scanned PDF now returns its page markers (the "looks scanned" verdict first) instead of refusing, so the model can view the pages. New settings: `model.imageDetail` (`auto` · `low` · `high`) and `model.imageTokens` (an image's cost in the context estimate; default 1600 on Anthropic, 3200 on an OpenAI-compatible endpoint). Old views are pruned with a line to view them again. Not in pod sessions or sub-agents; images you attach yourself are unchanged.
- **Mobile: the drawer shows which sessions need you.** A session row carries a small glyph for a pending ask (hand), a live workflow run (curve path) and an armed wake (clock); no glyph when the daemon reports none. `session/list` now carries those two counts itself — unanswered asks and workflow runs still live or waiting on the user (`workflows` absent where the session runs none) — so the drawer reads them from the list it already re-fetches on open, with no extra request.
- **Mockup kit: THE ask, and the permission sheet realigned to it.** The kit gains `K.askCard` (origin row whose glyph comes from the origin's `kind` — Polpetto's silhouette for the main agent, the branch for a sub-agent, the curve path for a workflow step — a four-row command with `+N lines · Show all`, and grey Deny / accent Allow once capsules outside the scroll), `K.askSlim` (the one-row peek/banner form, which never draws an answer) and `K.askSheet` (the formSheet frame, undimmed only at the peek detent). `K.permissionSheet` now draws that card inside the sheet instead of its own head/detail/pill stack, so the workflow and mobile-ask mockups match `PermissionSheet.tsx` again; `options`, `origin`, `title`, `detail` and `diff` stay parameters, and Polpetto's mask is folded from the app's own `polpetto-glyph.ts`.
- **Copy a message on the phone.** Long-press a message to copy it whole (a light haptic and a "Copied" confirmation); "Select text" opens it in a sheet where any part can be selected and copied.
- **File previews in the phone's transcript.** A file the model presents now shows an inline preview above its name — a PDF's first page (and its page count), the image, a markdown or text file's first lines, an HTML page — made on the iPhone with QuickLook, kept beside the artifact cache and shown offline once made. While it is being made the card keeps its final height with the file's symbol; a file the computer no longer has reads "no longer available", dimmed and not tappable. Tap opens the existing viewer.
- **A phone shows a file tool's content coloured by its type, with one line-number column and its header said once.** A Read / Edit / MultiEdit / Write row's open body is now syntax-coloured from the file's EXTENSION (unknown extension, or a file over the TUI's 2000-line / 200 KB cap, stays plain), with one number column — the new number, the old one on a removed line — and the `+`/`−` sign plus the add/remove tint on every diff row, so a change is legible without colour. The body opens with a single light line (`lines 87–135 · HTML`, `lines 1–12 of 521 · TypeScript`, `JSON · new file`) instead of the tool's raw result (`⎿ [path lines 1-12 of 521]`, `edited … with 2 edits (+78 -30)`) and the file card that repeated the path and the counts up to four times; it previews the first lines with `… N more lines · tap to see all`, and the step's trailing carries the `+A −D` once. `.html` files are coloured including the JavaScript in a `<script>` and the CSS in a `<style>` — which also fixed a latent bug: the sub-language wrapper was being printed as literal `<span class="language-css">` text in any `html` code block. A chat code block and a tool body now share one scope→colour mapping.
- **Polpetto now enters an empty iPhone session with a small animated scene.** An empty, open session used to say "Nothing here yet"; it now plays one entrance for Polpetto — the owner's 9×9 sprite, 6 pt a pixel, centred just above the composer — and then leaves the screen empty. Nine scenes, ported from the approved mockup: *Paracadute*, *Skateboard*, *Sbuca dal campo*, *Nuota*, *Razzo*, *UFO*, *Mimetismo*, *Palloncino*, *Elicottero*. One is drawn at random per empty session, in one of the nine palettes, and never the same twice in a row (an in-memory app-wide memory). It plays once and never returns by itself, and the first message (or any transcript row) removes it at once, mid-scene. With Reduce Motion it stands still at home, eyes open, and no scene starts. The sprite's colours are the TUI's, pinned equal by a parity test, so the phone never imports `@tentacle/tui`.
- **Mockup kit generated from the app's source.** `tools/mockup-kit/` (`bun run mockup-kit`) gives design mockups the real palettes, type, sizes, style metrics and animation timings of the iPhone app and the TUI, kept in sync by a drift test; `docs/MOCKUP-BRIEF.md` says how to use it.
- **New session from a project's session list.** The phone's list of a project's sessions now has a New session button at the bottom — the same one as in the drawer: it starts a session in that project and opens it ready to type; while the computer is offline it stays dimmed and says why.
- **Try a Figtree theme on the iPhone.** Settings → Beta → "Tema Figtree (prova)" (off by default, remembered on the phone, applied at once): the whole app switches to the Figtree typeface (code stays monospace) and, in dark mode, to a deep petrol background (#151B1D) with softer text and a cyan accent; light mode changes only the font. Off is exactly today's look.
- **Workflows: land on the list, and approve or delete a workflow from the phone or the TUI.** The session's Workflows button now opens the workflow list itself — runs that need you or are in progress on top, `Recent runs ›` below them, then each workflow with **Start · Approve · Delete**. Approve raises the usual approval ask (on the phone, as the permission sheet over the list; nothing is approved without your answer), and Delete asks first and removes only the YAML, keeping its prompt files. The TUI gets the same two actions as `/workflow approve <name>` and `/workflow delete <name>`. Both need an updated tentacle on the computer and are not offered to pod sessions.
- **Tool results can carry images to the model.** A tool result's images reach a vision model: inside the `tool_result` on Anthropic, and in one wire-only message right after the tool results on an OpenAI-compatible endpoint with `model.images: true`. The newest 20 tool images per request are sent, a budget separate from your own 5. Every image that is not sent leaves a visible line saying why (older than the newest 20, no vision, unavailable) — never a silent drop. `fs_read` on a PDF now marks each picture where it sits in the text (`[image p.N · W×H]`), skips tiny images, marks a picture repeated 3+ times (a logo) as `same as p.M`, and ends with an `[images: …]` line when anything was skipped or over the per-read cap (32 images / 8 MiB). PDFs up to 100 MiB are read (was 50 MiB).
- **Pairing is per project.** `tentacle pair` pairs the phone with the `serve` of the folder it runs in (`--project <dir>` for another), and only that one; with no `serve` running there it refuses. A `serve` with no device paired to it never dials the relay (until a phone paired before the upgrade first connects to one project, every `serve` dials it; a stale old pairing keeps that up until `tentacle devices revoke` or `reset`), and its direct address names it (`/s/<id>/e2e`). `tentacle devices` groups by project, and `revoke` acts on one project (`--project`, or `--all-projects`). A phone paired before keeps working, with no re-pairing, on the first project it connects to. Restart every running `serve` after upgrading: an older `serve` refuses the new registry and admits no device. The app pairs per project now; an app installed before this release is told to update instead.
- **`tentacle run --network <name|none>`.** A docker/podman run now chooses its
  container's network at create (`--network` › `TENTACLE_NETWORK` › profile ›
  config `network` › the engine's default `bridge`); `--network none` is an
  air-gapped run — the daemon rides the exec's stdio and the model is RPC to the
  laptop, so nothing in the container needs egress. A malformed value, a network
  with `--engine kubernetes` (a pod's network is the cluster's) and a network the
  engine does not have are each ONE refusal before anything runs, and an unknown
  network no longer triggers a pointless image pull. `/move container` honours the
  same configured network (`TENTACLE_NETWORK` › profile › config) for the
  container it creates, instead of silently leaving it on `bridge`.
- **`tentacle serve` is an MCP server.** `--mcp-token` / `--mcp-token-command` turn on a Streamable HTTP endpoint (`POST /mcp`, both the legacy `initialize` and the 2026-07-28 `server/discover` forms) on its own bearer token, so Claude Code and other MCP clients can start, steer, watch and cancel tentacle sessions that also show up on your phone. Clients that support MCP tasks get one per turn, recorded on disk before it is handed out (`tasks/get` follows it and survives a restart, `tasks/update` answers its approval, `tasks/cancel` stops it); the others get non-blocking tools plus a `session_status` wait. Your phone answers the session's approvals; with `--mcp-asks both` the caller may also allow or deny a tool approval once (`session_answer`), never permanently, and the first answer wins.
- **Apps host for session apps.** A new service (`apps/apps-host`) keeps a single-file HTML app published by a tentacle `serve` and serves it at `<id>.<apps domain>`: network off, a first-visit warning with a Report link, size/rate/count caps, a lease that lasts as long as the session, a kill switch and takedowns. Not deployed yet; the publish tools come next.
- **Publish a page as a session app.** With `apps.enabled` on, the agent can publish an HTML page it has already shown you (`present`) at a public address under `apps.tentacle.so`; you approve every publish and every update (never «always»), the approval shows any secret-looking text found in the page, and the page stays up while the session is open. `/apps` (and the phone's session info) lists them with their state and stops one. Off by default until the apps host is deployed.
- **A sentence of what a shell command does.** The model now describes each `shell` call in a few words, in your language; the TUI and the iPhone title the row with that sentence and a written outcome (`✓`, `✗ exit 2`), with the exact `$ command` on a line under it. A row without a sentence looks as before. The TUI permission ask now shows the whole shell command in full colour, wrapped over several rows (a very long one ends with `… N more lines`) instead of one dim, cut row. Beta: `beta.compactShell` (TUI config) and Settings → Beta → Compact shell rows (iPhone) show the `$ command` line only when the command fails.
- **Sub-agents on another agent harness: `claude`.** On the laptop and on a `serve` you own (never in a pod), when `claude` is on PATH the agent is offered an `agent_task` type `claude`: Claude Code runs headless in its own git worktree holding a snapshot of your tree (uncommitted changes included), with the model chosen per call (`opus`, `sonnet`, `haiku` or a full id; default `harnesses.claude-code.model`). Every permission Claude Code asks for comes to you through the usual prompt (TUI or phone), attributed to the sub-agent, and follows auto mode: with auto mode on everything in the run passes; with it off, edits inside its worktree pass and commands or anything outside are asked. Your session's grants and `tool_call` hooks apply. Its report ends with the list-price cost, the 5 h / 7 d plan usage and the `claude --resume` session; a worktree it changed is kept on its own branch, never merged. A workflow step can use it too (`type: claude`, `model: opus`): its result is enforced against a schema and becomes the step verdict. New `harnesses` config section.
- **Switch built-in tools off.** `tools.enabled` in the config (or a profile) turns built-in tools off by group (`subagents`, `shell`, `schedule`, `visuals`, `context_reset`, `move_session`, `workload_shell`) or by name (`fs_multi_edit`, …), so a small local model gets its context back; the new `/tools` panel shows what each definition costs the context (`~N` tokens) and switches them for the session. A tool that is off is never offered to the model — in a pod too, and in sub-agents — and a call to it is refused, never run. `skill` is always on.
- **Clickable links in the TUI.** http(s) URLs in the transcript are underlined and open in your default browser with a click; a presented artifact's title is underlined (a click opens it). Markdown links always show their address (`text (url)`), in every terminal.
- **A startup header in the TUI.** A fresh session now opens with a header — tentacle and its version, the model and folder, and the `/help` hint — which replaces the old `Tentacle ready.` line. The folder is shortened to fit the window.
- **Create and edit a workflow on the iPhone.** The graph view gains an edit and create mode: a ＋ on each edge inserts a step, dragging a step's ✗ port onto another rewires its failure path, the `✗ ×n` / `↻ ×n` labels edit retries and loops, and a template creates the YAML together with its `workflows/prompts/*.md` files. Save first shows exactly what will be written (files, patches, hash, version, every other workflow a shared prompt touches) and then writes it through `serve`; the saved file is a brand-new hash, so the next run asks for approval as any hand-edited workflow does.
- **The agent knows a workflow is running.** Each request carries one short status line for the session's live run (step, waiting for you, retry/round, tokens); a run's end reaches a running turn at its next step; a step left waiting for you on an unattended `serve` session wakes the agent once.
- **Workflows: the project's catalogue, a start pinned to the file you saw, and one step's prompt and report on demand.** A new `session/workflow_catalogue` read lists the project's workflow files — each validated and hashed against that session's models and agent types, with whether its hash is approved — asking nothing and starting nothing. A start now carries the `hash` the caller saw, so a file edited in between is refused `changed` with nothing run, and every refusal carries a machine-readable `refusal` word (`changed` / `running` / `invalid` / `inputs` / `unavailable`) beside its text. The catalogue names the absolute folder it read, and, when that folder holds no workflow, where some were found higher up — a display-only hint that can never be loaded. A second new read, `session/workflow_step`, answers the resolved `prompt` and the `report` of a single step execution — the detail a run's live row deliberately does not carry — choosing the newest attempt by default or the `attempt`/`round` asked for, and saying "not available" (an empty answer) for a step that never ran or whose record a compaction has since dropped, rather than showing another step's text. A step still running answers as live, with its prompt and no report. The client reads it — and the catalogue, and a run's live list, and the start / stop / resume / re-run-step actions — through one bounded, sanitized seam per session (`@tentacle/client`'s `workflows` module), so a `serve` daemon's runs reach every attached terminal and phone; from a daemon this client does not trust to run workflows (a pod under `run`/`attach`) the list is dropped and every action refuses locally, sending nothing. In the TUI, a run in flight now shows as a rail above the input — a header with steps done and tokens against the budget, then one row per step with its glyph AND its word (`✓ ok`, `▸ running`, `? needs approval`…; a state this build does not know is shown as its own word), windowed to seven rows around the active step on a long graph, narrowing by dropping `[where]` then the model — taking its rows from the transcript so the input never moves, and leaving when the run ends. `/workflow` opens a two-column panel (the steps; the selected one's detail, with `o` to read its prompt and report and `r` to re-run it), and `/workflow run <name> [k=v …]`, `stop` and `resume` act on the session's run, every reply or refusal shown as a notice. At rest — no run in flight — the live area carries one line naming the project's workflows and what each needs (`? needs approval`, `✗ invalid`, `✓ approved`), narrowing with the terminal from names and words to glyphs to a count, and saying nothing at all in a project with no workflows; `/workflow` lists them above the runs with an invalid file's errors and its path, says whether git ignores the folder, and `run <name>` now pins the hash of the file the person saw, so a file edited since is refused `changed` instead of run as something else — a workflow whose required inputs were never given pre-fills the command instead of starting half-specified. The list is re-read when the session opens, when a turn ends, when a run ends, when an approval is answered and on `/workflow`, never by polling, and its one line takes its row from the transcript so the input never moves. On the iPhone, the session hub gains a Workflows item — badged with how many runs wait on you, dimmed with "No workflow runs" (or "Update tentacle on this computer" for an older daemon) — that opens the computer's runs grouped as needs you / in progress / finished, re-read on open, on pull and (debounced) whenever a run changes, keeping the last list with an offline line when the link drops; a run opens as a vertical graph or as one card per step (the choice is remembered), each step with its glyph and word, with Stop, Resume and Re-run step, and an approval shows its request verbatim — scrollable, never cut — with Allow once / Deny answered through the session's own permission sheet, the buttons leaving as soon as the request is settled anywhere. A session that ended between the list and the tap says so instead of being reopened. Tapping a step — a node in the graph or a card — opens its detail where it stands: the pill grows into the header over 380 ms, its badge, glyph and both texts growing with it, the graph stepping back and fading as the rows stagger in; the state and attributes are final the moment it opens, and the prompt and report fill into a skeleton that already has the loaded layout's boxes, so nothing above them moves when they arrive. The back (or the backdrop) reverses the morph, one flight at a time; with Reduce Motion the same layout crossfades in with the skeleton stilled. On the iPhone a session's Workflows screen now offers "Start a workflow": the project's catalogue with each file's approval state in a word and a glyph (`✓ Approved` / `? Needs approval`) and, for a file that does not validate, its errors verbatim each naming its YAML path; a file opens as its description, every step — a `run` step's command whole, never cut — and a form of its declared inputs prefilled with the file's defaults, where an optional field left empty is OMITTED so the default still applies. Start pins the hash the catalogue showed, so a file edited since is refused `changed` and the catalogue reloads keeping what was typed, and a run already in flight opens instead of starting a second.
- **Phone run view: laid out from the definition, with a marker per state.** A run's graph now places each step where the workflow's own edges put it — the pass path down the spine, a `goto`'s target in the side column beside the step that failed, a back edge as an arc — so a first render can no longer put two pills on top of each other, and the counters (`✗ 1/2`, `↻ 0/1`) sit outside them. Every state has its own look without colour: a soft disc with its own glyph, *not yet* a plain disc with none, *not run* a dotted ring, and a state this build does not know keeps the daemon's own word.

### Changed

- **Apps first-visit warning is a dialog over the app.** The notice now appears over the app, shown blurred and inert behind it, instead of replacing it; Continue remembers the choice and reloads into the app.
- **The browser tools can now act, and ask first.** `browser_click`, `browser_type` and `browser_close` join the browser group. A form submit, destructive or payment wording, a link or form to a new domain, a password / card / one-time-code field, or the first action on a tab you handed over asks you first, allow once or deny, and the session's auto-accept never answers it. `browser_open` asks only for a domain the session has not visited. A tab that was closed is reopened at its last address instead of failing. `browser_close` releases a tab you handed over back to you instead of closing it. `tentacle browser install` now works from the compiled binary: the extension is built in.
- **Browser plugin shows real session names.** The Chrome tab group is labelled with just the session's name (unnamed: `tentacle` + 4 id characters), and the extension popup lists each session by name with its id, in a restyled light/dark popup.
- **Switches work before the first message.** In a new or resumed session, `/mcp`, `/skills` and `/tools` can switch servers, skills and tools on or off before anything is sent. The switches apply from the first message, so the first model call already runs without them.
- **A picture the user attached goes on-demand after 2 turns.** From the third turn on, an old user image is no longer resent with every request: its message carries a pruned-image placeholder line naming `image_view` instead, so the model can still look at it but the tokens are only paid when it does. The stored history, the log, the TUI and the phone are unchanged — a resumed session ages the same pictures the same way.
- **Mobile: the permission ask is one standard card and never blocks.** The ask shows who is asking, a four-row command preview, and small Deny / Allow once buttons (rare options behind `…`). Swiping it down parks it into a banner under the header instead of withdrawing it, so you can open the drawer and switch session.
- **A workflow run's own ask opens as the sheet over the run screen.** The run screen no longer answers inline: it keeps one slim row (`Review` when the sheet was swiped away, `Open the session` for an ask that is not this run's), and asks are paired to their step by the structured origin instead of the agent id.
- **iPhone: a clearer mic and send button in the composer.** The `+` and the mic now sit in the same soft accent circle with a full 44 pt touch target. While you dictate, the mic shows a filled stop square, a pulsing halo and the elapsed time; once you stop, a spinning arc and "…" show the last words are still being transcribed (and the mic ignores taps until it is done). None of these states rely on colour alone, and Reduce Motion holds the halo and the arc still. The send button is a soft accent circle with an accent ↑ when there is something to send, and a faint bare ↑ when there is not. The text field's border no longer turns accent while recording.
- **iPhone: the empty composer rests on one row.** When the field is empty and you are not typing, the composer is a single row — `+`, the "Message tentacle" hint and the mic — and the faint send arrow that did nothing is gone. Tap the field and it opens to the usual two rows with the keyboard. It stays open while it holds something (text, a photo or file, a dictation), and ■ Stop still sits on the closed row while a turn runs.
- **iPhone Artifacts gallery: tidy chart thumbnails, bigger tiles and a grid view.** Chart thumbnails stay inside their tile (bars and legend chips used to spill down the list), show only the chart's shape, and fall back to the kind's symbol when a chart is too dense to read at that size. List tiles are a little bigger, every kind has its own thin symbol, and a button in the gallery header switches between the list and a three-column grid — the phone remembers your choice.
- **The floating Activity button can rest at the center, and it floats.** Drag it to the left, the center or the right; nothing behind it keeps space free for it any more (a queued message now lines up with the ones already sent), and while you scroll the chat it fades to 20 % and lets your taps through, coming back 600 ms after you stop. Settings → Activity button → «Keep the chat's end above the button» (on by default) decides whether the last message stops above a button resting in the lower half.
- **Mobile: the jump-to-latest pill is just the ↓ arrow.** The "Jump to latest" label is gone (VoiceOver still reads it); "New messages" still shows when something arrived off-screen.
- **Mobile: native iOS sheets with three detents.** The five session sheets (permission, outbox decision, commands, tools, session info) are now native `formSheet` routes instead of React Native modals: each opens at the middle detent, drags between short / medium / large, dims the conversation behind it, expands to large on a scroll, and keeps the layout you left when it re-opens. A permission ask in progress can no longer be dismissed by a swipe or a backdrop tap — a blocked attempt answers with a light haptic and an inline "Answer to continue" note — and "Not now" withdraws it explicitly — and the lock now drains every sheet before the app leaves the screen, so nothing of a session is left in the app switcher; the same sheets come back after unlocking, with the ask still pending. The Tools sheet no longer has pull-to-refresh (it took the drag that expands the sheet): it refreshes itself when it opens and as its data changes, and its Refresh link stays.
- **The app lists each paired project under its computer.** Computers shows one row per project you paired (`tentacle pair` in its folder), with its own written status (Working, Idle, New, Stopped, Not reachable, Access removed), and "Pair a project on this Mac" in each computer's band. Pairing another project of the same Mac adds a row instead of replacing the one you had. A stopped project is retried every 15 s while the screen is open. A project's addresses refresh by themselves after its `serve` restarts on another port. A phone paired before keeps its project with no re-pairing.
- **A context reset and a compaction are timeline steps on the phone.** The transcript no longer draws a `↻ context reset by the model` divider followed by a full restart-prompt bubble, nor a `compacted · ctx A → B` separator line: each is ONE node of the step rail (`↺ Context reset` / `⤡ Compacted`), with the prompt's first line or the `ctx A → B` figures beside it, and the whole prompt/summary one tap away. A successful `/compact` started on the phone now leaves its step at once, and live matches a reopen. The TUI is unchanged.
- **Mobile: a shell step's output is a terminal block.** It no longer wraps — one horizontal scroll with a fading edge, always neutral (the failure is the step's `exit N`) — and a long log shows its last lines («… N earlier lines»). While you read inside an open long output, the step's row sticks to the top with «line X of N» and «Collapse».
- **iPhone: every step on the thread is now one shape, and a failure is written once.** A done step's trailing text is its duration alone (`52 ms`) — the `✓` / `✗` are gone, for a success and a failure alike; a failed shell call puts its exit code at the end of its `$ command` line (`$ podman ps … exit 125`), the command shortened with `…` when it does not fit and the code never, written in words because colour alone is not enough. The rail stays continuous from the first step to the last and grows a small branch to a step's `$ command` line instead of a `⎿` stamp, and the reasoning node stops being a `∴`: a filled dot in the accent while it thinks (the same dot and blink as a running tool), a dim outline ring once it has (`Thought · 2 s`). Opening a step no longer says the same thing twice — the command and the exit code each appear once (on the `$` line), the body's `⎿` is gone and its output is no longer indented past the title.
- **iPhone transcript: fuller prose, quieter tool rows.** The app now bundles Figtree Medium (500) and SemiBold (600) with their italics — a `fontWeight` no bundled face carried was silently rounded to Regular, which is why a step title had the same weight, size and grey as the prose. Assistant prose and lists read at 500 on the dark theme (400 on light, bold still 700), and tool step rows step back by size and lightness: 14 pt `sec` at 400, with the duration one size down at 13 pt.
- **Workflows landing: real buttons and the ask under the navbar.** On the phone, each workflow now has capsule buttons (Start filled, Approve only when needed, Delete alone on the right) over one grey line of state and description; a pending approval or other ask shows as a banner under the header that opens the usual permission sheet when tapped, instead of popping up over the list, and being offline is said once.
- **Phone ↔ computer traffic is ~25 % smaller.** The end-to-end channel now sends raw binary frames instead of base64 text; the app and tentacle must be updated together (a mismatch says which one to update).
- **The test gate runs across cores.** `bun run test` (and so `bun run check`) now runs the whole suite with Bun's parallel runner — one worker per core, each file in a fresh global and module registry, slowest files first from the committed `scripts/test-timings.json` (`bun run test:timings` refreshes it) — finishing in about a minute instead of ten, with the same pass/fail verdict and a stricter one: a test file that kills its own process is now a named failure instead of a silent exit 0. Bare `bun test` still runs the same files serially for bisecting an isolation question, and `bun test <path>` is unchanged for iteration.
- **A shorter README, with the details in guides.** The README now holds only what tentacle is, how to install it and where to read more, under the new Polpetto icon; the full text moved, unchanged, to `INSTALL.md`, `CONTRIBUTING.md` and `docs/guide/` (running, remote, configuration, features, hooks and packages). The generated config-key table lives in `docs/guide/configuration.md`.
- **The model now knows where it works.** Every session's system prompt — the default and a custom `systemPromptFile` — ends with the session's working directory and platform (the pod's path in `run`/`attach`), stable for the session's prompt cache; `systemPromptEnvironment: false` turns it off.
- **TUI shell rows: the command first, the output on ctrl+o.** A `shell` call now draws one shape, described or not: collapsed it is its title plus `⎿ $ <command>` with `exit=N` at the end of that row when N ≠ 0 (never cut), and its output only with ctrl+o — where the whole command opens the block, its last row carrying the code, and the output follows at col 2. A row without a sentence keeps the command in the title (code before the duration) and moves it into the block when expanded. The misaligned `  │ $ cmd` rows of the expanded view are gone, and `beta.compactShell` no longer changes the TUI (the phone keeps its own switch; the config key stays accepted).
- **One shape for every tool row in the TUI: no repeated outcome, the command inside the `⎿` block.** A described `shell` call no longer writes `✓` or `✗ exit N` in its title (the duration stays); the outcome is written on the block itself — `exit=N` only when N ≠ 0, as the block's first line under `$ <command>`, which is now the block's first line (dimmed, `⎿ $ …`) instead of a row of its own above it, so its output aligns with every other tool body. A successful command writes no `exit=` line at all (the line's absence is the success — the owner is colour-blind), including a spilled result and a plain `Bash <cmd>` row; a command with no output is then the title line alone. `Edit`/`Write`/`Read` rows, the expanded view (ctrl+o) and the permission ask are unchanged.
- **Workflows now live in `.tentacle/workflows/`, and know where they are looked for.** A project's workflow files moved from `workflows/` at the repo root to `<cwd>/.tentacle/workflows/` — the same folder as tentacle's other per-project files, versioned in git (this repo's `.gitignore` now excludes `.tentacle/*` but not `.tentacle/workflows/`). The folder and its children are spelled in ONE place (`@tentacle/core`'s `PROJECT_PATHS`), a symlink is now refused at every component of a workflow path (`.tentacle`, `workflows`, the file), and a missing file's error names the absolute folder tentacle reads, so a file written in the wrong place says where it belongs.
- **Workflow runs read honestly at rest and in every step.** The TUI is quieter: the `◇ workflows …` line above the input is gone — the project's workflow files now appear only in the `/workflow` panel — and before a session's first message that panel says "no workflow run in this session yet" instead of claiming the computer does not support workflows. Every step of a run now reads as one of a shared set of states — *not yet* versus *not run*, *needs approval* versus *waiting on you*, *stopped*, and a state this build does not know kept as sent — with its edges drawn as taken, possible or never, the `✗ 1/2` and `↻ 0/1` counters, the run's timeline and its summary strip. A step that never ran says why («Not run — review passed on its first try.») instead of appearing as *waiting* inside a finished run's chain. The `/workflow` panel also lists the run's own frozen routes for the selected step — `next → confirm`, `on fail → fix (0/2)`, `retry 1/2` — so the terminal shows the same graph the phone draws.

### Removed

- **The "workflows found higher up" hint is gone.** When a project's `.tentacle/workflows/` held no workflow, the `/workflow` panel and the phone's start screen used to name a parent folder that did (`no workflow files here — ~/x has 3`) and suggest starting tentacle there. Nothing looks above the current folder any more: an empty catalogue names only the folder it read, and the neighbouring-folder lookup was removed from every layer (core, cli, driver, wire, TUI, phone). A workflow is still started from the folder tentacle runs in.

### Fixed

- **A remote agent's question inside a workflow step is shown over its run.** `question_request` carries the step's workflow origin (`README`-visible on the phone's run screen), so an A2A question raised by a step's child pairs with that step's card instead of falling through to «Open the session»; the run screen's bar says **Answer** for a question and opens the sheet's own text field, sending nothing until the person writes one.
- **A2A sub-agent answers are no longer duplicated or cut.** A server that closes an artifact by re-sending its whole text (`append:false`, `lastChunk:true`) no longer makes the parent see the answer twice; the client now honours A2A `append:false` as a REPLACE of that artifact's text, and the replaced text gives back its share of the 64 KiB output cap — so an answer under 64 KiB is no longer truncated by its own closing replace, and one over it keeps the cap's worth instead of coming out empty.
- **Agent workflows: a `run` step now executes exactly what was approved.** A `tool_call` hook that rewrites a step's command (or its target workload) used to have its rewrite shown in the permission ask and then ignored, so the step ran the file's original command instead — the fix runs the approved one, and refuses the step rather than falling back when the approved input names no command or a workload a `run` step cannot express. A `where: { docker: <name> }` step also refuses `container:` at load, with its YAML path, instead of validating, approving and asking a file the container seam can never run.
- **Anthropic prompt caching.** The Anthropic provider now sends `cache_control` breakpoints (end of tools+system, and the last message), so the ~20k-token fixed prefix is read from the cache (0.1× price) from the second request on instead of being re-billed in full every round (~88% cheaper per follow-up request on Haiku 5.5).
- **Anthropic API tool schemas are valid again.** Tools with a positive-integer parameter (`fs_read`, `shell`, `search`, …) made every request to the Anthropic API fail with `400 JSON schema is invalid … draft 2020-12`; tool schemas are now normalised to draft 2020-12 on the Anthropic wire.
- **A `serve` stopped with SIGTERM or SIGHUP now shuts down cleanly.** `kill`, `pkill` or closing its terminal used to kill it outright, leaving a stale entry under `daemons/` and skipping the final session save; it now stops like Ctrl+C, and stale entries left by a crash or a reused pid are cleaned up. A `serve` started under `nohup` now stops on hangup — use tmux, `setsid` or a service manager to keep it running.
- **`run` and `attach` work in a non-root or read-only pod without `--bin-dir`.** The install dir for the injected binary is now picked in the pod, before any upload, by one probe that proves the dir can be written to and executed from: `/usr/local/bin`, then `$HOME/.local/bin`, then a private `$TMPDIR/tentacle-<uid>/bin` (an OpenShift random UID, a read-only root filesystem or a `noexec` `/tmp` no longer fail after the 60–90 MB transfer). When no dir works, the run stops before the upload with one error naming each dir and why. `--bin-dir` still forces a dir, and is now checked before the upload too. A matching `tentacle` already in any of these dirs is reused — also by `run` when the image ships this exact build — and `tentacle logs -f <run>` finds it wherever it was installed.
- **Mobile: one standard permission ask that says who is asking.** A permission ask now carries an optional structured `workflow` origin (workflow name, run, step and N of M) instead of making the phone parse it out of the sub-agent label, so the ask can name its workflow step, stays readable when the command is long, and no longer blocks switching session. The workflow driver fills it (`stepRequester`, and the schedule's approval with its name alone) and the daemon forwards it on both ask paths, so a workflow step's ask is named as such from the daemon instead of being read out of an `agent.id`.
- **Connect is faster and survives background / cell-to-WiFi. —** The next address is tried as soon as the previous one refuses (not after a stagger), the last working address is remembered across a cold start, returning to the foreground redials at once, `inactive` no longer drops the socket, pull-to-refresh keeps this session until the re-read succeeds, and the composer shows `This session has ended` for an ended session.
- **Mobile: "Send reply" is no longer hidden behind the keyboard.** In a permission ask, typing a "No, let's talk about it" reply used to leave the keyboard covering the Send reply button. The sheet now makes room for the keyboard and scrolls the button into view.
- **A message written offline on the iPhone is kept and sent on reconnect.** "Send when back online" now writes the message to the outbox at the tap (it used to wait for the link to come back, with the field already cleared, so a kill in between lost it), and the outbox runs as soon as the link is back on the open session instead of only when the session is reopened. Also: the hub's Activity says "Nothing running" again instead of opening a sheet with only "No scheduled wakes", and switches inside rows (Settings' Dictation/Read aloud/photos/notifications, Session info's MCP servers and skills) are reachable with VoiceOver — while a row with only a value (Session info's Model and Context, a Settings choice with its check) is still read as one, label and value together.
- **New session from the hub opens a new session again.** On the iPhone, the floating button's More → New session did nothing unless the sessions drawer had been opened first; it now checks the computer at the tap, creates and opens the new session, and when the computer is offline (or the create fails) opens the drawer, which says why.
- **iPhone dictation: stopping and sending no longer loses the words.** When the speech engine ended with an error right after you stopped dictation (or pressed Send), the transcript still on screen was wiped and Send did nothing; now everything shown is kept, and a Send you already pressed goes out. Tapping the microphone also gives a light haptic both when it starts and when it stops (it used to play only after the mic opened, when iOS mutes it).
- **Opening a session no longer scrolls visibly to the end.** When the list was still rendering its tail after the reveal, the growth was followed with an animated scroll; it now stays a silent jump, so the first frame is already the latest messages.
- **A long session is less likely to open short of its end.** The opening landing now stays hidden until the list actually rests at its end (one more silent scroll if not), and re-checks once, silently, after it ends. The exact cause of the rare "opens ~2 turns above the end" case was not reproduced.
- **A long session opens at its real end.** A transcript of about 110 rows could open one turn short, its last answer under the composer, until you touched it; the list is now shown only after its last scroll has landed.
- **A very long session opens on its end without visibly scrolling.** A session of a few hundred messages used to appear at a middle turn and scroll down to the end over a few seconds; its rows are now rendered in big batches while the list is hidden, so it shows the end at once.
- **A just-paired project no longer reads "Not reachable", and its first tap opens it.** A row whose
  status probe has not answered yet has its own `Checking…` state instead of being projected as a
  computer that does not answer, and a tap on a waiting (or stopped / not reachable) row now waits
  for that probe — up to 4 s — then opens the project if it answers, instead of silently re-probing
  (`apps/mobile/src/project-rows.ts`, `apps/mobile/App.tsx`). A tap that lands after you have moved on
  (another row, the menu, Add, a Pair, Remove, or leaving the screen or the app) no longer opens
  anything later.
- **Push notifications register again after a lost registration.** The app now reads the APNs environment from the running binary's signed `aps-environment` entitlement (via `expo-application`) instead of the JS bundle mode, so a sandbox-signed build no longer declares `production` and gets its token deleted on the first push; and the registration fingerprint is deduped per app run rather than across launches, so a registration the daemon lost (an APNs `gone`, a deleted store file) heals on the next launch instead of never. `serve`'s log now records `push-registered <device> <env>`.
- **Push banners show the rendered text, and tapping one opens the session.** The notification extension now reads the same Keychain service the app writes (it looked under a different name and always fell back to the placeholder), and a tap that launches the app is held until the app is ready instead of being dropped on the home screen.
- **Photos on the iPhone: the viewer shows them, offline photos are kept, sent photos keep their pixels.** Tapping a photo opens it full screen with a working ✕ (it drew nothing and could not be closed); a photo picked while offline now goes with its message when the phone is back online (it was silently dropped); photos you sent no longer turn into "Image not available" after the app comes back to the foreground, reconnects or relaunches; two identical photos in one message send as one instead of losing the turn; and the floating hub no longer covers the end of the last message.
- **iPhone: a running step reads whole, blinks like the Mac, and its detail shows only what ran.** The live label of a running step (a described shell command's sentence, «Thinking») is no longer cut mid-word or clipped at its last letter, in the default and the Figtree theme, light and dark: it is ellipsized at the row's real width like a finished step. A running tool step's node is now the blinking dot of the Mac TUI (same place and size as the finished dot, in accent, steady under Reduce Motion) instead of a turning ring. Tapping any tool step opens the exact command or input, the output and the outcome — no longer the model's reasoning.
- **Mobile: the "stream was lost" notice no longer stacks or survives a completed
  turn.** A turn's stream that throws once per reconnect now leaves ONE notice
  instead of one per throw, and that notice is retracted as soon as the same
  turn is seen completing — so a reply that arrived is never followed by "that
  turn's stream was lost". The app log's `qtrace` `turn-end` line for such a
  loss now also carries the throwing error's class and numeric code, so the next
  device capture names the trigger (`docs/fix/mobile-stream-lost-repeat.md`).
- **The phone names which side to update when it is older (or newer) than its `serve`'s protocol.** A paired computer whose `initialize` is refused with `VersionMismatch` now reads «Update the app» or «Update tentacle» — with the two protocol numbers («app protocol 28, serve 31») — instead of «Stopped · run `tentacle serve`» (a daemon that was running and answering) or «Not reachable», and its section reads «Needs attention» rather than «Offline». The side is derived from the protocol numbers in the daemon's own report, never from its text; a serve too old to send a report counts as the older side, and an unreadable report claims nothing. The session list's failure banner for the same error now names the side and offers no Retry, which no retry could fix. The Computers row for such a computer and the sessions drawer's title read the same word («Update the app» / «Update tentacle», not «Online» with a contradicting detail) and no longer offer New session, which the serve would refuse anyway.
- **A model server's own error is shown, and the remote-config hint only when it fits.** An error the server sends inside the stream (llama.cpp «Context size has been exceeded», an OpenAI-style `{error}`, Anthropic `overloaded`) now fails the turn with «model server error: …» instead of a «stream was cut» line; the «check its config and key on that host» hint is added only to key, URL, proxy and connection failures.
- **The model knows the current date and time.** A compact `[Fri 2026-11-20 13:42 CET]` line is prefixed to a user message when the model's sense of "now" would be stale — the first message of a session, a new local day, or more than 30 minutes since the last stamp — rendered in the laptop's own time zone (never a pod's UTC), kept out of the system prompt so the prompt cache holds. A scheduled wake is stamped with the instant it fired, and `schedule_create` now refuses a past `at` with the current time in the reason.
- **Smart compaction no longer leaves a `⟪pruned by tentacle: …⟫` placeholder inside a model's own earlier write/edit calls.** With `contextPrune.enabled`, a pruned `fs_write`/`fs_edit`/`fs_multi_edit` now loses its payload keys (`content`, `old_string`/`new_string`, `edits`) instead of having them replaced by a stub string in a value position — a weak model had read that string as a value to imitate and sent invented placeholders (refused by the write guard, two wasted rounds, then a full rewrite). The note saying where the text went is appended to the call's result, and the last two payload calls on a file still being worked on (a call naming it in the last twice-`keepRecentRounds` rounds) keep their arguments unchanged.
- **The composer's ■ Stop and microphone stay on the field's row after the keyboard closes.** Focusing then leaving an empty field (while a turn ran, or with dictation on) wrapped the trailing button below the composer onto the home-indicator edge; the resting row is now one line. The «jump to latest» pill moves above the hub when the hub rests at the centre instead of hiding under it, and the workflow Delete question shows the file name in monospace without literal backticks.
- **The model gets its own reasoning back.** Reasoning models (DeepSeek, Qwen3, Claude) now receive the reasoning of their earlier rounds on every later request, in their provider's own format (`reasoning_content`/`reasoning`, or Anthropic's signed `thinking` blocks), instead of re-deriving it each round of a tool loop. The reasoning is kept with the session, so it survives `--resume` and a daemon restart; it is still not shown (the `Thought · N s` row is unchanged).
- **The agent knows the remote agents it can call.** With an `a2a` agent under `harnesses`, the system prompt now lists it — its name, your description, its host, and how to call it (`agent_task` with `subagent_type: a2a:<name>`) — and `agent_task` says what an `a2a:` type is, so the agent no longer goes looking for it on disk. Never in a pod; an agent the model proposes is not listed.
- **`serve`'s MCP surface names the caller it refuses, hints a URL a client can dial, and no longer opens a second session for a retried `session_start`.** The `/mcp` origin and auth audit lines (and the plain route's `auth-failure`) now carry the peer's address and a sanitized, 120-character-capped user-agent — never the token; a wildcard bind is printed as loopback in the startup hint (`0.0.0.0` → `127.0.0.1`, `[::]` → `[::1]`), so `claude mcp add` no longer gets an unreachable URL; and `session_start` takes an optional `key` while an identical unkeyed retry inside 15 seconds returns the session it already opened (same `sessionId` and `turnId`, one `mcp-start-replayed` audit line), with a reused `key` carrying different arguments refused as `-32602` instead of running the wrong prompt.
- **A test's stray output can no longer corrupt a checked-in snapshot.** `serve --resident-status` / `--resident-stop` wrote the process's real stdout instead of the CLI's data sink, so a test running them leaked `{"resident":false}` onto the runner — which, with fd 1 free, landed as line 1 of a `.snap` file and turned 14 unrelated TUI snapshot cases red. The two one-shot modes now go through the same `out` sink as every other non-TUI command, and a guard test fails by name if any checked-in snapshot loses Bun's header line.
- **A finished turn's reasoning is no longer sent back to an OpenAI-compatible endpoint.** Only the current turn's rounds are echoed (and only when the request offers tools, which is where the leak lived). Echoing an older turn's reasoning made llama.cpp's Qwen template render that earlier reply as a `think … /think answer` block, and the model then repeated it — a stray `</think>` and a doubled answer in the reply (6/12 turn-2 runs, 0/12 without the echo). Nothing stored changes: the reasoning stays in the session log, and the cut happens at send time.
- **A stray click no longer overwrites the clipboard.** A mouse selection now copies only when it spans at least 3 cells along a row or two rows apart (a one-row vertical jitter is still a click); a real copy is confirmed in the status bar ("Copied · N chars") without moving the transcript.
- **A shell call's `⎿ $ cmd` row now opens it on click.** In the TUI only the header row toggled a tool block; for a `shell` call the command row (and its wrapped continuation rows) toggles too, while output rows stay selectable text.
- **No more flashing on terminals without synchronized output (Terminal.app).** The TUI now repaints only the rows that changed instead of erasing and redrawing the whole screen on every tick: one row per spinner tick while Thinking instead of 40, ~90–97 % fewer bytes per second. `TENTACLE_TUI_FULL_REDRAW=1` restores the old full repaint.
- **Workflow editor: picking Docker or "Go to step" now sticks.** A segmented option is drawn from the SHAPE the control wrote (`where: {docker}` / `on_fail: {goto}`), not from its content, so choosing Docker or "Go to step" before typing a container name or a step no longer snaps back to Local / Stop — the field stays up, empty, and Save names what is still missing.
- **Auto-accept now covers a workflow the model starts.** A run started by the model's `workflow` tool had no turn, so every step's permission ask stayed pending even with auto-accept ON (on a `serve` daemon and in the TUI alike) and it looked like every command was asked — the run is now attributed to the turn that started it, like a run started from the app or the TUI. A workflow's hash approval and `approve` steps are still always yours to answer.
- **A workflow step that ends without its verdict gets one reminder, and says why.** An `agent` step ends only by calling the `step_verdict` tool; a child that wrote «PASS» as text used to fail with a bare `no verdict`. It is now asked once more (carrying the end of its own report, and the step's remaining token budget), and a step that still ends without a verdict fails with `no verdict — the step ended without calling step_verdict`. The phone's step detail shows that reason as a `Reason` row, and the workflow template and tool descriptions now say a PASS/FAIL line is not a verdict.
- **Phone workflows: reachable from the hub, readable as a list, and a step's detail tells the truth.** Workflows takes the disc Attach held (the composer's `+` already opened the same sheet) and is no longer dimmed as "no workflow runs" when the project has a workflow to start — it is dimmed only when there is neither a run nor a workflow file, or when the session genuinely cannot run workflows. A run's list view is now its timeline — every execution in order (a retried or looped step appears once per try), then «Next» and «Not run» — instead of one card per step. A step's detail opens under its own nav bar — `‹ <run name>` back, its place in that timeline (`4 of 8`) — with the pill landing below it instead of over the clock, a bar at the bottom to step to the previous or next execution («Start / End of run» at the ends), and «Re-run step» on a failed step. A step that never ran says why («Not run — review passed on its first try.») instead of "This step's detail is no longer available", and an approve step shows the question it asked and the answer (Allowed / Denied, how long it waited).
- **Phone run view: the graph is drawn from the run, and the ask is a bar you cannot scroll away.** The run screen now draws the pills, edges and counters from the run's own frozen definition — through the same projection the TUI reads — instead of guessing placement from the file order, so a `goto` target sits beside the step that failed and a taken edge is a solid line (goto and retry included; dashed only for *possible*, dotted for *not taken*). It gains the summary strip under the header (outcome and its marker, elapsed time, tokens, how many of the steps ran) and the run's approval becomes one bar pinned under the content, verbatim, wherever a card happens to be scrolled. A running edge flows, and stands still under Reduce Motion.
- **Workflows before the first message: the panel lists the project's workflows, and a run starts.** A TUI session is only created when its first message is sent, so the `/workflow` panel used to answer «this session is not open yet» for a project that was perfectly readable — it now reads the same catalogue and starts the same run by opening the session first (one `session/open`, the pre-open `session/skills`/`session/tools` shape).

### Security

- **A pod can no longer exhaust the laptop's memory with one endless line.** The laptop read a pod's output (k8s and docker/podman exec, and the stdio / socket stream) until the next newline with no limit, so a hostile or broken pod could grow the laptop's memory until it died. One shared reader now caps a line at 256 MiB as the bytes arrive; past it the connection to the pod is closed and the reason (`pod stdout line exceeds … bytes … channel closed`) is written to the run's daemon log. The laptop's RPC peer refuses an oversized frame before parsing it, and reports it.
- **A workflow approval can no longer hide a command.** The ask that approves a workflow by hash built its step list (every `run` command verbatim, with its target) and then cut it at 2000 characters, and the Mac dialog cut it again — to 10 rows, each truncated to one line — so a long workflow could be approved, lastingly and by hash, without the owner ever seeing what it would run. The list is now uncut end to end, the dialog wraps every line and scrolls a window at a time with a row saying how much is left, and a workflow whose list would exceed 16 000 characters is refused at validation (with the size and how to fix it) instead of being asked with a command missing. Yes stays available at any scroll position.

## [0.7.1] - 2026-11-19

### Fixed

- **The macOS voice helper ships with the release again.** v0.7.0 went out without `tentacle-voice`: the helper's entry file was named `main.swift` while using `@main`, which the release builder's Swift rejects (a newer local Swift accepted it). The file is renamed; `tentacle update` and the install script fetch the helper again on macOS.

## [0.7.0] - 2026-11-19

### Added

- **The agent can schedule its own wake-ups.** Ask it to "check the build every 10 minutes" or "remind me at 17:00": it registers a scheduled wake (recurring or one-shot) that starts a turn with a short prompt when it is due. You are asked before each one is created, and the host's `schedules.*` config sets the limits (by default 10 per session, at least 1 minute apart, recurring ones expire after 7 days). `/schedule` (alias `/schedules`) is a panel listing each wake with its quoted prompt, next fire and fire count; in the terminal the pill carries `2 sched` and the background dropdown their rows (`ctrl+x` twice deletes one), a fired turn is styled `◷ scheduled · sc-1 every 10m · fire 5` (falling back to the plain `[scheduled …]` prefix after a reload), quitting a session with armed wakes asks first, and a wake that leaves the table says so in the transcript (a deliberate delete says that instead, and an expired wake names its expiry). On the iPhone, Session info has an "Scheduled wakes" section listing each wake with its next fire and a Delete, the session list says `2 wakes` beside its jobs count, and a fired turn shows the same styled `◷ Scheduled` head. On `serve` they survive a daemon restart, in a local session they last until you quit. Design: `docs/feat/cron-tool.md`.
- **`serve` accepts paired devices on an end-to-end encrypted route.** `/e2e` authenticates by the device's own key over the Noise channel, so a phone needs no token and its `Origin` header is accepted there only; a revoked device is disconnected within a second. A non-loopback `serve` without `--token` now starts and admits paired devices only. Design: `docs/feat/device-pairing.md`.
- **Pairing over the encrypted channel.** A new device proves a one-time code inside the channel and is added only after the computer's owner confirms, comparing a 6-digit code shown on both screens (`device/pair`, additive — no protocol bump). Design: `docs/feat/device-pairing.md`.
- **`tentacle pair`, `tentacle devices`, `devices revoke`, `devices reset`.** Pair a phone by QR (or pasted text) with a confirmation on the computer that compares a 6-digit code shown on both screens; one pairing covers every `tentacle` on that computer, `devices` lists them with when they were last seen, `revoke` removes one at once, and `reset` rotates this computer's identity.
- **`tentacle logs [-f] <run-name>`.** A detached run is now readable by its name: `-f` finds it in the kept index and follows its pod's resident daemon through the engine exec bridge as a read-only watcher (no model link, no broker, no attachment, no exit net), while `--tail <run-name>` reads the copy the relay saved on this laptop; an ended run is never dialled, and a name live at two places is refused rather than guessed. Design: `docs/feat/logs-cmd.md`.
- **`tentacle logs` reads a session's log without a TUI or a shell redirect.** It prints the newest session of the current folder (or the `<uid>` given) as one line per event — turns, messages, tool calls and results, the title, sub-agent markers — with `--tail N`, `--only <categories>`, `--json` (NDJSON, versioned) and `--summary` (tools used, files touched, turns, last outcome). Read-only and lock-free: a corrupt log is refused with the parser's reason and path, and a `serve` session is shown only up to the entry its state file marks. `-f` follows the file (committed events only). Design: `docs/feat/logs-cmd.md`.
- **`tentacle logs -f <uid> --connect <url>` follows a live session, and a follower never counts as a client.** A read-only watch (`session/watch`, `watch_next`, `unwatch`) delivers the stream by long-poll: a per-watcher queue bounded in bytes and count, adjacent streamed text coalesced, a `--only ask,error,turn` filter applied before anything is stored, and an exact "N events lost" when it overflows. A watcher is never an attachment — it takes no model call, answers no ask, and leaves `ps`/`session/list` untouched — and holding a poll blocks no other request. `--tail --connect` reads a `serve` daemon's committed log the same way without opening (or attaching to) anything. Ctrl+C unwatches and exits 0. Design: `docs/feat/logs-cmd.md`.
- **The app has its icon.** The tentacle octopus from tentacle.so on a white background, on the iPhone home screen.
- **New session from the phone, and background work you can see and steer.** The sessions
  drawer gains a "New session" pill: it creates an empty session on the computer
  the drawer lists (that computer's own project), opens it with the keyboard up,
  and the first message starts it. The pill is offered only while that computer
  is online; a create that fails says why under it and opens nothing. The chat
  header also gains an **Activity** pill — a spinner and the count of background
  sub-agents and shell jobs still running (or "n new" for a report not yet
  read), shown only when there is something — that opens one Activity sheet:
  Sub-agents (description, `sa-N` · type · steps · elapsed, the latest step),
  Shell jobs (the command, `bg-N` · status · elapsed), Finished (the children
  that ended while you watched, each opening its report, with Copy) and a greyed
  Scheduled for later. An `agent_task` card in the conversation links to its
  child in that sheet. Every row opens: a running child shows its latest steps,
  your messages to it (marked "read" once it has taken them in), a "Message
  sa-N…" field and Stop; a shell job shows its output (pull to refresh) and
  Stop; a finished child's report adds "Show in chat". Stop asks once first,
  and a message or Stop the computer refuses (the child just ended, an older
  computer) says why and keeps what you typed. Settings → Activity button can
  swap the header pill for a floating button (off by default): drag it to
  either edge, it stays there across launches, and it keeps out of the way of
  the composer, the keyboard and open sheets; with VoiceOver it stays put and
  the header pill is shown too.
- **Mobile composer queue model (task 13a).** The Expo app gains its own pure,
  React-free decision module for the rows above the session input: the daemon's
  queue merged with the phone's own not-yet-acked rows, whose row belongs to
  which writer, the send-now take and its refusal restore, and the hand-back
  that puts a returned row back into the field once — banner included — before
  reclaiming it, keyed on a persisted own-id set so a row queued by a killed
  earlier app still finds its way home, while another device's returned row is
  offered with an explicit Take. Pinned to the TUI's and the client's rules by
  parity tests. No screen change yet: this is the model the composer (13d)
  renders.
- **One image sniffer, and the phone can now upload a photo.** The rule that an
  image's type comes from its BYTES rather than its name or the picker's claim
  moved from the TUI into `@tentacle/core` (the TUI file is a re-export, so its
  behaviour and tests are unchanged), and the Expo app gained the pure photo
  pipeline that uses it: a HEIC is converted to JPEG once and re-sniffed, a
  photo over the 15 MiB cap is shrunk once (a GIF over it is refused, never
  re-encoded), the 5-photo limit and an attachment name's control characters are
  enforced before a single byte goes out, and the app now supplies the binary
  sha-256 the client needs — without it every upload from the phone threw, since
  Bun's hasher is absent under Hermes. The composer itself is task 13d.
- **Compose from the phone: steer, send now, queue and returned rows, an offline outbox, photos.** The mobile session screen's input bar now does what the TUI does — typing while a turn runs **queues** the text as a steer (Send now sends the queue plus the field as one prompt, Stop stays the same button), a queued row whose turn ends comes back into the field with a banner, another device's returned row is listed with an explicit **Take**, an offline tap becomes a persisted outbox item that goes out exactly once when the link returns (a changed conversation asks first: Send / Queue as steer / Edit / Discard), and photos from the library or the camera are uploaded with their progress and refusals on a chip.
- **The floating button is now a hub.** On the iPhone, with Settings → Activity
  button → Floating, long-press the button: a fan of actions opens around it
  (Stop, Steer, Activity, Artifacts, Attach, Sessions…). Slide to one and let
  go, or let go first and tap. Artifacts carries the count of new artifacts
  and opens the gallery. Tap still opens Activity. VoiceOver gets the
  same actions from the rotor.
- **Mobile: a Commands item in the hub, and empty items that say why.** The iPhone hub gains a **Commands** fan item (a bare `>_`) opening the session's own commands — **Compact** (`Compacting…` in the footer, stoppable from the hub's Stop, then `Compacted ✓`; a failure or a dropped link says so in the chat), **Clear** (confirmed inline in its own row — the cleared chat is kept as an archived session), Rename, **Retry last prompt** (text only, like the Mac's `/retry`) and Auto-accept — with Session info moving under More; an empty Activity, Artifacts or Tools item now shows its reason in place ("Nothing running", "No artifacts yet") with a light haptic instead of closing the fan — and the VoiceOver label speaks each item's own reason rather than always "nothing running".
- **The floating Activity button can be see-through.** Settings → "Button opacity" is a 30–100 % slider (a live preview above chat text) shown whenever the Activity button is set to Floating; the button then rests at that level, goes solid while you touch it or while its fan is open, and always goes back to the level you chose. The running-turn arc never dims — below 75 % it thickens and gains a page-coloured halo so it still reads — and iOS Reduce Transparency forces the solid look. Nothing changes for anyone who leaves the slider at 100 %, which is the default. Design: `docs/feat/mobile-hub-opacity.md`.
- **Session info can now be opened on its scheduled wakes.** On the iPhone's
  session screen, the "…" menu gains a **Scheduled wakes** entry while the
  session has wakes armed: it opens Session info scrolled straight to that band,
  the one place a wake can be read and deleted.
- **Tools in the hub.** On the iPhone, the floating button's fan has a Tools item (a plug) that opens a sheet listing the session's MCP servers and skills, with a switch on each to show or hide it from the model in this session. Each server's tools open in a collapsed list.
- **Live Activity and Dynamic Island on iPhone.** A running turn shows on the
  lock screen and in the Dynamic Island (project, session, current tool, elapsed
  time), an approval waiting shows Approve / Deny, and a finished turn stays for
  a few minutes. Turns started on another device start it by themselves. Updates
  are end-to-end encrypted: Apple and the relay see only opaque bytes.
- **Face ID app lock, app-switcher privacy cover, and Settings → Export logs (mobile).** The iOS app now locks at cold start and after the delay you choose (immediately / 5 min / 1 hour / never; the device passcode is the fallback when Face ID is unavailable), hides its content in the app switcher, hides it from VoiceOver while locked, and can write a locally-redacted diagnostic log — connection state, errors and timings, never message content, titles or keys — that you choose where to share.
- **Answer a permission request from the notification.** On iPhone a push about a
  waiting ask now carries its content end-to-end encrypted and decrypted on the
  phone by a Notification Service Extension (Apple and the relay see only an
  opaque blob): the banner names the computer, the project, the session's title
  and the command's first line, grouped per session. **Approve** always asks Face
  ID (even with the app unlocked) and only ever grants that one request — a
  lasting rule still needs the in-app sheet; **Deny** works straight from the lock
  screen with no prompt, because it grants nothing; **Reply…** takes the phone's
  passcode and sends the words with a refusal; **Open** jumps to the session. If a
  background answer cannot reach the computer within the iOS budget, a "Couldn't
  reach <computer> — tap to answer" notice fires instead, so an answer is never
  silently lost. A notification that cannot be verified against the paired
  computer's key answers nothing at all — the app opens and says so, and the ask
  is still waiting. Turn-finished and turn-failed notices are quiet and grouped
  per session. The extension's own logic is pinned to the same cross-language
  vectors as the phone's (`bun run test:swift`).
- **Scan the pairing QR, or open a `tentacle://pair` link.** The app scans `tentacle pair`'s QR with the camera — asked only when you tap Scan, closable again with one tap, and the paste field still works when camera access is off — and a `tentacle://pair` link opens the app on a confirmation card, never pairing by itself. Design: `docs/feat/mobile-pairing-screen.md`.
- **Pair the app with a computer.** Paste the code from `tentacle pair`, compare the 6-digit code on both screens and confirm on the computer; paired computers (several) are kept in this iPhone's Keychain only, can be removed, and a revoked or reset computer says so. The app now connects only over the end-to-end encrypted `/e2e` route. Design: `docs/feat/mobile-pairing-screen.md`.
- **Push notification content is sealed end-to-end before it leaves the computer,
  and every push is exactly one of three sizes.** `@tentacle/transport/push` gains
  `sealPush` / `openPush` — HPKE (RFC 9180) **Auth mode**, DHKEM(X25519,
  HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, single shot. The sender key is
  the computer's static key, so a relay or Apple cannot forge a push that opens;
  the recipient key is a per-device push key generated at registration, separate
  from the device's Noise key. The plaintext is padded to the next
  512/1024/2048 bucket behind an explicit `u16` length prefix, so the envelope's
  size says nothing about its kind, and the envelope's key id is the AEAD's
  associated data, so a ciphertext cannot be moved to another paired computer.
  The envelope is a plain HPKE Auth single-shot, so the app can open it with
  CryptoKit's own `HPKE.Recipient(…authenticatedBy:)` and no hand-written Swift
  crypto — the extension that does so is the app-side task, not this one. Pinned
  by RFC 9180 Appendix A.2.3's published vectors plus our own envelope vectors,
  both produced by an implementation independent of the code under test
  (`packages/transport/test/vectors/push-v1.json`).
- **The app side of notifications: a phone registers itself with the computer it
  is paired to, and its push key is the one secret the future Notification
  Service Extension will read.** A paired iPhone now asks for notification
  permission **once**, right after its first successful pairing, with an
  explanatory line — never at launch, never again after a denial — and from then
  on registers itself on every successful connect through a new
  `RemoteClient.pushRegister` / `pushUnregister` (the same Noise channel as
  everything else, so no new transport and no second session path). Registration
  is decided by a fingerprint of `(raw APNs token, environment, push key)` kept
  in the computer's own Keychain record: a reconnect, a remount, an app relaunch
  or a daemon restart sends **nothing**, while a token iOS rotated or a
  regenerated push key sends exactly one — and a status the daemon refused
  (`off` / `relay-off` / `relay-no-push`) is deliberately *not* remembered, so a
  relay that later gets its APNs key starts working on the next connect. The
  raw APNs token comes from `expo-notifications`' `getDevicePushTokenAsync`
  (never Expo's push service, decision 19), the environment (`sandbox` /
  `production`) follows the build, and an older computer's `MethodNotFound` is
  terminal: Settings says "update tentacle on <computer>" instead of retrying in
  a loop. The per-device X25519 push key is generated once, stored
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` in the **shared Keychain access group**
  (so task 17's extension can open a push while the phone is locked) and is a
  separate secret from the Noise device key, so an extension that reads
  notifications still cannot act as the phone. Settings gains one
  "Notifications" row for the phone — the toggle reaches every paired computer,
  and its detail line is the most informative status among them (a computer
  whose relay cannot deliver is the reason nothing arrives) — and `app.json`
  gains the `expo-notifications` plugin, the time-sensitive entitlement and the
  keychain access group. No notification UI beyond the OS's own placeholder
  banner: the extension, actions and Face ID are task 17. Design:
  `docs/feat/mobile-push.md` (slice P9).
- **A notification's delivery path can be verified without an Apple account, and the relay host can hold the APNs key without ever putting it in a command line.** The mobile E2E harness grows `push-placeholder`: it pairs a simulator, grants notifications, then hands iOS a push payload that came out of the daemon's **own** sealing chain — registered for the paired device, pushed through the relay to a local fake APNs, and placed with `xcrun simctl push` — and asserts the placeholder banner. It proves the `expo-notifications` wiring, the `aps-environment` / time-sensitive entitlements and the sealed envelope's shape (a 12-character key id, a 43-character encapsulated key, and one of the three padded ciphertext lengths), and it says plainly that it does **not** prove Apple's delivery: a simulator issues no APNs token, so that half stays on the real-device checklist. The deploy side gains the one secret the relay ever holds: the APNs `.p8` arrives as a systemd `LoadCredential` (root-owned, mode `0400`, so the `relay` user cannot read it), `ExecStart` names only `${CREDENTIALS_DIRECTORY}/apns-key`, and the relay still starts **without** push when the key is missing — logging one `push off:` line and announcing no `push` feature, so phone reachability never depends on Apple's key being installed. `docs/ops/relay-deploy.md` documents installing it, rotating it (two keys can coexist, so a rotation needs no app reinstall and no downtime), rolling it back, and what the journal lines mean. Design: `docs/feat/mobile-push.md` (slices P8, P9, P10).
- **A permission request nobody answers, or a turn that ends while nobody is
  watching, now reaches your phone — through the relay and Apple, which carry
  only a sealed blob.** A `serve` daemon observes its own sessions (an observer
  that is deliberately *not* an attachment, so it neither counts as a watching
  client nor silences the notifications it exists to send) and, once an ask has
  waited `push.graceSeconds` (default 30, `0`–`3600`, `serve --push-grace <s>`)
  with no client attached to that session, pushes every paired phone that
  registered for notifications: `ask` for the request, `ask_resolved` under the
  same collapse id once it is answered anywhere (so a stale banner is replaced,
  and a folded pair stays actionable until its last ask is answered), `turn_done`
  / `turn_failed` only when nothing at all is attached, and never for a
  cancellation. The exclusion is read at the *deadline*, so a phone locked
  during the grace is pushed to — that needed a real detach on the relay path,
  where a closed leg now drops its connection. Content is sealed per device
  (HPKE Auth, sender = the computer's static key), so Apple and the relay see an
  opaque envelope and can neither read nor forge a notification. New device
  methods `device/push_register` (raw APNs token, environment, per-device push
  key → the grace and an honest `on` / `relay-off` / `relay-no-push` status) and
  `device/push_unregister`; a registration is `<configDir>/devices/push/<id>.json`
  (0600, atomic), `gone` from Apple is a **compare-and-delete** so a phone that
  re-registered is never muted, and a revoked device is filtered at push time
  even if its file survives. The relay link holds a push for up to 60 s while it
  reconnects and drops it (audited) after that, and it never sends a `push` frame
  to a relay that did not announce `"push"` — an older relay closes the control
  socket on an unknown frame. Config: `push.enabled`, `push.graceSeconds`.
  Design: `docs/feat/mobile-push.md` (slices P7, P8).
- **The wire for push notifications: one sealed plaintext, one envelope, two
  device methods.** `@tentacle/protocol` gains `PushMessageSchema` (the sealed
  plaintext: `v`, a dedupe `id`, `at`, the four kinds `ask` / `ask_resolved` /
  `turn_done` / `turn_failed`, the computer, project and session it belongs to,
  and an ask's options) with `fitPushMessage`, the one producer-side gate that
  clips its text to the 2046 bytes a sealed push can carry — walking code points,
  so a clip never splits a surrogate pair — and `pushCollapseIdOf`, the opaque
  `apns-collapse-id` that lets a resolved ask replace its own banner;
  `PushEnvelopeSchema` / `PushPayloadSchema`, where the payload is `{tp}` and
  nothing else, so the notification's visible `aps` stays the relay's own fixed
  template and no content reaches a banner without the seal being opened. New
  methods `device/push_register` (raw APNs token, environment, per-device X25519
  push key → `{graceSeconds, push}` so Settings can say why notifications will
  not arrive) and `device/push_unregister`, plus `DEFAULT_PUSH_GRACE_SECONDS`
  (30). The relay's control wire gains `push` / `push-result`
  (`RELAY_PROTOCOL_VERSION` unchanged: sending one is gated on the relay
  announcing `"push"` in `ready.features`, which an unknown name never breaks).
  Additive on the wire — an older daemon answers `MethodNotFound` — so no
  `PROTOCOL_VERSION` change.
- **The relay delivers push to Apple, and only when it holds a key.** `apps/relay`
  gains the APNs path: a pure `apns.ts` (the one fixed banner every push shows, the
  HTTP/2 request, the ES256 provider JWT with its 40-minute cache, and Apple's
  status table — `410` / `400 BadDeviceToken` → `gone`, `429` → `throttled`, a
  `403 ExpiredProviderToken` → a fresh token and exactly one retry) and an
  `apns-client.ts` that keeps one HTTP/2 session per environment, reconnects when
  Apple retires it, and gives every request a 10-second deadline. A daemon's
  `push` frame is answered with `push-result` (`sent` / `gone` / `rejected` /
  `throttled` / `unavailable`); a socket that has not completed `hello` cannot
  push at all, and per-id (120/min) and per-token (30/min) limits refuse the rest
  with a status, never silently. `ready.features` announces `"push"` **only** when
  the relay was started with a readable APNs key (`--apns-key-file`,
  `--apns-key-id`, `--apns-team-id`, `--apns-topic`, or the matching
  `TENTACLE_RELAY_APNS_*` variables), so an unconfigured relay never swallows a
  push; the key is read once, never logged. Design: `docs/feat/mobile-push.md`.
- **A phone's push registration is stored, revoked and shown, and the daemon's
  push rules are pure.** `<configDir>/devices/push/<id>.json` holds one device's
  APNs token, environment and per-device push key (mode 0600, written through a
  temp file); an unreadable or unknown-version record is skipped with one audit
  line and left byte-for-byte alone, and a `gone` from Apple is a
  **compare-and-delete** — a phone that re-registered in the meantime keeps its
  fresh token instead of being silently muted. `tentacle devices revoke` and
  `devices reset` remove the file with the device, and `tentacle devices` gains a
  `PUSH` column (`on` / `off`) that reports what the daemon will do rather than
  what the phone believes. The when-to-buzz decisions are a pure, clock-injected
  module (`push-rules.ts`): a grace before an unanswered permission is pushed, no
  push to the device already showing the sheet (as it is showing it at the
  deadline — a phone locked mid-grace still gets the buzz), an `ask_resolved`
  under the same collapse id to replace the banner once the last ask sharing that
  banner is answered elsewhere (an earlier settle of a folded pair stays silent,
  so the banner never claims a still-blocking turn is answered), turn-end
  notifications only when nobody is watching (and never for a cancellation), and
  a per-session ask window plus a 60/minute cap that fold extra asks into "+N
  more waiting" instead of a storm — every refusal audited, never silent.
  Design: `docs/feat/mobile-push.md` (slices P5, P6).
- **Phones reach `serve` through a relay, end-to-end encrypted.** A `serve` with paired devices dials out to `relay.tentacle.so` (or `relay.url` / `serve --relay`; `--no-relay` to opt out), so a phone reaches it from anywhere with no open port; the relay sees only ciphertext. `pair` puts that address in the QR after the direct ones, so even a default loopback `serve` can be paired from another network, and `tentacle devices reset` rotates it along with the computer's key. The relay is a small self-hostable service in `apps/relay`. Design: `docs/feat/mobile-relay.md`.
- **Deploying the relay is now a one-page runbook, not a guesswork session.** `apps/relay/deploy/` carries the compile script (`bun apps/relay/deploy/build.ts` → a Linux x64 `dist/tentacle-relay`), a hardened systemd unit (dedicated `relay` user, loopback-only bind, `Restart=always`, no capability, and the three per-IP abuse limits sized for the single shared source address a TLS proxy in front produces) and the Caddy site block with `stream_close_delay 5m`, which turns a config reload from one instant drop of every live relay socket into a staggered one over 5 minutes; `docs/ops/relay-deploy.md` walks install, TLS, smoke test, upgrade and rollback. Nothing is applied by the repo: running it on the host stays the owner's step. Design: `docs/feat/mobile-relay.md`.
- **Session actions on iPhone.** Long-press a session in the drawer to rename,
  pin to top or delete it; pins are stored on the computer, so the phone and
  the Mac see the same order. In `connect`'s `/sessions` panel the pinned
  sessions are listed first, marked with a `·`.
- **The iPhone app can tell you what a session is running: model, context, MCP servers and skills.** The chat header's "…" menu now opens **Session info** — a grouped sheet with the daemon's model (and, under the title, `● Idle · <model>`, shortened to the last `/` segment) plus a thin live context bar from the turn's own measurement; the session's project, attached devices and running background jobs; the computer's MCP servers with state, tool counts and errors; and its skills with scope chips and skipped-skill notes. Each section loads, fails, is unsupported by an older daemon, or is offline INDEPENDENTLY, so one bad pull never blanks the rest; a session that is not attached is never asked for skills or context. The sheet also carries the session's shared auto-accept switch, and tapping the title renames the session through the existing `session/rename`, visible on every client (empty or unchanged is a no-op). Design: `docs/feat/mobile-session-info.md`.
- **Mobile transcript model (task 12b).** The Expo app now has its own pure,
  React-free transcript fold — a session's history plus live updates (own and
  foreign turns alike) become renderable rows with markdown, highlighted code,
  tool rows with their diffs and a `denied` state, and the daemon's notices —
  pinned to the TUI's fold by a parity test on shared fixtures, with stream
  batching, bounded parsing and bounded diff rendering so a huge message or a
  fast stream cannot stall the JS thread. Image attachments ride the rows as
  `[image: name]` with a thumbnail policy that only ever fetches the visible
  rows. No screen change yet: this is the model the session screen (12c) renders.
- **A phone can now open a session and read its transcript.** Tapping a session attaches to it (never a create), shows the daemon's history as rows — markdown, highlighted code, diffs, the model's reasoning, image prompts — and streams a live turn in as it runs, the phone's own or another device's. Prompts are typed in a bottom bar, a running turn gets a **Stop** that cancels *that* turn, and a refused send puts the text back. Permission asks arrive as a sheet with the options the daemon offered (allow once / allow for this session / deny / "No, let's talk about it" with words), guarded against a stray tap in the instant the ask appears; an ask answered on another device closes the sheet without answering, and the chat is never ended by leaving the screen — going back only detaches. Banners say what happened when a link drops, a session is archived (with an explicit **Reopen**), deleted, or a computer's tentacle is too old. Image prompts are labelled and their thumbnails are only ever requested for the rows on screen.
- **Swipe a row left to see when it arrived.** A person's message, an answer and
  a tool call each carry the time the daemon received it; swiping the row left
  reveals it, and the row springs back on release. Rows with no known arrival
  (an older daemon, a message restored from a reload) do not move at all, and the
  time is display-only — it is never persisted.
- **Voice on the iPhone.** Dictate a message with the mic button, on device and never sent to the cloud. Have a reply read aloud with the speaker button.
- **The model can present artifacts — images, HTML pages, PDFs, Markdown and files — on the Mac and the iPhone.** A new `present` tool snapshots a workspace file (confined to the workspace, secret-looking names refused) or generated text into the session's artifact store, versioned per artifact and content-addressed; the transcript shows a card under the tool row and a gallery lists every version. The bytes travel back over the existing session connection in resumable 256 KiB chunks (`artifact/list`, `artifact/read`, additive — no version bump), verified against the announced sha256 so a pod cannot hand the laptop other bytes, and every viewer treats the content as untrusted: HTML/SVG is CSP-wrapped with no network, and an `other` kind is only ever saved, never opened. On the iPhone, images open in a pinch-to-zoom viewer, Markdown and text render natively, PDFs render in a script-less view of the verified cached file, and HTML/SVG open **inert** in an isolated web view — scripts and network both off, each switched on for that one open by an explicit tap and never remembered — with no cookies or storage kept, no bridge to the app, and no navigation or link — not even `sms:` or another app's link — leaving the page; any other file can only be shared. Its bytes land in a 200 MB cache per computer that drops the least recently used copy first (never the one on screen) and is deleted when the computer is unpaired, and Share hands over a copy named after the artifact — `report.zip`, not a content hash. A local session's versions are also kept on the laptop beside its log, so `--resume` shows the gallery again — a pod's are never written there. Design: `docs/feat/model-artifacts.md`.
- **Charts in the conversation — the shared spec, the math, and the model's `chart` tool.** The agent can draw the numbers it talks about instead of only quoting them. A chart is a small, strict spec in the shape of Chart.js (line, bar, area, pie, doughnut, scatter; per-axis unit, `compact`/`full` format and decimals; ISO dates kept honestly apart as calendar, instant and floating) which rides the tool call's own arguments — so it survives a reload and needs no round trip — and styling is never in it: colours, widths and fonts are the client's. A validation error is a plain sentence carrying the fix (`datasets[0].data[0] is the string "12.5" — write the number 12.5 (no quotes)`), every error at once, so a small model repairs it in one retry; the caps are named with their advice (8 series, 1 000 points, 60 bar categories, 64 KiB). Axis ticks, number formatting (our own `k`/`M`/`G` — CLDR's Italian compact form loses the digits), date handling across DST, LTTB downsampling that keeps a single spike among 1 000 points, the summary line the model and VoiceOver read, and a CVD-validated 8-slot palette are one shared, unit-tested module in `@tentacle/core`, so the Mac and the iPhone draw the same numbers in the same colours. The `chart` tool itself runs with `permission: "none"` (a chart shows, never acts) and touches no resource, so two charts never conflict; it is never offered to a sub-agent. A `NaN`/`Infinity` — which JSON cannot express — gets the `use null for a missing value` hint instead of a bare parse error, and Chart.js styling keys the model adds out of habit (`backgroundColor`, `tension`, …) are dropped and said in the result rather than refused, because a refusal costs a retry and draws nothing differently. Design: `docs/feat/model-charts.md`. A chart is also registered as a `chart` artifact, so it survives a compaction and appears in the artifacts gallery with a drawn thumbnail and a `Grafici` filter chip, opening there as the same full-screen chart; in the Mac's `/artifacts` a chart opens as an expanded chart in the panel (`esc` back to the list) and a saved copy is the spec's own `<title>.json`.
- **The model can draw Mermaid diagrams.** A new `diagram` tool takes a title and a Mermaid source (flowchart, sequence, class, state, ER, gantt, mindmap, timeline, journey, gitGraph; numbers stay with `chart`). The daemon checks it with Mermaid's own parser (loaded on first use; about 3.8 MiB more in the binary), and every mistake comes back as one sentence with the model's own line and the fix — a bracketed label, `->` for `-->`, a message without its colon, a misspelt type — so a small model repairs it in one retry. A Markdown fence, `%%{init}%%` and hard-coded styling are dropped with a note instead of a refusal. The row shows the diagram's title; in the terminal the diagram is drawn inline in ASCII — flowchart boxes and decisions, sequence lifelines — with `ctrl+o` (or a click on its caption) adding the highlighted source, and a type the terminal cannot draw falling back to that source. On the iPhone the diagram is drawn in the conversation by a bundled Mermaid (offline, in the app's colours and mono font, light and dark), shown with scripts off; a tall one is cut at about half a screen with "tap to zoom", and a tap opens it full screen with pinch-zoom, a `Diagramma | Sorgente` switch, Share and "Copia sorgente". A diagram that cannot be drawn shows its source. Not offered to sub-agents.
- **Read PDFs.** `fs_read` extracts a PDF's text natively (page markers,
  `pages` ranges, a clear "scanned, no OCR" verdict); attach a PDF from the TUI
  or the iPhone — the `+` sheet's **File (PDF)** — and the model reads it as
  delimited `<file …>` data, while the message itself shows the file's name
  instead of its text.
- **Take back a queued message.** A message queued while the model works can be taken back before the model reads it: in the TUI, ↑ on an empty input pulls the last queued message back into the field to edit or drop (`session/unqueue`; if the model already read it, you are told so).
- **A `serve` session has the MCP tools of the machine it runs on.** A phone or
  `connect` session is hosted by `tentacle serve`, which connected no MCP server
  before this: a phone turn had none of the configured tools and `/mcp` answered
  with an empty list. The daemon now connects the host's `mcpServers` once, in
  the background (one connection set per daemon, which is one per project — a
  `serve` hosts exactly one), registers their tools into every session it builds
  — including one restored from the store, or built while the handshake is still
  in flight — and answers `mcp/status`, so `connect`'s `/mcp` lists them. Each
  tool keeps `permission: "ask"`: a deny reaches no server (pinned by a test with
  a mutation on the gate). A server that crashes is respawned with backoff (1 s,
  2 s, 4 s … up to 60 s, giving up after five consecutive failures, and a spawn
  that stays up ten minutes resets the count) on both hosts, and the tools it
  contributed keep working across the respawn, so a long-lived daemon — which
  nobody can restart from a phone — heals itself. A server's stderr is capped at
  50 lines then one "further stderr suppressed", a name clash with a built-in is
  reported instead of silently skipped, and a connect failure names the server.
- **Turn MCP servers and skills off for one session.** `/mcp` and `/skills` (and
  Session info on the iPhone) can hide a server or a skill from the model for the
  current session: Space flips a row's `[✓]`/`[ ]` switch (`[–]` marks a
  skill the model can never invoke), and the status line shows `⊘ … off` while
  something is hidden. On the iPhone every MCP server and skill row in Session
  info has its own switch, and a change made on another device reads "changed on
  <device>". It takes effect on the next model call and is kept with the
  session. In `/skills`, who may invoke a skill moved into its expanded rows.
- **A live session can move between your machine and a container.** `/move container [<image>]` hands the running conversation to a new docker/podman container with your folder bind-mounted at the same path, `/move local` brings it back, and `/move attach <engine>:<name>[/<container>]` joins a workload nobody else is in; the model can propose the same move with a `move_session` call, which only ever asks you through the usual permission prompt at the end of the turn, and never carries a lasting approval. The session uid, history and scrollback stay the same, a move waits for the turn to end (and for the queued messages to run) and is refused, with one line, while a background job, a sub-agent, a compaction or a broken link is in flight; the workload a move creates is kept and listed by `tentacle ps`, and is deleted only on `--rm` and only if that move created it. Design: `docs/feat/session-hop.md`.
- **`serve --address` and sibling discovery.** A `serve` daemon tells a paired client which other `serve` daemons run on the same computer and the addresses it can reach each one on, live (`daemon/discover` + a `daemon/discovery` notification); `--address <url>` (repeatable) adds a URL the host's interfaces cannot show (a tailnet name, a tunnel), also put in `tentacle pair`'s QR. Liveness is a 10 s heartbeat, so a crashed daemon whose pid a stranger now holds is no longer reported as a live sibling.
- **Smart compaction (opt-in): the model's copy of a long session drops what later rounds superseded.** With `contextPrune.enabled`, once a request reaches `pruneAtPercent` of the window (default 60 %) and the gain is at least `minGainPercent` (default 15 %), one batch replaces old file reads a later read or edit superseded, write/edit payloads already on disk, long shell output (head and tail kept), spill previews and duplicates with a short `⟪pruned by tentacle: …⟫` stub saying how to get each back. Conversation text and the last `keepRecentRounds` rounds (default 6) are never touched, and the stored history and the session log never change. Batches are rare on purpose, so the provider's prompt cache holds between them. The write tools now refuse text containing such a stub ("not file content — fs_read the file first"), so a model cannot copy a placeholder into a file. Off by default until it has been measured.
- **Per-round token usage log.** Every model round's spend (input, output, the cached
  part of the input when the provider reports it, the model id, and how many
  messages the request carried) is recorded as a non-critical `usage` entry in the
  session log, and `tentacle logs <uid> --usage` prints it as a per-round table with
  totals — plain text, no colour, `—` for anything the provider did not measure.
- **Voice dictation on the Mac.** Press Ctrl+R in the TUI, speak, press it again: the text lands in the input field for you to edit and send. Speech is recognised on the Mac; no audio leaves it or is saved.
- **Live dictation on the Mac.** With the Apple engine, the words you dictate now appear in the input while you speak — greyed after the cursor, never in your draft until you stop — and the second Ctrl+R replaces them with the final transcript, which arrives faster because the audio was already analysed. Ctrl+R works as before; the Parakeet engine still transcribes on stop. Design: `docs/feat/voice-live-transcript.md`.
- **Voice helper ships with every release.** On macOS, `curl -fsSL tentacle.so/install | sh` now also installs the dictation helper `tentacle-voice` next to `tentacle` (checked against `SHA256SUMS`), so voice dictation works without building it by hand; an older release without it, or a Mac older than macOS 26, just skips it with one line.
- **`workload_shell`: a stateful shell on a workload.** The model can now run commands through a persistent, non-interactive `sh` inside a Kubernetes pod or a docker/podman container without moving its session, so `cd`, `export` and shell variables carry over between calls. It opens on first use, one shell per workload (at most four per session), asks permission per command with "always" scoped to that single workload — never to a bare command, so a dev-container approval cannot carry over to a prod pod — and shows the exit code and current directory in every result. Commands get no TTY and no stdin; output is capped, each command has a timeout (60 s default, 600 s max) whose processes are then stopped, and the session closes its shells (EOF plus a kill tree) when it ends, leaving nothing behind in the workload. It is offered only where the daemon runs on your own host (the local runtime and `serve`), never from inside a pod.
- **A reopened shell returns to the working directory it was in.** When a dead shell is reopened (an idle close, a dropped link, an `exit`), the tool `cd`s back to the last known directory and says so. Environment variables are not replayed — they may hold secrets — and every reopen notice now states that.
- **`workload_shell` is off until you turn it on** (`workloadShell.tool`, or `TENTACLE_WORKLOAD_SHELL_TOOL=true`). It runs commands on another workload with your own kubeconfig / docker endpoint, so it is opt-in rather than opt-out; `tentacle config list` documents the key, and it is never offered inside a pod.

### Changed

- **The TUI's frame left `App.tsx`: the derived rows are one pure view-model and
  the tree is one dumb component.** Everything the frame is computed from — the
  palette's window, the input box's height, the panel/dock/drawer/pill/reply
  views, the transcript's viewport and the row a pill click lands on — is now
  `packages/tui/src/app-layout.ts`'s `frameLayout(input)`, a React-free function
  with its own unit test, and the JSX itself is `packages/tui/src/AppView.tsx`,
  which owns no state, no ref, no effect and no geometry: it paints the model it
  is handed. The decisions stay the existing pure modules' (`statusTokens`,
  `panelView`, `backgroundListView`, `pillView`, `windowFor`, …); the hook that
  owns an effect (`useDockClock`) and the transcript layout whose consumers are
  App's effects stayed where they were, so the effect list keeps its order. The
  JSX moved verbatim (the frame set and the SGR/pill-click pins are unchanged),
  the blank-row rule that keeps Ink from collapsing rows moved with it, and
  `App.tsx` loses 317 lines. No user-visible behaviour changes.
- **The TUI's `/move` execution left `App.tsx`, and the turn boundary is one
  rule.** `startHop` (the one place the view moves: the switching latch, the
  phase row, the `keepTranscript` swap), `requestHop` (a typed `/move`: the
  grammar, the boundary, then start it or leave it queued) and `hopIfQueued` (the
  queued hop's start at the first true idle) — plus the state they own — are now
  `packages/tui/src/useHop.ts`, a hook that declares no effect, so the App's
  effect list keeps its order, and the idle effect that starts a queued hop stays
  where its trigger is. "May a hop start now?" is ONE named pure rule,
  `hopReady` (`hop-command.ts`), used by both paths: it was written out twice,
  inside `hopStep` and inline in `hopIfQueued`, which is how the typed and queued
  paths drift into disagreeing. `App.tsx` loses 107 lines and no longer reads the
  daemon's queue to decide it. No user-visible behaviour changes.
- **The TUI's last inline decisions are pure modules with their own tests.** Five
  rules that `App.tsx` decided inside effects and callbacks are now named,
  React-free functions: `anchorOffset` (`scroll.ts`, the rows-changed scroll
  anchor), `pasteTarget` (`paste.ts`, where a paste lands — reply, panel, or an
  attachment), `exitOutcome` and `jobOutputEntry` (`job-drawer.ts`, a job exit's
  dock outcome and the one cache entry a `job_output` read produces, which the
  App had been building in two places), and `tryWake` (`wake-gate.ts`, the
  autonomous-wake gate the App derived twice). The effects and callbacks stay
  where they were, so the effect list keeps its order; only the decisions moved,
  each pinned by its failure modes. No user-visible behaviour changes.
- **The slash commands are one file each, with a registry behind them.** Every
  built-in command (`/help`, `/clear`, `/compact`, `/rename`, `/sessions`,
  `/close`, `/model`, `/retry`, `/attach`, `/copy`, `/save`, `/tokens`, `/mcp`,
  `/skills`, `/agents`, `/settings`, `/exit`) now lives in its own
  `packages/tui/src/commands/<name>.ts` and declares only the slice of the
  command context it uses; `commands/registry.ts` is the one list they are
  derived from, so the palette, `/help` and the code that runs a command can no
  longer disagree. `dispatchCommand` keeps the shared guards (a skill activation
  mid-turn, a latched session switch, a session-mutating command mid-turn), and
  `/compact`/`/clear`'s machinery stayed in `App` as driver functions so the
  compaction and clear state keeps one owner. No user-visible behaviour changes.
- **The input's image attachments moved out of `App.tsx` into one hook.** The
  paste/`/attach`/drop decisions and the upload loop now live in
  `packages/tui/src/useAttachments.ts`, which owns the one-decision-at-a-time
  chain the feature needs; the draft state and the unmount abort stay in `App` so
  the render, `submit`, Backspace and Esc keep their identifiers. No user-visible
  behaviour changes.
- **TUI: panels are pluggable.** Each list panel (`/mcp`, `/skills`, `/sessions`) now describes itself — its rows, its keys, its clicks — in its own file under `panels/`, registered by one line; previously every panel kind was a branch inside the panel and key-routing code. Behaviour is unchanged.
- **The TUI's quit and clear executors moved out of `App.tsx` into one hook.**
  `/quit` (`/exit`) and `/clear` now execute through
  `packages/tui/src/useQuitClear.ts`, which owns the wiring but no state of its
  own: every latch it reads (`exitPendingRef`, `clearingRef`, `ownClearsRef`,
  `clearAfterTurnRef`, `runClearRef`) stays in `App` because the turn's settle,
  the session `watch` and `swapSession` also read or write it. The decisions
  remain the existing pure modules' (`quitCommandStep`, `clearCommandStep`,
  `clearNoopNotice`), and `RunQuit` moved next to the hook that reads it, so the
  package surface is unchanged. No user-visible behaviour changes.
- **The TUI's turn driver moved out of `App.tsx` into one hook.** `run`, the
  single `streamTurn` loop, its settle, the send-now chord, Enter's `submit`,
  the warm-chunked history commit and `/compact` now execute through
  `packages/tui/src/useTurnDriver.ts`, which owns only its own latches: every
  ref another driver also reads or writes (`sendNowRef`, `streamCtrlRef`,
  `warmingRef`, `wakeRef`, `exitPendingRef`, the clear's arm, …) still lives in
  `App` and is passed in, so each read keeps its source and two keys with no
  render between them behave as before. The decisions remain the existing pure
  modules' (`planSendNow`, `planTurnStart`, `submitPlan`, `afterOldTurn`,
  `onCompactionSettled`, the queue's and `state.ts`'s), and `runRef` keeps its
  late binding. `App.tsx` loses 674 lines. No user-visible behaviour changes.
- **The TUI's session link moved out of `App.tsx` into one hook.** How the TUI
  follows a session — the activity feed it streams into the transcript, the
  subscription set a follow installs and tears down, the single way the view
  moves to another session, and a `/sessions` switch — now executes through
  `packages/tui/src/useSessionLink.ts`, which owns no state and no effect: every
  ref another driver also reads or writes (`heldRef`, `streamCtrlRef`,
  `sendNowRef`, `warmingRef`, the clear's latches, the wake model, `switchingRef`,
  `onActivityRef`) still lives in `App` and is passed in, so each read keeps its
  source and two keys with no render between them behave as before. The
  decisions remain the existing pure modules' (`nextStep`, `historyAction`,
  `closedNotice`, `openFailedNotice`, `stayingNotice`, `switchRefusedNotice`,
  `resetDock`, `noteSent`, the notice builders, `state.ts`'s and `wakeStep`), and
  the `onActivity` ↔ `swapSession` cycle keeps its late binding.
  `App.tsx` loses 261 lines. No user-visible behaviour changes.
- **Larger app icon.** The octopus now fills ~80% of the iPhone app icon (was ~65%), so it reads at home-screen size.
- **Harness lines speak in one quiet voice, and they group.** What the machine says about a session — a reply cut at its output limit, an empty turn, a failed compaction, a job exit, a repair — now shares ONE grey with a `◇` (info) or `▲` (warning) glyph instead of two unrelated blue/italic styles behind the assistant's own `●`, and consecutive harness lines form one block: a glyph at the head, the rest hanging two spaces under it, no blank row between. A reply cut twice by the output limit reads as one merged line (`asked it to continue, cut again`) rather than two near-identical ones.
- **A compaction takes the spinner slot, and leaves a rule behind.** `/compact` no longer writes two transcript lines of its own: while it runs the row above the input says `Compacting…`, and for a few seconds after it succeeds `Compacted ✓`. The transcript instead gets one grey rule at the compaction point — `compacted · ctx 182k → 9k`, the same wording whichever device compacted — so the conversation shows where it was summarised, including on `--resume`, and the rule's brief is one Ctrl+O away.
- **Activity in the mobile app is a low-detent bottom sheet.** It opens at the height of its rows (a short list cannot scroll), drags up to a tall detent only when the rows overflow, and closes on a downward flick from either detent, on a tap on the light scrim, or by itself when the last item ends — no page sheet, no dismiss resistance, and no panel at all when nothing is running. Its rows now carry a glyph per kind (spinning arc, terminal, clock, report) with the live step, and a running row's thin ■ stops it in two taps without opening its detail.
- **Chart labels on the phone, inside the plot or in a legend above it.** A
  line/area chart no longer spends a gutter of its width on line-end labels: the
  series name sits just above each line's end (a haloed name-only label, inside
  its own band for a stacked area), and a new **Charts** setting switches to a
  compact legend above the chart whose items you tap to single a series out. The
  stacked area's y axis now reaches a ceiling above the total, each series gets
  its own stroke and marker (● solid, ■ dashed, ▲ dotted) so colour is not the
  only cue, and the hero compares a series with its own previous point instead of
  a different series.
- **The phone's dark theme is soft warm graphite, not black, and its chrome
  is thin and hairline-quiet.** The dark palette's neutral ramp is the
  owner-approved B1 "grafite calda" (`#1F1F1E` page, `#2A2A28` card/sheet,
  `#33332F` fill) with a one-step-below drawer surface and two new section-band
  surfaces; the dark red was lifted to `#FF6D65` so it still clears 4.5:1 on the
  new fill. Sheets lose their heavy 38 pt corners for 14 pt, cards go square for
  the new banded lists, and `Icon` now accepts the `thin`/`light` SF Symbol
  weights plus the hamburger and gear glyphs the restyle needs. Every screen
  header drops its blurred glass circles for bare thin glyphs on the same 44 pt
  touch target (`GlassButton` survives only over the camera), the chat header
  ends in a single hairline and reads its context fraction as a small ring next
  to "…" instead of a flat 2 pt bar — the ring is plain `View`s, so no
  `react-native-svg` and no native rebuild — and the chat header itself is
  50 pt instead of 56. The rename dialog keeps its 26 pt alert corners and the
  light palette is otherwise untouched. Grouped lists become full-width bands:
  one edge-to-edge surface per section, with a small uppercase label above it,
  a hairline on its top and bottom edges, and the section's footnote beneath —
  the band always one step above the surface it sits on, so a sheet's own
  ground moves down a step to keep its bands separate. In a banded row the
  label never truncates: a long value shortens instead, keeping the end that
  tells values apart (a path its tail, a model id both ends), and at the
  largest text sizes the value drops under its label rather than squeezing it.
  Settings, Computers, Sessions, Pair and Session info all draw their sections
  that way now — one band per section, with the section's notes on the band's
  own margin and each note still a paragraph of its own — and the old inset
  grouped card and its separate section header are gone. The chat's back chevron becomes a
  hamburger that opens a **sessions drawer** over the conversation: the
  computer as its title (tap to list another paired computer's sessions, or
  pair one), Running / Recent / a collapsed Archived · n, the open session
  highlighted, long-press → Rename (by id, no open), a magnifier into the
  Sessions screen's search, and Settings at the bottom. Tapping a row switches
  session — detaching only, never closing it — and after a switch to another
  computer the back swipe lands on THAT computer's list. A list that cannot be
  read says so with Retry, never "no sessions"; with Reduce Motion the drawer
  fades instead of sliding.
- **The mobile app's dark theme is now "Ardesia neutra" (B3).** The dark
  palette moved from B1's warm graphite to the owner's cool-neutral slate —
  page `#1E1F21`, card/sheet `#28292C`, fill `#313236`, label `#EDEEF0`, sec
  `#A0A3A8`, sep `#37383C`, with the matching band (`#242528`), drawer
  (`#19191B`), sheet separators (`#3D3E42`), glass and switch tokens — so the
  dark UI sits next to the cyan accent instead of against it. The light theme
  is unchanged.
- **The iPhone's harness lines read like the Mac's.** On a session's transcript, the lines the machine says about the session itself now carry a glyph — `◇` for information, `▲` for a warning (a reply cut at its output limit, an empty turn, a failed turn, a lost turn stream) — and consecutive ones are drawn as ONE block: no blank row between them, the glyph re-opening only where the level changes. The shape is the signal, the amber only a cue; VoiceOver speaks "Warning:" before such a line. Separators (`compacted · ctx A → B`, a context reset) stay centred and ruled, and a warning keeps its level (and its place) when the re-ask's merged "cut again" line replaces it.
- **Mobile: the session's state is a small dot before its title, and the working folder shows.** The chat header no longer says "Idle"/"Running": a 6 pt dot before the title pulses while a turn runs, turns amber while an approval waits, and is a hollow ring when offline, connecting or not connected (idle: no dot; an ended session dims its title). Under the title the subtitle reads `<folder> · <model>`, the folder in mono with home as `~`, and a tap opens Session info. The sessions drawer shows each session's folder under its title.
- **Mobile hub: no badge dot, no count bubble, solid fan discs.** News arriving while the hub is on screen now plays a one-shot glow and a light haptic on the floating button instead of a persistent dot; a fan item's count is a rim arc (36° per item, full at 10) instead of a number bubble, and the fan's discs and label pill are opaque so the transcript no longer bleeds through them. VoiceOver reads the rim's meaning ("Artifacts, 3 new").
- **Mobile: the floating hub button is on by default, at 80 %, and its opacity
  slider moves in five steps.** A fresh install (no Activity button setting
  stored) now gets the floating hub at 80 % opacity instead of the header pill;
  a phone that already stored a choice keeps it (Header stays Header — switch in
  Settings › Activity button › Floating). The Button opacity slider snaps to
  20 · 40 · 60 · 80 · 100 % (the floor drops from 30 % to 20 %), with a light
  selection tick each time it lands on a step; an older in-between value (e.g.
  35 %) shows as its nearest step (ties go up: 30 → 40). The button stays solid
  while it is touched and while the fan is open.
- **Mobile: the floating hub button animates on the native driver.** Its
  show/hide fade, the rest-opacity fade (30–100 %, solid while touched or with
  the fan open) and the spring after a drag now run on the UI thread, like the
  fan itself and the running-turn arc already did, so a JS thread busy with a
  streaming turn can no longer stutter them. Behaviour is unchanged: tap opens
  the fan, hold-and-slide selects, drag moves it, Reduce Motion still places it
  at once and fades it in.
- **A tap on the floating button opens the hub.** On the iPhone, with the Floating Activity button, a single tap now opens the fan of actions (with a haptic) instead of the full-screen Activity sheet; Activity is one of the fan's items, and it stays dimmed and says "Nothing running" when there is nothing to show.
- **Queued messages show in the conversation.** A message queued while a turn
  runs now appears as a dimmed user bubble at the end of the transcript, where it
  will land, instead of a card above the input — with a footnote saying it is
  pending (or "Sending now · stopping the step", or "another device" for a
  message written elsewhere). Tapping one of your own opens **Edit · Send now ·
  Cancel**: Edit withdraws it (the agent can no longer read a half-edited text)
  and puts your own words back in the field under an "Editing a queued message"
  banner whose × queues them again; Cancel withdraws it and never touches the
  field. Both are silent no-ops with an honest notice when the agent already read
  the message, when the link is down, or on a computer too old to take a queued
  message back (which also hides them). **Send now** moved into the field, beside
  the send button, and only appears while your own message is actually queued;
  the field's card no longer lists the rows.
- **The phone stops waiting on dead addresses, so the relay is actually reached.** A dial now races the computer's addresses with a 750 ms stagger (RFC 8305 style) instead of trying them strictly in order: the first socket to open wins and goes on to the Noise handshake, while every loser is closed before any handshake, and `unauthorized` still stops everything. On cellular a LAN address that hangs in TCP connect no longer eats the 15 s dial deadline before the relay is tried, and the "can't reach it" message now names the relay as a path. Design: `docs/feat/mobile-relay.md`.
- **Mobile: the "Thinking" shimmer stays inside the letters, and photos sit outside the bubble.** The live row's bright sweep is clipped to the word's glyphs (no rectangle behind it) and runs on the native driver, and the elapsed time sits beside it in steady-width figures ("Thinking 12 s"); Reduce Motion shows a still grey word. A message's photos now sit ABOVE the text bubble as their own block (side by side, a grid, "+N" past four), and a photo-only message has no bubble at all; a photo still uploading from the outbox shows its percentage and a failed one offers Retry; tapping a photo opens a full-screen viewer that pages through all of them, with pinch-to-zoom, the caption and Share; a photo whose file is gone reads "Image not available".
- **Tool calls on iPhone read like steps.** One line per call on a thin thread, readable MCP names and arguments, thinking folded into a ∴ marker, and a live "Thinking…" node while the turn runs; tap a step for its thought, command and result. Design: `docs/feat/mobile-tool-rows.md`.
- **iPhone app: a new look on every screen.** One set of colours, type sizes and spacing, taken from the approved mockups, in light and dark mode, with Apple's SF Symbols icons, frosted-glass round buttons and haptics (a light tap when a message leaves, a firmer one for Stop, a success tap when a turn ends). Computers has a large title with round Settings and "+" buttons, each computer gets a bold header with a status dot (Online, Offline, or what needs your attention) above a rounded card with its project, and a "Pair a computer" card sits at the bottom. Pair again and Remove now live in a menu: long-press the project or tap "…". A computer that needs a new pairing (including a revoked one) shows "Pair again" right in its card. Pairing shows the camera full screen with a viewfinder, and the review, the code check (the 6 digits in two large boxes) and the result appear in a bottom sheet. The chat has a compact header with a status line and a "…" menu (copy the last answer or the whole conversation), your messages in bubbles, answers full width with SF Mono code: short inline code as small rounded chips, code blocks with a language header, a Copy button and sideways scrolling, tables as real grids. Tool calls are compact rows that open their output, diffs open on tap with line numbers and coloured rows, and the queue, tool output and diffs open and close with a smooth animation. Messages waiting for the network show as dashed bubbles with a "…" button when they need your answer, and that choice is a bottom sheet with large buttons. Sessions are grouped Running, Idle and Archived with a search field, the permission sheet has large answer buttons, and Settings uses the same rounded cards. Design: `docs/feat/mobile-ui-polish.md`.
- **Voice moves to Beta in the iPhone app.** Dictation and read-aloud are off by default; turn them on in Settings → Beta.
- **The Mac shows what the model presented: a card in the transcript and an `/artifacts` panel, and it opens them safely.** A `present` tool call now renders ONE card row under its header (`▣ <title>`, the type, the dimensions or size, the version, and `^X^O open`) instead of the tool's text, and a resumed session's cards are joined back from the daemon's `artifact/list`, so they survive a `--resume`. `Ctrl+X Ctrl+O` opens the newest artifact; `/artifacts` lists every presented artifact newest-first with its older versions folded under it (`→` unfolds, `enter` opens the version under the cursor, `s` saves a copy to `~/Downloads` without overwriting, `n` opens a page with the network after a confirm, `esc` closes). Opening writes a verified copy named `<sha>.<type>` (never the model's name) to a private temp folder removed at exit and hands it to the system opener with no output on the terminal; HTML and SVG are wrapped in a no-network CSP, and a kind this build cannot view is only ever saved, never opened. Cards from a pod daemon say `from the pod`, every open of pod bytes asks first (`y/N`, never remembered, no network option), and nothing is ever opened without a key. An older daemon says it needs a newer tentacle rather than opening an empty panel. Design: `docs/feat/model-artifacts.md`.
- **Charts now draw in the Mac TUI and on the iPhone.** A `chart` tool call renders its chart in the conversation's own place — the braille plot, the ⅛-cell bars, the stacked rows, the 100 % pie bar and the sparkline rows (one per series at 40–59 columns; the data table below 40), centred to the transcript width — instead of a generic `● Chart …` tool row and its one-line result: the chart is part of the reply, not a tool block (it keeps no bullet, no connector, and is exempt from the generic body cut). It is drawn from the call's own arguments, re-validated by the client with the same caps as the daemon, so a resumed session shows the same chart and a forged or unreadable spec falls back to the plain tool row rather than crashing. Ctrl+O — or a click on the chart's caption — expands it to 16 plot rows with per-series min/max/last and the data table. A new `tui.chartGlyphs` setting (`braille`, the default, or `blocks`) draws quadrant blocks for a font that has no braille patterns, which a terminal cannot report on its own. On the iPhone the same call draws a vector chart (`react-native-svg`, so the app needs a new dev build) full width on the conversation background, with no card and no tool chrome: the title, a monospace hero number with its change pill, then smooth monotone lines with a soft gradient, rounded bars and a gapped donut in the shared palette, in light and dark. It too is drawn from the re-validated arguments, live and after a reload, and VoiceOver reads it as one element whose label is the chart's summary; a failed, refused or invalid call keeps the plain tool row. Press and hold to scrub, as in Stocks: a rule and a dot follow the finger, the hero number shows the values under it, the rest of the curve dims, and every new category gives a selection tick. A `Grafico | Tabella` switch under the chart swaps in the data table (tabular figures, with a Δ column for a two-series comparison), and VoiceOver has the same thing as a "Show data table" action. A tap opens the chart full screen, in portrait or landscape: series chips switch series on and off (colours stay put), a strip shows last · mean · max, and Share sends the data as CSV. A new chart draws itself in once when it arrives (a line traces left to right, bars grow, the donut pops); with Reduce Motion it only fades in, and charts reloaded from history appear without animating. Design: `docs/feat/model-charts.md`.
- **The TUI's "in-process fallback" branches are gone with it.** A session's
  `/clear` is always an in-place reset (no more close-and-replace), `Ctrl+X
  Ctrl+S` only ever falls back when the daemon has no `sendNow` (not when the
  session has none), and images are off through the session's own answer rather
  than a missing seam — so those controller members are required instead of
  optional, and a controller that omits one no longer compiles.
- **A fired scheduled wake reads as a timeline event, not a message you typed.** On the phone and in the terminal, a wake that fires now shows as one quiet grey row — `◷ Wake 15:54 · <its prompt…>` — collapsed until you tap it (phone) or press Ctrl+O (terminal), instead of a user bubble holding the raw `[scheduled sc-1 · at 2026-11-17T15:54 · fire 1]` text. The time is the moment it actually fired, for one-shot and recurring wakes alike, and the row looks the same live, after a reload and on every device; a conversation saved before this change shows the one-shot's scheduled time, or `#N` for a recurring wake.
- **Auto-accept is per session, on every device.** Shift+Tab in a terminal or the switch on the phone's approval sheet turns auto-accept on or off for the whole session; every terminal and phone attached to it follows at once, and a `serve` session keeps it across a daemon restart. Approvals it gives are one-time only; a pod session (`run`/`attach`) keeps it on the laptop as before.
- **`sessionHop.tool` turns the agent's `move_session` proposal off.** New setting (default on) and its env form `TENTACLE_SESSION_HOP_TOOL`: with it off the agent is never offered the tool that proposes moving its session to another target, so the only way to move is a `/move` you type. The tool itself never moves anything — it raises one prompt in your terminal at the end of the turn, which auto-accept never answers and nothing remembers. On a `run`/`attach` session it is never offered at all: only a hop-capable terminal can put the proposal to you, so the model is never told to propose a move nobody is asked about. Design: `docs/feat/session-hop.md`.
- **With auto-accept on, a move needs no prompt — except toward your own machine.**
  A model's `move_session` proposal is answered by auto-accept like any other
  tool, logged allow-once (the outcome line says `(auto-accepted)`), with ONE
  exception kept for safety: a move TOWARD LOCAL proposed from a pod or container
  always asks on the laptop. A typed `/move`'s mount gate still asks.
- **The `move_session` description is rewritten for the model** (≤ 600
  characters): when to use it (multi-step work that needs the workload's tools or
  files; a one-off check stays a `kubectl`/`oc exec`), the target shapes including
  the namespace form, that it applies at the end of the turn, that a message
  arrives in the new place, and what resets — the stale "auto-accept is turned
  off" is gone.
- **A hop names its Kubernetes namespace, and one rule decides the default.**
  `kubernetes:<namespace>/<pod>[/<container>]` in `/move attach` (one segment =
  the pod, two = `<ns>/<pod>`, three = `<ns>/<pod>/<container>` — the old
  `pod/container` reading is GONE), and the same namespace as a structured
  `workload.namespace` on the `move_session` tool. One function, `kubeNamespace`,
  now decides it for `run`, `attach` and every hop: explicit >
  `TENTACLE_POD_NAMESPACE` > (a server override ? `default` : the kubeconfig
  context's, else `default`) — the hop used to ignore the env entirely, which is
  why a live test attached to `namespace default`. A proposal's namespace is
  resolved at the turn's end, so what the prompt shows is what is dialled; the
  prompt and the failure line carry the provenance (`namespace ns1 (from context;
  context c, ~/.kube/config)`); a k8s 404 says `/move attach
  kubernetes:<namespace>/<pod>` instead of a `--namespace` flag a hop does not
  have; and every label prints `kubernetes:<ns>/<pod>[/<container>]` from ONE
  function.
- **Auto-accept now survives a move.** It used to be turned off at every hop; it
  stays exactly as it was, and the moved notice states the mode it is in.
- **`move_session` is now OFF by default.** `sessionHop.tool` (env
  `TENTACLE_SESSION_HOP_TOOL`) used to default to on, so a fresh install offered
  the model a tool that proposes moving your session. It is now an opt-in: set
  `sessionHop.tool: true` (or `TENTACLE_SESSION_HOP_TOOL=1`) to offer it. A
  `/move` you type is unaffected — it never needed the setting. `config list` and
  the config reference now say so, and no longer claim a proposed move is "never
  answered by auto-accept" (it is, except toward your own machine).
- **The session continues by itself after a move.** When a model-proposed move
  (or a `/move` typed mid-task) settles, one short message tells the model where
  it now is, whether your folder is shared and what was reset, and the turn goes
  on — no typing needed. A `/move` typed at rest still waits for your next
  message, and after three consecutive self-continues it pauses and asks you.
- **A presented artifact's row is one title and one click.** The `present` tool row now reads `● Present <title>` (never the call's raw JSON or the page it carries) with one grey line under it — `<id> · <type> · <size>` — instead of the `▣` card and the model's "Presented … They open it from the card" receipt. Clicking the row's header opens the artifact with the Mac's default app through the same safe path as `Ctrl+X Ctrl+O` and `/artifacts` (our file names, CSP-wrapped HTML/SVG, unknown types never opened, a pod's bytes always asked first). Design: `docs/feat/tui-present-row.md`.
- **The TUI's turn indicator shimmers.** `Thinking…` / `Working…` now carries a
  soft highlight that sweeps left to right across the word and rests for a moment
  before repeating, matching the phone's mockup, instead of sitting in one flat
  accent colour. The sweep rides the spinner's existing 80 ms re-render — no new
  timer — and is computed by a pure module (`packages/tui/src/shimmer.ts`) that
  only ever returns runs of the label's own text, so the row cannot shift by a
  cell. The two highlight tones are per-mode palette tokens, gated by the light
  palette's contrast test, and with colour off (`NO_COLOR`, no TTY) the row is
  exactly the plain label it was before.
- **The voice conversation core, shared by the Mac and the iPhone
  (`@tentacle/core`'s `voice/`).** Both edges of hands-free voice mode now run
  the same pure, React-free modules instead of each growing its own loop: the
  end-of-turn fold (a comma-safe silence floor, Smart Turn on the Mac, "no new
  recognised text" on the phone, an injected audio clock so every trace is
  testable), the conversation reducer (states and the ordered `speak`/`hush`/
  `listen`/`prompt`/`enqueue` commands; an ask pending suspends every send, a
  phone call never re-opens the mic by itself, a link drop hushes and pauses,
  barge-in stops speech and steers but never cancels, and only the edge that
  started or steered a turn speaks it), the streaming chunker (a ≤ 4-word first
  chunk so speech starts fast, never a cut inside a word or a number, identical
  chunks at any delta split), speakable text (code fences, tables and hrefs
  never read out), tool narration from the tool name only, the ask template,
  and spoken-language resolution. Nothing is user-visible yet: the Mac TUI and
  the iPhone app are wired to these modules in later slices of the same task.
- **Voice in the terminal is off by default.** Turn it on with `voice.enabled: true` in the config; Ctrl+R then dictates as before. While off, Ctrl+R shows `voice is off — set "voice": { "enabled": true } in the config`, `tentacle voice status` prints the same hint, and the helper is never spawned (no mic is opened).
- **Voice turns answer sooner, and are written to be heard.** A prompt or a
  mid-turn steer can now say it came from voice mode, carrying that edge's own
  "reasoning off for spoken replies" setting. The turn then reasons off for the
  rounds before its first tool call — a spoken reply wants an answer now, while
  real work still reasons as configured once the model asks for a tool — and its
  requests carry one short instruction that the person is listening, not
  reading. Both live on the outgoing request alone: the stored conversation,
  `session/log` and a `serve` daemon's files never contain them. The setting is
  per edge and read at send time, so a phone and a terminal on one session each
  send their own. On OpenAI-compatible endpoints it asks for
  `reasoning_effort: none` with `enable_thinking: false`, retrying once without
  them (and remembering) if the endpoint rejects them; Anthropic is unchanged,
  and a pod's tunneled model call carries the wish back to the laptop that owns
  the model. A turn that is not a voice one is untouched.

### Removed

- **Removed `--in-process` / `--no-worker`, and the silent fallback.** The local
  TUI has one session path now — the agent always runs in a worker thread over
  RPC (AGENTS §7). A flag that still passes either option is refused as an
  unknown option, and a worker that cannot start is a clear error naming the
  phase and reason (`tentacle runs its agent in a worker thread and has no
  fallback`, with the Bun version and reinstall hints and the daemon error log),
  exiting 1 before Ink mounts instead of silently degrading the TUI.

### Fixed

- **An image the session cannot take now says which of the two causes it is — and where to fix it — instead of always telling you to update.** Pasting an image path into a session whose model has no vision on the current build said `this daemon does not take images (its model has no vision, or it predates images — update it)` — two unrelated causes merged into one sentence, advising an update of software that was already up to date and never naming the setting that would fix it. The client holds the facts to tell them apart: `initialize` enforces protocol equality, so a daemon that handshook at the version that introduced images and advertises no image input simply has a model whose config is off. So a current daemon now names the model AND whose config it is: for the in-process worker and a `--model-proxy` pod (both run this laptop's model) `<model> is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)`, and for a `serve` host or a pod daemon running its own model `<model> is configured without images — set model.images true in the daemon's config if that model takes images (tentacle config set model.images true, on the daemon's host)` — because the key lives wherever the model runs, so a command run on the wrong machine changes nothing. A model name from the wire is stripped of control characters and bounded (whole code points, an ellipsis, never a split character) before it reaches a terminal, and a daemon that reports its own model outranks any caller's claim about it. Only a daemon that really predates images — an older protocol, or one that answers `attachment/put` with `MethodNotFound` — says `this daemon predates images — update it`, from one shared constant. An unreadable model name invents nothing, and a handshake that has not answered yet is never treated as evidence of age.
- **The iOS build works again: the Live Activity target compiles `PushCore`.** `xcodebuild archive` had failed since the Live Activity target landed — `LACore.swift:23: error: Unable to resolve module dependency: 'PushCore'` — because `PushCore` is a module only in the SwiftPM test package, and the generated Xcode project has none: `swift test` stayed green while no installable build could be produced. The widget target now compiles the same sources as the Notification Service Extension, linked file-by-file (Xcode's synchronized root group does not follow a folder symlink, but does follow per-file ones — no copy, one source of truth), and `LACore.swift` guards the import with `#if canImport(PushCore)` so one source builds both ways.
- **Mobile: closing the Activity sheet no longer flashes it back open.** One close now closes it once: the sheet slides down and is gone. Before, it came back for a moment and then disappeared.
- **Mobile chat glitches.** A sent message no longer sits beside the transcript as a dashed "Sending…" bubble for its whole turn: the outbox row leaves, and the message appears in the transcript, as soon as the daemon accepts it (`RemoteSession.send` gains an `onAccepted` callback for the daemon's ack). A send now puts the keyboard down, and the emptied field shrinks back to one line. Opening a chat lands at the true end (RN's `scrollToEnd` stopped 16 pt short), and the list follows the end when the header or a notice shrinks it. The Rename dialog sits above the keyboard with a proper top inset. A foreground sub-agent's Agent card now shows its latest activity and tool count (`Done · N tool uses`, `Moved to background · sa-N`) instead of looking stuck on "Running". A Session info section that says "Couldn't load" now logs its error class and code (never the message) for Settings → Export logs.
- **One chat item that cannot be drawn no longer crashes the iPhone app.** A
  transcript row that fails while rendering is replaced by a small "couldn't
  display this item" note and the failure's error class is written to the app
  log, instead of aborting the app — which, since a session reopens on the same
  rows, used to crash it again on every launch.
- **The hub's fan opens smoothly while the model is thinking or answering.** On
  a phone, the fan opened in jerks during a streaming turn: every streamed chunk
  re-rendered the whole chat, and each re-render restarted the fan's opening
  animation (on the simulator, about 400 restarts in one open, so the fan never
  finished opening while the turn streamed). Now the fan starts its animation
  once per open. The chat re-renders at most about 10 times a second while text
  streams, and only the row that changed is redrawn. Turn ends, tool cards and
  permission prompts still show at once. Exported logs now include `ptrace`
  lines: JS frame gaps, whether a turn was streaming, and how long the fan took
  to open. Use them to diagnose jank on a real device.
- **Coming back to the app no longer moves a long conversation or shows a false "New messages".** On the first return from another app, a long session read further up jumped once and its "Jump to latest" pill turned into "New messages" although nothing new had arrived. The resync that runs on return rebuilt every row with a new identity, so the list forgot the sizes it had measured above the screen; rows that are already shown now keep their identity, and the conversation stays exactly where you left it.
- **A photo message on the phone now shows its reply, its picture, and a WhatsApp-shaped bubble — and photos go out
  smaller.** A message with a photo no longer leaves the header on "Running" with no answer: the outbox opened a
  second session handle for the same id, and the client hands the stream to whichever handle opened last, so the
  finished turn's reply and its `turn_end` never reached the transcript (the reply was in the history all along). A
  photo the phone just sent now draws the picture it sent — full bubble width with the bubble's radius, its caption
  below it and no empty text area — and tapping it opens it full screen. The transcript also pulls to refresh, re-reading
  the session from the daemon and replacing the rows: the recovery that used to mean leaving and re-entering. And a photo
  is downscaled to a 2048 px long edge at JPEG 0.8 before upload (a few hundred KB instead of several MB), with a new
  Settings switch, **Send photos at original size**, off by default. The resize names one edge only, so a rotated
  portrait photo is never squashed. The phone's copy of a sent photo is now kept (the transcript's own row draws it) and
  the folder is trimmed on a weekly grace window instead of deleted the moment the daemon accepted the message, so a
  photo that goes bad on disk turns the bubble back into its label rather than an empty frame.
- **A chat opens at its end, without scrolling through it.** A long session now
  lands on its newest message on the first frame: the list is laid out and
  scrolled while hidden (never animated on the initial landing), then shown once
  the end stops moving, so a reopen no longer flies through the whole history.
  Coming back to the app also resyncs silently — no spinner, no jump for someone
  reading further up — and pull-to-refresh, Retry and Reopen all re-arm the same
  silent landing.
- **Turning notifications off on the phone now stays off, and really stops the
  pushes.** The Notifications switch is the phone's decision and is persisted in
  its own Keychain record, so a relaunch no longer re-registers the phone with
  every computer; turning it off while a computer is not connected leaves a debt
  that the next connection settles before anything else (an unregister that could
  not be sent is never treated as sent); turning it back on registers immediately
  with the computers that are connected instead of waiting for a reconnect; and
  one outdated computer no longer makes the switch inoperable, so notifications
  can still be turned off for the computers that do deliver. The unregister is
  also remembered across an app relaunch (it lives in the computer's own stored
  record) and a switch record left by a different app version is never
  overwritten.
- **`serve --push-grace` now actually works.** The flag was validated and consumed by the daemon, but it was missing from `serve`'s accepted-argument table, so `serve --push-grace 30` — the documented way to tune how long a permission request waits before the phone is notified — was refused as an unknown option. It now parses, refuses anything outside 0–3600 before the daemon binds, and appears in `serve --help`.
- **The relay starts — and keeps serving every phone — whether or not Apple's push key is installed.** The APNs wiring moved out of `relay.service` into a systemd drop-in (`apps/relay/deploy/relay.service.d/apns.conf`), installed only together with the `.p8`. Both of its lines used to make the *base* unit unable to start on a host without the key: `LoadCredential=` with an absolute path fails the unit's start (243/CREDENTIALS) rather than skipping the credential, and an unset `${VAR}` is expanded by systemd to an EMPTY argument (`--apns-key-id ""`), which the relay refused. With `Restart=always` that was a crash loop — a routine redeploy, or a rollback that removed the key, took every phone off the relay. The base unit now carries no push wiring at all and boots with push off (one `push off:` line, no `"push"` in `ready.features`), and the relay additionally treats a blank `--apns-*` value as "not set" instead of a refusal, so a half-installed drop-in still boots. The drop-in is also a systemd-legal override of a `Type=simple` unit: it clears the inherited command line with an empty `ExecStart=` before restating it, so installing push no longer leaves the unit with two command lines (which systemd refuses outright) — the install step itself used to be the crash loop. `docs/ops/relay-deploy.md` §6.1 documents the drop-in and §6.3 reverts it in the same step as the key, with one stated outcome for a key-less drop-in: 243/CREDENTIALS, never "fine".
- **iPhone: a reopened session keeps its failed steps red, a compaction reads the same live and after a reopen, diagrams get their outline | filled setting, and the opacity slider's thumb is visible.** A failed tool call is now stored with its error flag (`isError` on the tool message — additive, display only), so reopening a session on the phone or resuming it in the TUI no longer turns a failed step green. Another device's compaction no longer shows a literal `_…_` notice: live and after a reopen it is the one `compacted · ctx A → B` separator, and the summary is no longer shown as a message you typed; the phone's other notices lost their stray underscores too. Settings gains a **Diagrams** section (Outline, the default, or Filled: soft-filled shapes, caption below). A full-screen diagram or chart now follows a light↔dark switch while it is open. The "Button opacity" slider's thumb is drawn in the accent colour with its shadow (it was white on white in light mode), and its preview shows ordinary chat text.
- **Coming back to the app no longer scrolls the transcript up and down, and a queued message can be cancelled again with the hub on the right.** A foreground return re-attaches the session, which REPLACES the rows and re-keys them all: a virtualised list unmounts its cells and reports a sequence of content heights. The "land at the end without animating" landing armed by that return was one-shot — it released on the FIRST measurement — so every later height was followed with an animated scroll, which is the loop the owner saw on a real iPhone after switching apps and back. The landing now absorbs the whole re-measure and lands in ONE silent scroll when the sizes go quiet (bounded, so a turn streaming through the return still gets the list back), keeps that silent hold through the growth its own landing scroll causes (a list renders the end's cells, so the height moves again right after it), and never scrolls at all if the person was reading further up — including when they scroll up while the return is still landing, where the history that arrives is still news and the "jump to latest" pill says so. Separately, the pending message's bubble reserved no space for the floating hub: on a 440 pt screen the hub spans x 376–430 while Cancel sat at x 384–434, entirely under it, so a tap there opened the hub fan instead of cancelling — a queued message could not be cancelled at all with the hub on its default right edge. The bubble and its Edit · Send now · Cancel row now keep the hub's whole column clear at BOTH edges (the hub can be dragged to either) and the actions wrap rather than run off, with nothing reserved when no floating button is drawn.
- **Artifacts open properly on the phone.** An HTML page, a Markdown document,
  an SVG or a text artifact now opens in its viewer instead of saying "Couldn't
  keep this file"; the viewer covers the whole screen instead of opening as a
  half sheet under the gallery; and the gallery's close button no longer sits
  on the status-bar clock. A chart with a currency unit or a long date axis no
  longer fails on iOS (whose Intl lacks `formatToParts`, or returns no parts),
  and the ∴ thought glyph is a little larger. The live "Thinking…" node now
  breathes (its ∴ dots light up in turn, and a shimmer crosses the word; still
  under Reduce Motion), and the Activity sheet's Scheduled group shows the
  session's real wakes (how many, and the next one; a tap opens them in
  Session info) instead of a greyed "soon". Tapping an artifact's card in the
  conversation now opens that artifact (closing it returns to the
  conversation) instead of the artifacts list.
- **iPhone: a "Send now" no longer leaves its message stuck in the queue, and its turn now shows live.** After tapping Send now during a turn, the message stayed shown as "Queued" for ever, even though it had been sent and answered. The row now leaves as soon as the daemon stops listing it. The new turn now streams into the open session (the running state, the answer, and Stop), where before it only appeared after leaving and re-entering. Coming back to the app while offline now refreshes the session once the connection is back.
- **Mobile: a tool step's line no longer carries a ∴ beside its duration.** The
  ∴ sat between the command's subtitle and its elapsed time (`Bash ls ∴ 22 ms`)
  and read as part of it. A step's line is now name + subtitle + duration only;
  the ∴ belongs to reasoning — a Thought row's node and the live `Thinking…`
  footer — and a thought folded into a step is still the open body's first line,
  so nothing it stood for is lost.
- **A write to a hard-linked file inside the workspace is no longer refused as "outside the workspace".** macOS's `realpath` intermittently answers with a *different* name of a file that has several, so the confinement check could see a legitimate in-root path as outside (or replace the wrong name); a file with several names is now resolved from its directory, keeping the name asked about.
- **iPhone app: messages you send arrive, and the chat reads right.** A message sent from the phone now reaches the computer and shows in the conversation — before, the app cleared the field and then failed silently, so nothing was sent and nothing appeared; if a send cannot even start, your words now come back to the field with a notice. The chat follows the answer as it streams, unless you scroll up (then a "Jump to latest" button appears), and code blocks keep each line whole and scroll sideways instead of wrapping. The composer clears the home indicator and stays above the keyboard; Return sends — the key reads "Send"; while a turn runs it queues, and it never stops a turn. Answers no longer show `&#39;`, `&quot;`, `&amp;` or `&lt;` (nor `&#x27;` inside a highlighted code block), a tool row shows its command or path instead of the raw JSON arguments, terminal colour codes are stripped from tool output, and in dark mode answers are no longer black on black. Design: `docs/feat/mobile-ui-polish.md`.
- **A permission dialog that appears while you are still typing no longer eats your next approving key.** Typing `/quit` and pressing Enter as an ask opened — or, worse, typing the `a` in an ordinary word, which granted a standing **session-scope** approval — used to answer the dialog you had not read yet: the dialog claimed every key the moment it was in the frame, Enter picked the highlighted "Yes", and `y`/`a` were the allow shortcuts. Approving keys are now swallowed for the first 500 ms after a request's dialog is first drawn (Enter on a "Yes"-style choice, `y`, `a`); the dialog stays up, nothing is approved and nothing is run. Refusals stay immediate (`n`, Esc, Enter on "No", and on a hooks-trust ask with no stored decisions `a` — an accidental refusal is recoverable, an accidental approval is not), as do the arrows, `t` (open the reply field, whose Enter can only refuse or send) and Ctrl+C. The window is measured from when the dialog is actually drawn, so a slow render cannot shorten it, it restarts for each new request (a second ask opening right behind the first is guarded too), and a clock that jumps backwards can only keep it disarmed — it never grants. Denying or answering deliberately is unchanged once the window has passed.
- **Pairing from a phone off the computer's network works.** The app races the
  pairing QR's addresses like it already races a paired computer's, so a dead LAN
  or Tailscale address no longer leaves pairing on "Connecting…" before the relay
  is ever tried. The race lives in `@tentacle/client` now (the mobile app imports
  `firstAnswering` from there), and it gained two options the link never needed:
  a caller-supplied "this failure is the computer's verdict" rule (pairing's
  refusal, so a spent code is never re-tried on another address) and an
  open-only deadline (15 s, after which "nothing answered" is an honest
  `unreachable` instead of a hang — the exchange itself still waits on a human).
  Cancel now closes every socket the race opened, not just the last one.
- **A `serve` session with auto-accept on keeps running with no app or terminal
  attached.** The computer answers its permission asks itself (allow once only),
  as a device would; pod sessions are unchanged.
- **Project hooks run in a phone turn.** They silently never did: the daemon
  asked the prompting client and the phone had no answer for that question, so
  every turn in a project with hooks ran without them and said nothing. The
  serve host's own `hooks-trust.json`, the file this machine's TUI writes, is
  now checked first, read-only, so a folder trusted once on that computer runs
  its hooks for every client's turns; a folder it does not trust is asked about
  by the phone, through the permission sheet, which always reaches a person and
  is never answered by auto-accept. Nothing is stored from a phone's answer.
- **`/move attach` joins a workload only when nobody else is in it.** Moving into an existing docker/podman container or k8s pod is refused, with one line and nothing dialled, when a `tentacle run --detach` of yours owns that workload, when another session is already attached to or running in its resident agent, or when it still holds an older copy of the session you are moving that is running, has background jobs, or has another terminal attached to it — and the refusal happens before any session is opened there, so the workload's current client is never disturbed. Idle older copies are closed and reseeded from your laptop's history, never joined. A workload you joined is never deleted on the way back, `--rm` included, and a hop's own container now really bind-mounts the folder it names — the agent works on your files at the same path instead of the image's own filesystem. Design: `docs/feat/session-hop.md`.
- **`/move` keeps the conversation.** After a hop the model sees the whole history, on the same session file — no more "this session was closed on another device" followed by an empty session. The hop's outcome is said once (an engine's text renders literally), the footer and tool asks show the target's own working directory, and a container whose arch probe fails takes the engine's arch instead of guessing x64.
- **Moving a session is one live line, not fourteen transcript notices.** A hop's
  provisioning now takes the engine runtime's interactive single-line contract
  without needing a TTY: the hop hands it a throttled `liveLine`
  (≤ 1 update per 100 ms, the latest text always landing) that paints its own
  status row. One attach used to print `resolving…`, `injecting…`, ten
  `transfer ▓▓░ 10%…100%` lines and `verifying…` — each a separate transcript
  notice. The transcript now keeps only the engine's warnings and the one outcome
  line (`Moved to …` / `not moved: …`).
- **A reopened session on the phone keeps its Thought rows.** Only how long the model thought is stored (never the reasoning text), so a thought before an answer reads `Thought · 12 s` live and after a reload alike — collapsed, not expandable — and a thought before a tool stays folded into that step ("thought first"). The Mac TUI is unchanged.
- **The TUI's row bullet no longer turns into an emoji.** The bullet that opens a
  tool call, a reply and a notice was `⏺` (U+23FA, the record symbol), which is
  emoji-capable: on a terminal whose monospace font lacks it — Windows Terminal
  under WSL, Safari on iOS — the OS substituted its colour-emoji font and drew a
  "record button", sometimes two cells wide. It is now `●` (U+25CF BLACK
  CIRCLE), which has no emoji form and is present in practically every monospace
  font. The blink's ON and OFF halves are still the SAME character (OFF under the
  SGR conceal attribute), so the row keeps its exact cells and nothing moves at
  1 Hz.
- **A real flowchart draws in the TUI instead of falling back to "source only".**
  The owner's transformer diagram (`subgraph id ["a long title"]`, 22 boxes,
  `<br/>` labels, `[[ … ]]` subroutines, back edges) came back as highlighted
  source because the renderer refused it. Now: a subgraph's title is read without
  its id (and a too-long title is shortened with `…` on whichever border has room
  instead of dropping the whole frame), a label's `<br/>` breaks are drawn as
  several rows in one box and a long label is wrapped to the terminal width, and
  `[[ … ]]` is a subroutine shape. When a diagram genuinely cannot be drawn, the
  caption says why — `too wide for 80 cols — widen the window or ^X^O`, `too many
  boxes to draw`, `cannot draw faithfully in a terminal` — instead of a bare
  "source only in the terminal".
- **No more flashes while the agent works.** While a turn ran ("Thinking…"), the TUI could flash now and then, as if the whole screen re-rendered. Each spinner tick (about 13 per second) repaints the whole screen as one erase-everything-then-redraw write, and the terminal could paint it half-way. Each frame is now sent as one synchronized update (DEC mode 2026), so iTerm2, Ghostty, kitty, WezTerm, recent tmux and other terminals that support it show only complete frames. Terminals without mode 2026 (e.g. Terminal.app) ignore it: no change there, and no stray characters on screen.
- **`voice.enabled: true` in the config now actually reaches the TUI.** `loadConfig` never projected the resolved `voice` block into the object it returns, so every `startTui` site read `config.voice === undefined` and fell back to `VOICE_DEFAULTS` — Ctrl+R answered "voice is off — set `"voice": { "enabled": true }` in the config" although the config said exactly that. The block is projected like `tui`/`sessions`, and `connect` no longer degrades to the voice defaults *silently*: an unreadable config file now says so in one `[config] …` line before connecting.
- **Live dictation now shows your words while you speak, not only at the end.** On a Mac the live preview stayed empty for most of a take: Apple's recogniser, opened in its accurate mode, holds every in-progress result until the input ends, so a 5 s Italian take showed nothing until the final. A second, fast recogniser now runs on the same audio for the preview only — a partial about every second, the first after ~1.2 s — while the text that lands in your draft still comes from the accurate one, identical to before.
- **A fresh shell no longer hands its own framing to the first command.** The bytes that arrive after a shell's readiness marker are now passed to the first command instead of being discarded, so a pod's startup banner survives. The sentinel scanner also agrees with the ready parser about where the marker ends, so a pod that prints `__TNT__E` itself can no longer put the delimiter into a command's output.
- **`workload_shell` works on a multi-container pod, and says which container it used.** A pod with more than one container used to fail every call in under a second with `exec channel errored`: no container was named, so the apiserver refused the exec, and the refusal's reason never survived the trip back. The container is now picked on your machine with kubectl's own rule — the pod's `kubectl.kubernetes.io/default-container` annotation, else its first container — and the first result names it, lists the others and points at `target.container` to choose a different one. The `container` and `namespace` fields now carry a description in the tool's schema, and a container the pod does not have is refused up front with the pod's container list instead of being left to fail. When the apiserver still refuses, the error now carries its own message (RBAC, SCC, admission) rather than a constant, with a bounded 5 s wait so a silent apiserver can never hang the report.

### Security

- **The mobile relay is hardened against the flooding an internet-facing
  service actually gets.** Four availability holes are closed and its log stops
  being a lever. Bun now refuses an oversized frame *before* allocating it
  (`maxPayloadLength` 96 KiB, above the largest legitimate Noise frame) instead
  of after a 16 MiB string existed; a `/v1/daemon` or `/v1/accept` socket that
  has not said `hello`/`accept` is capped per address and closed after 10 s
  instead of living forever on pings; `ping` is allowed only after `ready` and
  rate-limited; and a new `--max-ids-per-ip` (32) bounds how many computers one
  address may register. Behind Caddy the per-IP limits were **one global
  bucket** keyed on 127.0.0.1 — a new `--trust-proxy` makes them per client by
  reading `X-Forwarded-For` only from a loopback peer and only the right-most
  untrusted hop, with an IPv6 client collapsed to its `/64`
  (`apps/relay/src/client-ip.ts`). The deploy artefacts follow: the unit runs
  `--trust-proxy` and drops the fleet-sized overrides, and the Caddy site block
  adds HSTS, drops the `Server` banner, 404s every non-relay path and sets the
  header the relay reads. Logs are capped at 20 lines per kind per 10 s with an
  honest `log-suppressed` summary, IPs are never logged, stream-token prefixes
  are dropped and Apple's `reason` is bounded. The runbook's Caddy steps are the
  podman ones this host actually runs. Doc:
  `docs/fix/relay-hardening.md`.

## [0.6.0] - 2026-11-13

### Added

- **Images now survive a restart, a `--resume`, an archive→reopen and a re-attach.** A session's image bytes live beside its log as `<dir>/<uid>.attachments/<sha256>`, so the refs the history already names resolve to real bytes on the next model round instead of `[image unavailable]`: a `serve` daemon keeps them on disk with the session (archived sessions keep them, `session/delete` removes them, a `/clear` fork hard-links its images); a laptop keeps what it attached (the worker, `run` and `attach`) and gives them back through the existing upload before the resumed session's first prompt; a `--model-proxy` pod reads them from the laptop's disk under a scope of only the sessions this client opened. Gone bytes are never silent: one notice, and the send proceeds. No wire, log-format or `PROTOCOL_VERSION` change. Design: `docs/feat/attachments-durable.md`.
- **A prompt can now name an image, and it is resolved wherever the model actually runs.** `session/prompt` accepts `{ type: "attachment", ref }` blocks, so an image-only prompt is a real turn (no empty text block to work around) and a text-plus-image prompt is one message. Which side holds the bytes — the rule the whole feature turns on — is decided by who runs the provider, and the daemon now says which case applies: `initialize` advertises `agentCapabilities.images` as `{ input: "upload", maxBytes }` when the daemon runs the model (the client uploads by `attachment/put`, then names the ref) or `{ input: "client" }` when the laptop holds it (a pod with `--model-proxy`: the bytes stay on the laptop and only the ref crosses, so a pod never receives image bytes). A daemon whose model has no vision advertises nothing, and a client then refuses the attach before uploading. Every refusal is structured (`AttachmentRefused` with `images_off`, `invalid_ref` or `not_uploaded`) and happens before anything is recorded, so a refused prompt starts no turn and the same `turnId` is still usable once the image is uploaded. On the laptop side `RemoteClient` gained `imageInput()`, `attachImage()` (an upload, or bytes held in a bounded 100 MiB in-memory store that never evicts) and `prompt(…, attachments)`, whose refs ride every keyed re-send after a drop under the same `turnId`. The laptop attaches its own scoped source at all three model-serving casts (`model/stream`, `model/streamChunked`, `model/countTokens`), so a pod can name only ids the laptop itself added — anything else becomes a visible placeholder, never a read. New config: `model.images` (and `models.*.images`), with the effective value coming from one `imageLimits()` so the advertised capability can never disagree with what the provider does; `model.images: true` opts an OpenAI-compatible endpoint in. No interface sends an image yet — the attaching UI is the next task.
- **Drag a photo into the TUI — or type `/attach <path>` — and the model sees it.** A pasted image path (or several) becomes a chip row in the input box; Enter uploads each image's bytes through the session and sends the prompt naming their refs, so an image-only prompt is a real turn. The transcript shows `[image: name]` for your own prompt, for another device's (`turn_start.attachments`), and after `--resume`. Every refusal is a visible sentence with nothing sent and nothing lost: a HEIC or an oversized file, images off on this daemon, a turn already running (the draft is kept, never queued), an upload that fails (the text and chips come back — Esc cancels an upload), or a daemon that no longer holds the bytes (the bubble is withdrawn and Enter uploads again). Backspace on an empty input removes the last chip; `/retry` re-sends the text only and says so.
- **A path dragged into the terminal is recognised for what it is — an image candidate, or prose.** Terminals have no "file dropped" event: macOS Terminal sends `/Users/me/Shot\ 1.png`, iTerm2/Ghostty wrap it in quotes, kitty/VS Code send `file:///…%20…`, and several files may arrive at once. The TUI now has the pure layer that reads those forms (`~` and `./` included): a paste whose *every* token is a path becomes attachment candidates, while a path inside a sentence stays text — the user may be talking about a workspace file. The image type comes from the file's **bytes**, never its extension, so a PNG mislabelled `.heic` is a PNG and a renamed download is not one; PNG, JPEG, GIF and WebP are accepted, HEIC/HEIF is recognised and refused with a way out (`export it as PNG or JPEG first (macOS: sips -s format png …)`) rather than a bare "not an image", and every other file says it is not a PNG/JPEG/GIF/WebP. The limits are the wire's own (15 MB per image, 5 per message): a missing file, a directory, an unreadable file, an empty one, one over the cap and the sixth image each get a sentence naming the file and the limit, and nothing is ever attached silently or half-attached. File access goes through one injected seam, so the whole layer is tested without touching the disk. The UI wiring — chips in the input, `/attach`, upload — is the next task; nothing sends an attachment yet.
- **An image's bytes can now reach the daemon that holds the provider (the transfer the attaching UI will use; still nothing in the interface sends one).** The foundation moved the refs; this moves the bytes, chunk by chunk and resumably. A new `attachment/put` sends one 256 KiB chunk per request and answers with `have` — the contiguous bytes the daemon holds from zero — so an interrupted upload resumes where it stopped instead of starting over (a dropped link costs at most two chunks), the same image re-attached is deduped by answering its first probe with `complete` at once, a duplicated or out-of-order chunk is acknowledged and ignored rather than written twice, and the whole blob is verified against its sha256 daemon-side before a byte becomes readable. The daemon keeps it in a per-session, content-addressed, in-memory store bounded at 100 MiB a session and 256 MiB a daemon: a begun upload pays for its declared size immediately, so a peer that announces 15 MB and sends nothing cannot exhaust memory, and a full store refuses new uploads loudly (`store_full`) instead of evicting an image a message already refers to — only a partial left untouched for 10 minutes is dropped, and only when a new upload needs the room. The bytes belong to the session, not the connection, so a `serve` client that detaches and re-attaches resumes; closing or deleting a session returns every reserved byte. The laptop sends in a window of two chunks (the measured sweet spot for the control messages that share the link), never reads a path or a file the daemon names, and treats a daemon that answers `have` past the blob, `complete` before it, or `have: 0` forever as broken: it stops with an error after a bounded number of bytes rather than sending forever. A daemon too old to have the method answers `MethodNotFound`, which the client reports as a clear "this daemon cannot receive images — update tentacle". Both method and error are additive on the wire: no `PROTOCOL_VERSION` change. Custom clients can branch on the new error code `-32016` (`AttachmentRefused`, with `data.reason` one of `too_large`, `store_full`, `hash_mismatch`, `bad_chunk`), now in the published protocol schema.
- **Changelog entries are now one file per task, so parallel tasks stop colliding in `CHANGELOG.md`.** Every user-visible task used to add its bullet to the same `## [Unreleased]` list, which conflicted on every parallel pair, and — worse — a merge could file a branch's bullet silently under a version that had already been released (a wrong release note, and an emptied `[Unreleased]` that made the next release refuse). A task now writes `changelog.d/<slug>.<category>.md` — one Keep a Changelog bullet in a file named for the task, so two tasks never touch one path and a fragment dies with its branch — and `bun run release` builds the new version's section from those fragments, in Keep a Changelog order, then deletes them. `[Unreleased]` stays empty in the tree, and a test in `bun run check` fails if any entry is written there.
- **A per-computer identity and paired-device registry.** `<configDir>/devices/` holds this computer's key and the devices allowed to connect, shared by every `serve` on it; versioned, never overwritten when unreadable. Design: `docs/feat/device-pairing.md`.
- **Mobile app shell and the `e2e:mobile` harness.** The Expo app now has a
  native-stack shell (Computers → Sessions → a session placeholder) that lists a
  computer's sessions over the existing RPC stack, with Active/Archived
  sections, running/attached/job badges and honest link-failure wording, plus
  `bun run e2e:mobile`: a real `serve`, a mock model and Maestro flows on the
  iOS simulator — the gate every later mobile task merges through.
- **A sub-agent's spend is now bounded by TOKENS, not only by steps — and when it runs out the child is forced to write its report.** Steps bound cost badly: every round resends the whole history, a child has no compaction and no `context_reset`, so a runaway child grows ~quadratically — the observed failure was two `explore` children at 183 and 97 steps for 18M and 6.3M tokens (with `subagents.maxIterations: -1`), while a step cap low enough to catch that bites honest work. New `subagents.maxTokens` (env `TENTACLE_SUBAGENT_MAX_TOKENS`, default **2,000,000**, `-1` = unlimited) counts each model call's `promptTokens + completionTokens` — cache reads and writes included, so a resent history token counts 1:1 — summed over the child's whole life, across `twoWay` continuation passes (a message cannot buy more budget). Reaching it does not kill the child mid-stream: the round loop exits exactly as a spent step budget does and reuses the same forced final report — one tool-free model call that must answer in prose — so there is no second report path. The stop reason is the new `max_token_budget` (`PROTOCOL_VERSION` 24, as a `mandatory` update carries it), which the TUI renders as `✗ token cap`, the `turn_end` hook sees honestly, and the parent reads in the tool result as `_(sub-agent hit its token cap)_`; the child's report also carries `(token budget reached: N of M tokens used)` so the parent can narrow the task instead of re-spawning blindly. The check runs at a round boundary (like the step cap), so the overshoot is at most one round plus the forced report's own usage — stated in the config's own details. A cancel still wins over the cap, and a provider that reports no usage leaves the cap inert (the step cap is then the only bound) rather than stopping a child wrongly.

### Changed

- **`tentacle config list` now shows every known setting with its EFFECTIVE value and where it comes from, and `config get` answers for a key you never set.** `list` used to print only what the file happened to hold, so a key left at its default was invisible — `tentacle config list | grep image` found nothing for `model.images`, and `config get model.images` failed with "not set". `list` now walks the key registry: one `key = value  # origin` line per setting, where the origin is `file`, `profile <name>`, `env TENTACLE_…`, `default` or `no default` — and a default that depends on something names it, e.g. `model.images = false  # default (openai-compatible)`, which becomes `true # default (anthropic)` once the provider is Anthropic (the two image limits come from the same `imageLimits()` the providers use, so the line cannot disagree with what a session really does). `config get <key>` on an unset key prints that same line and exits 0 instead of failing; an unknown key is still refused with the nearest-key suggestion, a key with no value at all (`model.titleModel`) still exits 1, `get` on a SET key still prints the bare stored value, secrets stay masked (`***`, `[***]`), a map's entries are listed by their real names (an entry nothing defines keeps its `mcpServers.*.command` pattern, so no name is invented), and a key in the file that the registry does not know is still listed in clear so a typo stays diagnosable. `config list --set` keeps exactly the old output for scripts, and `--json` carries `{path, value, origin}` per setting. `--set` on any other `config` command is refused instead of being silently ignored.
- **The phone's session link: an ask waits for a person, and leaving never ends
  a session.** The mobile app now builds its single permission broker *held*
  (no requester until the permission sheet is up) instead of denying, so a
  daemon-side ask is never answered on the user's behalf; quitting or losing the
  app detaches (`drain()` + `close()`) instead of sending `session/close`, so a
  session keeps running for every device; and a new pure foreground gate drops
  the socket when iOS backgrounds the app and holds the redial until it is
  active, so returning re-attaches instead of leaving a ghost attachment for up
  to a minute. A new pure session controller owns open/leave (never create,
  never close), serialises a fast back-then-forward per session id, and turns a
  failed attach into a typed reason (`archived` / `deleted` / `gone` /
  `too-many` / `timeout` / `link`) decided by error class, never message text.
  No protocol change. The session screen itself is 12c.

### Fixed

- **Three small detached-run annoyances are gone: a `MultiEdit` permission ask now names the file and how many edits, `attach` stops leaving `[resume] … — (empty)` on screen after exit, and `tentacle ps` clears a background job's count as soon as the job exits instead of up to 30 s later.** `fs_multi_edit` had no case in `describeToolCall`, so its prompt showed `—`: the person was asked to approve an edit with no idea which file, or how many. It now reads `Edit a file` with `src/a.ts · 2 edits` as its subject — the wording the transcript row already used — and a malformed input still names the file. A plain `attach` re-opens the kept run's own conversation, but that uid is tentacle's choice, not the person's: the pre-mount `[resume] <uid> — <title>` line answered nothing anyone asked, the alternate screen hid it until exit, and for a history nobody typed into (a `/clear`ed chat, then a wake) it named the session `(empty)`. A tentacle-chosen uid is now silent — `--resume`/`--continue`, which the person did type, still name the session — while warnings, unreadable logs and refusals still print. And a job's exit now re-reads the running count at once instead of waiting for the 30 s poll, so `ps` no longer says `1 background job(s) running` for up to half a minute after that job died; a daemon that publishes its own job list (current pod binaries) already owned that number, and it stays the only writer there.
- **A DSML re-ask no longer eats the step budget, and `/compact` refuses a summary cut at the output limit.** When a model leaked a tool call as DSML text, the one corrective re-ask was meant to be free but actually cost two steps — with a small cap (sub-agents) a single leak could spend the whole budget and jump straight to the forced step-limit report; it now costs nothing, like the re-ask after a reply cut at the output limit. Compaction used to accept a summary the provider had cut off (`finish_reason: length`, or a stream that ended with no stop reason) and replace the whole conversation with it, silently losing the end of the brief; it now fails with a clear error and leaves the conversation untouched, so you can retry. Opt-in tool-output summaries (`summarizeLargeOutput`) get the same check and fall back to their existing "summary failed, full output at <path>" pointer.
- **A failed background sub-agent now reaches its parent in the same turn, with the findings it had already made — and `agent_control status` no longer denies it existed.** A child that ended while the parent's turn was running was invisible to the model until its NEXT turn began (exits were drained only at a turn's start), so the parent kept working on a dead child: the owner's transcript shows `sa-3 ended (error)` followed by "the sub-agent is still running", then `status` answering *no such background sub-agent* about a child that had just reported. Sub-agent exits are now delivered at the next round boundary, in the same turn (a shell job's exit still waits for the turn's start: it is pollable and has no report to lose). A child that THREW — the only `error` path there is — kept only its exception: its partial report and its tool count died with the frame. They now survive (`SubagentFailure`), so the note, the moved-foreground result and the foreground tool error all read `the sub-agent failed after 77 tool uses: …` plus `Partial output before the failure: …`. `AgentJobs` remembers the last 16 ended children, so `agent_control status sa-3` answers `sa-3 ended (error) 12s ago after 77 tool uses` and says where its report is — `no such` is kept only for an id that never existed (or was evicted). The TUI notice stops over-claiming: `sa-3 failed · 77 tool uses · … — the agent gets its error and partial output at its next step`, and the panel reads `✓ finished · report queued for the agent`; a failed child's headline reads `failed` instead of `finished (error)` in the live note and on reload.

## [0.5.0] - 2026-11-12

### Added

- **Image references travel with a message through the whole runtime (the foundation for attaching a photo; nothing in the UI sends one yet).** A `ChatMessage` may now carry `attachments` — content-addressed refs (a lowercase-hex sha256, an `image/*` MIME type, a byte size, an optional display name), never the bytes — and every boundary that used to drop them silently keeps them: the conversation history, the `session/open` seed, both provider payloads (images before the text, as an Anthropic `image` block or an OpenAI `image_url` data URL), and the pod tunnel, where the pod sends refs and the laptop alone may read bytes. Both providers show a visible placeholder instead of nothing when an image cannot be sent — `[image omitted: this model does not take images — cat.png sha256:…]`, `[image unavailable — …]` (no source yet, a resume before the bytes exist, a pod's ref), `[image omitted: unsupported type image/heic — …]`, `[image omitted: only the last 5 images are sent — …]` — and a source that answers the wrong bytes is detected by sha256 and size, never trusted. A model's ability comes from a new `model.images` option (default on for Anthropic, off for an OpenAI-compatible endpoint, which is usually a local model that would reject the block); when off, not a byte is read. `Session.send` refuses an unsendable ref (an unsupported type, over 15 MB, a duplicate, more than 5 on one message) with an error naming the image and the limit, before anything enters the history, and an image-only prompt now starts a turn instead of being read as a continuation. Compaction and `context_reset` drop images by design — the summary is told `[image: cat.png sha256:…]` existed — and sub-agents still get text. On disk a message with refs is written as a new CRITICAL log entry (`media_message`/`media_replace`) rather than a plain `message`: an older build then refuses a session that contains images **loudly** and leaves the file untouched, while every session without images stays readable by any build. That new entry type bumps `PROTOCOL_VERSION` to 23, so a mixed Mac/pod pair fails cleanly at `initialize`.
- **`explore` sub-agents can now SEARCH the workspace, not just read it.** A read-only investigator had one tool, `fs_read`, so locating a symbol meant opening files in slices — every slice staying in its context for every later step (the 183-step, 18M-token child of `TODO.md`). A child of type `explore` is now offered a bounded, prompt-free `search` as well: `content` mode returns matching lines, `files` mode returns matching paths (with `pattern` = "which files contain this", or `glob` = a file-name pattern), capped at 100 hits / 12000 bytes with an explicit truncation marker and a per-file digest of what was cut. It runs on `ripgrep` when the image has it and on POSIX `find`+`grep` when it does not, with the same output shape and bounds either way and the engine named in the result's header; the paths it walks are confined to the workspace (an absolute path or one climbing out with `..` is refused), and on the grep engine `\d`/`\w`/`\s` are translated to POSIX classes while lookaround, `\p{…}`, `{n,m}` and lazy quantifiers are refused with a message saying what to do instead — never silently different results depending on the image. The `explore` prompt now says to search first and read only the lines a hit pointed at. Only `explore` gets it: the main agent and `general` keep `shell`.

### Fixed

- **You can type to the model with the background dropdown open, and `ctrl+x` is the stop key.** The dropdown used to treat every printable key as a stop's or nothing's, so with it open the input's cursor still blinked while not a single character reached the model — it read as a hang. A printable key now moves the keys to the input and is typed there, and the dropdown STAYS VISIBLE while you type (Esc closes it, ↓ goes back into the list); Enter sends the text to the main agent. Because typing must never arm anything, the stop is no longer bare `x` then `y`: it is `ctrl+x`, then `ctrl+x` again on the row's `stop sa-N? ctrl+x`, for a sub-agent and for a shell job alike. `ctrl+x` also stops meaning "send queued messages now" while the LIST has the keys, so the chord's `ctrl+s` still works everywhere else. While you TYPE with the dropdown pinned the keys are the input's, so `ctrl+x` there is the chord's again and a doubled `ctrl+x` cannot stop a child — press `↓` first if a stop is what you meant.

- **Writing to and stopping a background sub-agent works in plain `tentacle` again (and in `run`/`attach`).** The laptop runtime wrapped its session in the persisting controller, which forwarded every panel member except three, so the panel's own guards refused on every attempt: sending to a running child always showed `this session cannot message background sub-agents (older daemon or local mode)`, and `x` then `y` hit its twin (`no agent kill here`) — while `tentacle connect` worked, since it drives the bare session. The controller now carries `messageSubagent`, `killSubagent` and `onSubagentMessage`, so a message reaches the child and its `✓` row comes from the daemon as before, a stop ends the child, and the notice blames nothing it should not: a runtime with no sub-agent panel at all (e.g. `--in-process`) now says `this session's runtime cannot write to sub-agents`, where the old text guessed at an older daemon or "local mode".
- **A reply cut short is no longer presented as the complete answer, and a turn that produces nothing no longer ends in silence.** Two faults from one session on a local model whose server slot was far smaller than the configured context window. First, `finish_reason: "length"` was read by the OpenAI provider only to flush its tool-call assembler and then thrown away, so a reply cut mid-sentence (`…la vera soluzione è`) was stored and shown exactly as a finished one — and a body that simply STOPPED, with no `finish_reason` at all, was byte-identical to a complete reply. Both providers now report why a stream ended (`done.stopReason`), and the loop acts on it: a reply cut at the output limit keeps its text — it is real work — but says `the reply was cut at the model's output limit — this answer is incomplete; asking it to continue` and re-asks the model ONCE, from where it stopped (bounded to one, because a truncation caused by a full context re-truncates at once); a stream that ends with no stop reason is missing data, so the turn FAILS with an error instead of accepting the fragment — the same stance `AnthropicProvider` already took for a stream cut inside a tool call; and a tool call cut by the limit is never run, since its arguments may be partial JSON (before this, the call was dispatched and burned 17 rounds). Second, a turn whose replies were all empty ended `end_turn` with no event shown at all — the TUI looked hung; it now says `the model returned an empty reply and did not continue when asked — nothing was produced for this turn`. An empty reply cut by the limit is not the model's choice to say nothing, so it gets the truncation re-ask rather than spending the loop's stall nudges. Both notices are new display-only updates (`truncated_reply`, `empty_turn`), so an older client skips them instead of failing the turn: no version bump. The tunnel to a pod carries `done.stopReason` too, so `run`/`attach` get the same behaviour (it was being stripped on the way in, and a cut tool call ran there); and the truncation notice says what the LOOP knows — whether the one re-ask is still coming — so when the continuation is cut as well the user is told the recovery failed instead of being promised a re-ask that never arrives.

## [0.4.0] - 2026-11-11

### Added

- **Running background shell jobs appear in the dock, like sub-agents.** A job started by `shell{run_in_background:true}` now counts in the pill (`2 agents · 1 shell`, counted apart from the agents), gets its own dropdown row (`◆ bg-3  shell  watch: grep -c '### Turno' conv.md   running · 4m 10s` — the elapsed time from the daemon's `startedAt`), and Enter opens it in a drawer showing the last 12 lines of its output, read on demand and refreshed at most once a second while it is open. The output is ONE stream in the order the process wrote it — stdout and stderr interleaved, the same stream `shell_output` gives the model, so a job that logs to stderr no longer hides its stdout (a program that block-buffers stdout on a pipe can still flush late, as on any pipe); reading it never consumes what the model will read. `x` then `y` stops a job from the dock. A job's command is pod-supplied, so every line it prints is made safe at the client before it reaches the terminal. A job that exits leaves the list at once (`✓ exited (0) · 4m 10s` in the drawer, `✓ bg-3 done` in the pill), and a quiet confirm now counts running jobs apart from sub-agents. The drawer's head says how it ended with the total run time — `✓ exited (0) · 4m 10s`, `✗ exited (2) · 4s`, `✗ killed · 2m`, `✗ stopped · 30s` when you stopped it from the dock — and the drawer fits short terminals now (its tail is cut to the rows left, so an 80×20 or 80×16 screen never overflows); CRLF output shows its lines instead of blank ones, and a clean exit can no longer freeze as `✗ stopped` when the exit and the list arrive in separate frames. New protocol methods `session/job_output` and `session/job_kill` and the update `jobs` (display-only, sent on a start or an exit): no version bump.

- **`ps` no longer claims a job is running half a minute after it exited.** A detached run's `ps` line took its job count from a 30 s poll; the daemon now reports the running set as it changes, and the relay reads that instead, so a start or an exit shows up within a tick. The sub-agent count is unchanged.

- **Background sub-agents are one pill in the status line, and you can write to one.** Nothing permanent sits under the footbar any more: the last line reads `⏵⏵ auto-accept on · 2 agents ↓`, and with nothing in the background there is no pill at all — the screen is exactly as it was. DOWN on the prompt's last line focuses the pill (`enter open · esc back` just left of it; highlighted, so it reads as a control), Enter or a click on it opens a dropdown ABOVE the input, and Enter there — or a click on that row — opens the sub-agent in a drawer in the same place. Ctrl+T or `/agents` reaches the dropdown from anywhere, and Esc walks back out: drawer → dropdown → pill → input. At rest the input's top rule still carries the model; while the dropdown or a drawer is open it never does (a plain line for the dropdown, `─ → sa-1 · enter sends · esc back ─` for a child), so the input says only what concerns the input. Rows are compact and left-aligned — `● sa-1  Ada: turni dispari   8 tools · 74k · 1m 24s` — the title capped at 56 cells and the figures starting 3 cells after the widest title, never padded to the far edge; the type column appears only when some child is not `general` (so `general` is never repeated), and a sub-agent's MODEL appears only when it differs from the main agent's, as a column in the dropdown and in the drawer's head (`─ sa-2 · Bruno: turni pari · qwen3-8 ─── running … ─`), never in the pill and never on the input rule. A child waiting on your permission turns the pill warning-coloured and names it (`▲ sa-2 asks`), which is visible with the dock closed; a child that finishes shows `✓ sa-1 done` for ~5 s, then the new counts, and the last one to end leaves no pill. The dropdown keeps the 5-row window with `↑k ↓m`, `x` then `y` to stop, and the drafts-per-target as before. New protocol field `subagents[].model` (a `models` name, display-only, absent when it is the main agent's model): no version bump.

- **The agent can see what its sub-agents are doing.** One read-only answer for one `sa-N` or for all of them: its state, tool uses, tokens, elapsed time, how many of the agent's messages it has not read, and the last few actions it took (the same labels the panel shows). It is what makes stopping or steering a child usable before it is obviously in trouble — an `explore` at 183 steps and 18M tokens is now visible while it runs. It is part of `agent_control` (`action: "status"`, below), never given to a sub-agent itself, and its answer is compact text with a bounded number of children and length; it says to consult it when you need to know, never to call it in a loop to wait (the child's report still wakes the agent by itself).

### Fixed

- **A long tool call is no longer split in two, and a tool call leaked as text is refused instead of being taken as the answer.** Two separate faults from one DeepSeek session. First, tentacle assembled streamed tool calls by the wire `index` alone, so when the server stopped repeating `index` mid-call (DeepSeek does), the rest of the arguments landed on a second, nameless call: a long `fs_write`/`shell` body arrived as a short head (`invalid JSON arguments for fs_write`) plus a tail that failed as `unknown tool:` — 108 times in one run, and only on long arguments. Assembly now treats a delta with no `index` as the continuation of the running call, which is what the server meant. Second, the same endpoint sometimes renders the tool call in DeepSeek's own DSML markup and sends it as ordinary text; tentacle used to accept that as the final answer and end the turn with the work not done. A reply that is a DSML tool call and carried no real call is now refused, the model is asked once more with a note saying so, and a second leak fails the turn honestly instead of looping. Nothing is retried forever, and no other model's markup is guessed at. The notice shown when a reply is refused is a new display event, so a laptop on an older build skips it instead of failing the turn.

- **A dev build now says which build it is, and a version skew says what actually fixes it.** Two builds of `0.3.0` printed `tentacle 0.3.0`, so `tentacle connect` refused with `protocol version mismatch: client 21 (tentacle 0.3.0), daemon 16 (tentacle 0.3.0) — update the daemon: run "tentacle update" on that host` — two builds that look identical, and advice that does nothing when the daemon already IS the latest release (`tentacle update` reinstalls it). A build that is not a release now carries its build id in the version (`tentacle 0.3.0+6f43104044d1`; `tentacle --version` and `--version --build-id` agree), while a released binary keeps the plain version, so the `+` means exactly "not a release". With that, the refusal names the real fix: an older daemon plus a dev-build client now says `the client is a newer build than any release: install the same build on that host (build this source there, then run "tentacle serve")`, an older RELEASE daemon keeps the `tentacle update` hint (which can really move it), and an older client is still told to update — while a container daemon keeps its `tentacle attach` advice, which re-injects this build. No protocol change.

- **A `tentacle connect` TUI's finished background job no longer reads `✗ stopped`, counting for ever.** A shell job that exited under `connect` froze its open drawer on `✗ stopped` instead of `✗ exited (3)`, and its duration kept climbing (26s → 32s) although the process was gone. The TUI learns how a job ended from its ONE live exit feed (`jobs.onExit`, where the outcome and the end instant are stamped), and `connect` handed it none — every other runtime passes `jobs: runtime.jobs` — so a drawer fell back to the `stopped` default and measured to `now`. `connect` now passes the same client-side jobs view (`remoteJobsView`) with `autoWakeOnJobExit: false`, so the exit reaches the drawer and no turn is started here: the `serve` daemon is still the only waker, as documented.
- **The background pill no longer says `0 agents · 1 shell`.** A count of zero is left out, so a shell alone reads `1 shell ↓` (and `2 shells`, `1 agent`, `2 agents · 1 shell` as before).
- **A compaction no longer renames the session to its own summary.** `/sessions` (and every list) took a session's title from its first user message, and after `/compact` that message IS the summary the compaction writes — so in the owner's own session, a title read `Summary of the earlier conversation (compacted to save context): …`. A derived (auto) title is now PINNED to the name it had once there is one: it follows the conversation's first real message, is never re-derived from a replaced history, and a model- or user-chosen title still wins; `/clear` drops the pin so the fresh chat names itself.
- **`/clear` says it happened, and the ctx meter follows it at once.** Under `connect`, `/clear` wiped the transcript with no word at all and left the meter at the cleared chat's figure until the next turn measured one. It now says `_Conversation cleared — a fresh chat in this session_`, and the measured fill of the replaced history is forgotten and the daemon asked to count what the session holds now.

- **A `tentacle connect` TUI shows the daemon's own model, not the laptop's.** The status bar's ctx meter drew the LAPTOP's `model.contextWindow` (its default 128k when `connect` names none) while the `serve` daemon was running its own model — on a 200k model the meter read `ctx ████░░░░░░ 42% (54k/128k)` and could look almost full when it was not — and the input's top rule said the literal word `remote` instead of the model's name. The daemon now reports its own model's NAME and window at `initialize` (`agentInfo.model`, `agentInfo.contextWindow`; a name and a number only — never an id, a URL or a key), and `connect` hands them to the TUI: the rule reads `───── served-m ─` and the meter counts against 200k. A pod or an older daemon reports nothing and the screen is exactly as before. New optional `agentInfo` fields (display-only): no version bump.
- **A carried `model.contextWindow` still only applies where the laptop's model IS the model.** A `serve` daemon builds every session's agent from its own config, so its context line, its warns and its `/compact` threshold use its own window whatever a client sends — pinned by a real-stack test (`/ 128k tokens` in the request, never the carried `72k`).

- **A model error on a `serve` daemon shows what the model actually said.** A daemon whose model answered `401 Invalid API Key` — or whose inference engine was restarting — gave only `RpcError: internal error`, and a turn whose engine never answered stayed `Working…` for ever: every later message was queued, so nothing ran until you quit and reconnected. A failed turn now carries the provider's own message (one line, anything key-shaped masked, the tail capped) and says WHICH model failed: the `serve` daemon uses its own model and key, so the line points at `tentacle config` on that host. A pod daemon still shows an opaque message (its host is not trusted). A second message sent while a turn is genuinely in flight is refused (`a turn is already running`, your text back in the input) instead of silently orphaning that turn — the state that left every later send failing — and a send issued while the link is down no longer wedges it: the link reconnects to the same session and the next message runs. `tentacle serve` also prints one line at start-up when its own config names no model — the endpoint and model it is using, and which setting to change if turns fail — so a 401 is explained before the first turn.
- **One invalid tool call no longer poisons the whole session.** A local model that emitted a tool call whose arguments were not valid JSON (a long file body cut mid-string) made every later request fail — on llama.cpp, `500 "Failed to parse tool call arguments as JSON"`, the very next round of the same turn included. That call is now sent to the model as `{"_invalid_arguments":true,"bytes":N}`, and the result paired with it says what was replaced and that the marker is not a tool input; unanswered calls and stray results are repaired the same way, always in the model's copy only. **Your saved session is never rewritten**: the log keeps what happened, and the repair happens on every request, so an already-poisoned session works again with no file edit. When it happens, the TUI says so once per session (`history repaired for the model: 1 tool call with invalid arguments — the saved session is unchanged`; the plain `run` output says the same). New display-only update `history_repaired`: no version bump.

- **A turn that dies mid-tool no longer leaves an unanswered tool call behind.** If the permission requester throws, a result transform throws, or a consumer stops reading at a `tool_result` (a client disconnect, a sink that throws), the calls of that round are answered in the stored history instead of being left dangling: `Not run: the turn stopped unexpectedly before this call started…` for a call that certainly did not start, `Interrupted: the turn stopped unexpectedly after this tool started; its result was not recorded…` for one that may have run. A result the client already saw is kept, and a call's raw output is never pushed when its transform (redaction, spill) did not get to run. Cancellation is unchanged.

- **Auto-accept now answers the wake turn after a background sub-agent finishes.** With auto-accept on (`⏵⏵ auto-accept on`), the continuation turn a `serve` daemon starts by itself when a background job or sub-agent exits used to show permission prompts for every call — the daemon mints that turn's id itself (`wake-…`), and the TUI answered only the turns it had started, so a wake — and anything a background child it spawned did — looked like another device's turn. Every `tentacle connect` TUI with auto-accept on now answers the session's own wake turns too (first answer wins when several are attached), while a turn another client really started stays asked, as before. `tentacle connect` is the only path that trusts this, because a `serve` daemon is the only one that wakes on its own and is trusted to say so; a pod's own `wake-…` turn stays foreign. The daemon now REFUSES a client that names a `wake-` turn id in `session/prompt` or `session/send_now` (`InvalidParams`), so no other client can borrow a TUI's auto-accept by naming a wake turn. That reservation is a breaking change: **the protocol version moved to 22, so client and daemon must be updated together** — an older `serve` does not refuse the id and a newer client would trust it.

- **The drawer shows whether the sub-agent read your message.** A message you sent to a running child kept saying `read before its next step` forever, even after `agent_control status` counted it as read, so you could not tell "not delivered yet" from "delivered and ignored". The daemon now sends how many of your messages each child has taken into its context (`subagents[].userRead`) and which one each `subagent_message` is (`n`, display-only: an older daemon shows today's text), and the drawer says `✓ read` once that message was read. A child that ended with your message still unread shows `· not read`.

- **`/clear` on a `tentacle connect` session no longer fails.** It answered `⏺ /clear failed: undefined is not an object (evaluating 'this.openForReset') — still in this session` and reset nothing: the TUI took the session's `clear` method off the object and called it alone, which works on the local runtime (its methods are closures over the inner session) but loses `this` on the remote session `connect` hands it. A job's drawer read its output the same way, and threw too. Both now call the method on the session.

- **The agent is told how to use sub-agents — and that there is a way back.** `agent_task`'s description now says to scope each prompt (the files, diff or questions the child owns, and a stop criterion), that this is the way to create and run agents of your own (role/persona ones included), and how the two patterns work: turn-based (one foreground sub-agent at a time, its report the call's result) or long-lived (`background: true`, then `agent_control` to steer it). Starting another agent CLI (`claude`, `codex`, `tentacle`) through the shell is the exception, for when you ask for it. A request like "create two agents" in an empty folder now goes to `agent_task` instead of a shell. With `subagents.twoWay` on, `agent_task` and `agent_control` also say a background sub-agent may answer with `agent_notify`, arriving as a `[sub-agent sa-N → you]` note that may wake you, instead of "no reply comes back, it does not wake you"; with it off the texts are unchanged, and a custom `subagents.agentTaskDescription` is still used as is.

- **`/clear` and `/compact` on a session you just resumed now really reset it.** `tentacle --resume <id>` and `/clear` (or `/compact`) before sending anything did nothing at all: the chat stayed, the model's context stayed, and the TUI either said nothing or claimed "Context compacted — 0 → 0 messages" — the daemon had no conversation under that id yet (it was still only your laptop's saved copy), so it answered "nothing to reset". Both now open that saved conversation first (exactly as your next message would) and then reset it: `/clear` clears it and keeps the dropped chat as its own session, `/compact` compacts the real history. If a `/clear` ever resets nothing while a chat is on screen, it now says so instead of staying silent. An own `/clear` on a session kept live by another device is no longer announced as "the conversation was cleared on another device" (only the other device is told), and a `/compact` of yours no longer leaves a stale count that would swallow the next "compacted on another device" notice.

### Changed

- **With `subagents.twoWay` on, a message handed to a background sub-agent says it may answer.** The text delivered into the child's own context (the user's panel message and the agent's `agent_control{action:"message"}` alike) now ends with one short line saying it can reply with `agent_notify`, instead of leaving the child to guess that a reply is possible; with the flag off the text is byte-for-byte what it was.

- **One tool controls a sub-agent instead of three.** `agent_kill`, `agent_message` and `agent_status` are now `agent_control`, with an `action` argument: `"status"` (read-only, what it is doing), `"message"` (`agent_id` and `text`: it reads it before its next model step) or `"kill"` (`agent_id`: stops it). Nothing about the model's reach changed — the same three things, the same texts and refusals — but each request's tool definitions are ~870 characters shorter (1653 → 785 with `subagents.twoWay` off, 1704 → 838 with it on), and a local model sees one flat object instead of three tools. **A hook whose matcher names `agent_kill`, `agent_message` or `agent_status` must be updated to `agent_control`**: the matcher is the tool name, and those names are no longer called. Old sessions are unaffected — their transcripts and saved logs keep the old names and still render (each shows its `sa-N`), and a sub-agent still never gets any of them.

- **Writing while a sub-agent runs no longer waits for it.** Type a message while the agent's `agent_task` is running, and that sub-agent moves to the background as `sa-N`: your message reaches the model at the next round instead of after the child ends, and the child keeps working. Its report arrives later as a `[background]` note, like any background sub-agent's. With something for two of them, both move. Send-now (Ctrl+X Ctrl+S) no longer throws the work away: the sub-agent moves first, then the turn is cancelled, so its report still arrives. The `agent_task` block closes with `→ background as sa-1 · its report will arrive later` instead of a failure, and shows no report body (it comes as its own notice). If the sub-agent was waiting on a permission prompt, that prompt is withdrawn and asked again at once, marked `sa-1` — so a click landing in that instant has to be repeated.

- **`/clear` keeps your background work running.** `/clear` now empties the conversation inside the same session instead of starting a new one. Background shell jobs and background sub-agents keep running: they stay in the status line's count and in `/sessions`, and their exit or report arrives in the cleared conversation with its command or description. The agent there is told what is still running. The approvals you gave for this session ("always allow") are cleared, so a running sub-agent asks again for anything not approved yet. The old chat stays listed in `--resume` / `/sessions` as its own session, with its own id: it has no link to the running work, which stays with the cleared session. Another terminal on the same session sees the conversation cleared too. If a turn of yours is running, `/clear` stops it first. The protocol version moved to 21: an older pod daemon or `serve` is refused at connect with "update".

- **Background job notices stay notices after a resume.** The `[background] job N … finished` note the agent received now shows as a dimmed notice when you `--resume` a session (or a terminal resyncs), not as a message you typed.

- **Sub-agents are limited only by `subagents.maxParallel`.** tentacle no longer asks a llama.cpp server for its slot count (`/props`) to lower that limit, locally or on `run`/`attach`. Set `subagents.maxParallel` to match your server (e.g. llama.cpp's `-np`); with more sub-agents than slots, the server queues the extra requests. The protocol version moved to 18: an older pod daemon or `serve` is refused at connect with "update", as for any version change.

- **A running sub-agent shows its latest steps.** The `agent_task` block lists the last 5 tool calls of the sub-agent, under `… +N earlier · ctrl+o to expand`, instead of its first ones, so you see what it is doing now; Ctrl+O still expands the whole trail. A finished sub-agent keeps its last steps and its report visible, and one that was cancelled or failed ends with `✗ cancelled` / `✗ error`. Long rows are cut to the terminal width; the counts on the first row always stay visible.
- **The built-in sub-agent type `general-purpose` is now called `general`.** `agent_task` lists `general` and `explore`. An old session that names `general-purpose` still runs, on the default type. A user `agents/general-purpose.md` no longer replaces the built-in: it becomes an extra type, and the default type (used when a call names none) is now the built-in `general`, with all its tools. To keep your override, rename the file to `agents/general.md` (and its `name:` line, if it has one). A hook script that matches `agent.type == "general-purpose"` must now match `general`.
- **`tentacle serve` now stores its sessions as a session log, like the laptop.** Each session
  in `<configDir>/daemon/<project>/` is `<id>.jsonl` (the same log format as your local
  sessions) plus a small `<id>.state.json`; a save appends what changed instead of rewriting
  the whole history. A restart continues each session's log, so a client that was reading it
  carries on without a fork. Old `<id>.json` files from earlier builds are ignored (no
  conversion: delete the folder to clean up); a session a newer build wrote is left untouched.
  `sessions.keepSuperseded` now also applies to `serve` (from the `serve` host's config).
  Use one build per store: an older build does not see these sessions.

### Added

- **A background sub-agent can message you, and wake you (`subagents.twoWay`).** With `"subagents": { "twoWay": true }` in your config (env `TENTACLE_SUBAGENTS_TWO_WAY=1`), a sub-agent launched with `agent_task{background: true}` gets an `agent_notify` tool: it sends a short text to the agent that launched it, mid-run. The agent reads it at its next step — as a `[sub-agent sa-1 → you] …` note — and, if the agent is idle, an `autoWake` continuation turn starts, exactly as for a background job exit. You see `sa-1 → agent: <first line>` live as it arrives, in a local session, a pod, a `serve` or a detached run. The reply, if any, is `agent_control{action:"message"}`. It is off by default, and with it off no sub-agent is offered the tool and nothing else changes. Bounded, so two agents cannot ping-pong: at most 3 waking messages per session between two of your messages, and at most 8 messages of at most 8 000 characters per sub-agent — over the wake budget the text still arrives and just wakes nothing, over the per-child cap the sub-agent is told to put the rest in its report. On `run`/`attach` the setting is yours (the laptop's), it beats the pod's. A message not yet read when the session ends is lost with the sub-agent, like an unflushed background exit. On `--resume` the note renders as a notice, not as a row you typed.

- **The agent can write to a running sub-agent.** `agent_control` with `action: "message"` takes the `sa-N` id `agent_task` returned and a text, and the sub-agent reads it (`[message from the parent agent] …`) before its next model step — useful to redirect a background child without starting another one. It is one-way (no reply comes back; the report still arrives as a `[background]` note) and it never wakes the agent. The result says `queued`, not `delivered`: a child in the middle of a long tool call or a permission prompt reads it after that. A text the sub-agent can no longer read (it finished or is finishing) or a queue already holding 8 unread messages is refused with the reason and nothing is sent; a text over 8 000 characters is refused too. A text that arrived just as the child was finishing is either read in one last step or counted in its report, never dropped.

- **See your background sub-agents.** The status line shows how many are running (`· 2 sub-agents`), and quitting a session that would lose them asks first (`2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)`) — by `/quit`, `/exit` or Ctrl+C. `connect` only detaches, so it never asks. The agent can also stop one: `agent_control` with `action: "kill"` takes the `sa-N` id `agent_task` returned, and a refused launch now names it as an option. A detached run's relay keeps the laptop awake while a sub-agent runs, because that sub-agent needs the laptop for its model.

- **Background sub-agents.** The agent can start a sub-agent with `background: true` and keep working: the call returns at once with an id (`sa-1`), and the report comes back later as a note that wakes the agent, like a background shell job. They share the `subagents.maxParallel` limit with foreground sub-agents. Over the limit, a new sub-agent (background or not) is refused and the agent is told which ones are running, so it can end its turn and wait for a report, or do the work itself. A background sub-agent's permission prompts are asked as usual and name it (`sa-1 · general · "…" · background`). The protocol version moved to 20: an older pod daemon or `serve` is refused at connect with "update".

- **Named models for sub-agents (`models`).** Declare extra models next to `model`, then say which sub-agent type runs on which, and optionally let the agent pick one per task:
  ```jsonc
  {
    "model": { "baseURL": "http://localhost:8080/v1", "model": "qwen3-27b", "apiKeyCommand": "cat ~/.cache/llama-key" },
    "models": {
      // Same server and key as `model`, another model id.
      "fast": { "model": "qwen3-4b", "contextWindow": 32768, "description": "Small and quick: searches, summaries." },
      // Its own endpoint and key: nothing of `model`'s connection is inherited.
      "claude": { "provider": "anthropic", "model": "claude-sonnet-5-5", "apiKeyCommand": "pass show anthropic", "description": "Hard bugs and design questions." }
    },
    "subagents": {
      "types": { "explore": { "model": "fast" } },
      "selectableModels": ["fast", "claude"]
    }
  }
  ```
  An entry has the keys of `model`; what it leaves out comes from `model` — except the endpoint and key, which move together: an entry that sets any of `provider`, `baseURL`, `apiKey` or `apiKeyCommand` inherits none of them, so your main key is never sent to another server. `subagents.types.<type>.model` must name an entry (a typo refuses the config, naming the defined ones). An `agents/*.md` `model` is looked up in `models` first, else used as a model id on the main endpoint, as before; the config beats it. With `selectableModels`, `agent_task` lists those models with their `description` and takes an optional `model`; any other name is refused and no sub-agent starts. Every entry's `apiKeyCommand` runs once at startup, before the TUI (for a `run --detach`'s background relay, see the next entry). In a profile, an entry replaces the base one whole. Keys are masked by `tentacle config list/get` and refused on the command line, like `model.apiKey`; a docker/podman `run` hides every entry's key file from the workspace mount. On `run`/`attach`: see the next entry. `autoTitle`/`titleModel` inside an entry are accepted and have no effect. `tentacle explain <section>` now prints the section's details (for `models`, `profiles`, `model`). The docker/podman warning for a key file it cannot name says whose it is (`model` or `models.<name>`).
- **Named models work on `run`/`attach` too.** A sub-agent in a pod or container now runs on the entry `subagents.types.<type>.model` names, or the one the agent picks from `subagents.selectableModels`. The calls still run on your laptop, with your keys: the pod asks for a model by NAME, and your laptop serves only the entries it uses in `subagents.types` or `subagents.selectableModels` (any other name, an id, a URL or the main model's name is refused, and the first refusal per name is reported on the laptop as a `[laptop rpc]` line in the run's `daemon.log`, or in `relay.log` for a detached run). Only the names, context windows and the selectable models' `description`s travel to the pod; keys, URLs and model ids never do. Differences from a local run: a pod's own `agents/*.md` `model` never picks an entry (only your laptop's `subagents.types` and the agent's selectable `model` do), and the pod's own `models`/`subagents.types`/`selectableModels` are ignored (its daemon log says so). A pod's named calls have the same exposure as its main-model calls: no extra limit on the laptop. A `run --detach`'s background relay, which has no terminal, now runs the key commands of those published entries too, 10 s each: one that fails, prints nothing or needs a terminal makes only that entry unavailable to the detached run (a line in `relay.log` with the exit code, never the command's output; the agent sees an error on that entry), until a terminal attaches. `/settings` shows `models` as `(same text)` or `(text differs)`; `/settings sync` applies a changed publication to the session. **The protocol version moved to 19: update tentacle in your pods** (`attach` replaces the pod's binary; an older pod daemon is refused at connect with "update").
- **`tentacle config` edits your config from the command line.** `tentacle config subagents.maxParallel=3` (or `config set <key> <value>`), `config unset <key>`, `config get <key>`, `config list` and `config path`; `--profile <name>` targets that profile. The value is typed by the key (true/false, numbers, text; arrays and objects as JSON) and the whole file is validated before anything is written, so a bad value leaves the file untouched. Your comments, layout and key order are kept, and the write is atomic (a symlinked config is written through the link). A secret such as `model.apiKey` is never accepted on the command line, where it would land in shell history: pass `-` to read it from stdin, or leave the value out for a hidden prompt. `get` and `list` print secrets as `***`. A prompt that starts with the word "config" needs `tentacle -- config …`.
- **`tentacle explain [key]` documents every config key.** With no key it lists the top-level keys; a section (`tentacle explain subagents`) lists its direct sub-keys; a leaf (`tentacle explain subagents.maxParallel`) prints its card: meaning, type, allowed values, default, env var, flag, whether it is carried to a pod, scope and an example. `--all` prints every leaf, `--json` the same as data, and a typo gets the nearest key. It never reads your config and never prints a secret. Because `explain` is now a subcommand, a one-shot prompt that starts with the word "explain" needs `tentacle -- explain …`. The README's config table is generated from the same registry, so the two no longer drift.

- **A `tentacle serve` session reacts when a background job ends — connected or not.**
  The daemon starts the follow-up turn itself and saves it: with `connect` attached you watch
  it live (and can stop it with Esc); after `connect` quits (it only detaches),
  `connect --resume` shows it. The daemon is the only one that wakes a `serve` session, so
  there is one turn per job end, for every client. The `serve` host's own `autoWake` decides
  (default on; `"autoWake": false` in its config: no turn, the exit is shown at the next
  attach and flushed by your next message). A turn that ended in an error or was cancelled
  stops the chain until a normal turn. No limit, as in the TUI. Pod runs, the local worker
  and `run --detach` are unchanged.
- **`fs_write` and `fs_edit` may write to the system temp dir.** A scratch file in
  `/tmp` (or macOS's `/var/folders/…/T`) no longer fails with "refusing to write
  outside the workspace"; each write still asks as before (unless auto-accept is
  on, as for any write). Set the list with `"tools": { "writableDirs": [...] }`
  (absolute or `~/…`; env `TENTACLE_WRITABLE_DIRS`, `:`-separated): it
  **replaces** the default, and `[]` keeps writes in the project only; an entry
  that is ignored (`/`, a relative path) is logged. Paths are matched by real
  path, so a symlink out of a temp dir is still refused. Not carried to a pod: a
  container keeps writing its own `/tmp`.

### Changed

- **Sessions are saved as an append-only log, `<uid>.jsonl`.** Each round adds only its own lines to `~/.config/tentacle/sessions/<folder>/<uid>.jsonl` (a 2 MB session no longer rewrites 2 MB per round). Old `<uid>.json` sessions are **not read** any more (no conversion): `--resume` and the picker list only `.jsonl` sessions. A copy from another writer that the file does not contain is set aside in `<uid>.stale-….aside` with a notice, never dropped silently; two terminals of one detached run no longer overwrite each other. A turn cut mid-way is closed when the session is loaded. New `sessions: { keepSuperseded: true }` keeps the history a compaction or a context reset replaced (default off).
- The TUI's turn indicator reads `Working…` / `Thinking…` (capitalised), the word in the accent colour with the spinner; the timer and hint stay grey.
- **Saving a session after each round moves only what changed.** The laptop
  used to read the WHOLE history back from the daemon after every committed
  round (about 2 MB and 9 round trips for a long session, ~2.3 s on a pod's
  link, ahead of the streamed reply). It now reads the daemon's session log
  after the last entry it holds: about 1 KB and one round trip (~0.1 s on the
  same simulated link), and a reply streamed meanwhile is no longer queued
  behind it. The session file on disk is unchanged.
- **A history that diverged is kept, never silently replaced.** If a restarted
  pod daemon was reseeded from another terminal's copy, this terminal's copy is
  saved next to the session file (`<id>.stale-….aside`) with a notice, and the
  daemon's history is adopted.
- Protocol 17: a laptop and a pod daemon of different builds refuse each other
  at connect with the usual "update" message (`tentacle update`, or re-run with
  the same build).

### Fixed

- **`tentacle ps` and `tentacle rm` no longer run your `apiKeyCommand`s.** Those commands never call a model, yet the key commands (main and every `models.<n>`) ran while the config was loaded — so one that fails (`exit 7`, or one that wants a terminal) made `ps`, `rm`, `hooks trust` and `package …` die with `[config error] models.<n>.apiKeyCommand exited with code 7`. They now load the config without running any key command. `run`/`attach`/`connect`/`serve`, the TUI and a one-shot prompt still run it, exactly as before.

- File writes (`fs_write`, `fs_edit`, `fs_multi_edit`) are harder to steer
  outside the workspace with links, in the project as in the temp dirs:
  - a write through a **dangling** symlink is refused ("refused: dangling
    symlink"), and a symlink loop says so — before, a dangling link could create
    its target outside;
  - a file is now **replaced atomically**: the new content goes to a fresh temp
    file in the same directory (mode `0600` while it is written), which then gets
    the target's permission bits (or `0666` minus your umask for a new file) and
    is renamed over the target. An existing file is not written in place
    (except in a read-only directory, below), so a hard link planted at the path
    only loses that name; the file it shares an inode with keeps its bytes. Like
    an editor's atomic save, this **breaks hard
    links** (a hard-linked project file, e.g. a `file:` dependency after `bun
    install`, stays writable and loses its link) and **does not keep the file's
    owner, group, ACLs or extended attributes** (macOS tags and quarantine
    included), nor setuid/setgid/sticky bits;
  - a file you could not write in place is still refused: a read-only file or
    another user's file without write permission for you fails with `EACCES`,
    unchanged;
  - in a directory you cannot create files in, an **existing** writable file is
    still written, in place, as before (opened without following a symlink and
    without creating; refused if it has more than one hard link or is no longer
    the file that was checked). A **new** file there is refused, with an error
    naming the directory;
  - a symlink, FIFO or other non-regular file at the path is refused, and a
    directory swapped for a symlink between the check and the rename is
    detected in most cases (the path is re-checked after the temp file is made
    and before the rename).
  A write through an existing symlink to a file inside the workspace still works.
  **Known limit (hosts shared with other users only):** another local user who
  can write a directory on the path — e.g. one they created in `/tmp` — can win
  the race by swapping it for a symlink at the right moment. Your content can
  then land outside, in a new hidden file (`.tt-<random>.tentacle-tmp`) in
  any directory you can write; an existing file there is never written in
  place by this race. Not covered either: a process running as you, and the `shell` tool,
  which is not confined.

### Fixed

- **A long `run` turn is saved on your laptop after every finished round, not only when
  the turn ends.** Before, a pod or container lost mid-turn (`docker stop`, OOM, node
  loss) took the whole conversation with it: nothing had been written yet, so there was
  nothing to resume. Now the session file grows during the turn and you lose at most the
  round in progress; a resume closes the unfinished call honestly. A session's creation
  time also stays fixed across saves (it was reset at every save, so it always equalled
  the last-updated time).

## [0.3.0] - 2026-11-06

### Added

- **A light palette, chosen from the terminal's own background.** On startup, before
  the first frame, the TUI asks the terminal for its background colour (`OSC 11`, with
  a 200 ms cap — a terminal that does not answer costs one round trip, not the timeout)
  and paints the matching palette: a dark-green/red diff tint with dark text on a light
  terminal instead of the near-white on dark tints that were unreadable there. Every
  colour — accent, auto-accept, the dim greys, the context meter, syntax highlighting
  in `fs_read`, Markdown and fenced code, the notice blue — has a light value, gated at
  4.5:1 contrast (3:1 for borders) on white, on Solarized Light, and after the
  downgrade to a 256-colour terminal. Dark output is byte-for-byte unchanged.
  **Override with `"tui": { "theme": "auto" | "dark" | "light" }`** in `config.jsonc`
  (or a profile): `dark`/`light` skip the query entirely. `connect` honours it too; an
  unreadable config there warns once and connects anyway. A display setting only — it
  is never carried to a pod.
- `tools.outputRetentionDays` / `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS`: how long large
  tool outputs are kept (days, default 30; `0` or negative = forever).
- **Sub-agents run in parallel.** Several `agent_task` calls in one message now run at
  the same time, in a shared workspace. `subagents.execution` chooses: `parallel` (the
  default), `read-only` (only sub-agents that cannot write) or `sequential`.
  `subagents.maxParallel` (default 4; env `TENTACLE_SUBAGENT_EXECUTION`,
  `TENTACLE_SUBAGENT_MAX_PARALLEL`) is the ceiling, and a llama.cpp server with fewer
  slots lowers it on its own. In a pod or container these are your laptop's values.
- **`subagents.agentTaskDescription` or `agentTaskDescriptionFile`** (at most 4096 bytes;
  setting both is a config error) replaces the `agent_task` description; the list of
  sub-agent types is still appended.
- **The permission dialog names the sub-agent that asks**, for example
  `explore · "find callers"`.
- **The status bar names where the agent runs.** In a container or pod the
  left of the bar shows a badge: `docker:<name>`, `podman:<name>`,
  `kubernetes:<pod>/<container>` (the container is always shown); the prefix
  is grey and the name keeps the accent colour. A local session shows nothing.
  The bar stays one row: on a narrow terminal the path shrinks first, then
  `kubernetes:` becomes `k8s:`, then the badge name is cut in the middle. The
  scroll hint and `expanded` never cut the name (they are left out instead),
  and the `ctx` meter always keeps its max.
- **Context at open.** `ctx` is shown with its max from the start, before any
  turn: the exact count where the provider can count without generating
  (Anthropic `count_tokens`; llama.cpp `/apply-template` + `/tokenize`), else
  an estimate marked `~` (`ctx █░░░░░░░░░ ~7% (~9k/128k)`). It covers the real
  history on `attach` and `--resume`, refreshes after `/compact`, and the first
  turn replaces it with the measured figure. `↑ ↓` token totals are hidden until
  measured. The count is capped at 2 s and falls back to the estimate silently;
  in a pod run it is made by your laptop, so the model key never leaves it.

### Changed

- **`/settings` and `/settings sync`.** `/settings` shows all the settings of the
  running session as one indented JSON block, nested as in `config.jsonc`, with
  comments for the values the container sets (`// (container)`) and those that differ
  from this terminal (`// this terminal: …`). `/settings sync` applies this terminal's
  settings to the live session, between turns: the conversation, background jobs, your
  approvals and other terminals stay, and those terminals see `Session settings changed
  by another terminal: { … }`. Values the container's own config sets still win. A
  project-hooks trust you gave is asked again after a sync. Not available on `connect`
  or a local session.
- **Attaching to a session is now bounded.** A daemon that makes no progress for 30
  seconds (no answer, no new page of the history) no longer leaves the terminal
  waiting for ever; a long history on a slow link still loads. `attach` says so and
  opens the session at your first prompt; attaching to a detached run, and `connect`,
  fail with `no answer from the daemon within 30s`, so you can retry.
- **`tentacle run --rm` replaces `--keep`, as in docker and kubectl.** A run still
  keeps its pod or container by default; `--rm` removes it when the run ends
  (`--detach --rm`: when the run goes idle or is stopped), and `--rm=false`
  overrides the config. In the config (and profiles) `keep: false` becomes
  `rm: true`; `keep` is no longer accepted and is reported as an unknown key.
  There is no `--keep` alias: it is an unknown option; the help names `--rm`.
- **`-d` is the short form of `run --detach`.**
- **Detached-run state files change format (version 2).** `owner.json` and
  `spec.json` now carry `rm` instead of `keep`. Runs started by a previous build
  keep running and keep their workload, but this build lists them as `unknown
  owner`, cannot take them over while their relay runs (afterwards `attach` is a
  plain one, which never deletes), and leaves their `owner.json` for you to
  delete; `tentacle rm <name>` still removes them.
- **`ps` and `rm` no longer make a finished detached run look alive.** Once its relay
  has finished and no terminal is on it, `ps` shows `up · idle` (or `up · failed: …`, `up ·
  interrupted`) instead of `running · idle`, and `rm` says the run has ended
  instead of guessing that a session may be attached. It still asks.
- **Large tool output no longer lands in your project.** Output too big for the
  context used to be saved in `.tentacle/tool-output/` inside the project (and
  in the mounted folder, for a Docker/Podman run). It now goes to your cache
  folder — `$XDG_CACHE_HOME/tentacle/tool-output/` or
  `~/.cache/tentacle/tool-output/`, or the system temp folder where that is not
  writable (e.g. a container running as a random user id) — readable only by
  you. A session's files are deleted with the session (`session/delete`), and
  files older than `tools.outputRetentionDays` (default 30; `0` or a negative
  number keeps them) are removed silently when the daemon starts; a local
  in-process session has no in-app delete, so only that age sweep cleans its
  files. Reading a removed file says it is no longer available. Files already
  in `.tentacle/tool-output/` are left alone: delete them by hand.
- **Esc / Ctrl+C in the `--resume` session picker now exits silently**, with no
  `[resume] cancelled` line (local and `connect --resume`). The exit code is
  unchanged.
- **Notices are soft blue, their hint grey.** Every notice line in the TUI
  (`Session settings: …`, `Container config: …`, `auto-accept on`, …) now has
  one colour instead of dim grey, and its hint (`(/settings sync to use this terminal's values, or /clear)`,
  `(Shift+Tab to turn it off)`) stays grey beside it. Separator rules are
  unchanged; `relay.log` still prints each notice as one plain line.
- **"Yes, always" now covers the whole session,** the main agent and all its
  sub-agents; before, it held only for the agent that asked. A request it does not
  cover is still asked, one at a time.
- **A sub-agent's rounds now follow `tools.execution` and `tools.maxParallel`,** so its
  reads overlap as the main agent's do.
- **A rate-limited request waits a little longer than `retry-after`,** with some random
  extra, so sub-agents limited together do not all retry on the same tick.

- **Your config now reaches a pod or container.** `run` and `attach` carry your
  `maxIterations`, `tools.*`, `contextAwareness`, `contextReset`, `loadAgentsMd`
  and `loadSkills` (your environment, active profile and global file, resolved on
  your laptop) as the lowest layer. The container's own environment and config
  file still win, and you are shown the values that win. Pods no longer run on
  plain defaults, so a limit such as `maxIterations` now follows you.
- **Sub-agent settings, `model.contextWindow` and `model.autoTitle` are always
  your laptop's** in a pod or container; its own config cannot change them.
- **`attach --profile <name>` now applies to the new sessions it opens.** A
  session already running keeps the settings it was created with, and shows those
  that differ from yours as soon as you attach, as one line:
  `Session settings: { "maxIterations": 3 } (/settings sync to use this terminal's values, or /clear)`. The container's
  winning values read `Container config: { "maxIterations": 7 }`, and only those
  that differ from yours.
- The protocol is now version 16. A daemon left running by an older tentacle is
  refused at connect; attach again to replace it, or `tentacle rm <name>` if a
  detached run still uses it.
- The model name moved from the status bar to the top border of the input
  field, right-aligned (cut on the left with `…` when too long).
- `⏵⏵ auto-accept on` in the status bar is now golden yellow (`#fec20a`)
  instead of cyan; `off` stays grey.
- A line break in the link-status text no longer gives the status bar a second
  row, and a cut no longer shows a doubled `…`.
- A model endpoint answering HTTP 500, 502 or 503 before any output is now
  retried like a rate limit (up to 3 attempts, honouring `retry-after`). A 504
  and other errors still surface at once.

### Removed

- `tentacle serve --context-window` and `--auto-title`: the laptop now sends those
  values per session.

### Fixed

- **Attaching to a session whose background jobs ended while nobody was attached now wakes it.**
  `session/open` reports how many job exits no turn has flushed (`unflushedExits`, an optional
  field, no protocol bump); with `autoWake` on, the attaching TUI starts a continuation turn by
  itself (`autoWake: false`: none). Exits that reach the client before the TUI subscribes are
  no longer dropped. The attach also says `n background job(s) ended while you were away`
  (with `autoWake` on or off); two terminals attaching at once start exactly one wake turn.
- **A permission dialog with a wide label (Chinese/Japanese, emoji) no longer grows a row.**
  The sub-agent, detail and folder rows are now cut by terminal cells, not characters.
- **The "sub-agents capped at N at once" line no longer carries a `[hook]` prefix**
  in the plain / one-shot modes; it is now `[agents]`.
- Two tool calls that share a call id (a server may reuse them, e.g. two `agent_task`
  calls in one message) no longer overwrite each other's saved large output.
- A model HTTP error on a pod run (`run`, `attach`, `run --detach`) now names its
  cause (`the model endpoint answered 401 (unauthorized)`) in the TUI, `relay.log`
  and `tentacle ps`, instead of `internal error`. Only the status reaches the pod,
  never the provider's message; the full error stays in the run's `daemon.log`.
- **A `run --detach` with no terminal attached now reacts when a background job
  ends:** the relay starts the follow-up turn itself, as the TUI does (`autoWake`,
  default on). Attaching mid-way never wakes the agent twice. A failed or
  interrupted run does not wake. There is no limit, as in the TUI: stop a runaway
  with `tentacle stop` or `attach`.
- A `model.apiKeyCommand` in a container's own config no longer runs there, and
  can no longer stop the daemon from starting. The container never uses that key.
- `tentacle attach` no longer reuses an older tentacle binary in a pod or
  container just because it reports the same version: it compares build ids and
  re-copies this laptop's binary on a mismatch (instead of failing with
  `connection closed`). A binary with a live detached run is never replaced:
  attach says `<name> runs an older tentacle build than this one · tentacle rm
  <name>, then run again`.

## [0.2.0] - 2026-10-27

This release adds Docker and Podman as places to run, and moves the protocol
from 10 to 13. **Upgrade the CLI and every daemon or pod together:** a CLI and
an older pod or daemon refuse each other at connect with a version error.
`tentacle update` fetches the matching pod binaries.

### Added

- **Docker and Podman engines.** `tentacle run` and `attach` take
  `--engine kubernetes|docker|podman`; `engine:` in the config sets the
  default (Kubernetes if unset). Podman's socket is found automatically.
- **Remote Docker over `ssh://`.** `DOCKER_HOST=ssh://user@host` works with no
  local `docker` binary.
- **Workspace mount.** With a local Docker or Podman engine, `run` mounts your
  current folder read-write at the same path; `--no-mount` opts out. A remote
  engine never gets the mount.
- **Hidden secrets in the mount.** `~/.ssh`, tentacle's config and common
  credential files are masked inside the container. Add your own paths in
  `.tentacle/hide`, or set `mount.hide` / `mount.hideExtra` in the config.
- **Risky mounts ask first.** Mounting your home folder or a hidden path asks
  for confirmation (`--confirm-mount` without a terminal); `/`, `/usr`,
  `/usr/local`, `~/.ssh` and tentacle's config are refused. On a
  case-insensitive disk (macOS) a hidden *file* inside the mount refuses the
  run: hide its folder instead.
- **`tentacle ps` and `tentacle rm <name>`.** List the pods and containers you
  kept, and remove one. `attach <name>` finds the engine and location itself.
- **`--keep`.** Choose whether `run` keeps its pod or container (`keep:` in the
  config); a kept one prints its re-attach command.
- **Context.** The model sees how full its context is, and can renew it with
  the `context_reset` tool (asks for approval like other tools). A reset
  re-reads `AGENTS.md` and the skills from disk.
- **Skills hot-reload.** A skill you add or edit is picked up without a
  restart.
- **Send now.** `Ctrl+X Ctrl+S` cancels the running turn (or a `/compact`) and
  sends your queued messages at once.
- **Sessions on `connect`.** A `/sessions` panel to list, switch, resume and
  delete a daemon's sessions; `--resume` works on `connect`.
- **Archived sessions.** A session that ends is archived, not lost; reopen it
  explicitly, or delete it for good.
- **Session titles.** Automatic titles (model-written ones are opt-in) and
  `/rename`.
- **Daemon sessions.** `serve --session-ttl never`, and the TTL of a running
  daemon can be changed.
- **Several clients on one session.** Queued messages show on every attached
  client, and each client renders turns started by another.
- **Syntax colours** in file reads, chosen by file extension.
- **Version mismatch notice** says which side is older and what to do.
- **Sub-agents.** Their progress is shown over the wire, and a permission
  prompt says which call it is for.

### Changed

- **`--keep` defaults to true.** `run` keeps its pod or container; use
  `--keep=false` (or `keep: false`) for the old create-and-delete behaviour.
- **Breaking: protocol 13.** Clients and daemons from 0.1.0 (protocol 10) must
  be upgraded together with the CLI.
- **License:** Apache-2.0 (was MIT).
- Sent messages sit on a full-width background; queued ones look sent, in
  grey, above the thinking line.
- A large tool result shows a short note instead of the model's banner.

### Fixed

- **`tentacle ps`:** no footer, a 3-space column gap, and `--keep true|false`
  is accepted with a space.
- A model rate limit (HTTP 429 or 529) is retried, honouring `retry-after`.
- Two edits to one file at the same time no longer lose an update.
- Images on musl, loader-less or unsupported-architecture bases are detected
  before the transfer, with a clear error.
- Tool rows show the real duration, never a fake `0.0s`.
- Ctrl+O expand is instant on long sessions; a tab no longer breaks diff bars;
  the input cursor follows soft-wrapped text.
- A single version marker in the compiled binary.
- A warning when a sub-agent's `model` or `contextWindow` is ignored.

### Security

- The pod stays untrusted: the laptop decides what is mounted, and model keys
  and credentials never enter the container.

## [0.1.0] - 2026-10-22

The first public release, 0.1.0. Everything below is new compared with no
release. Items marked *(since 0.1.0-beta.1)* changed after the beta.

### Added

- **Agent and TUI.** A coding agent for the terminal with a rich TUI: line
  editing (word jumps, selection, prompt history), mouse scroll, queued
  follow-up messages while a turn runs, `/compact`, `/retry`, and
  `--resume` (session picker) / `--continue` (newest session of this folder).
  Built-in tools are shown with CamelCase labels (`Bash`, `Edit`, …)
  *(since 0.1.0-beta.1)*.
- **Models.** Any OpenAI-compatible endpoint, or the native Anthropic Messages
  API. A model connection that drops before any output is retried
  automatically *(since 0.1.0-beta.1)*.
- **Where it runs.** Locally (the agent runs on a worker thread, off the
  render thread), in a Kubernetes pod (`tentacle run` creates and deletes a
  pod; `tentacle attach` uses an existing one), or as a remote daemon
  (`tentacle serve` / `tentacle connect`, with `--ca-cert` and
  `--insecure-skip-tls-verify` for a self-signed daemon). In a pod the model
  is reached through the laptop: API keys never leave your machine.
- **Sessions.** Sessions belong to the daemon: a client can detach and
  re-attach, `connect` / `attach` / `run` reconnect and resume after a dropped
  link, and a `serve` daemon persists sessions and reloads them after a
  restart. A permission prompt is a session event that any attached client
  can answer; a turn waiting on it stays suspended until you answer.
- **Configuration.** Named config profiles (`--profile <name>`), per-project
  sessions, and the repository's `AGENTS.md` loaded into the system prompt.
- **Agent Skills.** `SKILL.md` discovery, a `skill` tool the model can call,
  `/skill-name` to activate one yourself, active skills kept across
  `/compact`, and a `/skills` panel *(since 0.1.0-beta.1)*.
- **MCP.** stdio and Streamable HTTP servers, a client that speaks both the
  2026-07-28 and the earlier MCP protocol versions, and an `/mcp` panel with
  each server's reachability and tools *(since 0.1.0-beta.1)*.
- **Hooks** *(since 0.1.0-beta.1)*. Out-of-process commands on `tool_call`
  (allow, deny, ask, or rewrite the input), `tool_result`, `turn_start`
  (add context or stop the turn), `turn_end` (continue the turn, at most 3
  times) and `model_request` (a notification). Project hooks in
  `.agents/hooks.json` run only after you trust them, and are asked again
  when they change; `tentacle hooks trust --list | --revoke <folder>`.
  Hooks get `TENTACLE_PROJECT_DIR`, and package hooks also get
  `TENTACLE_PACKAGE_DIR`.
- **Packages** *(since 0.1.0-beta.1)*. Bundles of skills, agent types, MCP
  servers and hooks: `tentacle package install <path | git-url>[#ref]` (or
  `tentacle install …`), `list`, `update`, `remove`. Install and update print
  every hook and MCP command they will run.
- **One-line install:** `curl -fsSL tentacle.so/install | sh` (`scripts/install.sh`):
  verified download, no sudo, then `tentacle update` for the pod binaries.
- **Developer guide** for hooks and packages: `docs/extensions.md`
  *(since 0.1.0-beta.1)*.

### Changed

- **Protocol 10** *(since 0.1.0-beta.1)*. The wire between client and daemon
  is now forward-compatible: unknown fields are ignored, an update kind a
  client does not know is shown once as "update tentacle" instead of breaking
  the session, and a permission request is never sent to a client that
  cannot answer it. Clients and daemons from 0.1.0-beta.1 (protocol 7) are
  refused at connect with a clear version error: update both sides.
- The launch folder is the working folder; `TENTACLE_CWD` and the config
  `cwd` key were removed (a config that still has `cwd` is an error).

### Security

- Writes are confined to the workspace; shell commands go through a
  permission prompt.
- Secret-looking environment variables are removed from the environment of
  shell commands, hooks and MCP servers.
- Optional secret redaction of tool output (keys, tokens, private keys, URL
  credentials) before it reaches the model or disk: `"tools": { "redactSecrets": true }`.
  Off by default.
- Every background process runs in its own process group and is killed when
  tentacle exits.
- A package symlink that points outside the package is refused at install and
  at load *(since 0.1.0-beta.1)*.

## [0.1.0-beta.1] - 2026-10-21

The first pre-release, for testing.
