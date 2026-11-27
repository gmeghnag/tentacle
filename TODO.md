# TODO

Running backlog of planned work. The near-term roadmap is **skills support** next;
the rest are "value-add" improvements layered on the harness.

## Owner review queue

- [ ] **fix/config-file-guard** (owner 2026-11-26 ~12:45, after the a2a TUI test where the agent ran `sed -n 1,80p ~/.config/tentacle/config.jsonc` and 7 literal `apiKey`s entered the conversation — `tools.redactSecrets` is OFF by default) — «quando il modello prova ad aprire il suo file di config gli viene detto che non va fatto, e in ogni caso mascherare quel file (solo quello)». (1) A tool call that reads tentacle's OWN config file (the resolved `config.jsonc` in the config dir, incl. TENTACLE_CONFIG_DIR) — fs_read, or a shell command naming it — is answered with a clear message: tentacle's config holds credentials, do not read it; use `tentacle config get <key>` / `tentacle explain` for settings. (2) Regardless (a shell can always reach the file some other way), the SECRET VALUES of that file (apiKey and other credential fields, read from the loaded config) are masked by exact value in every tool output before the model sees it — only that file's secrets, not a generic redactor. Draft first for the owner (plan with owner questions). Type: fix · Size: S–M · Blast: cross-module (tool results path) · Suited: Opus plan.

- [ ] **fix/a2a-shell-bypass** (PARKED by the owner 26/11 ~12:28 «la 2 in todo» — not now) (owner 2026-11-26 ~12:20, same TUI test; SECURITY) — the agent reached the remote agent OUTSIDE the a2a permission gate: it `cat`-ed another agent's bearer token file and called the A2A endpoint with `curl` from the shell, so no «Send a task to bravo» ask was raised (the shell command itself went through the shell permission only). In real configs the token sits behind `harnesses.*.tokenCommand`, still runnable from the shell. Design (AGENTS §7: every effect that leaves the laptop toward a remote agent is gated on the laptop through the single broker; secrets never reach the model): e.g. the agent never sees/runs a harness tokenCommand or its output (masking, deny-list of the configured commands/paths, the secret scanner on tool OUTPUT), a shell command that targets a configured A2A endpoint is flagged/asked as an A2A send, and what remains possible is stated honestly (a determined shell can always curl). Red tests first. Type: fix · Size: M · Blast: load-bearing (broker, secrets) · Suited: Opus plan, Sonnet exec, fresh Opus review.

- [ ] **feat/session-apps** (PROMOTED 26/11 ~10:10; umbrella doc docs/feat/session-apps.md; interim domain *.apps.tentacle.so on the current box) — was eval/session-apps: (owner 2026-11-26 ~08:30) — public static HTML/CSS/JS "apps" published by the agent, up while the session lives: GO-with-conditions — upload + lease to a separate apps host on a SEPARATE registrable domain (PSL, wildcard DNS-01, not `apps.tentacle.so`), host-enforced CSP network-off, every publish asked via the single broker (pods via the laptop), abuse/takedown/kill switch before launch; live container ports (owner bonus) = later phase over the relay after feat/a2a-relay, private phone preview first; 8 owner questions; doc docs/feat/session-apps.md. Type: eval · Size: L if built (6 phases) · Blast: load-bearing · Suited: Opus plans + fresh-context Opus review. **Owner answered Q1–Q8 26/11 ~10:00** (all as recommended except Q4: lifetime tied to the session, no 7-day cap) — next: domain availability → P0.

- [ ] **feat/container-apps-devices** (owner 2026-11-26 ~18:30 «partiamo dalla versione privata sui dispositivi») — session-apps P5, PRIVATE first (docs/feat/session-apps.md §7 option 4): a live container port on the `serve`'s host, viewable ONLY on the owner's paired devices — the phone opens it in an in-app WebView through the EXISTING relay/Noise channel; no public URL, no domain, no apps-host. Binding from §7: any local container, the owner approves EACH exposure through the single broker (never allow_always), the prompt names engine/container/image/port as the ENGINE reports them; refused: host-network, privileged, the engine socket, remote engines; the serve dials the container's published 127.0.0.1 port and re-resolves it on every new connection; HTTP/1.1 + WebSocket only; down when the session, the container or the link ends. Phone: entry via the hub (mobile-hub-vision) + the session. Public secret-link exposure stays a later task (after feat/a2a-relay). Type: feat · Size: L (split if needed) · Blast: load-bearing (trust: what the workload can expose; relay streams) · Suited: Opus plan + fresh Opus security review, Sonnet exec.
- [ ] **feat/image-heic** (owner 2026-11-26 ~23:30 «aggiungi supporto HEIC subito») — HEIC/HEIF pictures (iPhone photos) read like PNG/JPEG: `fs_read` of a `.heic`/`.heif` puts the picture in front of a vision model, an attached HEIC works, and `image_view` (incl. `region`, `low`) works on it. Today `packages/tools/src/image-file.ts` sniffs `heic` and refuses it. Decoder choice is the core question: HEVC is patent-encumbered and libheif/libde265 are LGPL — prefer the OS's own decoder where present (macOS ImageIO, e.g. `sips` → JPEG/PNG in memory or a temp file inside the allowed dirs) and keep the clear refusal where no decoder exists (a Linux pod without one), unless an option with acceptable licence, size and speed is benchmarked. Pods and `serve` on Linux: say exactly what happens. Red tests first; the existing image caps, dedupe and refusal-without-eviction rules apply unchanged. Type: feat · Size: M · Blast: load-bearing (the image path) · Suited: Opus plan, Sonnet exec, fresh Opus review.
- [ ] **feat/relay-status** (owner 2026-11-26 ~22:55 «1 ora, così lo mergiamo stasera») — minimal monitoring, step 1 only: `relay` and `apps-host` each answer `GET /__status` ONLY on the loopback listener (never through Caddy: the public `/healthz` keeps no counters, by design), a JSON of aggregate numbers — no ids, IPs, keys or names. Relay: registered daemons now, attached device legs now, active spliced pairs now, dials per minute, refusals (rate limit, oversize), bytes relayed, pushes sent/failed, uptime, memory. Apps host: live apps, requests per minute, reports, store bytes used, kill-switch state, uptime. Plus a per-minute history of the last 24 h kept in memory (a ring buffer, reset on restart). Counters in pure modules with tests; a test that a non-loopback peer gets 404 for `/__status`. No deploy (27/11 demo freeze) — merge only. Steps 2 (journal summary line) and 3 (`ops:status` over SSH) are later. Type: feat · Size: S–M · Blast: contained (apps/relay, apps/apps-host) · Suited: Sonnet plan/exec/review.
- [ ] **feat/model-switch** (owner 2026-11-27 ~07:40 «implementiamo subito, sia /model che il flag --model, solo per la TUI ora, così lo portiamo in demo» — DEMO TODAY: small, safe, no owner questions) — (1) `/model` with no argument keeps showing the active model AND lists the switchable ones (the main `model` plus every `models.<name>` entry, marking the active one); `/model <name>` switches the live session's main model to that `models` entry (or back to the main one, e.g. `/model default`) from the NEXT model request on, without restarting the session: same history, the reasoning of another provider skipped as today (ReasoningRecord.source), the context window / maxTokens / images of the new entry applied (fill meter, prune/compaction thresholds), the status bar label updated, and a notice row «Model: <old> → <new>». A switch during a running turn applies from the next request (or is refused with a clear message — decide and test). (2) `--model <x>` accepts a `models` entry NAME as well as a raw model id (an entry name wins; say so in `--help`), so `tentacle --model haiku` starts on that entry's connection. TUI first: local worker sessions and `connect` to a serve over the existing RPC (TUI always over RPC — one session path, AGENTS §7); the phone and pods are out of scope (refuse clearly in a pod session: the laptop serves pod model calls only for entries it published). Keys never leave the laptop; persisted session log records the switch as a typed fact if needed for resume (or the resume uses the config's main model — decide and document). Red tests first. Type: feat · Size: M · Blast: load-bearing (agent loop model selection, protocol method) · Suited: Opus plan + fresh Opus review, Sonnet exec.
- [ ] **feat/session-apps-container-ports** (owner 2026-11-26 ~22:45 «partiamo subito con P5») — session-apps P5: a running Docker/Podman container's web port reachable at `<id>.apps.tentacle.so`, the way static session apps are, through a tunnel the `serve` DIALS OUT to the apps host (no open port on the user's side; NOT waiting for feat/a2a-relay: a direct serve→apps-host tunnel). Reuse feat/container-apps-devices S1 (container_preview ask with engine facts, engine safety refusals, port re-resolved per connection, lifetime tied to the session). Owner decisions already taken (docs/feat/session-apps.md §7 answer 7): access by a SECRET capability link by default (secret in the URL checked by the serve, exchanged for an HttpOnly cookie on that app's origin), fully public only as an explicit per-exposure choice in the ask; every exposure asked through the single broker, never «always». HTTP/1.1 + WebSocket (dev servers with hot reload). Apps-host side: per-app bandwidth/connection caps, Report link, kill switch, takedown, as for static apps. Deploy of apps-host/relay changes waits until the owner says the 27/11 demo is over (develop and test locally). Type: feat · Size: L (split into slices) · Blast: load-bearing (trust: what a workload exposes to the internet; apps-host) · Suited: Opus plan + mandatory fresh Opus security review.
- [ ] **feat/builtin-skills** (owner 2026-11-26 ~21:40, promoted from eval) — three Agent Skills shipped inside the binary, OFF by default: `tentacle` (essential commands + how-to recipes + «never read config.jsonc, use tentacle config get / explain»), `a2a` (A2A in tentacle + writing/validating Agent Cards for any agent), `workflows` (writing and running a workflow). Lowest-precedence built-in scope (a project/user skill of the same name shadows it); reference parts generated from the code (CLI usage, key registry, workflow schema) with a drift test; switches like every other skill, plus ONE way to turn a built-in on lastingly (open point: recommended `skills.builtin: [...]`, empty by default — confirm with the owner). Doc: docs/feat/builtin-skills.md. Type: feat · Size: M · Blast: cross-module (skills scan, config, build) · Suited: Opus plan, Sonnet exec, Opus review.
- [ ] **fix/mobile-session-open-empty** (owner 2026-11-26 ~21:10, iPhone, to ship in the next app build) — SOMETIMES opening a session on the iPhone shows it EMPTY (the empty-session Polpetto animation) although it has messages; switching to another session and back shows them. Reproduce FIRST (AGENTS §1) on the simulator against a real `serve` with sessions that have history: open a session from the list repeatedly (cold app, warm app, right after reconnect, after the relay path), record how often the transcript is empty and what the client received (session/open result, the transcript read, updates, order). Likely a race or a lost state in the open path: the open's transcript arriving before/after the screen subscribes, a cached empty projection, a reconnect resetting the store, an open answered while the session is still loading on the daemon. Related earlier work: docs/fix/mobile-open-long-session{,-2,-3}.md, mobile-open-at-end.md, mobile-open-at-bottom.md (read them first: the fix may be a regression of one of them). Fix in the pure controller/client module where possible; a regression test red on the current code; the mobile e2e flow for opening a session green. Type: fix · Size: S–M · Blast: cross-module (mobile + possibly packages/client) · Suited: Opus plan, Sonnet exec (simulator), Opus review.
- [ ] **fix/mobile-workflow-run-jank** (owner 2026-11-26 ~18:30, iPhone screenshots of a running workflow `demo-note`) — on the workflow RUN screen (apps/mobile/src/screens/WorkflowRun.tsx + workflow-run-controller.ts) the elapsed timer does not tick smoothly every second (it sometimes stalls), and tapping a finished/failed step node SOMETIMES does not open it. Owner's hypothesis: reading the run/task state blocks the JS thread. Reproduce FIRST (AGENTS §1) on the simulator: measure timer drift and tap reliability while a workflow runs; then find the cause (e.g. a 1 s tick re-rendering the whole graph, nodes remounted on every status update so a press is lost, heavy parse/JSON of the run state on the JS thread, polling instead of the update stream). Fix in the pure controller where possible; a regression test that is red on the current code. Type: fix · Size: S–M · Blast: contained (mobile run screen) · Suited: Sonnet plan/review, Sonnet exec (simulator).
- [ ] **fix/device-refused-log** (owner 2026-11-26 «sì mettilo in todo», from the connect-via-relay e2e) — when the daemon refuses a paired device's key (revoked, unknown), the serve log shows only a bare `relay-open` and no `device-open`: no explicit line. Add one audit line, e.g. `device-refused <short id> (revoked|unknown)` (no key material), for phone and laptop alike, so a stolen-laptop attempt is visible afterwards. Evidence: the e2e in .tentacle/tmp/connect-relay-e2e/ (client error «this laptop's key was refused (revoked?)», serve log without a refusal line). Test red before green. Type: fix · Size: S · Blast: contained (daemon log line) · Suited: Sonnet plan/review, DeepSeek exec.
- [ ] **feat/a2a-reload** (owner 2026-11-25 ~22:45, «mettiamola dopo sta cosa della Tui, intanto c») — after feat/a2a-client merges: a `/a2a` TUI command to reload the remote agents' cards on demand (a2a-client fetches them ONCE at worker/`serve` start-up and refreshes them in the background after each build — option (c), docs/feat/a2a-client.md «Owner decision — finding 2»; `startA2ACards`, `packages/cli/src/wiring.ts`), so a changed card reaches the model one build late. Needs a client→daemon path to re-run `prefetchA2ACards` on the host and rebuild the type text; check phone parity (a hub entry) in the plan. Type: feat · Size: S–M · Blast: cross-module (TUI + daemon RPC) · Suited: Opus plan → Sonnet exec.
- [ ] **feat/a2a-relay** (owner 2026-11-25 ~12:10, «sì, mettila una voce in todo») — after feat/a2a merges: give every `serve` a public A2A URL through the tentacle relay — the relay accepts HTTPS at e.g. `https://relay.tentacle.so/a2a/<id>/…` (Agent Card + JSON-RPC + streaming) and forwards it over the serve's EXISTING outbound relay link (no open port, NAT or domain). Trade-off to state in the plan: today the relay sees NOTHING (phone↔serve is Noise end-to-end, `apps/relay/src/server.ts:16`); a standard A2A client speaks plain HTTPS, so the relay would see A2A payloads in clear. A2A token still checked on the serve; the relay only forwards (rate limits, size caps). **Design direction (owner 2026-11-25 ~12:45, «abbozziamo in TODO inoltro TLS passante»): TLS PASSTHROUGH so the relay can be a FREE public service that still sees nothing** — each serve gets `<id>.a2a.tentacle.so`; the relay reads only the SNI of the TLS ClientHello and pipes the still-encrypted bytes over the serve's existing outbound link (no termination); TLS ends on the user's serve, which obtains its own certificate for its subdomain (ACME, e.g. DNS-01 through a relay-side challenge endpoint the serve authenticates to). The relay then sees only which `<id>` and how many bytes — the same property as Noise today. Open points for the plan: certificate issuance/renewal flow and rate limits (Let's Encrypt per-domain limits → wildcard/registered-domain strategy), the trust gap (whoever controls `tentacle.so` DNS could mis-issue: `tentacle` watches Certificate Transparency logs for its subdomain and warns), HTTP/2 + streaming through the pipe, abuse limits by bytes/connections without reading content. A plaintext relay (TLS terminated on the relay, like ngrok/Cloudflare Tunnel) is acceptable only for the owner's own use and opt-in, stated in clear. Later, optional: an opt-in directory of Agent Cards on the relay («registrazione»; A2A has no standard registry beyond the well-known Agent Card URL). Type: feat · Size: M · Blast: cross-module (relay + daemon relay link) · Suited: Opus plan → Sonnet exec.
- [ ] **feat/builtin-skills** (owner 2026-11-25 ~10:30, TODO only — «metti solo in todo la voce») — today tentacle does not know how its own features work (e.g. it cannot write a workflow: no idea of the YAML format). Ship Agent Skills INSIDE the binary, through the existing `skill` seam (`packages/tools/src/skill.ts`, docs/feat/skills-core.md: catalog = one description line in the prompt, body on demand → tokens paid only on use); today only project/user skill dirs are discovered. First skill `tentacle-workflows` (YAML format, step kinds, retry/goto, prompt files, `.tentacle/workflows/`, validate/run, approvals); the reference part GENERATED from the same schema the code uses, with a test that fails on drift. Later: schedule, artifacts, chart/diagram, sessions/sub-agents. A project/user skill of the same name overrides the bundled one. Type: feat · Size: M · Blast: cross-module (config skill discovery + tools) · Suited: Opus plan → DS exec.
- [ ] **feat/browser-inspect** (PROMOTED by the owner 2026-11-25 ~11:45 «partiamo»: doc moved to docs/feat/browser-inspect.md; spike B0 by Sonnet, B2 by Sonnet — owner: «ottimizziamo con sonnet quando possiamo»; was eval, owner 2026-11-24 «ok solo voce todo») — tentacle opens a browser and can SEE the page and TRACE its fetch/XHR/WebSocket traffic. Phone: an in-app WKWebView (`react-native-webview`), screenshot via `takeSnapshot` → `image_view`, DOM as text; traffic via a document-start `WKUserScript` that wraps `fetch`/`XMLHttpRequest`/`WebSocket` and posts each request/response/frame to the app → daemon → a model tool (limits: no native subresource loads, little service-worker visibility, cross-origin iframes need per-frame injection). Mac: drive Chrome via the DevTools Protocol / Playwright — full Network domain incl. WebSockets. One device-agnostic `browser_*` tool group for both. Design points: logged-in sessions → redact tokens/cookies before the model and never persist them raw; prompt injection from page text → consequential actions (submit, pay, delete) through the single broker. Type: eval · Size: L (umbrella) · Blast: load-bearing (new capability surface, credentials) · Suited: Opus eval.
  - **Owner direction (2026-11-24):** a **Chrome extension in the user's REAL profile** (logins/cookies), linked to the Mac daemon via **native messaging** (not a localhost WebSocket); `browser_*` tool group off by default (`browser_open` in a «tentacle» tab group, `browser_read`, `browser_shot` → `image_view`, `browser_click`/`browser_type`, `browser_net` via `chrome.debugger` incl. WebSockets). Decisions: (1) the model sees ONLY its own tab group + tabs the user hands over via the extension icon; (2) secrets (Authorization, cookies, tokens) masked before the model and in the saved log by default, with an **option to show them in clear**; (3) consequential actions (form submit, pay, delete, cross-domain navigation) ask through the single broker by default, with an **auto mode** option; (4) **Chrome only** in v1 (no Safari: no `chrome.debugger` equivalent); (5) the Mac's Chrome is reachable from every session of that computer (incl. phone sessions on its `serve`). DevTools-Protocol attach to the default profile is blocked since Chrome 136; persistent dedicated profile / AppleScript kept as fallbacks. Next: Opus eval (native messaging, `chrome.debugger` limits).
  - **B1–B4 MERGED 2026-11-25 14:29 (87e1a988).** **Bug for B5 (owner's first install, 25/11 15:05):** `tentacle browser install` from the COMPILED binary prints «extension: sources not found next to this build» — `packages/cli/src/browser-install.ts:54` resolves `apps/browser-extension` from `import.meta.url`, which is inside the bun bundle, not the repo. The host side installs fine; the extension was copied by hand to `~/.config/tentacle/browser/extension`. Fix: embed the extension files in the binary (e.g. `import … with { type: "file" }` / a generated asset table) so install works from `~/bin/tentacle`, + a test that runs install against the compiled output. **Owner's first live test (25/11 15:20, real Chrome, phone-capable serve): WORKS** — open/read/shot/search-by-URL on a news site, a 404 self-corrected. Gaps the agent itself reported: no click/type/scroll (= B5, expected) and **no way to close its own tabs** (no `browser_close`; the tab stays open for the user) → add `browser_close` (own tabs only, no ask) to B5. **Owner 25/11 15:25: a tab found closed (e.g. by the user) must NOT be an error — reopen it («credo scelta migliore»).** Today the hub drops the tab on `tab_closed` (`packages/cli/src/browser-host.ts:181`) and the next op on it fails. B5: the tool layer remembers each own tab's last URL; an op on a closed own tab reopens that URL in the session's group (no new ask: same URL already approved) and tells the model «tab N was closed; reopened <url> as tab M — scroll/form state and its traffic log are lost». Proposed limits (confirm at B5 plan): only tabs the agent opened itself (a tab the user HANDED over and then closed stays closed: reopening it would undo the user's choice); a tab closed by `browser_close` is not reopened.
- [ ] **eval/prune-real-usage** (owner 2026-11-23 ~15:25) — the 8-run live A/B of smart-compaction (S4) was STOPPED after run 1 (8–10 h of DeepSeek; 2 runs per arm cannot detect a 25 % difference; pruning may not even trigger below 60 % of the window). Instead: (1) one SAFETY run with pruning forced early (profile `deepseek-ab-prune20`, `run-ab-stop-and-safety.sh`): task success + no sentinel in written files + batches happened; (2) in a few days, measure SAVINGS from the owner's REAL sessions (contextPrune ON since 22/11 night, incl. `~/assistant`): batches, tokens pruned, re-reads of pruned paths, sentinel refusals, from the usage logs. Then decide the default. SAFETY RUN RESULT (23/11 17:01, profile prune20, 1 DeepSeek run): pruning fired; DeepSeek tried TWICE to write a `⟪pruned by tentacle…⟫` placeholder into `fs_multi_edit` (R2 stubs of its own earlier writes) — the guard refused both, no file contaminated; the task ended with 3 red tests (n=1, not attributable). ALSO EVALUATE (owner 23/11 ~17:20): for weaker models (DeepSeek, local Qwen) do NOT prune recent WRITE/EDIT payloads (R2), or make the R2 stub less copyable — measure how often the guard fires in real sessions first. Note: one-shot `--` runs save no session, so their token usage is not logged. Type: eval · Suited: Opus.
- [ ] **eval/endpoint-concurrency** (owner 2026-11-23 ~15:15, NOTE only — «per ora va bene così») — a local single-GPU model server (llama.cpp `--parallel 2 -kvu`, 2 slots sharing one 120k cache) overflows when the main turn + a background sub-agent + a new turn run at once (seen 23/11: «Context size has been exceeded»). Idea: `model.maxConcurrent: N` per endpoint, tentacle queues its own requests instead of overflowing the server (paid APIs unlimited). Verified 23/11: «send now» already aborts the old request (`openai-provider.ts:161-162,223-224,270`) and starts the successor only after the old turn unwinds (`hosted-session.ts:365-375`) — the overlap came from the sub-agent. Type: eval · Suited: Opus.
- [ ] **feat/truncated-tool-call-recovery** (owner 2026-11-23 ~13:35) — on the owner's `~/assistant` serve, Qwen wrote a whole `screen.py` in ONE `fs_write` (21 803 bytes of arguments) and hit the output limit mid-call: tentacle (correctly) did not run the partial call, but the turn just ended «incomplete» and the work stopped. Owner wants AUTOMATIC recovery: when a tool call is cut by the output limit, tentacle continues the turn with an explicit instruction to the model (e.g. «your call was cut at the output limit — write the file in smaller parts: fs_write then fs_edit/append»), bounded (no loop: one or two retries, then stop and say so). First verify what the model receives today after a cut (agent loop), whether the reasoning budget counts against `maxTokens` (32768 in the owner's config; 21.8 KB ≈ 6–7k tokens alone would fit), and llama.cpp's own limit. Related cosmetic bug (not chosen now): `packages/tui/src/model-error.ts:25` appends the remote «check its config and key» hint to ANY error containing «model», including this output-limit cut. Type: feat · Size: S–M · Blast: load-bearing (agent loop) · Suited: Opus plan.
- [ ] **eval/lock-own-window** (owner 2026-11-23 ~12:55, parked) — alternative B for the native-sheets lock problem (spike F5a: an RN-Modal lock cannot present while a native formSheet is up, so Face ID showed over live content): present the app lock from the top-most VC or its own `UIWindow` (native), so it wins over ANY presentation. Not taken now (A = drain the sheet stack on lock/inactive). Type: eval · Blast: load-bearing (privacy) · Suited: Opus.
- [ ] **feat/mobile-composer-compact** (QUEUED — owner 24/11 «aspettiamo che scodano»; workflows-ui merged; owner 2026-11-23 ~11:15) — empty composer at rest = ONE row (placeholder «Message tentacle» on the buttons' row); expands to today's two rows only when the text field is tapped. Mockup https://claude.ai/artifact/LMeMREwnkcGAtxYXKTixnv (v2). Owner chose (23/11 ~11:55): **1a B** (no ↑ at rest; the slot returns when it is an action: ■ Stop, ↑ with a draft) · **1b A** (stays open while it holds something: text, attachment, dictation). Type: feat · Size: M · Blast: contained · Suited: Opus mockups → plan → DS exec.
- [ ] **feat/mobile-hub-center** (QUEUED — owner 24/11 «aspettiamo che scodano»; workflows-ui merged; owner 2026-11-23 ~11:15) — the floating hub (⁘) can also rest at the CENTRE, not only left/right (`floating-button.ts` `Edge`). Mockup https://claude.ai/artifact/LMeMREwnkcGAtxYXKTixnv (v2). Owner rules: the hub FLOATS — nothing behind it moves or reserves space in any position; dragging looks EXACTLY like today (no snap-column guides — the mockup v2 draws dashed columns + a highlighted one while dragging: NOT wanted); the centre is just a third resting place. Owner chose **2 B**: while the transcript scrolls the hub fades to 20 % and ignores taps, back 600 ms after scrolling stops (150 ms fade). Owner (23/11 ~12:05): **remove `footClearance`** (`floating-button.ts:158`: pending bubbles no longer keep `HUB_COLUMN` clear at both edges) and make **`listEndPadding` optional** (`floating-button.ts:172`: a setting — on = today's «list end above a lower-half hub», off = plain 16 pt; default ON, as today, unless the owner says otherwise). Type: feat · Size: S–M · Blast: contained · Suited: Opus mockups → DS exec.
- [ ] **eval/workflow-script-hash** (owner 2026-11-23 ~10:15) — a workflow's approval hash covers the YAML + its prompt files only (agent-workflows D1 `workflowHash`), so a `run: ./scripts/deploy.sh` step can have its SCRIPT edited after approval and still run unapproved. Options: hash the files a `run` names (which? only repo-relative paths in the command?), refuse `run` of repo scripts unless listed in the YAML (`files:`), or show it in the ask. Type: eval · Size: — · Blast: load-bearing (§7 approval) · Suited: Opus.
- [ ] **fix/e2e-26-drawer-pro** (found 23/11 02:20 by the e2e-parallel-gate validation) — flow `26-drawer` ALWAYS fails on the iPhone 17 Pro simulator (`session-rename-save` not found), passes on the 17 Pro Max with the same app (where the single-sim baseline runs). Until fixed, the two-sim gate is red whenever that flow lands on the Pro → build launchers stay on the single-sim (Pro Max) form for now; switch them to `scripts/e2e-gate.sh <pro>,<promax>` after this fix. Repro: `scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 26-drawer`. Type: fix · Size: S · Blast: contained (e2e flow) · Suited: Opus (needs the simulator).
- [ ] **eval/e2e-affected-flows** (owner 2026-11-22 ~23:30, idea only) — each e2e flow declares which screens/files it covers; a merge runs only the affected flows, the full suite stays before publish (or nightly). Needs the flow → code map first. Type: eval · Size: — · Blast: cross-module · Suited: Opus.

- [ ] **feat/mobile-artifact-session-trust** (owner 2026-11-22; QUEUED — starts after `feat/agent-workflows`) — part 2 of `feat/mobile-file-view`, split out by the owner: the HTML-artifact scripts confirm gains «Esegui sempre in questa sessione» (trust per session, revocable from the session info sheet; network stays off and per-open; NEVER offered for a pod/container-backed session — if the app cannot tell reliably, it does not offer it, signal proved `file:line`; viewer bar «script attivi · sessione fidata»; dated owner amendment to the Q5 notes of `docs/feat/model-artifacts.md`). Spec: `docs/feat/mobile-file-view.md` §Context "Part 2" (owner decisions 1–6). Type: feat · Size: S–M · Blast: load-bearing (artifact sandbox + pod trust, AGENTS §7) · Suited: plan + exec, fresh-context Opus review red-teaming the pod exclusion.

- [ ] **feat/tool-run-grouping** (owner 2026-11-21, TUI screenshot of a 6-tool run filling the screen) — consecutive tool calls between two model texts collapse into ONE live row: the blinking dot + the action in progress (shell-intent sentence / `Read <file>`), then a summary at the end (`2 comandi · 1 lettura · 2 modifiche note/x.md (+6 −5) · 0.4s`, detail on ctrl+o / click). Agreed guards: edits/writes stay visible as one line each (file + `+N −M`, diff on expand) — a safety check; a failed call (`✗ exit N`) leaves the group and stays fully visible; permission asks unchanged; a model text closes the group. Beta first (like `compactShell`); same grouping on the phone step rail (phone/Mac parity). **Next: animated mockups (≥ 2 variants) built WITH the mockup kit once `feat/mobile-mockup-kit` is ready** (owner: "fai i mockup col kit quando è pronto"). Type: feat · Size: — · Blast: cross-module · Suited: Opus mockups + plan.

- [ ] **feat/live-camera-look** (owner 2026-11-21: "tentacle con accesso alla fotocamera, che può vedere in diretta da una ripresa video realtime del cellulare (e non solo)"; parked in TODO by the owner, "lasciamo solo in todo") — design already in `docs/eval/realtime-media.md` §7.4 "live vision: pull by default". Proposed phases: (A) a `look` tool takes the newest frame from the phone camera on demand (camera on only by hand, always-visible indicator, first `look` of a session through the permission broker, frames not stored by default; reuses BF2 binary frames + pdf-images S1 tool-result images + the phone's attachment upload); (B) "keep an eye" mode — the phone refreshes one frame every N s, the model sees the latest per turn; (C) continuous realtime video + voice to a realtime front (Gemini Live / OpenAI Realtime, ~1 fps), with the voice roadmap V3/V4. Other sources later: Mac screen/webcam, phone screen, IP cams. Open owner question: main use — show-and-ask (A+B) or continuous conversation while it watches (C)? Type: feat · Size: — · Blast: load-bearing · Suited: Opus plan after pdf-images S1.

- [ ] **eval/anthropic-untested** — inventory of what has never been tested
  against an Anthropic model (owner 2026-11-21: "sarebbe bene segnare tutto ciò
  che non è mai stato testato con Anthropic"). No Anthropic API-key profile is
  configured in the owner's tentacle config today, so model-facing measurements
  ran only on DeepSeek + local Qwen. Known item: `feat/shell-intent-line`
  fill-rate (DeepSeek 100 %, Qwen 100 %, Anthropic NOT measured).

- [ ] **review/mobile-decisions** — the owner wants to re-read every mobile
  decision taken on 13–14/11 (owner 2026-11-14). Each doc has the questions with
  the recommendation and the chosen answer:
  - **Decided by the orchestrator** (night delegation, `#### Orchestrator
    decisions (owner night delegation 2026-11-14)`): `docs/feat/mobile-compose.md`
    (13), `docs/feat/mobile-lock.md` (14), `docs/feat/mobile-pairing-screen.md`
    (11b) — plus `docs/feat/session-hop.md` (not mobile, same night).
  - **Approved by the owner "all as recommended"** (`#### Owner decisions`):
    `docs/feat/mobile-relay.md` (15), `docs/feat/mobile-push.md` (16),
    `docs/feat/mobile-notifications.md` (17), `docs/feat/mobile-live-activity.md` (18).
  - Earlier owner answers: `docs/feat/mobile-session-view.md` (12, "all +
    images"), `docs/feat/sibling-discovery.md` (10, "all").

- [ ] **feat/voice-conversation** (owner 2026-11-15, plan APPROVED) — hands-free voice conversation on the Mac and the iPhone (realtime-voice V2 + phone edge, background/locked screen in v1). Doc: `docs/feat/voice-conversation.md`. `Type: feat · Size: L (10 S/M slices) · Blast: load-bearing (C3 voice-turn profile) · Suited: Opus plan, DeepSeek slices, mandatory fresh review`. Code after `feat/voice-dictation` + `feat/mobile-voice` merge; spikes C1 (Mac) and P1 (iPhone, owner-assisted) can run now.

- [ ] **eval/wake-word** (owner 2026-11-20, after feat/voice-conversation): hands-free voice with tentacle always listening — window in the background, or even terminal CLOSED — woken by "Hey <name>" like Siri/Alexa. Mac: a launchd agent (voice-only client of `serve`, like `connect`; reuse `tentacle-voice`) with an on-device wake-word engine (openWakeWord / Porcupine / Apple on-device speech — compare CPU, accuracy, licence, custom word); nothing leaves the Mac before the wake word; mic indicator always on. iPhone: no always-listening with the app closed (iOS) — use App Intents ("Ehi Siri, chiedi a tentacle…"), the Action button, AirPods; background listening only inside an active audio session (battery, App Review). Check docs/eval/local-relay.md (always-on local process: NO-GO then — say what differs). Type: eval · Size: M · Blast: load-bearing (always-on mic, new client) · Suited: Opus eval.
- [ ] **eval/deepseek-efficiency** (owner 2026-11-17: "deepseek vaneggia e probabilmente va in loop … voglio poterlo usare ma dopo averne efficientato l'utilizzo"; DeepSeek runs ONE task at a time until settled) — [doc](docs/eval/deepseek-efficiency.md): 228 DS logs mined. Causes: model-run verification (20% of calls, 612 full suites where 228 is the floor, suite 487 s > 120 s shell timeout), sleep-polling (30.7 h asleep, 221 timeout kills), read sprawl (50% of calls). Fixes: brief + gate-by-script + watchdog caps (orchestration), `shell_output` wait / sleep guard / usage summary / loop detector (product). 6 owner questions. Type: eval · Size: M · Blast: none (eval) · Suited: Opus.

- [ ] **eval/windows-support** (owner 2026-11-16: "il momento che tutti aspettavamo con paura"; START RIGHT AFTER the mobile work closes, to keep the 5h budget on mobile now) — native Windows (PowerShell / Windows Terminal, no WSL). Step 1 (cheap): make **WSL2 officially supported** (docs + a real run + small fixes; it already ran on a friend's Ubuntu-in-WSL). Step 2 (this eval, docs only, Opus): inventory every POSIX assumption with `rg` counts — shell tool (`bash -c` → PowerShell/cmd), daemon IPC (unix socket → named pipe / localhost TCP), signals (SIGINT/SIGHUP, the detached delete-on-exit child), paths/separators/case-insensitive FS, `chmod 600` secrets → ACLs, lock files, `open` → `start`, Docker/Podman named pipes, the installer (`irm | iex` / winget), Ink keys + glyphs on Windows Terminal, Bun windows-x64 compiled binary — and propose a platform layer + slices; pods/k8s stay Linux. Step 3: native slices + a Windows CI runner (without CI it re-breaks at every merge). Type: eval · Size: L overall (split) · Blast: load-bearing where marked · Suited: Opus.

- [ ] **feat/mobile-visual-baseline** (owner 2026-11-21, after BF2): DETERMINISTIC visual regression for the iPhone app — Maestro flows save screenshots (light+dark, fixed mock-model data, fixed clock/status bar), a script compares them pixel-wise (tolerance) with owner-approved baselines committed under `apps/mobile/e2e/baselines/`; only the CHANGED shots go to a model for review. Why: an Opus QA sweep that looks at every screenshot cost ~7.7 $ (176 turns, 104 shots, 23.5M cache-read tokens, 19/11). The full SMOKE PASS moves to the owner's LOCAL Qwen (vision on, free) via `~/bin/tentacle`; Opus only judges the new features. Gate: `scripts/e2e-gate.sh` reds that are not known reds block the build regardless of any model verdict. Type: feat · Size: M · Blast: contained · Suited: Opus plan, DeepSeek exec.
- [ ] **eval/mobile-file-attachments** (owner 2026-11-20): send PDFs/documents (not only photos) from the phone — today `attachment.ts` accepts `image/*` only. Decide: which providers accept which types (Anthropic PDF yes; qwen local no → text extraction?), size caps, store, pods, the same preview card for sent files. After feat/mobile-file-preview-cards. Type: eval · Size: M · Blast: load-bearing (protocol + provider) · Suited: Opus eval.
- [ ] **feat/mobile-pdf-ocr** (owner 2026-11-20): attaching a SCANNED PDF from the phone fails — repro (`.tentacle/tmp/pdf-attach-repro/`): 2 pages, 0 chars per page → daemon refuses "no extractable text — it looks scanned; OCR is not supported" (`core/src/pdf-text.ts` `attachedPdfText`, `daemon/src/prompt-documents.ts:143`). Proposal: OCR ON THE PHONE before upload (iOS Vision `VNRecognizeTextRequest` on pages rendered with PDFKit; offline, private — the image never leaves the phone), sent as text with a "testo da scansione" note; honest error when OCR finds nothing too. Check Mac TUI parity (macOS Vision on the laptop for `/attach`). Type: feat · Size: M · Blast: cross-module · Suited: Opus plan.
- [ ] **feat/mobile-tool-toggles** (owner 2026-11-20, Q8 of [feat/tool-toggles](docs/feat/tool-toggles.md)) — the phone's half of `/tools`: a "Tools" section in Session info (P1 pattern: an iOS switch per group, `~tokens` per row, `skill` locked), reading `session/tools` and switching with `session/set_capability{kind:"tool"}` — the wire is already built by feat/tool-toggles, so this is UI ONLY. **Mockups first**, in the approved mobile-chrome look (as session-capabilities S5); a daemon without `disabledTools` in its snapshot shows no switch (F8). Type: feat · Size: S–M · Blast: contained (apps/mobile) · Suited: Opus mockups, DeepSeek exec + simulator check.
- [ ] **eval/container-sessions-mobile** (owner 2026-11-18: "mi piacerebbe poter da mobile controllare una sessione eseguita in un container") — today NO: the phone sees only `serve` sessions; `run --image`/`attach` and session-hop (`/move` into podman/docker) are TUI-only, `serve` has no `--image`. Options to weigh: (A) `serve` runs chosen sessions' WORKSPACE in a container/pod (daemon + model key stay on the Mac via the existing reverse model tunnel, §7 "compute next to the code, identity with the user"), exposed to the phone like any serve session; (B) a phone "Move to container" (session-hop from the phone); (C) detached `run` sessions listed and attachable from the phone through the laptop. Security: pod not trusted, single broker, persistence. Type: eval · Size: — · Blast: load-bearing if built · Suited: Opus eval.
- [ ] **feat/shell-wait-and-usage** (owner 2026-11-18, docs/eval/deepseek-efficiency.md B1+B2+B5, all approved) — tentacle product guardrails for every user: (B1) `shell_output` gets a blocking `wait_s` so an agent waits on a background job instead of sleep-polling; (B2) the shell tool refuses/caps `sleep` ≥ 30 s with a message pointing at wait_s; (B5) a usage summary at the end of a one-shot run (rounds, prompt/completion/cached tokens, wall time) on stderr — the prerequisite for measuring. Then Q6: re-run 2 small past tasks twice each, target ≤ 60 % of the old tool calls and 0 sleeps, before re-opening parallel DeepSeek. Type: feat · Size: M · Blast: cross-module (tools + agent loop output) · Suited: Opus plan + Opus exec.
- [ ] **feat/mobile-masked-view-shimmer** (owner 2026-11-18) — ONLY if the svg-native glyph-clipped Thinking shimmer of feat/mobile-thinking-images (S0-a) does not hold on device: add `@react-native-masked-view/masked-view` (native-driven, glyph-clipped) — a new native dependency, needs a full iOS build. Until then the fallback is a static "Thinking" + seconds. Type: feat · Size: S · Blast: contained · Suited: Opus.
- [ ] **feat/attachment-get** (owner 2026-11-18, from mobile-thinking-images Q2) — a protocol method + daemon handler to fetch a message's image bytes by attachment id, so photos show after reload and on other devices (today only the sending phone's own copies, newest 60 / one week). Type: feat · Size: M · Blast: load-bearing (protocol + daemon) · Suited: Opus plan + exec.

- [ ] **feat/relay-push-split** (owner 2026-11-15; plan done) — public always-on push service decoupled from the closable data relay. Remaining owner questions open. Type: feat · Size: L · Blast: load-bearing.

- [ ] **fix/mobile-dictation-quality** (owner 2026-11-16, iPhone build) — (1) no visible feedback while holding the mic; (2) transcripts of 1–2 nonsense words. First hypothesis: the `auto` locale follows the iPhone language (en-US vs Italian speech). Voice is behind Settings → Beta (off) until this passes. Needs a dev build on the owner's phone. Type: fix · Size: M · Blast: contained.

- [ ] **fix/confinement-emfile** (reviewer of `fix/main-gate-flakes`, 2026-11-17; split out, NOT fixed there) — `packages/exec/src/host-execution.ts` `safeRealpath`/`entryExists` swallow every errno and fall back to the lexical path; under fd pressure `realpathSync` throws `EMFILE`, so a lexical `/var/…` target is compared with a realpath'd `/private/var/…` root and a write INSIDE the project is refused (fails closed, no escape). Evidence: gate log `.tentacle/tmp/main-gate-flakes/mobile-session-actions-gate-main-1.log:17` (confinement F2), probes `probe-realpath-emfile.ts` / `repro-confine-emfile.ts` there. A first attempt (WIP `6b51238a`: errno whitelist + retry + `pathCall` seam) broke `cli/test/wiring.test.ts` "buildAgent always hands the runner config.projectDir" and `model-proxy.test.ts` "hostile pod…" (`ENOENT lstat '/repo/sub'`; exact mechanism not diagnosed) — the redesign must keep non-existent roots working and be red-tested against both. Type: fix · Size: S · Blast: cross-module · Suited: Opus.

- [ ] **fix/serve-log-store-s11-env-leak** (reviewer of `fix/main-gate-flakes`, 2026-11-17) — S11 (`packages/daemon/test/serve-log-store.test.ts`, 200 SIGKILLs) intermittently scores `loads 0/200` ONLY inside the full `bun test` (seen in 15.8 s: the children exited on their own almost at once, since a child that never printed `ready` costs 20 s). It passes alone (3/3) and with all of `packages/daemon` (1383 pass); a later full run (171f42fc) was green. Hypothesis: a test in another package leaks process state (likely `process.env`) that `Bun.spawn` passes to `fixtures/serve-crash-child.ts`. Diagnostic already in place: on failure the message is `loads N; exit X: <stderr>` of the first child that died by itself. Next: capture that message from a red full run, find the leaking test, isolate the child's env (an explicit `env:`) or fix the leak. Pre-existing (main's blind-kill version fails the same way). Type: fix · Size: S · Blast: contained · Suited: Opus.

- [ ] **eval/apple-watch** (owner 2026-11-15, later) — tentacle on the Apple Watch. Free already: push notifications and the Live Activity (watchOS 11 Smart Stack) mirror to the watch. Small next step (S–M): actionable notification buttons (e.g. Deny free, Allow requiring the phone unlocked — keep the "answered only by a tap bound to that ask" rule). Large (L): a native SwiftUI watch app embedded in the iOS app (React Native does not run on watchOS), talking through the phone (the E2E channel and keys live there): sessions, state, last reply, dictated message; hands-free voice later. Recommendation: start with the notification actions.

- [ ] **feat/per-session-model** (owner 2026-11-15: later — "per ora lasciamo fuori") — `serve` is bound to ONE model (its `--profile` at start); no `session/set_model`; the TUI `/model` only SHOWS the model. Idea: `serve` exposes its config profile NAMES and a session picks one at creation or with a real `/model <profile>` (TUI + app), as a phone/Mac parity step. Origin: docs/feat/serve-mcp.md Owner Q3.

- [ ] **eval/mobile-polar** (owner 2026-11-20: "facciamo direttamente le cose fatte bene" — NATIVE Polar support in the mobile app as a deliberate exception, Apple Watch later; ~~blocked until voice-conversation closes~~ — owner 20/11 ~10:30: write the eval/plan NOW (Opus, personal); build order decided after it; **design for future devices from day one** (owner 20/11): a device-agnostic BLE/sensor layer — device registry + pairing/connection lifecycle, a common timestamped sample model (`hr`, `rr`, `ecg`, `acc`, …), store-and-forward, the `sensor/*` protocol and the daemon tools all speak "sensor + channel", never "Polar"; the Polar SDK is ONE driver behind that interface, the standard BLE Heart Rate Service (0x180D) a second driver for any HR strap, so a new device = a new driver, not a redesign) — live data from the owner's Polar H10 while RUNNING OUTDOORS with only the phone (or the Watch, later) reaches a tentacle; first use: a hands-free voice coach with feat/voice-conversation.
  - **Phone (native, in the build):** official Polar BLE SDK — HR, RR (→ HRV), ECG 130 Hz, accelerometer 25–200 Hz, skin contact, battery; pairing UX in Settings; BLE-central (+ location for pace/route?) background modes, screen locked; on-phone live view (HR, zone written not only coloured — owner-colorblind, sparkline) that works OFFLINE; store-and-forward while the network drops, dedup on the daemon; phone-side reduction (e.g. ECG only on request) to save battery/cellular.
  - **To `serve`:** new `sensor/*`-style protocol surface (E2E relay); the daemon keeps a bounded recent window.
  - **Model side:** daemon tools (heart rate / HRV / zones over a window, ECG snapshot, derived respiration, cadence, movement — ectopic beats indicative, never diagnostic) as a `tool-toggles` group (e.g. `sensors`), off when no strap is paired; optional threshold wake-up of a turn (like a background-job end). Data reaches the model only through these tools, never auto-injected.
  - **Privacy:** health data → warning when the model is not local.
  - Parked, not dropped: a GENERIC package-declared phone-capabilities layer (`ble`/`location`/`motion`/`health` catalogue + per-package consent + declarative UI) — reconsider if a second sensor appears. Rejected for live use: HealthKit via Polar Flow, Polar AccessLink (post-session only).
  Open for the eval: Mac parity (no strap on the Mac), pods (sensor data stays on `serve`), battery budget, location in v1 or later, Watch path (the H10 accepts 2 BLE connections). Type: eval · Size: L (umbrella → S/M slices) · Blast: load-bearing (new protocol surface, background modes, health data) · Suited: Opus eval on main, fresh-context review.
- [ ] **eval/mobile-native-swiftui** (owner 2026-11-15, low priority) — could the iOS app be even smoother/more beautiful with native Swift? Stance: stay on React Native/Expo (native UIKit components already) and adopt SwiftUI only where it pays: (1) MEASURE first — the conversation with thousands of streamed rows on the owner's iPhone 12 Pro (frame drops, scroll, memory); (2) candidates: a high-performance virtualized (or native) transcript list, real system sheets/menus, iOS 26 materials (Liquid Glass) via Expo UI / a local Swift module, interactive sheet gestures; widgets/Live Activity are Swift anyway (task 18). A full Swift rewrite is out (Android lost, two codebases) unless the measurements say otherwise.

- [ ] **eval/repo-schedules** (owner 2026-11-22 ~22:20, idea only — «per ora lasciamo stare, solo una voce in todo») — schedules/cron versioned IN the repo, loaded by a tentacle at start (t0), later extended to workflows. Notes from the chat: a schedule = a workflow trigger (`on: cron …` in `workflows/`, one format/approval/run view; a plain prompt = 1-step workflow); runs only after the owner approves the file's content hash on the laptop (a repo file is untrusted input — never approvable from a pod; an edit/pull suspends it); one owner per project (the `serve` daemon, project lock) so it never fires twice — OWNER CONCERN (why parked): two agents in the same folder (two terminals / contexts) would both load and run the same crons; one new session per run; missed fires skipped + noted; model-made `schedule_create` wakes stay for session reminders. Could shape agent-workflows slice 10 (scheduled start). Type: eval · Size: — · Blast: load-bearing (unattended turns, §7 trust) · Suited: Opus.
- [ ] **eval/repo-git-triggers** (owner 2026-11-22 ~23:20, idea only) — start a workflow on a repo event (commit / merge / tag on a branch) via a trigger in its YAML (`on: { git: { branch: main, event: commit } }`, the run gets `{{inputs.sha}}`/branch/message). Notes from the chat: the project's `serve` is the single listener (watches `.git/refs` + `packed-refs`, not per-clone git hooks); an event may only START a workflow whose hash the owner already approved (a commit that edits the workflow file suspends it until re-approval); loop guard (ignore the run's own commits + max runs/hour); coalesce bursts (rebase/pull of 20 commits → one run on the last sha); remote events (GitHub push/PR) need a webhook through the relay — later. Shares the single-owner + hash-approval design with eval/repo-schedules; agent-workflows plan already lists «trigger su push git» under «Dopo». Type: eval · Size: — · Blast: load-bearing (unattended runs, §7 trust) · Suited: Opus.
- [ ] **eval/tui-workflow-editor** (owner 2026-11-22 ~23:15, idea only — «lascia solo una voce in todo, vedremo poi») — creating/editing workflows from the TUI (today: only YAML, written by the model or by hand; slice 6 gives run/view/approve). Options noted: a guided `/workflow new` (questions step by step) or a panel showing the graph with a per-step edit sheet like the iPhone. Mockups before any decision. Type: eval · Size: — · Blast: contained · Suited: Opus mockups.
- [ ] **feat/tui-mascot-anim** (PASS 21/11 21:37, ON HOLD by the owner) — animated Polpetto in the TUI header; Polpetto is hidden in the TUI (`fix/tui-mascot-hidden`) until the owner decides the Apple Terminal half-block issue. Branch kept, no worktree.
- [ ] **feat/tui-detach** (plan, owner rounds 1–3 answered, H0 probes done; not started) — `/detach` returns the shell prompt like `/quit`, the TUI process goes headless. Doc on the branch.
- [ ] **feat/remote-control** (promoted from eval 18/11; plan on the branch, uncommitted doc edit in its worktree; not started).

## Open follow-ups (sub-items of done tasks)

Kept by the 2026-11-26 clean-up: open sub-items whose parent task is done.

- [ ] **Design 3 — background tap STILL OPEN**: needs the owner's phone `notify` log line after the next iOS build; then decide/fix.
- [ ] Follow-up (Opus round-3 LOWs, `docs/feat/subagent-tail-view.md` Review → Round 3 → Nits): a cancel with no text still says "cancelled" twice (the model's advice is shown); an empty report draws two blank rows; a spilled report keeps a blank row; a wrapped row can start with a space; a stop reason named like an `Object` member prints garbage (`Object.hasOwn`); Ctrl+O on a trail over the screen height loses its top (live check, maybe pre-existing). Type: fix · Size: S · Blast: contained.
- [ ] 🔵 **Later hardening:** Ed25519-signed `SHA256SUMS` verified by
  `update` (D3 deferred).
- [ ] 🔵 **Debt: no 64-char MCP tool-name warning in the TUI** (K2). It is
  printed only in `--plain` / one-shot mode (`cli/src/main.ts`, after
  `connectMcpServers`). The TUI connects MCP in the worker, which has no
  warning channel (a raw write would corrupt Ink, §7). Route it through
  the worker's MCP status (`McpStatusTracker` / `mcp/status`). Type: feat
  · Size: S · Blast: contained.
- [ ] **Hook model access (LLM-judge seam)** — hooks call a model
  through tentacle (unix-socket HTTP + per-invocation token), judge
  model from a laptop-side `hookModels` map, resolved and capped on the
  laptop; in a pod via a new daemon→client `model/complete` (keys never
  leave the laptop). Owner decisions M1–M8 open. **Eval:**
  `docs/eval/hook-model-access.md`. Type: eval → feat · Size: L (split
  A local / B pod+protocol) · Blast: load-bearing.
- [ ] 🔵 **Nit: re-check pending asks after a throwing send** — a client
  whose send throws in `emit` is dropped without `recheckAsks()` (needs a
  programming error; next attach/detach re-checks). Fix: one
  `recheckAsks()` after the fan-out loop (never inside: `settle` emits).
  Also optional: default `requestTimeoutMs` for requests to a pod.
  Type: fix · Size: S · Blast: contained.
- [ ] device check (from the e2e triage, unverified): on iOS 26 a rightward drag that starts on the hub-opacity track (not on the thumb) may be taken by the stack's content back-swipe and pop Settings — flow 33 hit it with Maestro's swipe; check with a finger, fix with a native gesture if real.

## Quarantined e2e flows

Each quarantined / known-bug flow needs its line here (`apps/mobile/test/e2e-gate.test.ts`).

- [ ] e2e flow `22-notify-approve` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-deny` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-reply` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-forged` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `push-placeholder` is quarantined: Maestro does not see SpringBoard notification banners on the iOS 26 simulator (a plain `simctl push` banner was not found during a 20 s wait), so the banner step cannot be asserted; re-enable when Maestro can read banners (or assert the presentation another way).
- [ ] e2e flow `22-notify-render` is quarantined: Maestro does not see SpringBoard notification banners on the iOS 26 simulator (a plain `simctl push` banner was not found during a 20 s wait), so the banner step cannot be asserted; re-enable when Maestro can read banners (or assert the presentation another way).
- [ ] e2e flow `19-lock-unlock-button` is quarantined: on the simulator a resume auto-prompts Face ID over the Unlock button (by design) and a nomatch cannot be scripted, so the button cannot be driven; re-enable when a failed/cancelled evaluation can be scripted (or drive it on a device). Logic covered by `app-lock.test.ts`.

## v0.1.0 stabilization review (in progress)

Full code review, hot-path → polish, to stabilize a v0.1.0. Findings recorded
here as we go; fixes applied in a batch at the end. Severity: 🔴 blocker ·
🟡 should-fix · 🔵 nit/hardening.

### Block 1 — core execution (agent loop, provider/SSE, exec, result-pipeline)

- [ ] 🔵 **Timing flake, not investigated:** `tui/test/queue.test.tsx` "a task
      typed while running is shown queued…" — a spinner-glyph regex timed out
      under full-suite load once (2026-10-23, task 4b's baseline on an
      unchanged tree, 2048/2/1); run alone `--rerun-each 5` → 15/15 green.
      Likely test-only (frame polling under CPU load); confirm before assuming.
      Found in: `docs/feat/send-now-b.md` (Execution, Baseline).
- [ ] 🟡 **Intermittent timeout, not investigated:** `agent/test/session-store.test.ts`
      "JsonSessionStore durability > drain() resolves only after in-flight and
      queued writes settle" timed out at 5 s once in 12 full runs (2026-10-20).
      Unknown whether test-only or a real `drain()` defect — investigate before
      assuming the former (session persistence path).
- [ ] 🔵 **Test residue:** a `HostedSession` from `cli/test/engine-runtime.test.ts` (was `pod-runtime.test.ts`)
      stays reachable from a root closure through its `SpyFakeCluster` fake after
      the file ends (heap snapshot, 2026-10-20). Test-scoped; tidy when touched.
- [ ] 🔵 **The replay ring is unbounded during a long permission suspension**
      (from `feat/permission-events` Review, 2026-10-20): the ring never evicts
      past the cut (`daemon/src/ring.ts`), and the cut cannot move while a turn
      waits on a permission — which now has no timeout. Updates emitted meanwhile
      (background-job exits, a sub-agent's progress before its ask) accumulate
      for as long as the suspension lasts. Bound them (e.g. coalesce
      `background_exit` past a budget) without unpinning the pending request.
- [ ] 🔵 **`BackgroundJobs.jobs` map is never reaped** (`exec/background.ts:78`):
      every finished job keeps its ≤256KB×2 buffers for the session's life. Reap
      old `exited`/`killed` jobs or cap the count.
- [ ] 🔵 **`exec()` buffers all stdout+stderr in RAM** (`host-execution.ts:103`)
      before the pipeline can spill — a multi-GB command can OOM (background jobs
      are capped; foreground exec is not). Consider a capture cap.
- [ ] 🔵 `spillLargeOutput` keeps the whole content inline *and* writes a file
      when `maxInlineChars < previewChars` (misconfig only; defaults are safe).
- [ ] 🔵 `exec` kills with SIGTERM only (no SIGKILL escalation on timeout); tool
      args are JSON-parsed twice (permission gate + registry). Both harmless.
- [ ] 🟡 **Oversize / degenerate tool-call guard (anti-runaway).** A real
      incident (2026-10-16): the local model repetition-looped emitting `"` and
      produced an `fs_multi_edit` tool-call with **167,794-char arguments** →
      the upstream (llama.cpp) returned `500 "parse error col 167795"`, and that
      monster call **poisoned the session file** (had to remove messages 169/170
      by hand with `jq`). One degenerate model loop broke the whole session.
      **Guard, at the harness** (NOT the sampler — a DRY repetition penalty was
      tried and reverted because it breaks `fs_edit`'s verbatim reproduction of
      existing code): when a tool-call's assembled arguments exceed a sane cap
      (and/or show degenerate repetition — a short sequence repeated N× ), reject
      the call *before* executing or persisting it and return an actionable
      tool-error to the model so it can recover, instead of attempting the call
      and saving a corrupt turn. Lives in the tool-call parse/validate path
      (agent loop / provider SSE assembly where `tool_call` args accumulate).
      Precedent: the daemon already caps inbound RPC frames (`maxFrameBytes`,
      Block 4) — this is the analogous cap one layer up, on model output.
      Keeps normal editing untouched. Plan not yet written.

### Block 2 — tools (fs_*, shell, background, task/subagent)

- [ ] 🔵 **`explore` (read-only) sub-agent still writes spill files** to
      `.tentacle/tool-output/` via the result pipeline (`subagent.ts` passes
      `resultTransforms`), contradicting "cannot modify anything".
      Tentacle-internal + confined, but either exclude the spill write for
      read-only types or note it.
- [ ] 🔵 `fs_read` with `offset` past EOF yields a backwards header
      (`lines 500-499 of 10`) + empty body; `shell` labels any `exit=124` as
      "killed/timed out" even when a command legitimately exits 124.

### Block 3 — permissions & agent support (gate, shell-prefix, compact, agent-defs)

- [ ] 🔵 Empty-prefix shell approval is dead/misleading: when `suggestShellPrefix`
      returns `""` (command is only `VAR=val`, bare `sudo`, or empty),
      `PermissionGate.remember` falls through to `grantedTools.add("shell")`, but
      `isRemembered` never consults `grantedTools` for shell — so a session
      approval silently doesn't stick (re-asks). Fails safe, but confusing.
- [ ] 🔵 `programTokens` strips leading `sudo` in both suggest and match, so
      approving `sudo systemctl restart` creates the rule `systemctl restart`
      (and a later non-sudo `systemctl restart` auto-runs, and vice versa).
- [ ] 🔵 A throw from the permission `requester` (or `gate.authorize`) escapes
      `runMessages` uncaught, same class as Block-1 ①. **Subsumed by**
      `docs/eval/history-validity-invariant.md`. The interactive requester
      resolves `allowed:false` rather than throwing, so low-risk in practice.
- [ ] 🔵 `agent-defs.ts`: `parseFrontmatter` needs `\n---\n` → a CRLF file loses
      its frontmatter silently; `tools: foo` (bare string, no `[]`) falls through
      to `"all"` instead of a single-tool list — a footgun that over-grants.
- [ ] 🔵 `compactedHistory` can leave two consecutive `user` messages (summary +
      next send); OpenAI-compatible servers tolerate it, but note for strict ones.
      **Subsumed by** `docs/eval/history-validity-invariant.md`.

### Block 4 — remote (transport `RpcPeer`, daemon ws-server/connection/host)

- [ ] 🟡 **Worker daemon swallows its own errors → TUI shows bare `RpcError:
      internal error`.** SEEN TWICE on 2026-10-16, both in the local (worker,
      no pod) TUI, both right after a `Read` tool result rendered in the TUI
      (second time: after reading `packages/agent/src/agent.ts`, a 434-line
      file). Chain: the worker's RPC request handler throws a NON-`RpcError`
      → `transport/peer.ts:209` converts it to the generic
      `InternalError(-32603, "internal error")` for the client AND calls
      `reportError` → `onError` — but `cli/src/worker.ts:92` builds its
      `Connection` with NO `onError`, so the real error is dropped and the TUI
      (client side) only ever sees the generic message. ROOT CAUSE UNKNOWN
      (no daemon-side log exists to look at). Suspect: a handler that throws on
      a large tool result / `session/update` payload (both crashes followed a
      big `Read`), or the client's inbound result validation
      (`peer.ts:258`, "invalid result for …") — but neither is confirmed.
      **Observability shipped (2026-10-16) — the error is no longer lost
      (root cause still OPEN):** the worker's `Connection` now wires `onError`
      → `logDaemonError` (`cli/daemon-log.ts`), appending the real message +
      **stack** to `<configDir>/logs/daemon-errors.log` (append-only, ISO
      timestamped; a FILE, not stdout, so it can't corrupt the TUI mid-session).
      AND, because the worker is a local/trusted peer, `Connection` is built
      with `exposeInternalErrors: true` (new `RpcPeerOptions`/`ConnectionOptions`
      flag): a non-`RpcError` handler throw now sends the REAL message (+ stack
      in `data`) to the client instead of the opaque "internal error", so the
      TUI line itself shows the actual cause. Default stays opaque — the remote
      `ws-server` path does NOT set the flag (no leak to untrusted clients).
      Tests: `transport/test/peer.test.ts` (expose on → real message+stack; off
      → generic), `cli/test/daemon-log.test.ts`.
      **When it recurs:** grab `~/.config/tentacle/logs/daemon-errors.log`
      (or the configured `configDir`) — it now has the stack — and/or screenshot
      the (now real) TUI error line, then diagnose. Still TODO: the same
      generic-conversion gap on `ws-server.ts:182` is intentionally left (remote
      = untrusted); a server-side error log there is a possible follow-up.
- [ ] 🟢 **Steering follow-ups (from `fix/steering-over-rpc` Review 2).**
      (a) The TUI removes ⏳ rows by COUNT, so a late `NoTurnRunning` reject
      (one round-trip after `turn_end`) can remove a row belonging to the
      NEXT turn's message (`tui/App.tsx`, reconciliation `.catch`). Cosmetic.
      A real fix needs an id per enqueue, which touches the `Agent` core.
      (b) On a reject the typed text is lost; only the notice remains. It
      could be restored into the input line. (c) Pre-existing, out of scope:
      Esc while the first `send` is still opening the session does not cancel
      the turn (`client/remote-session.ts`, the abort listener is attached
      after `openSession`).

### Block 5 — config (resolve/load/schema)

Solid: key kept in memory only, provenance never carries the secret, precedence
clear, `.strict()` schema is deliberate. Minor notes only:

- [ ] 🔵 MCP server names (record keys) aren't charset-validated; a name
      containing `__` or odd characters could collide with / malform the
      `mcp__<server>__<tool>` tool-name convention. Validate the key shape.
- [ ] 🔵 `apiKeyCommand` failure surfaces `stderr` in the error — ensure a
      key-printing command can't leak the key there on a non-zero exit (low).

### Block 6 — TUI (App.tsx, state, render-lines, scroll, mouse, paste, run)

Reducer (`state.ts`), scroll math, mouse parsing, selection: clean and well-tested.
Findings are in the App glue and terminal lifecycle:

- [ ] 🔵 Live background-exit and `pushNotice` force `setScrollOffset(0)` (jump to
      tail) even when the user is scrolled up reading history — yanks them down.
- [ ] 🔵 `queued` (steering) list is unbounded: queueing many tasks grows the
      bottom area past the terminal height while running (viewport clamps at 3).
- [ ] 🔵 After the Block-1 ① fix, a cancelled turn just stops silently — consider
      a subtle `⎿ cancelled` notice so the user sees it was interrupted, not done.
- [ ] 🔵 (aesthetic) diff bars pad to width by character count, not display
      width, so CJK/emoji lines misalign the full-width background bars.
- [ ] 🟡 **A dropped connection leaks the raw Bun socket error into the TUI.** A
      transport close mid-turn (candidate sources: the model-provider
      `fetch`/SSE stream, an MCP connection, or the local worker channel)
      surfaces verbatim as
      `⚠ Error: The socket connection was closed unexpectedly. For more
      information, pass verbose: true in the second argument to fetch()`
      because `App.tsx:326` does `failTurn(state, String(error))` with no
      mapping. Future iteration: catch transport/network close errors at the
      `session.send()` boundary and surface a clean "connection to the
      provider/daemon dropped — retry the turn?" notice instead of the raw
      message; decide on auto-retry / reconnect semantics. (Reported 2026-10-14
      in a local TUI session — **not** k8s/pod related.)

Daily-driver work (done 2026-10-14):

- [ ] 🔵 **TUI: mouse copy turns tabs into 4 spaces** (owner decision in
      the `fix/tui-diff-tabs` Review, 2026-10-25) — the selection copies the
      rendered rows (`App.tsx` `finishSelection` → `extractSelection`), and
      since that fix a tab is rendered as 4 spaces, so code copied from a
      Read/Bash/diff block loses its tabs (Makefile, Go). The model, the
      store and `/save` are unchanged. Owner: keep "copy what you see" for
      now; a faithful copy needs the source text kept next to each rendered
      row. S–M · contained.

- [ ] 🔵 **TUI: one helper for time-budgeted background work** (owner,
      2026-10-25) — in progress: `feat/tui-run-chunked`
      (`docs/feat/tui-run-chunked.md`) has the three callers moved onto
      `runChunked`; left open for the "measure other candidates" follow-up.
      The "slice into ≤ 6 ms chunks, yield with `setTimeout`,
      cancel by a generation token" loop was hand-written in `App.tsx` for the
      resize re-layout (~:535) and the long-history open (~:789,
      `WARM_THRESHOLD`), and `fix/tui-expand-latency` adds a third (idle warm
      of the other Ctrl+O layout). Extract one pure, tested helper (e.g.
      `runChunked(work, { budgetMs, isStale })`) and move the three callers
      onto it. Then measure other candidates before touching them: syntax
      highlighting of a very large Read, `/sessions` with many sessions.
      After `fix/tui-expand-latency` merges. Type: feat (refactor) · Size: S
      · Blast: contained · Suited: Sonnet executes, Opus reviews.

- [ ] **Default `maxIterations` = `-1` (unlimited), agent and sub-agents** (owner, 2026-10-25,
      from the `context-reset` plan questions) — today 16
      (`packages/config/src/defaults.ts:11`); the commented default in the
      generated config, docs and tests follow. Sub-agents' default too
      (50 → `-1`, `:18`; owner "si grazie"). Type: fix · Size: S · Blast: contained ·
      Suited: Sonnet executes, Opus reviews.
- [ ] **The model knows how full its context is (`contextAwareness`)**
      ([`docs/eval/context-awareness.md`](docs/eval/context-awareness.md);
      owner, 2026-10-25, decided) — a line `context: 82k / 128k tokens (64%)`
      once per new percentage point, on the message that crosses it; provider
      usage when available; `"contextAwareness": { "enabled": true,
      "stepPercent": 1 }`. BEFORE `context-reset`. Type: feat · Size: M ·
      Blast: load-bearing · Suited: Opus executes; mandatory fresh-context Review.
      **Status (2026-10-26):** executed on `feat/context-awareness` — task doc
      [`docs/feat/context-awareness.md`](docs/feat/context-awareness.md);
      `DAEMON_RECORD_VERSION` 7; pod window = the laptop's (`--context-window`);
      line hidden from the TUI. Awaiting Review.
- [ ] **Model-initiated context reset (`context_reset({ prompt })`)**
      ([`docs/eval/context-reset.md`](docs/eval/context-reset.md); owner,
      2026-10-25, 9 decisions taken) — the model renews its own context when
      a new part of a plan starts: same session, history replaced by the
      fresh system prompt (re-read: identity, `AGENTS.md`, skills) + the
      model's restart prompt + running jobs list; approval like other tools;
      anti-loop rule + configurable cap (default unlimited); feature on by
      default, configurable. Next: promote and plan. Type: feat · Size: M–L
      (to confirm) · Blast: load-bearing · Suited: strong model, fresh review.

- [ ] 🔵 **TUI: a re-layout at the old width can wipe a fresh resize warm**
      (Review finding 1 of `fix/tui-expand-latency`, 2026-10-25; owner: separate
      task) — if a new item / notice / job exit lands while a resize warm is in
      flight (> 400 ms on a long session), the idle warm restarts at the OLD
      width (`App.tsx` ~:546 and the idle-warm effect ~:636-645) and the
      width-keyed `rowCache` entries just warmed are replaced: the first frame
      after the resize costs ~305 ms instead of ~0.4 ms on a 2.6 MB session.
      Pre-existing in kind on main (a keystroke during a resize). Fix idea:
      while a resize warm is in flight, gate every re-layout on the pending
      width, or key the cache on both widths. S · contained.

- [ ] **Parallel execution — split into 7 tasks** ([`docs/eval/parallel-execution-plan.md`](docs/eval/parallel-execution-plan.md);
      owner answered PE-Q1..Q6 on 2026-10-26: default = read-only parallel, R2,
      shared workspace, one "always" for the session tree, trust MCP
      `readOnlyHint` + override, cap sub-agents at llama.cpp slots). Order: 1
      `feat/fs-path-locks` (S, DONE `bfffdb4`) · 2 `feat/subagent-progress-wire` (M, DONE `ada7918`) · 3
      `feat/model-retry-429` (S, DONE `bb43767`) · 4 `feat/permission-call-attribution` DONE `206adbf` → 5 `feat/round-groups-persistence` DONE `1ee6123` (merged with permission-reply, shared record v8; owner 2026-11-04: phase-1 "Interrupted" accepted; `beforeRun` → `Promise<boolean>`, `true` for never-persisted sessions; task 6 adds the one-at-a-time fallback on a failed write AND the laptop `cutHistory` option (b): "Interrupted" for calls the laptop saw a `tool_start` for, "Not run" for the rest) → 6 → 7 (load-bearing, strictly
      ordered).
- [ ] **fix: engine architecture mismatch** (found live 2026-11-04): an amd64 image on arm64 podman runs the x64 binary under qemu → Bun MemoryExhaustion. Pull/create for the native platform, and refuse a mismatch before copying the binary. Type: fix · Size: S–M · Blast: cross-module.
- [ ] **feat/run-oneshot** (owner 2026-11-04, separate from run-prompt): one-shot streaming run in a container, non-TTY stdin (`--prompt -` without `--detach`). Type: feat · Size: M · Blast: cross-module.
- [ ] **tui-light-theme-followups** (LOW, from its review round 3): (1) the timeout hand-over of a cut UTF-8 character (`carry`) has no repo test — a reviewer mutation survived; (2) after a seeded residue, hex keys typed first are dropped; (3) not live-checked: a terminal that never answers the OSC-11 query (mute), and `connect --resume` against a real `serve`. Type: fix · Size: S · Blast: contained.
- [ ] **fix/detached-autowake-followups** (LOW, from its two reviews, `docs/fix/detached-autowake.md`; R2-1..R2-3 moot: the wake cap was removed by fix/autowake-unbounded, merged e0a5798, owner 2026-11-06 "illimitato"): F6 a refused-wake streak keeps the relay alive (no model calls; accepted); F7 weak bounds `relay.test.ts:2530`, no mutation on R-W4; F8 `handedWakeRef` decision in `App.tsx:1221-1225` and the refusal predicate `relay.ts:403` → pure module. Live oddity: after the woken turn `ps`/log said `running 1 background job(s)` ~10 s with the job already exited. Type: fix · Size: S · Blast: cross-module.
- [ ] **serve-autowake-followups** (LOW, from its reviews + live check): (1) `connect` shows no `n background job(s) ended while you were away` notice on attach (live check 2026-11-07); (2) D6 not pinned with a client attached — no test for Esc/error then another exit while attached (move repro cases A, G into the daemon test); (3) the `connect.test.ts` no-second-waker pin misses a conditional seed (`unflushedExits() > 0 ? { wakePending: true } : {}` stays green; `capturingDial` reports none); (4) docs promise more than `connect` does; (5) stale "nobody attached" wording (`serve.ts:199`, `session-host.ts:182`, daemon test header/describe `:205`, CLI test header, doc title) and `SLOT_LOST_NOTICE` ("another device started a turn") wrong when the daemon's wake took the slot; (6) the tool-bound test is vacuous for the guard; (7) a wake that fails before its flush leaves the exit counted with no notice; (8) Esc pauses daemon wakes until a turn ends normally. Type: fix · Size: S · Blast: cross-module.
- [ ] **run-session-never-saved-stuck-readback** (LOW, owner Q4 2026-11-07, `docs/fix/run-session-never-saved.md` Context "Side finding"): a read-back lost on a link that keeps carrying the pod's `model/stream` traffic delays every later save until liveness (15 s of inbound quiet) replaces the link — saves are delayed, not lost. Separate fix; needs a lost frame on an otherwise healthy stream. Type: fix · Size: S–M · Blast: load-bearing (persistence/liveness).
- [ ] **tui-busy-after-docker-stop** (LOW, owner R3 2026-11-07, `docs/fix/run-session-never-saved.md` Review "Optional repro"): on 65a0f07 the in-process repro (`repro-h6.ts kill`) shows the turn never ends (`busy=true` > 20 s) after the pod link is gone; A/B with the fix disabled is the same, so not caused by that diff; may be a repro artifact. **Confirm on clean `main` first** (one run), then a separate fix/eval. A TUI stuck "busy" after `docker stop` would be user-visible.
- [ ] **remove-in-process** (owner 2026-11-07) — remove `--in-process` / `--no-worker` and the automatic fallback to the in-process path when the worker fails (`packages/cli/src/main.ts:1636-1674`): it is the only second session path (AGENTS §7 "TUI always over RPC") and every persistence/steering/hooks change has to be handled twice. A worker that fails to start → a clear error. After `feat/session-log-laptop-store`.
- [ ] **pod-turn-auto-continue** (owner 2026-11-07, live test of `feat/session-log`) — when a pod daemon dies mid-turn and the laptop recreates the session (reseed), the interrupted turn is NOT resumed: the agent waits for the user. Owner wants an automatic "continue" after the recreate — OPT-IN setting, default OFF, never under manual tool approval unless explicitly enabled (owner 2026-11-07), like the `serve` daemon does for suspended turns (`docs/feat/suspended-turn-resume.md`). Separate task, after `feat/session-log`; size/blast to be planned. Related: the silent turn end after a daemon kill (investigation `.tentacle/tmp/silent-turn-end/findings.md`) — the TUI must at least SAY the turn was interrupted.
- [ ] **fix/silent-turn-end** (S–M · cross-module · no protocol/format; owner 2026-11-07) — NOT a regression of `feat/session-log` (same on main): when a pod daemon dies mid-turn the client fails the turn and the TUI adds a ⚠ row, but the recreate's `history` activity (`client/src/remote-session.ts:1123`, applied in `drainHeld`, `tui/src/App.tsx:1427`) REPLACES the transcript and wipes that display-only row → the TUI goes silently idle. Fix in a pure module (keep/re-add the notice after the restored transcript). Owner-approved text: `⚠ Daemon lost: turn interrupted. Type to continue.` (no `RpcError:` prefix). Findings + in-process repro: `.tentacle/tmp/silent-turn-end/findings.md` (copy into the task doc).
- [ ] **recreate-interrupted-marker** (LOW, owner 2026-11-07) — verify first: after a pod recreate mid-TOOL, is the cut call closed for the MODEL with an explanation (like `serve`'s "interrupted: the daemon restarted during this turn", `daemon/src/persisted-session.ts:516-556`)? Only matters when a tool was killed mid-execution (half-done side effects); if missing, a small load-bearing fix.
- [ ] **feat/session-settings-apply-followups** (LOW, round-2 review): R2-1 no test that re-served snapshot pages do not count as attach progress (mutation `attachMark = 0` stays green; code right by reading); R2-2 a hostile pod can stretch an attach to ~83 h with fabricated pages (finite, `SNAPSHOT_MAX_PAGES`); a failed sync after a session switch is told nowhere. Owner note: likely drop the W rule (container wins) for run/attach — then `// (container)` goes too; decide with project-config eval Q5–Q11. Type: fix · Size: S · Blast: cross-module.
- [ ] **write-tmpdir-followups** (LOW, from its review round 4 + accepted residuals): (1) `README.md:321` and `CHANGELOG.md` say an existing outside file is "never written in place" — too absolute under the shared-root race (the rename over a same-named outside file was not excluded, only never seen in 135k writes); (2) `host-execution.ts:454` would wrongly say "temp file left" on a Linux read-only mount (unverifiable on macOS); (3) accepted residual: on hosts shared with other users, a user controlling a dir on the path in `/tmp` can race a swap and leave hidden `.tt-*` files with our content elsewhere; (4) the dropped-entry notice fires once per `buildAgent` (once per `serve` session); (5) below ~46 columns the permission key-hint footer wraps (pre-existing). Type: fix · Size: S · Blast: contained.
- [ ] **feat/subagent-unknown-type-note** (owner 2026-11-08, rename review Q1): an `agent_task` whose `subagent_type` names no known type still runs on the default `general`, and its tool_result now says so in one line ("unknown type X, ran as general") so the model knows. Separate small task, after the subagent-live tasks. Type: feat · Size: S · Blast: contained.
- [ ] **fix/detached-tui-sighup-kills-tool** (live check of models-map-pod, 2026-11-09, O3; not diagnosed): a SIGHUP to a TUI of a detached run seemed to interrupt the running turn's shell command (`sleep 40` → `exit=124 [killed …]`); AGENTS §7 says it must ONLY detach. First reproduce on main (could be the tool timeout instead). Owner 2026-11-09: repro allowed with the local docker and the DEFAULT config model (local qwen3.8, no cloud key). Type: fix · Size: S · Blast: load-bearing.
- [ ] **eval/task-board** (owner 2026-11-10: start NOW, in parallel): a PUBLIC board on tentacle.so (`/board`) of backlog / in-progress / merged / released tasks with pickup date, who works on it, merge commit, release version — FILTERED fields only (no descriptions; security bugs only after their fix), DERIVED from TODO/docs/git/tags (step A, site-only, S–M) + live events sent by the orchestrator's launchers (step B, M) — agents do nothing extra. Doc `docs/eval/task-board.md` (opus); owner questions Q1–Q7 open (step A runs locally on the recommendations meanwhile, nothing published). Type: eval · Size: — · Blast: contained (site only). OFFLINE since 2026-11-10 evening (owner: "rimuovi https://tentacle.so/board"): launchd unloaded, `/srv/tentacle.so/board` removed (backup `/root/tentacle-site-backup/board-dir.2026-11-10.tgz`), deploy key disabled (`authorized_keys.disabled` of user `board`), nav link removed; code kept in `.tentacle/site/board/`.
- [ ] **fix/reask-budget-and-compact-length** (Opus review of fix/truncated-reply-silent, 2026-11-11, both pre-existing on main): (1) the DSML re-ask uses `budgetFrom--` (`agent/src/agent.ts` ~:1229), which SHRINKS the step budget (costs 2 steps) instead of making the re-ask free — truncated-reply's re-ask uses the correct `budgetFrom++`; (2) compaction (`agent/src/compact.ts` ~:77,115) accepts a summary cut by `finish_reason: length` as complete — same class as truncated-reply, needs `done.stopReason` (lands with that fix). Type: fix · Size: S · Blast: cross-module · Suited: DeepSeek.
- [ ] **feat/attachments** (owner 2026-11-12: attach PHOTOS from the TUI on the laptop first — drag a file into the terminal / paste a path / `/attach`; promoted from eval, [umbrella](docs/feat/attachments.md) §Promotion): sub-tasks in order 1 `attachments-core` **MERGED 9baa0ba 2026-11-12** (silent merge per owner rule: Opus review 1H 3M → fixed, Opus r2 PASS; main gate 7016/3/0; needs `bun install` after pull — providers/client gained a workspace dep) ([doc](docs/feat/attachments-core.md), M load-bearing, bump PROTOCOL_VERSION 23, new critical log entries `media_message`/`media_replace`) → 2a `attachments-upload` → 2b `attachments-prompt` ([doc](docs/feat/attachments-prompt.md), M load-bearing, plan APPROVED by night delegation 2026-11-12, no protocol bump) → 3a `attachments-tui-detect` (may run in parallel) → **3b `attachments-tui` = the owner's goal** → 4 `attachments-durable` → 5 clipboard image paste → 6 **client downscale/resize** (owner: images up to 15 MB, no resize for now — resize later here). Owner: attachments sub-tasks merge WITHOUT asking after Opus PASS + green gate. Type: feat · Size: L (split) · Blast: load-bearing.
- [ ] **eval/attachments-audio-video** (owner 2026-11-13): the mobile app must support attachments — photos/camera in mobile task 13 (compose) via `attachment/put`, image rows in task 12 (transcript) — AND audio/video files. Audio/video is new scope beyond images: which providers/models take audio or video input, a transcription fallback for models that do not, size caps and chunked upload limits, where `serve`/pods store them (durable like attachments-durable), how the TUI and the phone show them. Bonus (owner 13/11): general tentacle support for live VIDEO STREAMS (e.g. a camera or screen stream the model watches, in the TUI and on the phone) — evaluate feasibility (which models take streaming video, frame sampling vs native streams, bandwidth over the E2E channel, cost) as a separate section; may become its own task. Decide here before any code; then promote to feat. Type: eval · Size: — · Blast: load-bearing (protocol, persistence) · Suited: Opus.
- [ ] **eval/binary-frames** — **OWNER VERDICT 20/11: all recs, Q2 = clean break (binary-only, app unpublished); next slice BF2 `feat/noise-binary-carrier` after the current queue** — (owner 2026-11-13: "ogni efficientamento è da perseguire") (owner 2026-11-20: QUEUED — Opus eval on condo after fix/inject-bin-dir-probe): the wire is JSON-RPC TEXT; image bytes travel base64 inside `attachment/put` (256 KiB chunk = 349 528 chars, `protocol/src/attachment-upload.ts:28`) — +33% bytes plus JSON encode/parse and a string copy per chunk, on every hop (laptop→daemon, pod tunnel, Noise E2E channel to the phone). Evaluate a pure-binary path for blobs (and later audio/video/streams, see eval/attachments-audio-video): binary frames next to JSON-RPC on each `DuplexChannel` (WebSocket binary frames, stdio/k8s-exec/docker byte streams with a length-prefixed framing, Noise frames are already bytes), how a request references its binary payload, back-pressure, version negotiation (protocol bump rules §7), Hermes support on the phone; measure before/after (bytes on the wire, CPU, latency for a 15 MB image). Type: eval · Size: — · Blast: load-bearing (transport, protocol) · Suited: Opus.
- [ ] **eval/session-tree** (owner 2026-11-09: FIRST thing after the sub-agent tasks 6b → 8 → 7 → 9 — and, owner 2026-11-10, after the 3 explore-loop tasks — before `feat/logs-cmd`): should the session log become a TREE (each entry has `id` + `parentId`, a moving "current leaf"; branch from any earlier message, the old branch stays in the same file), as pi does (`/tree`, `/fork`; verify pi's format first)? Candidates it could subsume cleanly: `clear-fork-history` (the old chat becomes a branch, not a separate session), superseded history of compaction/`context_reset` (`sessions.keepSuperseded`), rewind/retry from a message, a summary of an abandoned branch, and possibly the §7 rewrite machinery (atomic segment rewrite, set-aside files, "append only what the file lacks") if the log becomes append-only. Costs to weigh: on-disk format change (`schemaVersion` bump, old logs), a file that never shrinks (load time, leaf index), two writers (laptop + `serve` daemon) appending to one tree, `session/log` reads over the wire, sub-agent markers. Type: eval · Size: — · Blast: load-bearing (persistence, §7). Doc `docs/eval/session-tree.md` (opus 2026-11-10: recommends B + "rewind carries its lesson", no format change; owner questions Q1–Q10 open).
- [ ] **fix/detach-open-items** (owner 2026-11-09: right AFTER `eval/session-tree`, before `eval/parallel-tasks`): DeepSeek read-only triage on main 34aab38 of the detach-live candidates + `fix/detached-autowake-followups` (repros were in `.tentacle/tmp/detach-triage/`, gitignored — re-derive). FIXED: footer `↑0 ↓0 · ctx 0%` after attach (e506a1e + 7ee6dc2); `attach` without `--profile` (`main.test.ts` "round 10 / owner A"). OPEN, to group into tasks when planned: (3) Enter typed for `/quit` approves a permission ask that just opened — no age guard, `permission-reply.ts:118`, every key routed to the dialog `App.tsx:2534` (S · contained; safety-relevant, first); (4) `MultiEdit` ask shows `—` — no `fs_multi_edit` case in `describeToolCall` `agent/src/permission-gate.ts:36-64` (S · contained); (5) `[resume] … — (empty)` after exit — the pre-mount line is suppressed only for `live:true` `cli/src/tui-sessions.ts:121-128`, and the title comes from the first non-note user message only `agent/src/session-store.ts:73-80` (S · contained); (9d) `ps` says `1 background job(s) running` ~30 s after the job exited — `job_exit` never clears `jobs`, only the 30 s poll does `cli/src/relay-state.ts:112-113,150-151` (S · contained); (7) `dispose()` takes no `seal` → false `not saved` line, `cli/src/local-runtime.ts:785-791` vs `:797,:861` (S · load-bearing); (2) `thinking…` timer starts at attach — turn start time not on the wire (`TurnStartSchema` / `SnapshotTurnSchema`), `App.tsx:1539` (M · cross-module, protocol field); (8) a TUI closing during ITS model call cancels the turn for the other TUI — `daemon/src/connection.ts:147-153`, no re-routing of an in-flight call (M–L · load-bearing); (9a) F6 refused-wake streak re-arms the relay's idle deadline forever `relay-state.ts:107-113` (S · contained, accepted debt); (9b) F7 weak test bounds `relay.test.ts:2763`, R-W4 no mutation (test debt); (9c) F8 `handedWakeRef` in `App.tsx` and the refusal predicate in `relay.ts:408` → pure modules (S · cross-module). O3 (`fix/detached-tui-sighup-kills-tool`) stays its own entry (needs docker + real keys).
- [ ] **eval/parallel-tasks** (owner 2026-11-09, after `fix/detach-open-items`): relax "one code task at a time" (AGENTS.md §10; today the owner allows 2 with disjoint files) to 3–4 parallel tasks, even on shared files. Pieces: (1) a small merge queue run by the orchestrator — before each merge, rebase the branch on the current `main` and re-run the full gate on the result (catches semantic conflicts git cannot see); the second to merge resolves the conflict; (2) remove hotspots: `TODO.md` and the changelog as per-task fragments (changesets/towncrier style), `PROTOCOL_VERSION` bumped at merge time only ([doc](docs/feat/protocol-version-at-merge.md); done, pending merge), the `App.tsx` key handler extracted (known §7 debt); (3) optionally run only affected tests during iteration. Changing §10 is a rule change → its own `feat` with Review (§10 carve-out (c)). Type: eval · Size: — · Blast: cross-module (process).
- [ ] **eval/multi-model-council** (written 2026-11-08, committed 2026-11-11; [doc](docs/eval/multi-model-council.md)): the smallest architecture that lets several configured models deliberate on one decision with the user, inside the single session path and the §7 invariants — orchestration over the sub-agent runner, a new kind of session, or an external tool. Analysis + proposed 8-task split done; owner questions Q1–Q11 open. Not scheduled. Type: eval · Size: L overall (split) · Blast: load-bearing where marked.
- [ ] **feat/config-show** (owner 2026-11-08, `docs/eval/config-cli.md`, task 5/5): `tentacle config show [key] --origin`: the effective value and where it comes from. Type: feat · Size: M · Blast: cross-module.
- [ ] **attach-unflushed-exits-followups** (LOW, from its reviews): (1) multi-session seed — a session opened later in the same TUI (`/sessions` switch) is not seeded (owner 2026-11-06: follow-up); (2) T-TUI-6b does not exercise the round-3 deferral guard; (3) late-`open` ordering vs the deferred wake untested (`remote-session.ts:1118`); (4) the deferred `setTimeout` can fire `runRef` after an unmount in the same tick (pre-existing `wakeIfPending` pattern); (5) residual race: a count-seeded TUI B whose continuation lands after A's wake turn ended starts an empty turn (needs a daemon-side "nothing unflushed" refusal). Type: fix · Size: S · Blast: contained.
- [ ] **fix/tool-output-location-followups** (LOW, round-2 review, `docs/fix/tool-output-location.md`): (3) on a case-insensitive FS (default APFS) session ids `AB`/`ab` share one spill dir; (4) a swept spill name can be reused by a server that reuses call ids (old banner then reads new content); (5) `HOME=/w`, `cwd=/w/sub` still writes into `/w/.cache` (Q1 only checks root-inside-cwd); (6) tests using the real `toolOutputStore()` (`serve-persistence.test.ts:419,439`) reach the real `$TMPDIR/tentacle-<uid>/tool-output`, outside the test env guard; two `agent-spill-sink` tests leave `project` in tmp. Type: fix · Size: S · Blast: contained.
- [ ] **feat/parallel-agents follow-ups** (task 7 review, 2026-11-06) — items (1) and (3) DONE in fix/parallel-agents-followups, merged 40d86c0 (cells-width rows; `[agents]` prefix, live one-shot shows `[agents] sub-agents capped at 1 at once…`); only the live `-np 2` checklist remains: (1) `tui/src/permission-ui.ts:81` (and `PermissionPrompt.tsx:11-13` `truncate`) cut by UTF-16 length, not cells — a CJK / wide label makes the dialog one row taller than `permissionPromptRows` says; one width-aware helper (string-width, like `cells.ts`). (3) `cli/src/wiring.ts:294` logs `sub-agents capped at N at once…` through `options.log`, which `main.ts` prefixes with `[hook]`: give it its own prefix. (5) DONE in fix/tool-output-location (exclusive-create spills). **Live, not yet run:** fan-out with a server at `-np 2`+ (N=1 vs N=3 timing, `subagents.execution: parallel` vs `sequential`, the permission prompt naming the child, Esc on one child / the parent). Type: fix · Size: S · Blast: contained.
- [ ] **feat/pod-laptop-only-notice** (owner 2026-11-05, config-carry Q5): when a session runs in a pod/container, the laptop says once which of ITS setup does not apply there — `hooks`, `mcpServers`, `PROMPT.md`, `agents/` — like the existing packages line (`main.ts:641-646`; `docs/container-config-sources.md` §3.3, eval project-config rule 10). Right after feat/config-carry. Then an owner discussion: what more can be carried into the pod/container (eval project-config Q9 MCP, skills, sub-agent defs). Type: feat · Size: S · Blast: contained.
- [ ] **Parallel tool calls** ([`docs/eval/parallel-tools.md`](docs/eval/parallel-tools.md);
      owner, 2026-10-25) — run a round's calls in parallel where safe; which
      tools are parallel-safe to evaluate; setting `sequential` | `parallel`,
      default to recommend (owner's first idea: sequential). AFTER task 7
      and `context-reset`. Type: eval → feat · Blast: load-bearing.

### Block 8 — cross-cutting audit (2026-10-17, each verified by a fresh-context sub-agent repro)

- [ ] 🟡 **Pod `--model-proxy` batch fallback waits for the laptop's generation
      to finish after a cancel.** Split off the item above (FIXED, merged to
      main 2026-10-19): the loop fix stops the *actions*, but a
      mixed-version (old-laptop, batch-only) pod still waits for the laptop's
      generation to complete. Low priority — race `send` against the signal in
      `packages/daemon/src/proxy-model.ts:~183`.
- [ ] 🟡 **Remote `/compact` failure shows an opaque `internal error`** (worker
      surfaces the real `CompactError` via `exposeInternalErrors`, but a remote
      `connect` omits the flag — `ws-server.ts:182-187` — so the client gets
      `RpcError: internal error` and the TUI prints `Compact failed: internal
      error`). Correct (history is safe) but unhelpful; fix = a dedicated
      additive `DomainErrorCode` (e.g. `EmptySummary`) mapped to an `RpcError`
      so the message crosses the wire without leaking internals (protocol
      version stays 1). Second review pass, Finding 4, of
      `docs/fix/compact-empty-summary-wipe.md`. Type: feat · Size: S ·
      Blast: cross-module.
- [ ] **Detach `fix/detach-live`** ([task doc](docs/fix/detach-live.md)): the live
      test's defects in S1–S3. `/quit` closes the session for every TUI on it (y/N
      with others), FAIL 39, the attach notice, the launcher line; auto-accept
      inherited on attach, Shift+Tab per session and shared. EXECUTED 2026-11-01,
      awaiting the fresh-context Review and the owner's live re-run.
      Type: fix · Size: L · Blast: load-bearing · Suited: Opus, fresh review.
      Candidates left by it (owner's list, not planned): footer `↑0 ↓0 · ctx 0%`
      after attach; the `thinking…` timer starts at attach; Enter on a permission
      prompt opening while typing `/quit` approves it; `MultiEdit` ask shows `—`;
      `[resume] … — (empty)` left after exit; `attach` without `--profile` shows the
      default model; `dispose()`'s same late read (one `seal`); a window close or
      crash during this TUI's model call fails the other's turn (needs re-routing).
- [ ] 🔵 **TUI: close a turn's still-running tool calls when the turn fails**
      (Review of `feat/tui-tool-blink`, 2026-10-30; owner: separate task) — after
      a failed turn a tool call stays `running` in the session state (seen as a
      bullet blinking forever, `App.tsx` ~:701); `feat/tui-tool-blink` only gates
      the blink on the turn running. Close them in the reducer (as cancelled /
      failed) when the turn ends without their result. Type: fix · Size: S ·
      Blast: cross-module · Suited: Sonnet executes, Opus reviews.
- [ ] 🔵 **k8s: recover the real exit code of a failed exec** (Review of
      `feat/detached-runs` S1 fix round 2, finding 3, 2026-10-30; owner: not in
      S1) — `packages/k8s` `exec-run.ts:99-102` maps every `Failure` status to
      exit 1 but keeps `details.causes[0].message`, which on `NonZeroExitCode`
      is likely the numeric code (unverified: no fake pins it, no cluster
      here). If so, a killed `residentGuard` probe (137) on k8s could refuse
      like docker instead of landing on `none`. Verify on kind first. Type: fix
      · Size: S · Blast: contained · Suited: Sonnet executes, Opus reviews.
- [ ] 🟡 **Worker death after handshake hangs the TUI forever** (Bun fires
      `close`; nobody listens). CONFIRMED. **Eval:** `docs/eval/worker-crash-hang.md`.
      Type: eval · Size: S · Blast: contained.
- [ ] 🟡 **Truncated tool-call persisted when the SSE stream ends before
      `finish_reason`** (Esc abort is NOT a trigger in practice). PARTIALLY
      CONFIRMED. **Eval:** `docs/eval/sse-abort-truncated-toolcall.md`.
      Type: eval · Size: S · Blast: cross-module.
- [ ] 🔵 **Oversize (8–16 MiB) frame on `connect` hangs the request** (null-id
      error can't be correlated). PARTIALLY CONFIRMED (the `--resume` trigger was
      wrong). **Eval:** `docs/eval/oversize-frame-hang.md`. Type: eval · Size: S ·
      Blast: cross-module.
- [ ] 🟡 **Anthropic provider drops `thinking` blocks instead of echoing them
      back.** Quality-only or a hard 400 in tool loops: undetermined, needs a live
      test. **Eval:** `docs/eval/anthropic-thinking-echo.md`. Type: eval · Size: M ·
      Blast: cross-module.
- [ ] 🟢 **Graceful shutdown for background jobs** (follow-up of
      `fix/background-process-groups`). On the worker path, and in practice on
      stdio/ws `serve`, tentacle's exit kills job groups with SIGKILL only — no
      TERM grace (dev servers may leave sockets/temp files). Fix: a `shutdown`
      handshake (worker runs `Connection.close()` → `dispose()`, acks, bounded
      by a timeout) and an awaited grace before `process.exit`; the exit net
      stays the fallback. Likely folded into the v2 `session-registry` child.
      See Notes/debt in `docs/fix/background-process-groups.md`.
      Type: feat · Size: S–M · Blast: load-bearing.
- [ ] 🟡 **OpenAI provider treats an in-band SSE `{"error":…}` chunk as an empty
      stream** (HTTP 200, no throw), so callers see a silent empty response (e.g.
      `/compact` wiping history). See `docs/fix/compact-empty-summary-wipe.md`
      (the wipe is guarded there; this provider defect — which also affects
      normal turns — is the separate follow-up).

### Block 10 — remote execution model (pod mode: what runs where; 2026-10-17, measured on OCP)

Umbrella and order: `docs/eval/remote-execution-model.md` (proposes a new §7
invariant: "compute next to the code, identity with the user; a pod is not
trusted"). Do them in order. `docs/fix/steering-over-rpc.md` goes right after 1.

- [ ] 🟡 **2. A large payload blocks every other message on the channel** (5 MB
      → ~4 s head-of-line; an end-to-end window W=2×256 KB bounds it to ~0.25 s).
      **Eval:** `docs/eval/rpc-flow-control.md`. Needs 1. Type: eval → feat ·
      Size: M–L · Blast: load-bearing.
- [ ] 🟡 **3. `runOn: "client"` — laptop MCP servers usable by the pod daemon**
      (push `tools/register`, `tool/call`, laptop-side gate). **Eval:**
      `docs/eval/mcp-client-tools.md`. Needs 1 (hard), 2 (soft), §7 invariant.
      Type: eval → feat · Size: L · Blast: load-bearing.
- [ ] 🟡 **4. `runOn: "daemon"` — workspace MCP servers started in the pod**
      (placeholder-only secrets, process-group dispose). **Eval:**
      `docs/eval/mcp-daemon-servers.md`. Type: eval → feat · Size: M · Blast:
      load-bearing.

### `/mcp` follow-ups (from `docs/feat/mcp-status.md` Review, 2026-10-21)

- [ ] 🔵 **A command notice that lands mid-reply splits the reply.** The display
      no longer merges them, and `/copy` skips notices. But `/save` still emits
      the two halves as separate `## Assistant` blocks, and a notice inside an
      open code fence leaves the fence broken in the live view. Options: hold an
      async notice until the reply's text ends, or insert it before the item
      that is still streaming. Display/export only, never persisted.
      Type: fix · Size: S · Blast: contained.
- [ ] 🔵 **`/mcp` polish.**
      - ~~No "probing…" placeholder during the ≤2 s probe.~~ Done by
        `feat/mcp-tools-panel`.
      - The tool list includes tools skipped for a name clash at register time.
      - The `methods.ts:1-6` header says the peer validates `result` before
        replying. Only the receiver validates (`peer.ts:436-444`).
      - ~~With the panel open, a paste or a lone typed `[` still lands in the
        hidden input.~~ Done by `feat/skills-panel` (bracketed paste, its
        timeout flush, a held `[`, and a late Ctrl+V clipboard read).
      Type: feat · Size: S · Blast: contained.

### Block 11 — new capabilities under evaluation (2026-10-19)

- [ ] **Tentacle is not usable from ACP editors (Zed)**: our wire is
      ACP-shaped but not ACP-compatible, and there is no `tentacle acp`. Proposal:
      an adapter frontend over `createLocalRuntime` (no wire change).
      **Eval:** `docs/eval/acp-adapter.md`. Type: eval → feat · Size: M (v1) ·
      Blast: load-bearing.
- [ ] **Sub-agent in an ephemeral Kubernetes pod** (opt-in, e.g. `runOn: "pod"`
      on `agent_task`). Open decisions D1–D8; D1 (what code the pod works on) is
      unanswered. **Eval:** `docs/eval/subagent-in-pod.md`. Type: eval → feat ·
      Size: M–L · Blast: load-bearing.

- [ ] **Sessions die with their connection; no re-attach** (blocker for the
      mobile app). Protocol-v2 redesign: daemon-owned sessions, `session/open`,
      seq'd byte-bounded stream + consistent-cut snapshot, compaction barrier,
      idempotent commands, permissions as events (no timeout: the turn suspends
      until a human answers), 24 h idle TTL, multi-attach, thin-client
      profile, JSON Schema export. CONFIRMED (repro); fresh-context review
      F1–F8 integrated. **Parent eval:** `docs/eval/session-reattach.md`.
      Children drafted (Implementation per child) and owner decisions A–G, D1–D10
      recorded in the parent (2026-10-19).
      Type: eval (parent) · Size: L → split · Blast: load-bearing. Children, in order:
      1. **Fix (DONE 2026-10-19, `fix/background-process-groups`):** `docs/fix/background-process-groups.md` · S–M · load-bearing
      2. **Feat (DONE 2026-10-19, `feat/protocol-schema-export`):** `docs/feat/protocol-schema-export.md` · S–M · cross-module
      2b. **Fix (DONE 2026-10-20, `fix/daemon-compact-turn-guard`):** `docs/fix/daemon-compact-turn-guard.md` (before 3c)
      (Steps 3a–3c are the three parts of `docs/eval/session-event-stream.md`,
      now closed: all three merged.)
      3a. **Feat (DONE 2026-10-20, `feat/session-wire-classes`):** `docs/feat/session-wire-classes.md` · M · load-bearing
      3b. **Feat (DONE 2026-10-20, `feat/session-turn-events`):** `docs/feat/session-turn-events.md` · M · load-bearing
      3c. **Feat (DONE 2026-10-20, `feat/session-history-cut`):** `docs/feat/session-history-cut.md` · M · load-bearing
      4. **Feat (DONE 2026-10-20, `feat/session-registry`):** `docs/feat/session-registry.md` · L · load-bearing
      5. **Feat (DONE 2026-10-20, `feat/session-ttl-limits`):** `docs/feat/session-ttl-limits.md` · M · load-bearing
      5b. **Fix (DONE 2026-10-20, `fix/session-store-durability`):** `docs/fix/session-store-durability.md` · M · load-bearing (before 6)
      6. **Feat (DONE 2026-10-20, `feat/daemon-side-persistence`):** `docs/feat/daemon-side-persistence.md` (Part A, `serve` only) · M · load-bearing
      7a. **Feat (DONE 2026-10-20, `feat/permission-events`):** `docs/feat/permission-events.md` · L · load-bearing
      7b. **Feat (DONE 2026-10-20, `feat/suspended-turn-resume`):** `docs/feat/suspended-turn-resume.md` · M · load-bearing
      — **Fix (DONE 2026-10-20, `fix/cancel-hung-disk`):** `docs/fix/cancel-hung-disk.md` — a
        hung disk no longer traps `cancel` of a turn waiting on a permission (the
        gate's clear-before-run wait now ends on the turn's abort) · S · load-bearing
        (fresh-context Review waived by the owner)
      8a. **Feat (DONE 2026-10-20, `feat/client-reattach`):** `docs/feat/client-reattach.md` · L · load-bearing
      8b. **Feat (DONE 2026-10-20, `feat/client-reattach-frontends`):** `docs/feat/client-reattach-frontends.md` · M · load-bearing
      9. **Eval:** `docs/eval/session-handoff.md` — continue a `serve` session from another device (owner requirement 2026-10-20: mobile → TUI, live) · L → split · load-bearing
      — **Eval:** `docs/eval/attachments.md` (sister) · 4 sub-tasks · load-bearing
      — **Feat (DONE 2026-10-20, `feat/pod-attach-resilience`):** `docs/feat/pod-attach-resilience.md` — Layer 1: exec-channel keepalive (WS ping + blank stdin + pong-gated dead-man) · S · contained
      — **Eval (DECIDED 2026-10-23):** `docs/eval/mobile-app.md` — iOS-first React Native (Expo) app: E2E-encrypted
        channel over the tentacle.so relay / Tailscale / cloudflared / own domain, per-computer QR pairing, E2E push
        + Live Activity in v1. 21 owner decisions; 19 tasks + TestFlight in 7 phases (decision 21). Task 0 DONE
        2026-10-23 (`feat/mobile-spike`, `docs/feat/mobile-spike.md`); task 1 (`feat/session-list`) executing;
        plans ready: 1, 8; planning: 4. Absorbs the open questions of 9. Type: eval → feat · Size: L → split · Blast: load-bearing
      — **Eval (deferred, low):** `docs/fix/reaper-gc-flaky-test.md` — test-only flake, at the end of v2

- [ ] **Skills support (Agent Skills, `SKILL.md`)** — packaged procedural
      guidance the model opts into (skills = *how to do it*; the result pipeline
      = *the guarantee the context stays clean*). Next on the roadmap. Owner
      decisions recorded 2026-10-20; promotion-ready.
      Split into 4 feats: skills-core → skills-compaction → skills-slash /
      skills-subagent. **Eval:** `docs/eval/agent-skills.md`. Type: eval →
      feat ×4 · Size: L → split · Blast: load-bearing.
      - [ ] **skills-subagent** (`agent_task{skill}`: the parent passes the name,
        the sub-agent loads it before its first round) — eval written 2026-10-21,
        owner decisions Q1–Q8 open: `docs/eval/skills-subagent.md`. Type: eval →
        feat · Size: S–M · Blast: load-bearing (model-facing schema).

- [ ] **No changelog discipline** (no `CHANGELOG.md`). **Eval:**
      `docs/eval/changelog-discipline.md`. Type: eval. Open.

- [ ] 🔵 **`/save` still exports the model's spill banner** (Review of
      `tui-spill-note`, 2026-10-25) — the export writes the raw tool content
      (`[large … output: …]` + preview); it could use the structured `spill`
      field like the TUI does. Decide whether an export should show what the
      model saw (today) or the user-facing note. S · contained.
- [ ] 🔵 **TUI: Fn+Delete (forward delete) deletes BACKWARD** (found in the
      `fix/tui-input-wrap-cursor` Review round 2, 2026-10-25; pre-existing) —
      Ink 5.0.1 reports `\x1b[3~` (Fn+Delete) like `\x7f` (Backspace), so the
      prompt deletes the character before the cursor; Alt+Fn+Delete
      (`\x1b[3;3~`) deletes the previous word instead of the next. Needs the
      raw sequence (Ink's `useInput` does not expose it) — check
      `docs/library-bugs.md` and Ink's parser first. S · contained.
- [ ] **Permission prompt: "No, let's talk about it"** (owner, 2026-10-24) — a
      third answer next to Yes / Yes, always / No: it opens a text field; the
      model gets the rejection TOGETHER with the user's text (e.g. "Rejected
      by the user: why do you need to delete build/? Try just bun run build
      first") and the turn CONTINUES — the agent answers or changes plan, and
      asks again if it still needs the tool. Unlike `Ctrl+X Ctrl+S` (stops the
      turn, sends the queue), the text answers that one request. Shape: an
      optional text on the permission answer (additive, no
      `PROTOCOL_VERSION` bump); the text leaves the laptop like every answer,
      so it holds for every target. Order: after send-now 4d, before the app's
      tasks (task 13's approvals inherit it). **Planned 2026-10-24** (slug
      `permission-reply`, awaiting the owner): re-sized M · load-bearing. **DONE 2026-11-04, merged `1ee6123`** (rebased onto main, record v8 shared with parallel task 5). A
      rejection already does not end the turn (it becomes the call's `tool`
      result and the model runs again — proved), so only the rejection's
      content changes. Wire: `permission_request.reply?: {maxChars}` (the
      DAEMON declares the request accepts a text — the client never guesses)
      and `session/resolve_permission.message?` (≤ 2000 chars, no control
      chars but `\n`/`\t`); no bump. Rejected: a new option kind (an older
      client could no longer parse the whole blocking update); sending text
      to an older daemon (it would drop the user's words silently).
      **APPROVED by the owner 2026-10-24:** the model sees today's rejection,
      then `The user replied:` + the text, then one guidance line; empty text
      + Enter = a plain No; **Shift+Tab while typing turns auto-accept on AND
      approves the request being answered** (owner's change; the draft moves
      to the main input with a notice, never lost); a request withdrawn while
      typing (send-now, cancel, another device) → the draft moves to the main
      input with a notice.
- [ ] **The model cannot ask the user a structured question** (owner, 2026-10-30):
      today it can only ask in plain text, which ends the turn. Proposal: an
      `ask_user` tool — one call carries 1–4 questions (short header, 2–4
      options with a description each, recommended first, single or multi
      choice, always a free-text "Other"); the TUI shows a form (one tab per
      question, ←/→ between questions, ↑/↓ choose, space toggles a multi choice,
      Enter confirm, Esc cancel, summary before send); the answers return as
      the tool result and the turn goes on. The tool description + system
      prompt teach when to use it (blocking decisions only; in planning, bundle
      independent questions into one form; always recommend; never ask what the
      model can verify itself). No one to answer (detached run, one-shot, a
      client that did not declare it) → immediate fallback result "no user:
      proceed with the recommended options and state your assumptions"
      (AGENTS §7 *blocking* update: declared + fallback). **Disableable, like
      every other tool, default enabled** — there is no per-tool disable today
      (`config/src/schema.ts` `tools` holds only output options), so the eval
      also decides a generic one (e.g. `tools.disabled: [names]`, per profile).
      Split: (1) tool + protocol + fallback + disable switch, (2) TUI form,
      (3) mobile app. Ties in with detach (a detached run takes the fallback).
      **Eval:** to write (`docs/eval/ask-user-tool.md`), after detach.
      Type: eval → feat · Size: L → split · Blast: load-bearing.

### Block 9 — open legacy plans (moved out of `docs/` root, 2026-10-17)

Pre-§10 docs with no TODO entry until now; not sized yet (size them when picked up).

- [ ] **Self-deleting injected binary on `attach`** (leave-no-trace on a
      user-owned pod). **Eval:** `docs/eval/pod-ephemeral-binary.md`. Type: eval.
- [ ] **React 18 → 19 + Ink 5 → 8** (want-driven, retires two workarounds).
      **Eval:** `docs/eval/react-19-migration.md`. Type: eval.

## Roadmap (ordered)

- [ ] **feat/tui-btw** (owner 2026-11-20: "magari domani ci lavoriamo"; after the
  stabilization week unless the owner makes an exception) — `/btw <question>` in
  the TUI: a side question answered from the current conversation WHILE a turn
  runs, never added to the session history. Shape (to verify in the plan): new
  request method `session/side_question` (added method: no `PROTOCOL_VERSION`
  bump) → daemon takes a snapshot of the session messages, ONE model call with
  no tools, streams the answer back (pods: through `ProxyModelProvider`, key
  stays on the laptop); TUI slash command + a dismissable answer panel, its
  state in a pure module. Concurrent with `session/prompt` (peer dispatch is
  concurrent by design). Not persisted. Phone parity (mobile `/btw`) = a
  separate sub-task. Was parked by option A in `docs/eval/subagent-live.md:76`
  — owner wants it anyway. Estimate ~half a day (Opus plan → DeepSeek exec →
  different-family review). Type: feat · Size: M · Blast: cross-module ·
  Suited: DeepSeek exec, Opus plan + review.

> **Owner queue (2026-10-25, updated 2026-10-26), next code tasks in this order:**
> 1. ~~task 7 `connect-sessions`~~ DONE, merged `6319beb` (2026-10-26; `docs/feat/connect-sessions.md`);
> 2. ~~`context-awareness`~~ DONE, merged `867a4d0` (2026-10-26; `docs/feat/context-awareness.md`; record v7);
> 3. `context-reset` (`docs/eval/context-reset.md`; re-planned 2026-10-26,
>    3 branches; owner answered CR-Q1/CR-Q2; takes record v8 if it needs one) —
>    slice 1 `feat/context-reset-refresh` DONE, merged `e58d8bf`; slice 2
>    `feat/context-reset-barrier` DONE (protocol v12), merged `031cb52`; slice 3
>    `feat/context-reset` DONE, merged `5fe4d20` (review MERGE; F1 `/compact`
>    resets the `model_request` hook baseline; `[context]` diagnostics). DEBT
>    (slice-2 review F1, owner 2026-10-26): after a `serve` crash right after
>    the barrier, a reloaded send-now answers the restart prompt while in
>    memory it is refused — mark the reset head in the record at the NEXT
>    record bump (permission-reply's v8). Unverified: a real reset under pod
>    `run`/`attach` and across a `serve` restart.
> 3b. skills hot-reload for the USER (`/name` list + `/skills` panel follow a
>    reset / new skill without restart) — DONE, merged `067cd49` (protocol v13; D1 owner-accepted; small debt in `docs/feat/skills-hot-reload.md`);
> 4b. **Detached runs** (**S1 `pod-daemon-resident` DONE, merged `9f17376` 2026-10-30, no tag**; **S2 `detached-relay` DONE, merged `e7620d7` 2026-10-31** (live 17/20, items 3, 8, 17 carried to S2b); **S2b + S4 `detached-relay-lifecycle` DONE, merged `4f0fc2f` 2026-10-31**; **S3 `detached-handover` DONE, merged `9ec10d1` 2026-10-31** ([task doc](docs/feat/detached-handover.md); fresh Opus Review + Opus fix + DeepSeek fix; live items 27–57 in the S2b checklist), then the owner's one hand-run live checklist; S5 `/detach` + `adopt` left;  release with protocol 14 after S3 — task doc [`docs/feat/detached-runs.md`](docs/feat/detached-runs.md)) (owner 2026-10-27, draft — eval [`docs/eval/detached-runs.md`](docs/eval/detached-runs.md) written, DR-1…DR-9 DECIDED by the owner 2026-10-27; still to verify: k8s exec survival; AFTER docker E). Leave a `run` working with no TUI and re-attach later. The model stays on the laptop (AGENTS §7), so a detached run needs a LAPTOP-SIDE background relay (keeps the `model/stream` proxy + the single permission broker + session persistence alive without Ink); it stops if the Mac sleeps/powers off.
>    - CLI: `tentacle run --detach` — open question: only in one-shot mode (prompt given on the command line) or also as "start interactive, detach later"? + `--auto-accept[=true|false]` to launch detached with auto-accept on (explicit opt-in; a detached run with auto-accept off would stall on the first permission — say so in the message).
>    - TUI: `/detach` — leaves the session running in the background relay and exits the TUI cleanly (pod/container kept). Requirement (owner 2026-11-06): after `/detach` the relay's auto-wake (fix/detached-autowake + fix/autowake-unbounded) must work on the handed-over session — pin it with a test.
>    - Re-attach: `tentacle attach <name>` (slice E resolves engine/location) reconnects the TUI to the relay; `tentacle ps` shows a DETACHED/ATTACHED state + last activity.
>    - To decide: relay lifetime (until the turn ends? until `rm`?), where its logs go (never the terminal), notifications on finish (mobile app task 17 later), what `--keep=false` means for a detached run (delete when the relay ends).
> **DONE 2026-11-02, merged `e9a1e30`:** mobile app task 8 `feat/e2e-channel` (Noise IK secure channel, `docs/feat/e2e-channel.md`) — 2 fix rounds, Hermes check passed on the iOS simulator (1 MiB frame ~0.8 s: task 11). Wanted debt: binary WS frames before the app ships.
> **DONE 2026-11-02, merged `0edf0be`:** `fix/detach-live` (`docs/fix/detach-live.md`, L · load-bearing) — 10 fix rounds, live re-run green + owner item 12 (lid) passed; gate on main after merge 4082/3/0, lint 0. **Follow-up `fix/detach-live-followups`** (S–M): Q8 marker for a turn cut mid-stream by a lone `/quit`; Q11 delete the Q6 aside files with the session/`rm`; Q12 per-file lock for the store guard window; Q13 a failed keep=true run also shows `not saved`; comment that R9 relies on the synchronous idle flush; `--model` flag on attach (Q-A1); drop the `RpcError:` prefix in the TUI error line; `↑0 ↓0`/ctx 0% after a failed turn; `rm` with several names; prune or hide `gone` rows in `ps`. Q9 (revision counter in the laptop record) rides `permission-reply`'s record bump; Q-B1/Q-B2 (keep partial text on Esc / close mid-stream) ride `feat/resume-after-model-loss`.
>
> **DONE 2026-11-04, merged `8570e25`:** `fix/detach-live-followups` (`docs/fix/detach-live-followups.md`) — the follow-ups above (Q8 closed with evidence → Q-B1; Q12 deferred) plus owner 2026-11-03: `--model`/`--profile` are flags ONLY of the session commands (`run`, `attach`, `serve`, bare `tentacle`), written after the command; empty `ps` prints only the header. 4 rounds (exec Opus ×2 + Sonnet ×2; reviews Opus ×3 + one quick check). Spec of the target behaviour: `docs/attach-detach-behaviour.md` (awaiting the owner's review).
> 4g. **Order agreed with the owner (2026-11-01):** (1) close detach — `fix/detach-live` (fix round, live re-run incl. owner item 12), release (protocol 14), S5 `/detach`, then the attach/detach/quit cases document (Italian, from the as-built code); (1b) `feat/resume-after-model-loss` (also **Q-N1**: a turn that fails before its first event must still be read back and saved on the laptop — today it is not, and a keep=true run then shows no `not saved`; the F6 test in `relay.test.ts` pins today's behaviour; owner 2026-11-02, after the lid live test: a model stream lost mid-reply — e.g. laptop sleep — pauses the turn, waits for the network (bounded), then continues keeping the partial text, no duplicates, with a visible "connection lost … resumed" note; the cut-and-show path of fix/detach-live round 10 stays the fallback); (2) `permission-reply` (item 6) together with **attachments sub-task 1** `feat/attachments-history` (`docs/eval/attachments.md`, plan of 2026-10-19 to refresh against today's main) — both bump the session record, so one bump or back-to-back; (2b) parallel execution tasks 5 `feat/round-groups-persistence` → 6 `feat/parallel-tools` → 7 `feat/parallel-agents` (owner 2026-11-02: right after permission-reply; 5 also bumps the session record, coordinate with (2)); (3) attachments sub-tasks 2–4 (store, prompt block, TUI paste/path); (4) mobile app task 9 onward. In parallel (disjoint files): mobile task 8 `feat/e2e-channel` (in review), UI mockups approved (`docs/eval/mobile-app.md`). App attachments stay after v1 (decision 11).
> 4c. **Session log format: JSON vs JSONL** (owner 2026-10-27; eval `docs/eval/session-log-format.md`, AFTER the shared record v8 of permission-reply + task 5 is merged). Today both stores rewrite the whole record per turn (temp file + rename, `agent/src/session-store.ts`); pi and Claude Code append one JSON line per message. Weigh: write cost growing with session size (largest local records ~600 KB), crash loses the whole in-flight turn vs only the last line, streaming tools (`tail -f`/`jq`), full history kept after compaction/context-reset (mobile "review everything"), versus today's simplicity (file = state, strict whole-record `schemaVersion`, in-place fields like title/archive/`pending[]`).
> 4d. **Docker live-test bugs** (owner's first `run --engine docker`, 2026-10-27; fix task `fix/pod-binary-staleness`, S–M): (1) a STALE prebuilt pod binary in `<configDir>/bin/tentacle-<target>` (22 Oct) was injected silently — every build says `0.1.0`, so neither `run` nor `attach`'s replace-older-tentacle notices; the old daemon died on `unknown option --context-window` → compare a build id (content hash / commit) not the version string; (2) that daemon stderr never reached the user: only `[container] failed: connection closed` (AGENTS §7 says buffered daemon stderr is flushed on the pre-mount failure path — it was not); (3) the `kept <name> — resume with …` line is printed TWICE — on failure AND on a normal Ctrl+C exit of `run` (owner repro: `tentacle run --engine docker --image node:22`, then Ctrl+C).
> 4e. **`ps`/`rm` follow-ups** (slice E review, 2026-10-27; S): (1) same name on the same engine in two locations (two k8s contexts/namespaces) → `rm` cannot pick one and wrongly suggests `--engine`; add `--context`/`--namespace` filters and print the exact command to re-run (`kept.ts:325`, `kept-cmd.ts:160`); (2) re-attaching to an indexed k8s cluster uses today's `TENTACLE_K8S_TOKEN`, possibly another cluster's (`engine-select.ts` `buildEngineHost`); (3) nit: no uid check between label re-read and delete (`kept-cmd.ts:210-215`); (4) OWNER QUESTION (recommend yes): should `ps` also scan local docker/podman for kept containers missing from the index (created before E or on another machine)?
> 4f. **CI on every push** (owner 2026-10-27; S): `.github/workflows/build.yml` runs only on `v*` tags, so nothing runs `bun run check` on push/PR — add a workflow (install with `--filter '!@tentacle/mobile'`, the three opt-in skips stay skipped), then add a "build passing" badge to the README.
> 4. `docker-runtime` (slice A `feat/docker-engine-client` DONE, merged `116d45f`; A2 `feat/docker-ssh-dialer` DONE, merged `1168217`; B `feat/docker-engine-seam` DONE (EngineHost); C `feat/docker-engine-cli` DONE (merged today: `--engine`, `engine:` user config/profiles/`TENTACLE_ENGINE`, podman socket, `--keep[=true|false]` + `keep:` config, DEFAULT TRUE (owner 2026-10-27)), then D `feat/docker-workspace-mount` (cwd bind-mount, masks, y/N gate, labels for E — DONE 2026-10-27, merged (commit `6d1fa2c`; 3 review rounds, case-insensitive file-mask refusal verified live); follow-up: a copy/sync workspace for a remote engine, owner M3), then E `tentacle ps` / `tentacle rm <name>` for kept containers/pods (owner 2026-10-27) — E `feat/engine-ps-rm` DONE 2026-10-27, merged (commit `904a6e9`; review MERGE, live-tested ps/rm on Docker Desktop) (laptop index, one file per workload; `attach <name>` resolves), awaiting the mandatory fresh-context Review ([`docs/feat/engine-ps-rm.md`](docs/feat/engine-ps-rm.md))) — `run`/`attach --engine kubernetes|docker|podman`, default configurable (owner 2026-10-26) (`docs/eval/docker-runtime.md`,
>    owner answers 2026-10-26; promote to `feat/` when picked; slices A
>    `packages/docker`, B neutral `SandboxHost` seam, `ssh://` dial-stdio, C CLI/docs);
   - FUSE name-filter for hidden files on case-insensitive filesystems (agent non-root; removes the refuse rule) — [`docs/feat/docker-workspace-mount.md`](docs/feat/docker-workspace-mount.md) (fix round 2).
> 5. default `maxIterations` = `-1` (agent and sub-agents);
> 6. `permission-reply` ("No, let's talk about it"; plan of 2026-10-24 to
>    refresh against today's main);
> 7. parallel tools and parallel sub-agents (`docs/eval/parallel-tools.md`,
>    `docs/eval/parallel-agents.md`; evaluate first).
>
> **DONE 2026-10-26, merged `cf66a70`:** `fix/musl-image-detect` — musl /
> loader-less / unsupported-arch images fail before the transfer with a clear
> message (k8s now, Docker later; `docs/fix/musl-image-detect.md`).
>
> **DONE 2026-10-26** (merged, `fix/agent-defs-warn`, by the local tentacle agent):
> ~~**Debt (found in context-awareness, 2026-10-26):**~~ `parseAgentDefinition`
> (`packages/agent/src/agent-defs.ts`) silently ignores an invalid `model` or
> `contextWindow` in a sub-agent's frontmatter — surface it (a load warning),
> never a silent drop. Type: fix · Size: S · Blast: contained.
> Then the mobile app tasks resume (task 8 onward, `docs/eval/mobile-app.md`).
>
> **Eval open (owner, 2026-10-26):** `docker-runtime` — `run`/`attach` on a
> local or remote Docker (Engine API `exec` over a hand-written HTTP/1.1
> upgrade, same JSON-RPC over another byte stream; `docs/eval/docker-runtime.md`).
> Owner questions answered; slotted as queue item 4 (after context-reset).
>
> **DONE 2026-10-26, merged `9511c0e`:** `fix/tool-duration` — Type: fix · Size: M · Blast:
> load-bearing (additive wire field + persisted `ChatMessage` format) ·
> Suited: Opus exec, fresh Opus review. A tool row rebuilt from history
> (`--resume`, reconnect, session switch, compaction replace) shows a fake
> `0.0s`: `messagesToItems` stamps `startedAt: 0`/`endedAt: 0`
> (`packages/tui/src/resume.ts:31,42`) and `toolLines` prints any defined
> `endedAt` (`render-lines.ts:489`). Repro: same `sleep 2` call → live
> `2.0s`, replayed `0.0s`. Owner decision (2026-10-26, option A): the daemon
> measures each tool call's duration and stores it on the tool `ChatMessage`
> as a metadata field like `spill` (never sent to the model: zero context
> cost), carried on the `tool_result` update; live AND replayed rows show it
> (also more exact over `connect`, where client receipt time adds network
> latency). A row whose duration is unknown (older records) shows NO time,
> never a fake `0.0s`. Plan must settle: record/store versioning for the new
> field (strict laptop parser), and sub-agent tool rows.
> **Status (2026-10-26):** plan approved and executed on `fix/tool-duration`
> — task doc `docs/fix/tool-duration.md`; `DAEMON_RECORD_VERSION` is now 6
> (context-awareness / permission-reply / parallel-tools renumber to 7+);
> fresh-context Review MERGE (APPROVE-WITH-NITS), gate 2789 / 2 / 0.

- [~] **F4 — Pod execution** (`run --image <ref> [--namespace <ns>] [<name>]`): run the agent inside a
      k8s pod (the sandbox), driven from the local TUI. Self-contained (no
      kubectl/oc — direct API via kubeconfig + the `v4.channel.k8s.io` exec WS)
      with a **reverse-tunnel for the model over the RPC channel** so the local
      endpoint/secret never leave the laptop. Reuses the whole client/daemon/RPC
      stack (new transport + lifecycle only). Full design + slice plan in
      `docs/architecture/F4-pod-execution.md`. MVP = F4.a–F4.e.
      - [~] **F4.e.2 — read-only-rootfs pods** (2026-10-16): a hardened pod
        (`readOnlyRootFilesystem`, e.g. coredns on OCP 4.22) broke injection
        twice. FIXED: (a) `--bin-dir <dir>` / `TENTACLE_POD_BIN_DIR` installs to
        a writable+exec dir (e.g. `/tmp`) instead of `/usr/local/bin`, exec'd by
        absolute path; (b) the pod daemon (`serve --stdio`) loads config with
        `scaffold:false` — it no longer `mkdir`s `~/.config` (was `EROFS` →
        daemon dies → client sees "connection closed").
        **OPEN 🔵 residual (fully read-only pods):** `spillLargeOutput` writes a
        large tool result to `<cwd>/.tentacle/tool-output/` (`agent/agent.ts`);
        on a read-only pod cwd this write fails. Only triggers on big output (not
        startup), so attach/run work, but a tool with huge output would error.
        Fix options: make the spill best-effort (skip + keep inline on write
        failure), or spill to a writable dir (`/tmp`, or the `--bin-dir` dir).
        Not yet done. **Audit 2026-10-19 — to verify with a repro:** the code
        already looks best-effort (`agent/src/agent.ts:474-480` catches the write
        and returns `null`; `result-pipeline.ts:74-77` keeps a preview + "could
        not be saved"), so the residual may only be "full output lost", not an
        error.
- [ ] **AGENTS.md auto-load — folder-trust gate** (follow-up to the above): v1
      loads a discovered repo's `AGENTS.md` into the prompt UNCONDITIONALLY — a
      prompt-injection surface if tentacle is launched in an untrusted/cloned repo
      (that file becomes instructions for a shell+`fs_edit` agent). The `.git`
      boundary stops *parent*-repo inheritance but not a malicious repo-root file.
      Add a first-run "trust this folder's AGENTS.md?" gate (remembered per path).
      Deferred by the owner when autoload shipped; fine for today's single-user
      trusted-repo use. Type: fix · Size: M · Blast: load-bearing · Suited: strong
      model + mandatory fresh-context review.
- [ ] **Subagents don't receive AGENTS.md** (follow-up to the above): the autoload
      primes only the MAIN session; a spawned subagent (the `agent_task` tool) still
      starts from its agent-definition body (`agent-defs.ts` → `prompt`), not the
      repo rules. Defensible — subagents are handed the executor/reviewer briefs,
      which order reading AGENTS.md — but undocumented, and it partly undercuts the
      weak-model motivation. Decide: inject AGENTS.md into subagent prompts too, or
      document that the briefs are the channel. Type: eval · Size: S · Blast:
      cross-module.

## Result-pipeline transforms

Built on the `ResultTransform[]` pipeline (`packages/agent/src/result-pipeline.ts`),
wired in order: redact → dedup → tabulate → (summarize | spill).

## Context budget (ties in with `/compact`)

- [ ] **Budget-aware spill** — lower the spill threshold as the context meter fills.
- [ ] **Auto-compact** — compact automatically above a fill threshold (manual
      `/compact` already exists).

## Output / file handling

- [ ] **File-handle registry** — hand the model handles (e.g. `#out1`) instead of
      raw paths, expandable via a dedicated `read_output(handle, grep|offset)` tool.
- [ ] **Anchors / citations** — include the line range in a spilled file's preview
      so the model can `fs_read offset/limit` precisely.

## Targeted guidance (not system-prompt bloat)

- [ ] **One-shot contextual hints** — a short note only the first time a tool
      exceeds a threshold, not every turn.

## Earlier deferrals (from prior slices)

- [ ] **MCP — full compatibility across both protocol eras** (2026-07-28 + legacy):
      reconnect & safe re-issue, tool-set change notifications, result content,
      warnings + version in `/mcp`, elicitation, OAuth — six tasks, in order.
      **Eval:** `docs/eval/mcp-full-compat.md` (owner-approved split; deprecated
      Sampling/Roots/Logging/HTTP+SSE excluded by decision). Transport + dual-era
      client: `docs/feat/mcp-remote-transport.md`.
- [ ] **MCP**: resources & prompts; MCP in the `serve` daemon; `headersCommand`
      (secret headers off the config file).
- [ ] **Sub-agents**: background / parallel execution (SA.d).
      **Eval:** `docs/eval/parallel-subagents.md` (open — leans background-first, must split; needs a use-case).
- [ ] **Parallel tool calls within a round** (today strictly sequential,
      `agent.ts:304`; pi, Claude Code and opencode all run them in parallel).
      **Eval:** `docs/eval/parallel-tool-calls.md` (**DEFER**, 2026-10-19: design
      ready — consecutive `shared` batches, serial prompts then concurrent run —
      but on 53 Qwen sessions only 4.3% of calls would go parallel, all
      ms-scale `fs_read`. Promote on: parallel sub-agents approved, a frontier
      model as regular driver, or network MCP becoming common).
      Type: eval → feat · Size: M · Blast: load-bearing.
- [ ] **F2**: container execution environment (behind the existing
      `ExecutionEnvironment` contract).
- [ ] **Remote control (F3)**: heartbeat/idle-timeout/reconnect, multi-client
      observers, `config.jsonc` `remote` block, operator docs. **Superseded**
      (heartbeat, reconnect, multi-client) by the protocol-v2 redesign
      `docs/eval/session-reattach.md` (children `session-ttl-limits`,
      `session-registry`, `client-reattach`); the `remote` config block and
      operator docs remain.
- [ ] Add `.tentacle/` to the workspace `.gitignore` guidance (spilled output).

## Branding

- [ ] **Startup pixel mascot in the TUI** (`feat/tui-mascot`): half-block
      banner beside the welcome text; design + palette prototyped in
      `docs/feat/mascot.md` (Context). Type: feat · Size: S · Blast: contained.
- [ ] **Mascot follow-ups**: dark-mode README variant (`<picture>`), small-size
      icon (16–32 px). See
      `docs/feat/mascot.md` (Review).
- [ ] **eval/app-store-release** (owner 2026-11-16) — what an App Store release of the iPhone app needs: Apple Developer account (personal vs company), App Store Connect record, EU DSA trader status, distribution cert/profile, production APNs (relay + PushCore), PrivacyInfo.xcprivacy, usage strings, TestFlight, listing (icon, screenshots, privacy-policy + support URL on tentacle.so, nutrition labels, export compliance), and the review blocker: a reviewer-reachable demo serve or demo mode (guideline 2.1).

## Quarantined e2e flows

- [ ] e2e flow `22-notify-approve` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-deny` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-reply` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `22-notify-forged` is quarantined: its injected notification response is read by DEV builds only (Owner Q7) and the gate runs the Release build; re-enable with a dev-build lane for the notify flows (or drive the action on a device).
- [ ] e2e flow `push-placeholder` is quarantined: Maestro does not see SpringBoard notification banners on the iOS 26 simulator (a plain `simctl push` banner was not found during a 20 s wait), so the banner step cannot be asserted; re-enable when Maestro can read banners (or assert the presentation another way).
- [ ] e2e flow `22-notify-render` is quarantined: Maestro does not see SpringBoard notification banners on the iOS 26 simulator (a plain `simctl push` banner was not found during a 20 s wait), so the banner step cannot be asserted; re-enable when Maestro can read banners (or assert the presentation another way).
- [ ] e2e flow `19-lock-unlock-button` is quarantined: on the simulator a resume auto-prompts Face ID over the Unlock button (by design) and a nomatch cannot be scripted, so the button cannot be driven; re-enable when a failed/cancelled evaluation can be scripted (or drive it on a device). Logic covered by `app-lock.test.ts`.
