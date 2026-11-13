# Changelog

All notable user-visible changes to tentacle are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Internal and test-only
changes are left out; the git history and the task docs under `docs/` have
those.

## [Unreleased]

### Added

- **Drag a photo into the TUI — or type `/attach <path>` — and the model sees it.** A pasted image path (or several) becomes a chip row in the input box; Enter uploads each image's bytes through the session and sends the prompt naming their refs, so an image-only prompt is a real turn. The transcript shows `[image: name]` for your own prompt, for another device's (`turn_start.attachments`), and after `--resume`. Every refusal is a visible sentence with nothing sent and nothing lost: a HEIC or an oversized file, images off on this daemon, a turn already running (the draft is kept, never queued), an upload that fails (the text and chips come back — Esc cancels an upload), or a daemon that no longer holds the bytes (the bubble is withdrawn and Enter uploads again). Backspace on an empty input removes the last chip; `/retry` re-sends the text only and says so.
- **A prompt can now name an image, and it is resolved wherever the model actually runs.** `session/prompt` accepts `{ type: "attachment", ref }` blocks, so an image-only prompt is a real turn (no empty text block to work around) and a text-plus-image prompt is one message. Which side holds the bytes — the rule the whole feature turns on — is decided by who runs the provider, and the daemon now says which case applies: `initialize` advertises `agentCapabilities.images` as `{ input: "upload", maxBytes }` when the daemon runs the model (the client uploads by `attachment/put`, then names the ref) or `{ input: "client" }` when the laptop holds it (a pod with `--model-proxy`: the bytes stay on the laptop and only the ref crosses, so a pod never receives image bytes). A daemon whose model has no vision advertises nothing, and a client then refuses the attach before uploading. Every refusal is structured (`AttachmentRefused` with `images_off`, `invalid_ref` or `not_uploaded`) and happens before anything is recorded, so a refused prompt starts no turn and the same `turnId` is still usable once the image is uploaded. On the laptop side `RemoteClient` gained `imageInput()`, `attachImage()` (an upload, or bytes held in a bounded 100 MiB in-memory store that never evicts) and `prompt(…, attachments)`, whose refs ride every keyed re-send after a drop under the same `turnId`. The laptop attaches its own scoped source at all three model-serving casts (`model/stream`, `model/streamChunked`, `model/countTokens`), so a pod can name only ids the laptop itself added — anything else becomes a visible placeholder, never a read. New config: `model.images` (and `models.*.images`), with the effective value coming from one `imageLimits()` so the advertised capability can never disagree with what the provider does; `model.images: true` opts an OpenAI-compatible endpoint in. No interface sends an image yet — the attaching UI is the next task.
- **An image's bytes can now reach the daemon that holds the provider (the transfer the attaching UI will use; still nothing in the interface sends one).** The foundation moved the refs; this moves the bytes, chunk by chunk and resumably. A new `attachment/put` sends one 256 KiB chunk per request and answers with `have` — the contiguous bytes the daemon holds from zero — so an interrupted upload resumes where it stopped instead of starting over (a dropped link costs at most two chunks), the same image re-attached is deduped by answering its first probe with `complete` at once, a duplicated or out-of-order chunk is acknowledged and ignored rather than written twice, and the whole blob is verified against its sha256 daemon-side before a byte becomes readable. The daemon keeps it in a per-session, content-addressed, in-memory store bounded at 100 MiB a session and 256 MiB a daemon: a begun upload pays for its declared size immediately, so a peer that announces 15 MB and sends nothing cannot exhaust memory, and a full store refuses new uploads loudly (`store_full`) instead of evicting an image a message already refers to — only a partial left untouched for 10 minutes is dropped, and only when a new upload needs the room. The bytes belong to the session, not the connection, so a `serve` client that detaches and re-attaches resumes; closing or deleting a session returns every reserved byte. The laptop sends in a window of two chunks (the measured sweet spot for the control messages that share the link), never reads a path or a file the daemon names, and treats a daemon that answers `have` past the blob, `complete` before it, or `have: 0` forever as broken: it stops with an error after a bounded number of bytes rather than sending forever. A daemon too old to have the method answers `MethodNotFound`, which the client reports as a clear "this daemon cannot receive images — update tentacle". Both method and error are additive on the wire: no `PROTOCOL_VERSION` change. Custom clients can branch on the new error code `-32016` (`AttachmentRefused`, with `data.reason` one of `too_large`, `store_full`, `hash_mismatch`, `bad_chunk`), now in the published protocol schema.
- **A path dragged into the terminal is recognised for what it is — an image candidate, or prose.** Terminals have no "file dropped" event: macOS Terminal sends `/Users/me/Shot\ 1.png`, iTerm2/Ghostty wrap it in quotes, kitty/VS Code send `file:///…%20…`, and several files may arrive at once. The TUI now has the pure layer that reads those forms (`~` and `./` included): a paste whose *every* token is a path becomes attachment candidates, while a path inside a sentence stays text — the user may be talking about a workspace file. The image type comes from the file's **bytes**, never its extension, so a PNG mislabelled `.heic` is a PNG and a renamed download is not one; PNG, JPEG, GIF and WebP are accepted, HEIC/HEIF is recognised and refused with a way out (`export it as PNG or JPEG first (macOS: sips -s format png …)`) rather than a bare "not an image", and every other file says it is not a PNG/JPEG/GIF/WebP. The limits are the wire's own (15 MB per image, 5 per message): a missing file, a directory, an unreadable file, an empty one, one over the cap and the sixth image each get a sentence naming the file and the limit, and nothing is ever attached silently or half-attached. File access goes through one injected seam, so the whole layer is tested without touching the disk. The UI wiring — chips in the input, `/attach`, upload — is the next task; nothing sends an attachment yet.

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
