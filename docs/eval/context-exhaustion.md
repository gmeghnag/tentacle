# eval/context-exhaustion — tell "context full" from "output limit", and recover instead of re-asking

> **Status:** context · review (verdict proposed; awaiting the owner — to read 2026-11-28)
> **Branch:** none (an `eval`, committed to `main`, AGENTS §10)
> Type: eval · Size: L (split below into S/M slices, no XL) · Blast: load-bearing (agent loop request assembly + its recovery path, provider request shape, one new display update kind) · Suited: Opus plans and executes the loop slices, fresh-context Opus review; contained slices may go to a weaker model

## Sintesi (IT)

*— claude-opus-5-5, 2026-11-28*

Ieri sera (27/11, sessione FINANZA su Qwen locale) l'app ha mostrato due volte
«the model returned nothing: it hit its output limit…». **Non era il limite di
output**: in 23–24 s Qwen genera ~1 000 token, non 32 768. Era il **contesto
pieno**: tentacle manda sempre `max_tokens: 32768` senza togliere quanto
contesto è già occupato, llama-server si ferma quando la finestra è piena e
risponde `finish_reason: length` — lo stesso segnale del limite di output. Oggi
tentacle non distingue i due casi, e reagisce sempre chiedendo al modello di
«continuare», che con il contesto pieno non può funzionare (il «retry failed»).
In più non esiste compattazione automatica: `needsCompaction` non ha chiamanti,
la potatura (`contextPrune`) è spenta di default, e `/compact` manda l'intera
conversazione in UNA chiamata al modello — cioè fallisce proprio quando serve.

**Proposta (un design pattern unico):** un *pianificatore del budget di
contesto* puro, in `core`, che prima di ogni richiesta calcola quanto spazio
c'è davvero e dopo ogni risposta **classifica** perché si è fermata
(`output_limit` · `context_full` · `stream_cut` · `empty`). Il ciclo
dell'agente ha **una sola scala di recupero** per `context_full`: potatura
senza perdite → compattazione automatica (a pezzi, che ci sta sempre) →
riprova il round una volta → se ancora pieno, fallisce con un avviso chiaro e
un'azione. «Continua» resta solo per il vero limite di output. Gli avvisi
diventano un aggiornamento **tipizzato** (causa, azione fatta, esito, numeri),
reso uguale su Mac e telefono — la base per la UI degli avvisi (NA) che
faremo dopo. Sotto: cosa vede l'utente caso per caso, i rischi, le 5 domande.

## Context

*— claude-opus-5-5, 2026-11-28*

### The question

When a model round stops for lack of room, what should tentacle detect,
what should it do, and what should the user see — on every runtime (TUI,
phone, pod) and every provider (OpenAI-compatible local servers, Anthropic)?
The owner asked for an architectural fix, not a patch, to land **before** the
notice UI (`docs/eval/…` mockups `.tentacle/mockups/bg-job-rows/`, variant NA),
so that UI renders causes that are true.

### Evidence

- **Owner screenshots, 27/11 23:47** (`.tentacle/mockups/bg-job-rows/ref/notice-warning.png`):
  after «Stai a tappo col contesto, resettati e vai avanti», `Thought · 24 s` →
  «the model returned nothing: it hit its output limit, and was cut again when
  asked to continue — nothing was produced», then `Thought · 23 s` → «…hit its
  output limit before writing anything».
- **Arithmetic:** Qwen3.8-27B Q6 on the owner's server generates tens of tokens
  per second; 24 s of reasoning is ~10³ tokens, not the 32 768 `maxTokens`
  (`~/.config/tentacle/config.jsonc`, profile `gab`). So `finish_reason: length`
  came from the **server's context window filling up**, not from `max_tokens`.
  (Inference, not a measurement of that request's `usage`: the next cheap check
  is the session log's last `usage` before those rounds.)
- **Server window ≠ configured window:** `GET /props` on the owner's llama-server
  (28/11 01:40): `n_ctx = 130048`, 1 slot. Config says `contextWindow: 115000`.
  The model is told its fill percentage against 115k (context-awareness line),
  the server cuts at 130k; neither number is what tentacle uses to size a request.
- **Device log 27/11** (owner export): turns ending `outcome=interrupted` /
  `lost` after long stalls in the same session — consistent with rounds that
  never complete near the top of the window.

### What the code does today (verified)

| Fact | Where |
|---|---|
| `max_tokens` is the configured `maxTokens`, unconditionally; never reduced by the prompt size | `packages/providers/src/openai-provider.ts:580-582` |
| `finish_reason` is normalised to `stop` / `length` / `tool_calls` / `other`; `length` has ONE meaning downstream | `openai-provider.ts:431-475` |
| `length` with no tool call → `truncated_reply{reason:"length", retrying}` and ONE re-ask «continue» (`MAX_TRUNCATION_REASKS = 1`) | `packages/agent/src/agent.ts:1835-1845`, `:278` |
| `length` with a tool call → refused, `ModelStreamCutError("cut-tool-call")` | `agent.ts:1821-1829` |
| No stop reason → `truncated_reply{reason:"cut"}` + turn fails | `agent.ts:1807-1814` |
| Empty rounds → bounded nudges (`MAX_EMPTY_CONTINUES = 2`) then `empty_turn` | `agent.ts:266`, event union `:597-600` |
| The notice text is built from the reason alone («output limit»); no cause is known | `packages/core/src/truncation.ts:41-58` |
| A server that REFUSES an over-long prompt (HTTP 400 / in-band `error`) becomes a generic `ModelRequestError` / `ModelServerError` → «turn failed» with the raw body | `openai-provider.ts:78-108`, `:352-359`; `packages/tui/src/model-error.ts:47` |
| `ContextManager.needsCompaction` exists and has **no caller** | `packages/core/src/context.ts:75-91` (the only hits) |
| Lossless pruning exists but is **off** by default (`contextPrune.enabled = false`, at 60 %) | `packages/config/src/defaults.ts:75-83`, `docs/feat/smart-compaction.md` (S4 A/B never run) |
| The model can renew its own context (`context_reset`, on) and is told its fill % (context awareness, on) — both depend on the model choosing to act | `defaults.ts:69-73`, `docs/feat/context-reset.md`, `docs/feat/context-awareness.md` |
| Prompt size is already known precisely: the last `usage.promptTokens` anchored to the history + a counted delta for what was appended since | `packages/agent/src/context-awareness.ts:19-23`, `:156`; anchors set at `agent.ts:2178-2179` |
| `/compact` summarises the WHOLE rendered transcript in one model call — it cannot fit when the conversation no longer fits | `packages/agent/src/compact.ts:108` (`summarizeConversation`) |

### The load-bearing assumption (to prove first)

**A `length` stop can be attributed to the context window from data the loop
already has**: `promptTokens` (anchor) + `completionTokens` of that round vs.
the effective window. If `prompt + completion ≥ window − margin` and
`completion < maxTokens`, it was the window; if `completion ≥ maxTokens`, it was
the output limit. Cheap test (slice 1): replay the owner's session log's last
`usage` before the two empty rounds and check the inequality; plus a fake
OpenAI server that stops at `n_ctx` (the repro shape of
`docs/fix/truncated-reply-silent.md`). If llama-server does not report `usage`
on a `length` stop, the fallback is the counted prompt (`context-awareness.ts:156`)
— measure both.

## Implementation (proposed design — the eval's answer)

*— claude-opus-5-5, 2026-11-28*

### The pattern: one pure context-budget planner, one classifier, one recovery ladder, one typed notice

1. **`ContextBudget` planner (pure, `packages/core/src/context-budget.ts`).**
   Input: effective window, configured `maxTokens`, the anchored prompt size,
   a safety margin, the reasoning floor (the output a round needs to be useful).
   Output per request: `maxTokens = min(configured, window − prompt − margin)`
   and a pressure level `ok | tight | full` (`full` = the clamp would leave less
   than the floor). No I/O, unit-tested with tables. This is what
   `ContextManager` was meant to be; it replaces it (one source of truth).
2. **Effective window = what the server really has.** Start from the config;
   learn the server's real size once per connection where it is cheap
   (llama.cpp `/props` `n_ctx`, vLLM `/v1/models` `max_model_len`; Anthropic:
   the model's documented window) and from the first `context_full` the server
   proves. Use the **smaller** of config and server; surface a mismatch once
   (115k configured vs 130k served today is harmless; the 26/11 incident in
   `truncation.ts:38` — a slot `n_ctx` far below config — is the dangerous one).
3. **`classifyStop` (pure, same module).** Every round's end becomes one of
   `completed · output_limit · context_full · stream_cut · empty · server_refused_context`
   from `(stopReason, usage, budget, error)`. HTTP 400 / in-band errors whose
   body says the prompt exceeds the context (llama.cpp «exceeds the available
   context size», OpenAI `context_length_exceeded`, Anthropic `prompt is too
   long`) map to `context_full` instead of a raw «turn failed». The loop and
   every frontend read the class, never the raw reason.
4. **One recovery ladder in the loop (`agent.ts`), per class:**
   - `output_limit` → today's behaviour (keep the text, re-ask «continue» once).
   - `context_full` (or pre-flight `full`) → **never «continue»**. Step 1:
     lossless prune (`contextPrune`, already built). Step 2: automatic
     compaction. Step 3: retry the same round once on the smaller history.
     Still `full` → end the turn with an honest notice and the action left to
     the user. Each step emits what it did.
   - `stream_cut`, `empty` → unchanged (fail / bounded nudges).
   - **Pre-flight:** when the planner says `full` BEFORE sending, run the ladder
     first instead of spending a round that cannot succeed.
5. **Compaction that always fits (`compact.ts`).** Summarise in bounded chunks:
   the oldest segment that fits the summariser's own budget, rolling, keeping
   the last N rounds verbatim (the prune's `keepRecentRounds` idea) — so the
   summary call itself can never overflow. Same output shape as today
   (`compactedHistory`, skills carried over), so persistence and the daemon's
   epoch/barrier rules are untouched.
6. **One typed notice (`turn_notice`, protocol display update).**
   `{ cause, action, outcome, numbers }` — e.g. `{cause:"context_full",
   action:"compacted", outcome:"retrying", before:126k, after:14k}`. Display
   class (free to add, AGENTS §7 forward compat: an older client shows
   `unsupported` once). It supersedes building strings from `truncated_reply`;
   the short and the full text come from ONE pure `describeNotice` shared by
   TUI and mobile (today each side has its own words). This is exactly what the
   NA notice UI will render — that UI is a later task (owner: fix first).

Why this shape: the decision (how much room, why it stopped, what to do) moves
out of string-building and scattered branches into two pure, table-tested
functions (AGENTS §7 «logic lives in pure modules»), and the loop keeps ONE
recovery path instead of three partial ones (re-ask, model-driven
`context_reset`, manual `/compact`).

### What the user sees (TUI and phone, same words — NA glyphs)

| Case | Today | Proposed |
|---|---|---|
| Real output limit, continuation works | «the reply was cut at the model's output limit; asking it to continue» | `ⓘ Reply cut · output limit — continuing`, then the reply goes on |
| Real output limit twice | «…asked it to continue, cut again; this answer is incomplete» | `ⓘ Reply cut · output limit, retry failed` (full text on tap) |
| Context nearly full, pruning is enough | nothing; the next round fails later | `◌ Context trimmed · 118k → 92k tokens` (quiet info node), the turn goes on |
| Context full, auto-compaction | «the model returned nothing: it hit its output limit…» ×2, turn dies | `◌ Context compacted · 126k → 14k tokens` (summary on tap), then the same round runs again — the user sees Thinking continue |
| Context full, compaction could not save it | same as above | `ⓘ Context full · couldn't make room` + action on tap: `/compact`, `/clear`, or a model with a larger window |
| Server's window smaller than config | silent until something breaks | once per session: `◌ Server context is 32k (config says 115k) · using 32k` |
| Server refused an over-long prompt (HTTP 400) | «turn failed: model request failed with status 400: …» | treated as `context_full` → the ladder above |
| Stream cut | «the model's stream was cut…» + turn failed | `ⓘ Stream cut · turn failed` (unchanged semantics) |

The fill meter (TUI status bar, phone header) uses the **effective** window, so
«92 %» means the same thing the server enforces.

### Files (dependency order; each slice its own `feat/` task)

| # | Slice | Size · Blast | Files |
|---|---|---|---|
| 1 | Planner + classifier (pure) + the load-bearing proof | S · contained | `packages/core/src/context-budget.ts` (new), `packages/core/test/context-budget.test.ts`; retire `ContextManager` (`core/src/context.ts`) |
| 2 | Clamp `max_tokens`; classify `length`/400/in-band overflow as `context_full`; learn the effective window | M · load-bearing (provider request shape + error mapping) | `packages/providers/src/openai-provider.ts`, `anthropic-provider.ts`, `packages/agent/src/agent.ts` (request assembly), `packages/config/src/resolve.ts` (effective window), tests with a fake server that stops at `n_ctx` |
| 3 | Bounded compaction (chunked, rolling, keep recent) | M · cross-module | `packages/agent/src/compact.ts`, its tests; `hosted-session.ts` only if the summary shape changes (it should not) |
| 4 | Recovery ladder + pre-flight in the loop | M · load-bearing (agent loop) | `packages/agent/src/agent.ts`, `packages/core/src/truncation.ts` (absorbed), tests for every class × step × outcome |
| 5 | `turn_notice` typed update + shared `describeNotice` | M · cross-module (protocol display kind) | `packages/protocol/src/updates.ts` (+ `UPDATE_CLASS` display), `packages/client/src/mapping.ts`, `packages/tui/src/…` (render the existing notice row from it), `apps/mobile/src/transcript.ts` (same) — rendering stays today's style; NA comes later |

### Failure modes

- **No `usage` on a `length` stop** (some servers): fall back to the counted
  prompt; if both are missing, classify `output_limit` (today's behaviour —
  never worse than now).
- **Auto-compaction loses something the user needed:** prune first (lossless),
  compact only on `full`; the summary is shown on tap; superseded history is
  kept when `sessions.keepSuperseded` is on (AGENTS §7 persistence rule
  unchanged — a compaction is already a persisted epoch).
- **Ladder loops:** bounded — one prune, one compaction, one retry per turn;
  the outcome is always emitted.
- **Compaction during a pod session:** the summariser call goes through the
  same `model/stream` reverse tunnel; no new pod capability, keys stay on the
  laptop (AGENTS §7).
- **A model's own `context_reset` racing the ladder:** both hold the busy slot
  / epoch barrier already (`hosted-session.ts:18-37`); the ladder runs inside
  the turn, before the round, never concurrently.
- **Version skew:** `turn_notice` is display-class; an older client shows
  `unsupported` once and keeps working (AGENTS §7 forward compat). No
  `PROTOCOL_VERSION` bump needed unless slice 5 changes an existing kind.
- **Prompt-cache cost (Anthropic):** compaction invalidates the cached prefix
  — acceptable only at `full`, which is exactly where the round fails today.

### Alternatives rejected

- **Only fix the wording** («context full» vs «output limit»): honest, but the
  turn still dies; the owner asked for the architecture.
- **Always clamp, never compact:** the clamp alone shrinks the reply to
  nothing as the window fills — it converts one failure into another.
- **Rely on the model (`context_reset` + awareness line):** it already exists
  and did not trigger on 27/11 (the model kept reasoning until cut); a local
  27B model cannot be the only safety net.
- **Raise `maxTokens` / `contextWindow` in config:** the server's `n_ctx` is the
  hard wall; config numbers do not move it.

### Owner questions (each with a recommendation)

1. **Automatic compaction on by default?** Recommend **yes**, only on
   `context_full` / pre-flight `full`, after a lossless prune; `/compact` stays.
2. **Turn `contextPrune` on by default** (the S4 A/B of smart-compaction never
   ran)? Recommend **yes as step 1 of the ladder only** (prune on pressure, not
   at 60 % on every request) — no behaviour change below the threshold.
3. **Effective window: adopt the server's smaller `n_ctx` automatically?**
   Recommend **yes**, with one notice per session and a `tentacle doctor` line.
4. **Margin and floor:** recommend margin 2 % of the window, floor 4 096 tokens
   (enough for one reasoning round + a short answer on Qwen); configurable later
   only if needed.
5. **Persist the notices?** Recommend: persist the ones that explain a history
   change (compaction, prune — they already are epochs), not transient ones
   (output limit continuing).

## Execution

*(empty — an `eval`; filled by each promoted slice's own doc)*

## Review

*— claude-opus-5-5, 2026-11-28* — **proposed verdict: APPROVE the pattern; start
with slice 1 (proves the load-bearing assumption on the owner's real session
log) and slice 2.** The notice UI (NA, `.tentacle/mockups/bg-job-rows/`) follows
slice 5. Pending the owner's reading.
