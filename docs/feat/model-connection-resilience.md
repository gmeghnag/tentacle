# feat/model-connection-resilience — Resilienza della connessione al modello (retry + diagnostica)

> **Status:** context · implementation (approvata 2026-10-21, D1–D3 inclusi) · execution · review (APPROVE-WITH-NITS, nit corretti) · **done — in attesa di commit**
> **Branch:** `feat/model-connection-resilience` (promosso da `docs/eval/` il 2026-10-21)
> **Size:** M · **Blast:** load-bearing · **Suited:** modello forte esegue, Review in contesto fresco obbligatoria (avvolge il seam `ModelProvider` da cui passa ogni chiamata al modello, §7)

## Context

*— claude-opus-4-8, 2026-10-17*

> *Line cites in `openai-provider.ts` refreshed after the anthropic-api-support
> merge (`a4cb875`) shifted them; content unchanged. — claude-opus-5-5, 2026-10-17*
>
> *Alla promozione (2026-10-21) le cite qui sotto sono di nuovo slittate; quelle
> valide sono nella sezione Implementation. Corrispondenze: `agent.ts:213/214/233`
> → `:400/:401/:420`; `agent.ts:211-222` → `:398-419`; `agent.ts:321` → `:532`
> (il report finale al limite di step); `openai-provider.ts:127/129/136` → `:131/:133/:142`;
> `App.tsx:436`/`commands.ts:18` → `commands.ts:31/:119`. Contenuto invariato.
> — claude-opus-5-5, 2026-10-21*

### La domanda da decidere

Quando la connessione HTTP al modello cade (es. `ECONNRESET`), tentacle deve
**ritentare automaticamente**, o deve restare il comportamento attuale (l'errore
uccide il turno e l'unico recupero è `/retry` a mano)? E se ritenta: **con quali
regole**, dato che un retry cieco può duplicare lavoro o corrompere un turno?

Decisione collegata: la diagnostica attuale di questi errori è troppo povera per
capirli senza i log del server — va migliorata nello stesso intervento?

### Evidenza (due incidenti del 2026-10-17)

**Incidente A — turno principale:**

- `~/.config/tentacle/logs/daemon-errors.log`, ore 17:24:48 UTC:
  `ECONNRESET: The socket connection was closed unexpectedly` — `(no stack)`.
- Log di llama-server (`podman logs llamacpp`, server a `192.168.1.17:8080`)
  attorno all'istante: l'ultima risposta si chiude normalmente alle 19:24:48.207
  (ora locale), l'errore lato tentacle è 166 ms dopo, e **fino alle 19:25:03 il
  server non riceve nessuna nuova richiesta**. Container su dalle 14:50, 0
  riavvii, nessun OOM. → **La richiesta fallita non è mai arrivata al server:**
  la connessione è caduta mentre tentacle stava per inviarla.
- Ipotesi di rete scartate con test empirici su `/health` (endpoint gratuito,
  nessun costo per il modello):
  - *timeout di inattività 5s* (`Keep-Alive: timeout=5` del server): 36/36 ok con
    pause 4,5–6 s → il pool di socket di Bun non è il colpevole.
  - *limite 100 richieste per connessione* (`max=100`, il server manda
    `Connection: close` ogni 100): 350 richieste, 0 errori → Bun gestisce bene.
  - Resta un `ECONNRESET` **transitorio e raro** lato invio, non riproducibile a
    comando. Pista non provata, coerente con l'incidente: il provider esce dal
    ciclo SSE appena legge `[DONE]` (`openai-provider.ts:136`) senza drenare né
    annullare il resto del corpo, quindi un socket non "pulito" può tornare nel
    pool. **Non dimostrata** — servirebbero decine di richieste in streaming al
    modello vero, che oggi rallenterebbero gli altri agenti (slot singolo).

**Incidente B — sub-agent (poche ore dopo):** durante la review adversarial
in contesto fresco del feat Anthropic, un `agent_task` è fallito dopo 73,6 s con
`tool agent_task failed: TypeError: ECONNRESET: The socket connection was closed
unexpectedly`. Stesso errore grezzo (`TypeError` da `fetch`, non un
`ModelRequestError`). Qui è caduto il **percorso del sub-agent**: il child
costruisce `new Agent({ model, … })` (`subagent.ts:162`) e gira `child.run(…)`
(`:175`), cioè lo **stesso** `model.stream` (`agent.ts:214`/`:321`) con lo stesso
retry mancante. → Due occorrenze in un giorno, non un caso isolato; e la seconda
conferma che il seam del retry (a livello provider/stream) copre **padre e
figlio insieme**, senza lavoro separato.

### Stato attuale del codice (verificato)

- **Nessun retry, da nessuna parte.** `rg -ni "retry|backoff|reattempt|reconnect"`
  su `packages/**` (esclusi i test) trova solo: `/retry` **manuale** nella TUI
  (`App.tsx:436`, `commands.ts:18` — ri-manda l'ultimo prompt quando l'utente lo
  digita) e il `reconnect` del daemon (`hosted-session.ts` — replay buffer per la
  riconnessione di un *client*, nulla a che vedere col modello).
- Percorso al modello: `agent.ts:214` e `:321`, `for await … model.stream(req)`.
  Il `try` a `agent.ts:213` ha un unico `catch` (`:233`) che tratta **solo**
  `signal?.aborted` come cancellazione pulita; **ogni altro errore → `throw`** e
  il turno muore.
- L'`ECONNRESET` **non** è un `ModelRequestError` (quello è solo per status HTTP
  non-ok, `openai-provider.ts:129`). È un errore grezzo di `fetch`/stream con
  `.code === "ECONNRESET"`, lanciato o da `await this.doFetch(...)`
  (`openai-provider.ts:127`, **prima di qualsiasi byte**) o dentro `parseSSE`
  durante `reader.read()` (**a stream già iniziato**).
- Il seam da toccare è `ModelProvider.stream` (`core/src/model.ts`). Ha **due**
  implementazioni oggi: `openai-provider.ts` e `anthropic-provider.ts`. Il retry
  va messo in un punto solo che le copra entrambe (vedi Design), non duplicato.

### Il confine che decide tutto: pre-primo-byte vs mid-stream

- **Caduta prima del primo byte** (fetch fallita, o errore prima di qualsiasi
  `yield` di `text`/`tool_call`): il server **non ha generato nulla** (provato
  dall'incidente: la richiesta non è arrivata). Ritentare è **completamente
  sicuro e trasparente** — nessun output duplicato, nessuno stato sporcato.
- **Caduta a stream iniziato** (già emessi delta di testo o tool call parziali):
  ritentare alla cieca **duplicherebbe** l'output già mostrato e già accumulato
  in `text`/`toolCalls` (`agent.ts:211-222`). Questo caso **non** è
  banalmente ritentabile; va o scartato (propaga l'errore) o gestito con un
  design esplicito (append-only, resume) che è fuori scope di una prima mossa.

Questa è la ragione per cui il retry **non** è un `fix` da una riga: è un `feat`
con decisioni di design reali (quali errori, quanti tentativi, backoff, il
confine qui sopra, cosa mostrare all'utente mentre ritenta).

### Spazio delle opzioni

1. **Status quo** — niente retry, `/retry` manuale. Costo zero, ma un blip di
   rete transitorio (il caso *facile e sicuro*) perde un intero turno. Fragile.
2. **Retry solo pre-primo-byte** *(raccomandato come prima mossa)* — ritenta
   solo quando la connessione cade prima di qualunque byte emesso, su una
   lista-permessi ristretta di errori transitori (`ECONNRESET`, `ECONNREFUSED`,
   `ETIMEDOUT`, reset del socket; **mai** su status HTTP 4xx, mai su `AbortError`
   da cancellazione utente). N tentativi (2–3) con backoff esponenziale +
   jitter. Antifragile e **senza rischio di duplicazione** perché limitato al
   confine sicuro.
3. **Retry completo con resume mid-stream** — copre anche la caduta a metà
   stream. Molto più grande (serve un protocollo di ripresa idempotente col
   modello, che l'API chat/completions non offre nativamente). Da **splittare**:
   non è una prima mossa. Resta un eval separato se mai servisse.

### Diagnostica (da decidere nello stesso intervento?)

Il log attuale dà `(no stack)` e non dice **in che fase** è caduta la
connessione né quale richiesta era — senza i log del *server* l'incidente era
indiagnosticabile. Proposta minima, accoppiata al retry perché condivide la
stessa distinzione di fase: loggare fase (pre-byte / mid-stream), `error.code`,
e il numero del tentativo. È un miglioramento diagnostico, non un difetto di
comportamento → sta bene dentro questo `feat`.

## Implementation

*— claude-opus-5-5, 2026-10-21*

### Repro (prova empirica, 2026-10-21, Bun 1.4.3)

Script in `.tentacle/tmp/model-connection-resilience/errors.ts`: un server
`node:net` su loopback rompe la connessione in ogni fase rilevante e stampa la
forma dell'errore che `fetch`/`reader.read()` lanciano. Output integrale
(messaggi accorciati con `…`):

```
[1 refused]               {"ctor":"TypeError","name":"TypeError","code":"ECONNREFUSED","errno":0,"message":"ECONNREFUSED: Unable to connect. …","hasStack":false}
[2 reset-before-response] {"ctor":"TypeError","name":"TypeError","code":"ECONNRESET","errno":0,"message":"ECONNRESET: The socket connection was closed unexpectedly. …","hasStack":false}
[2b fin-before-response]  {"ctor":"TypeError","name":"TypeError","code":"ECONNRESET", … ,"hasStack":false}
[3 reset-mid-body] got 48 bytes
[3 reset-mid-body]        {"ctor":"TypeError","name":"TypeError","code":"ECONNRESET", … ,"hasStack":false}
[3 fin-mid-body] got 48 bytes
[3 fin-mid-body]          {"ctor":"TypeError","name":"TypeError","code":"ECONNRESET", … ,"hasStack":false}
[4 abort-mid-body]        {"ctor":"DOMException","name":"AbortError","code":20,"message":"The operation was aborted.","hasStack":true}
[5 abort-before-response] {"ctor":"DOMException","name":"AbortError","code":20, … ,"hasStack":true}
```

Cosa ne segue, e cosa cambia nel design:

1. Gli errori di connessione di Bun sono `TypeError` con `code` **stringa** e
   **senza stack**: è esattamente il `(no stack)` dell'incidente
   (`daemon-log.ts:28` stampa `err.stack ?? "(no stack)"`).
2. **L'errore non dice la fase:** un reset prima della risposta (2) e uno a
   metà body (3) sono identici (stessa classe, stesso `code`, stesso
   messaggio). La fase si può sapere **solo** tracciando se è già uscito un
   evento: deve farlo il wrapper, non un classificatore dell'errore.
3. Anche `AbortError` ha un `code`, ma **numerico** (`20`). Il classificatore
   accetta solo un `code` stringa in lista-permessi. È una trappola da fissare
   con un test (T5).
4. Un FIN pulito prima della risposta (2b) arriva anche lui come `ECONNRESET`:
   coperto senza logica in più.

### Load-bearing assumption

**Una caduta prima che il provider abbia emesso il primo `StreamEvent` non ha
lasciato effetti a valle: rifare `inner.stream(request)` è indistinguibile da un
primo tentativo riuscito.** Tutto il retry si regge su questo. Prova:

- I provider sono generatori il cui unico effetto è la `fetch`
  (`openai-provider.ts:116-190`, `anthropic-provider.ts:98-113`). Lo stato del
  turno (`text`, `toolCalls`) lo accumula **solo** il consumer e **solo** dagli
  eventi emessi (`agent.ts:398-419`, `:532-547`). Lo stesso vale per la
  compattazione (`compact.ts:77`, `:115`) e per il tunnel verso il pod, che
  inoltra solo eventi emessi (`remote-client.ts:1279-1285`).
- Zero eventi emessi ⇒ nessun consumer ha visto output ⇒ niente da duplicare.
  Il confine sicuro è quindi «nessun evento emesso», non «nessun byte
  ricevuto». Il costo di questa scelta è in Failure modes (F9).

### Preconditions (verificate)

- **P1 — un solo punto di costruzione per i provider reali.** Ogni modello vero
  nasce da `createModelProvider` (`select-provider.ts:28`): main agent
  `wiring.ts:106`, sub-agent con modello per tipo `wiring.ts:174`, laptop che
  serve il pod `pod-runtime.ts:336` e `:530`. Avvolgendo lì sono coperti tutti i
  runtime (worker in-process, `serve` sull'host, `run`/`attach` lato laptop) e
  compattazione e riassunti (`wiring.ts`, `summarizeText(model, …)`).
- **P2 — niente doppio retry nel pod.** Il daemon nel pod usa
  `ProxyModelProvider` (`serve.ts:244`, iniettato via `modelOverride`,
  `wiring.ts:94`/`:105`), che non passa da `createModelProvider`. Il retry gira
  quindi **una sola volta, sul laptop**, dove avviene la `fetch` vera. È
  coerente con «il modello resta sul laptop» (§7).
- **P3 — il sub-agent è coperto (incidente B).** `createSubagentRunner({ model, … })`
  (`wiring.ts:168-169`) riceve lo stesso `model` del padre, oppure
  `modelFor` → `createModelProvider` (P1). Il figlio fa `new Agent({ model })`
  (`subagent.ts:162`).
- **P4 — la cancellazione converge già.** Il `catch` dell'agent tratta come
  `cancelled` qualunque errore con `signal.aborted` (`agent.ts:420-428`); lato
  laptop vale lo stesso (`remote-client.ts:1286-1296`). Un'attesa di backoff
  che **rifiuta subito su abort** finisce quindi nel percorso di cancellazione
  pulita esistente, senza codice nuovo nell'agent.
- **P5 — §7, il peer non viene serializzato.** Le richieste in ingresso sono
  dispatchate in concorrenza (`transport/peer.ts:310`, `void this.handleRequest`).
  Il backoff è un `await` dentro il generatore di **una** chiamata: non è un
  lock e non tocca il `Connection`.
- **P6 — dove arriva l'errore finale.** Nel worker in-process
  `exposeTurnErrors: true` e `onTurnError` → `logDaemonError`
  (`worker.ts:93-96`); `redactTurnError` porta `error.message` in
  `turn_end.error` (`hosted-session.ts:147-157`). Un messaggio diagnostico
  migliore arriva quindi **sia alla TUI sia al log** senza toccare il protocollo.

### Design

**Seam: un decoratore `RetryingModelProvider` in `@tentacle/providers`**,
applicato da `createModelProvider`. Copre entrambi i provider da un punto solo,
**senza toccare `agent.ts`**, protocollo, daemon, client e TUI.

```ts
// packages/providers/src/retry.ts (nuovo)
for (let attempt = 1; ; attempt++) {
  let emitted = false;
  try {
    for await (const event of this.inner.stream(request)) {
      emitted = true;
      yield event;
    }
    return;
  } catch (error) {
    if (request.signal?.aborted || !isTransientConnectionError(error)) throw error; // as-is
    if (emitted) throw new ModelConnectionError(error, "mid-stream", attempt, max);
    if (attempt >= max) throw new ModelConnectionError(error, "pre-stream", attempt, max);
    const delayMs = backoffDelay(attempt, policy);
    notify(onRetry, { attempt, maxAttempts: max, code, delayMs, providerId }); // best-effort
    await sleep(delayMs, request.signal); // rifiuta subito su abort (P4)
  }
}
```

- **Classificatore** `isTransientConnectionError(e)`: oggetto con
  `typeof e.code === "string"` e `code ∈ {ECONNRESET, ECONNREFUSED, EPIPE, ETIMEDOUT}`.
  Il `code` numerico di `AbortError` non passa (Repro, punto 3).
  `ModelRequestError` (status HTTP, `openai-provider.ts:38`) non ha `code` e non
  passa.
- **Politica: 3 tentativi totali** (quella dell'eval). **Backoff «equal
  jitter»**: `exp = min(cap, base·2^(attempt−1))`, `delay = exp/2 + random()·exp/2`,
  con `base = 500 ms` e `cap = 4 s` → retry 1 ∈ [250, 500) ms, retry 2 ∈
  [500, 1000) ms, **massimo 1,5 s aggiunti**. *Deriva dall'eval:* l'eval
  scriveva `random(0, …)` (full jitter) ma poi «≈0,5 s ± 50%»; le due cose si
  contraddicono. Equal jitter mantiene la desincronizzazione padre/sub-agent e
  garantisce una pausa minima > 0.
- **Iniettabili per i test:** `maxAttempts`, `baseDelayMs`, `capDelayMs`,
  `sleep(ms, signal)`, `random()`, `onRetry(info)`. Il default di `sleep` è un
  `setTimeout` che su abort fa `clearTimeout` e rifiuta con `signal.reason`.
- **`id`** = `inner.id`, invariato. `readonly inner` è esposto: serve ai test e
  rende ispezionabile quale provider è stato scelto.

**Diagnostica:**

- **`ModelConnectionError`**, solo per errori transitori (gli altri passano
  intatti). Campi: `code`, `phase: "pre-stream" | "mid-stream"`, `attempt`,
  `maxAttempts`, e `cause` = errore originale. Messaggi:
  - `model connection lost before any event was delivered (ECONNRESET), gave up after 3 attempt(s): <msg originale>`
  - `could not connect to the model endpoint (ECONNREFUSED), gave up after 3 attempt(s): <msg originale>`
  - `model connection lost mid-stream (ECONNRESET) on attempt 1/3 — not retried, events were already delivered: <msg originale>`

  *(Messaggi corretti dopo la review, finding 1 e 5: «pre-stream» vuol dire
  «nessun evento consegnato», non «nessun output generato»; e un `ECONNREFUSED`
  non ha mai avuto una connessione da perdere. — claude-opus-5-5, 2026-10-21)*
- **`logDaemonError`** (`daemon-log.ts:24`): se `err.cause` esiste, aggiunge
  `Cause: <name>: <message> (code <code>)` e lo stack della causa, se c'è. È
  generico: vale per ogni errore con `cause`.
- **Retry riusciti: niente a schermo, una riga nel log.** Il nuovo
  `logModelRetry(configDir, info)` in `daemon-log.ts` appende a
  `daemon-errors.log` una riga
  `[ts] model retry 1/2 after ECONNRESET (no event delivered yet, openai:<model>), waiting 412ms`.
  Collegato via `onRetry` nei 4 punti di P1. Serve a **misurare la frequenza**
  dei blip, che oggi un retry riuscito renderebbe invisibili: è il dato che
  serve per il follow-up sul drain dopo `[DONE]`. Scrive su file, mai sul
  terminale (§7 Ink).

**Decisioni che deviano dall'abbozzo dell'eval — approvate dall'owner il 2026-10-21:**

- **D1 — nessun indicatore TUI «⟳ riprovo» in questo feat.** Servirebbe una
  variante nuova di `StreamEvent` più `WireStreamEventSchema`
  (`protocol/model.ts:45`), che la deve trasportare dal laptop al pod, più un
  `session/update` nuovo, il mapping in `client/mapping.ts` e la TUI: 5
  pacchetti e un bump di `PROTOCOL_VERSION` (7 → 8, perché un discriminante
  sconosciuto rompe il `connect` tra versioni diverse, §7). Tutto questo per un
  indicatore che vivrebbe al massimo 1,5 s, nell'attesa del primo token in cui
  la TUI è comunque già in attesa. In più, in un sub-agent sparirebbe lo
  stesso, perché `subagent.ts:178-188` scarta tutto tranne
  `text`/`tool_start`/`turn_end`. Raccomando: rimandare. Un retry fallito
  produce già un errore che dice tutto (fase, codice, tentativi).
- **D2 — nessun knob di config `maxRetries`.** Costanti nel modulo e politica
  iniettabile. Un knob vuol dire toccare schema, resolve, load e defaults per un
  valore non ancora tarato; si aggiunge quando i dati del log (sopra) diranno
  che serve.
- **D3 — retry solo su errori di connessione, non su status HTTP** (503
  «loading model» di llama-server, 429/529 di Anthropic). Sono transitori anche
  loro, ma richiedono un'altra politica (rispettare `Retry-After`, attese più
  lunghe di 1,5 s). Restano un follow-up separato.

### Files (ordine di dipendenza; nessun cambio a protocol, daemon, client, tui, agent)

1. `packages/providers/src/retry.ts` — **nuovo**: `RetryingModelProvider`,
   `ModelConnectionError`, `isTransientConnectionError`, `backoffDelay`, `RetryPolicy`.
2. `packages/providers/src/select-provider.ts` — avvolge il provider scelto;
   aggiunge l'opzione `onRetry` a `CreateModelProviderOptions`.
3. `packages/providers/src/index.ts` — `export * from "./retry.ts"`.
4. `packages/cli/src/daemon-log.ts` — la catena `cause` in `logDaemonError`;
   nuovo `logModelRetry`.
5. `packages/cli/src/model-provider.ts` (**nuovo**, dopo la review — finding 2):
   `configuredModelProvider(config, model?)`, l'unico punto in cui la CLI
   costruisce un provider reale, con `onRetry` → `logModelRetry`. Lo chiamano
   `wiring.ts` (main e `modelFor`) e `pod-runtime.ts` (`run` e `attach`): un
   test solo copre il wiring di tutti e 4 i punti.
6. Test: `packages/providers/test/retry.test.ts` (**nuovo**);
   `packages/providers/test/select-provider.test.ts` (i `toBeInstanceOf`
   passano a `.inner`); `packages/cli/test/daemon-log.test.ts`.

### Failure modes (e come converge lo stato)

- **F1 — abort durante un tentativo.** L'inner lancia `AbortError` con
  `signal.aborted`: viene rilanciato intatto, e l'agent chiude il turno come
  `cancelled` (P4).
- **F2 — abort durante il backoff.** `sleep` cancella il timer e rifiuta
  subito, nessun nuovo tentativo: di nuovo `cancelled`. Niente timer lasciati
  in giro.
- **F3 — errore transitorio con `signal` già abortito.** Prevale la
  cancellazione: rilancio intatto, nessun retry.
- **F4 — errore non transitorio** (`ModelRequestError` 4xx/5xx, evento `error`
  Anthropic `anthropic-provider.ts:194`, JSON rotto, `TypeError` senza `code`):
  rilancio **della stessa istanza**, un solo tentativo. Comportamento identico
  a oggi.
- **F5 — caduta a stream iniziato** (anche dopo un solo `reasoning` o `done`):
  nessun retry; `ModelConnectionError{phase: "mid-stream"}` con la causa.
  L'output parziale resta quello già emesso, come oggi.
  **Precondizione (aggiunta dopo la review, finding 4):** vale solo se il body
  ha `transfer-encoding: chunked` o un `content-length`. Se il body è delimitato
  dalla chiusura della connessione, Bun non distingue un reset da una fine
  normale: il turno finisce `end_turn` con il testo troncato, e un tool call
  troncato viene eseguito. Non è introdotto da questo feat, che lì non vede
  alcun errore; è il problema aperto di
  `docs/eval/sse-abort-truncated-toolcall.md`.
- **F6 — tentativi esauriti.** Propaga `ModelConnectionError{phase:
  "pre-stream", attempt: 3}`, mai silenziato. Il turno finisce in `error` come
  oggi, ma con un messaggio diagnostico.
- **F7 — `onRetry` lancia un'eccezione.** Viene ingoiata (best-effort, come
  `logDaemonError`) e il retry procede.
- **F8 — il consumer chiude in anticipo** (`return()` sul generatore): il
  `for await` chiude l'inner, non c'è retry né timer pendente.
- **F9 — costo lato server** *(corretto dopo la review, finding 1)*. Il confine
  è «nessun evento **consegnato**», non «nessun token generato». I provider
  trattengono i tool call fino allo stop reason (`openai-provider.ts:175-179`,
  `anthropic-provider.ts:175`/`:225`): una caduta a metà di una risposta fatta
  **solo** di tool call è quindi pre-stream, viene ritentata e il tool call
  viene **rigenerato per intero** (oltre al prefill del prompt). È sicuro (il
  consumer non ha visto niente, e il tool call parziale non esce mai: test su
  socket reale in `select-provider.test.ts`), ma il costo è quello di una
  risposta completa, non solo del prompt. Accettato: senza retry quella
  risposta andava persa comunque, insieme al turno.
- **F10 — pod.** Il retry avviene sul laptop (P2). A tentativi esauriti il pod
  vede `internal error`: è la redazione esistente (`remote-client.ts:1297-1302`,
  §7), voluta. Il messaggio completo va solo nel sink stderr del laptop
  (`pod-runtime.ts:364`). È debito pre-esistente, fuori scope.
- **F11 — padre e sub-agent cadono insieme.** Il wrapper non ha stato condiviso
  (tutto per chiamata) e il jitter li desincronizza.
- **F12 — version skew.** Nessuno: non cambia niente sul wire.

### Tests (red-before-green, §9)

Unit su `RetryingModelProvider`, con un inner finto (generatori scriptati per
tentativo) e `sleep`/`random` finti, quindi senza attese reali:

- **T1** — `ECONNRESET` pre-stream ×2, poi successo: il consumer riceve
  esattamente gli eventi del successo, l'inner viene chiamato 3 volte e
  `onRetry` 2 volte con `attempt` 1 e 2. *Rosso senza wrapper.*
- **T2** — 3 fallimenti: `ModelConnectionError`, `phase` `pre-stream`,
  `attempt` 3, `cause` **identica** all'originale, `code` `ECONNRESET`, inner
  chiamato 3 volte.
- **T3** — `text` emesso, poi `ECONNRESET`: il consumer vede il `text`
  **una sola volta**, poi `ModelConnectionError{mid-stream}`; inner chiamato 1
  volta. *Mutazione: togliere il controllo `emitted` ⇒ rosso.*
- **T4** — `ModelRequestError(503)` e `TypeError` senza `code`: rilanciata la
  stessa istanza, inner chiamato 1 volta.
- **T5** — `DOMException AbortError` (con `code` 20): nessun retry, stessa
  istanza.
- **T6** — abort durante il backoff, con il `sleep` **di default** e un delay
  lungo: rifiuta subito, inner non richiamato.
- **T7** — `ECONNRESET` con `signal` già abortito: stessa istanza, nessun
  retry. *Mutazione: togliere il controllo `aborted` ⇒ rosso.*
- **T8** — limiti del backoff: `random = 0` ⇒ 250 e 500 ms; `random → 1` ⇒
  < 500 e < 1000 ms.
- **T9** — un `onRetry` che lancia non blocca il retry.
- **T10 (integrazione, socket reale su loopback, < 100 ms)** — un server
  `node:net` che resetta la prima connessione e alla seconda serve SSE;
  `createModelProvider(...).stream()` produce il testo. È **l'unico** test che
  prova la proprietà esatta su cui si regge il classificatore: che il
  `ECONNRESET` **reale** di Bun abbia `code` stringa. Un fake scritto a mano
  proverebbe solo il fake.

`daemon-log.test.ts`: la catena `cause` appare nella voce del log; la riga di
`logModelRetry` ha il formato atteso.

Non-vacuità (§9), da mostrare in Execution: T1 rosso su `main` (o con il
classificatore che ritorna `false`), più le mutazioni di T3 e T7.

## Execution

*— claude-opus-5-5, 2026-10-21*

Fatto, nell'ordine del piano:

1. **Rosso prima del verde.** Test d'integrazione in `select-provider.test.ts`:
   un server `node:net` resetta la prima connessione, poi serve SSE. Su `main`
   fallisce con lo stesso errore dell'incidente:
   `TypeError: ECONNRESET: The socket connection was closed unexpectedly … code: "ECONNRESET"`
   (`5 pass, 1 fail`). Test sulla catena `cause` in `daemon-log.test.ts`: rosso
   (la voce del log non conteneva `Cause: …`).
2. `packages/providers/src/retry.ts` (nuovo): `RetryingModelProvider`,
   `ModelConnectionError`, `transientConnectionCode`, `backoffDelay`,
   `abortableSleep`, `RetryPolicy`, `RetryInfo`.
3. `select-provider.ts`: `createModelProvider` avvolge il provider scelto e
   accetta `onRetry`; `index.ts` esporta `retry.ts`. Nei test
   `toBeInstanceOf` è passato a `.inner`. Il test d'integrazione diventa verde
   (circa 380 ms: il backoff reale).
4. `retry.test.ts`: 14 test (T1–T9 del piano, più `reasoning` come output,
   `id` invariato, i limiti di `backoffDelay` e due casi di `abortableSleep`).
5. `daemon-log.ts`: catena `cause` in `logDaemonError` (nome, messaggio,
   `code`, stack se c'è); nuovo `logModelRetry`. Collegato con
   `onRetry: (info) => logModelRetry(config.configDir, info)` in `wiring.ts`
   (main e `modelFor`) e `pod-runtime.ts` (`run` e `attach`).

**Non-vacuità per mutazione (§9)**, una mutazione alla volta, file
ripristinato e verificato con `cmp` dopo ognuna:

| Mutazione | Test che vanno rossi |
|---|---|
| il classificatore non riconosce mai l'errore | 7, inclusa l'integrazione reale |
| senza il controllo `emitted` | i 2 test mid-stream (`text` e `reasoning`) |
| senza il controllo `signal.aborted` | «a cancel wins» |
| lo `sleep` di default ignora l'abort | «an abort during the backoff» (timeout a 5 s) |

**Deriva dal piano:**

- *Nomi:* `isTransientConnectionError` è diventato
  `transientConnectionCode(e): string | undefined` (restituisce il codice, che
  serve a messaggio e log); `sleep` di default esportato come `abortableSleep`.
- *Mutazione scartata:* togliere il controllo `typeof code === "string"` è
  **equivalente**, perché `Set.has(20)` su un set di stringhe è comunque
  `false`. Il guard resta come documentazione dell'intento; la protezione
  dall'`AbortError` è fissata dal test sul suo `code` numerico.
- *Incidente di processo:* il primo giro di mutazioni ha scritto il backup in
  una cartella che non esisteva. Le mutazioni si sono accumulate nel file e
  quei risultati sono stati buttati. Ho ripristinato il file a mano (le tre
  sostituzioni inverse, verificate leggendo il codice) e rifatto il giro con
  il backup in `.tentacle/tmp/` e un `cmp` dopo ogni ripristino. La tabella qui
  sopra viene dal secondo giro.
- `createModelProvider` ora ha tipo di ritorno `RetryingModelProvider` (un
  sottotipo di `ModelProvider`), così `.inner` è tipizzato nei test. I chiamanti
  non cambiano.

**Gate (`bun run check`):** typecheck pulito, lint pulito (331 file),
`1440 pass · 2 skip · 0 fail` su 1442 test. I 2 skip sono gli opt-in di
baseline (`ws-server.test.ts:280` `TENTACLE_SLOW_TESTS`,
`integration.live.test.ts:30` `TENTACLE_K8S_SERVER`).

**Non verificato:** un `ECONNRESET` reale contro llama-server dal vivo (il
blip non è riproducibile a comando, vedi Context). Da verificare dalle righe
`model retry` in `~/.config/tentacle/logs/daemon-errors.log` nell'uso normale.

### Correzioni dopo la review (2026-10-21)

*— claude-opus-5-5, 2026-10-21* — tutti i finding della review sistemati.
L'owner ha deciso **senza** una seconda review in contesto fresco.

1. **Finding 1 e 5 — messaggi.** In `retry.ts`, `ModelConnectionError` ora
   costruisce il testo con `connectionFailureSummary`: «before any event was
   delivered» per i reset pre-stream, «could not connect to the model endpoint»
   per `ECONNREFUSED`, «events were already delivered» per mid-stream. La riga
   di log ora dice `(no event delivered yet, …)`. Il JSDoc della classe spiega
   il confine. Test aggiornati prima, visti **rossi** (4 fail), poi verdi.
   Nuovo test su **socket reale**
   (`select-provider.test.ts`, «a drop mid tool call…»): risposta chunked con
   un tool call parziale e poi reset; secondo tentativo completo; il tool call
   esce **una volta**, con gli argomenti completi, e le connessioni sono 2.
   F9 corretto, F5 con la sua precondizione.
2. **Finding 2 — wiring non testato.** Nuovo
   `packages/cli/src/model-provider.ts` con `configuredModelProvider`; i 4
   blocchi duplicati in `wiring.ts`/`pod-runtime.ts` diventano una chiamata
   (`createModelProvider` non è più importato altrove in `packages/cli/src`).
   Nuovo `packages/cli/test/model-provider.test.ts`: un reset reale recuperato
   lascia la riga `model retry 1/2 after ECONNRESET (no event delivered yet,
   openai:qwen)` nel log; un model id per tipo sostituisce quello di config.
3. **Finding 3** — `TODO.md` aggiornato.

**Mutazioni sul nuovo codice** (backup in `.tentacle/tmp/`, `cmp` dopo ogni
ripristino):

| Mutazione | Test che vanno rossi |
|---|---|
| l'helper non passa `onRetry` | il test del log in `model-provider.test.ts` (prima: M12 della review sopravviveva) |
| il classificatore non riconosce mai l'errore | entrambi i test su socket reale; quello sul tool call prova che la prima connessione dà davvero un errore e non una fine pulita |
| il ramo `ECONNREFUSED` del messaggio | il test sull'esaurimento dei tentativi |

**Gate dopo le correzioni (`bun run check`):** typecheck pulito, lint pulito
(333 file), `1444 pass · 2 skip · 0 fail` su 1446 test (+4 rispetto al primo
gate: il test sul messaggio di reset, quello sul tool call e i 2 di
`model-provider.test.ts`). I 2 skip sono gli stessi opt-in di baseline.

## Review

### Review adversarial dell'implementazione (contesto fresco)

*— claude-opus-5-5 (contesto fresco), 2026-10-21*

> **Nota sull'indipendenza:** l'executor era anche lui claude-opus-5-5. Questa
> review è lo **stesso modello con solo un contesto fresco**: i punti ciechi
> condivisi possono sopravvivere a entrambi i passaggi.

**Verdetto: APPROVE-WITH-NITS.** Il retry è corretto sul confine che conta
(nessun evento emesso), non tocca nessun invariante §7, e i test reggono alle
mutazioni. I rilievi sotto sono di accuratezza della diagnostica, del doc e di
copertura del wiring. Nessuno blocca il merge.

#### Rilievi

1. **[Basso — diagnostica/doc] «pre-stream» non vuol dire «il server non ha
   generato nulla».** I due provider emettono i `tool_call` solo alla fine:
   OpenAI al `finish_reason` (`openai-provider.ts:171-175`), Anthropic li
   trattiene fino allo stop reason (`anthropic-provider.ts:175`, `:225`). Una
   risposta fatta solo di tool call (niente testo, niente reasoning) che cade
   a metà generazione viene quindi classificata `pre-stream` e ritentata.
   L'ho provato e2e (`e2e-chunked.ts`, «chunked toolfrag then RST»: 2
   connessioni, turno completato col testo del secondo tentativo). È
   **sicuro**: il consumer non ha visto niente. Due cose però sono sbagliate:
   (a) F9 dice «calcolo duplicato = il prefill», ma qui si rigenera
   **l'intera** tool call (un `fs_write` lungo su llama-server a slot singolo
   può valere minuti); (b) il messaggio a tentativi esauriti
   (`retry.ts:51`, «lost before any output») e la riga di log
   (`daemon-log.ts:77`, «(pre-stream, …)») dicono «nessun output» anche quando
   il modello stava generando. Da correggere: il testo di F9 e la
   formulazione del messaggio (es. «before any event was delivered»).
2. **[Basso — copertura test] Il wiring di `onRetry` nei 4 punti non ha test.**
   Mutazione M12: ho tolto `onRetry` da `wiring.ts:113` e `:182`, e
   `packages/cli/test` resta verde (233 pass, 0 fail). La diagnostica che il
   doc chiama «il dato per il follow-up sul drain» può sparire in silenzio da
   un refactor. Non tocca il comportamento, quindi è un nit.
3. **[Nit — indice] `TODO.md:414`** dice ancora «Implementation awaiting
   approval», mentre il doc è approvato ed eseguito.
4. **[Info — vincolo pre-esistente, non introdotto] F5 vale solo se il corpo
   ha una framing (chunked o `content-length`).** Con un corpo delimitato
   dalla chiusura (né `content-length` né chunked), Bun tratta un RST a metà
   corpo come un EOF normale. Il risultato (`e2e.ts`, B e C): turno
   `end_turn` col testo troncato, e una tool call troncata
   (`{"path":"a.txt","con`) eseguita. Il wrapper non vede nessun errore, quindi
   non c'è nessun `ModelConnectionError{mid-stream}`. È esattamente
   `docs/eval/sse-abort-truncated-toolcall.md`, ancora aperto. Questo diff non
   lo peggiora né lo cura. Con la framing chunked (quella di llama-server e
   OpenAI) F5 regge (vedi e2e). F5 andrebbe annotato con questa
   precondizione.
5. **[Nit] `ECONNREFUSED` viene descritto come «connection lost»**
   (`retry.ts:51`), ma la connessione non è mai stata stabilita. Con
   llama-server spento l'utente aspetta circa 0,75–1,5 s in più e legge un
   messaggio un po' fuorviante. Il codice tra parentesi lo disambigua.

#### Gate (`bun run check`, rieseguito)

typecheck pulito; lint `Checked 331 files … No fixes applied`;
**`1440 pass · 2 skip · 0 fail`, 1442 test su 134 file**, exit 0. I 2 skip
sono gli unici `skipIf` del repo: `ws-server.test.ts:280`
(`TENTACLE_SLOW_TESTS`) e `integration.live.test.ts:30`
(`TENTACLE_K8S_SERVER`). Combacia con i numeri dell'Execution.

#### Non-vacuità per mutazione (§9)

Per ogni mutazione: backup in `.tentacle/tmp/model-connection-resilience/review-*.bak`,
mutazione applicata, test eseguito, ripristino dal backup e `cmp`. Dopo ogni
ripristino l'albero è risultato **byte-identico**. Script: `mutate.sh`.

| # | Mutazione | Esito |
|---|---|---|
| M1 | classificatore → sempre `undefined` | **7 fail**, inclusa l'integrazione col socket reale |
| M2 | senza controllo `emitted` | **2 fail** (mid-stream `text` e `reasoning`) |
| M3 | senza controllo `signal.aborted` | **1 fail** («a cancel wins») |
| M4 | `abortableSleep` ignora l'abort | **1 fail** (timeout 8 s) |
| M5 *(nuova)* | `attempt > maxAttempts` (off-by-one) | **1 fail** (esaurimento) |
| M6 *(nuova)* | full jitter invece di equal jitter | **3 fail** |
| M7 *(nuova)* | `onRetry` senza try/catch | **1 fail** |
| M8 *(nuova)* | `AbortError` trattato come transitorio | **1 fail** (T5) |
| M9 *(nuova)* | numerazione `retry n/maxAttempts` | **1 fail** (`daemon-log.test.ts`) |
| M10 | catena `cause` senza `code` | **1 fail** |
| M11 | catena `cause` rimossa | **1 fail** |
| M12 *(nuova)* | `wiring.ts` senza `onRetry` | **0 fail → sopravvive** (rilievo 2) |

Le mutazioni dichiarate dall'executor (M1–M4) confermano la sua tabella.

#### Tabella delle premesse

| Premessa | Verifica | Esito |
|---|---|---|
| Sintomo / Repro: gli errori di connessione di Bun sono `TypeError` con `code` stringa e senza stack; `AbortError` ha `code` 20 | riesecuzione di `errors.ts` (Bun 1.4.3): output identico a quello del doc | VERO |
| `daemon-log.ts:28` stampa `(no stack)` | `HEAD:daemon-log.ts:28` | VERO |
| Load-bearing: un provider è un generatore il cui solo effetto è la `fetch`; lo stato lo accumula solo il consumer | `openai-provider.ts:116-190`, `anthropic-provider.ts:98-113`, `agent.ts:398-419`, `:532-547`, `compact.ts:77/:115`, `remote-client.ts:1279-1285` | VERO (con la precisazione del rilievo 1 su «output») |
| P1: un solo punto di costruzione | `rg "new (OpenAI\|Anthropic)Provider"` (fuori dai test) → solo `select-provider.ts:47`; chiamanti `wiring.ts:107/:176`, `pod-runtime.ts:337/:532` | VERO |
| P2: niente doppio retry nel pod | `serve.ts:244` `modelOverride: new ProxyModelProvider`; `modelFor` usa anch'esso `options.modelOverride ??` (`wiring.ts:175`); nessun retry in `proxy-model.ts` né nel peer | VERO |
| P3: sub-agent coperto | `subagent.ts:162` `new Agent({ model })`, `wiring.ts:168-169` | VERO |
| P4: la cancellazione converge | `agent.ts:420-428`, `remote-client.ts:1286-1296`; e2e E/F → `turn_end:cancelled` in circa 100 ms | VERO |
| P5: il peer non è serializzato | `peer.ts:310` `void this.handleRequest` | VERO |
| P6: dove arriva l'errore finale | `worker.ts:93-96`, `hosted-session.ts:147-157` | VERO |
| F5: caduta a metà stream → `ModelConnectionError{mid-stream}` | e2e con framing chunked: VERO; con corpo delimitato dalla chiusura: nessun errore (rilievo 4) | VERO con precondizione |
| F8: `return()` chiude l'inner | `early-return.ts`: il `finally` dell'inner gira al `break` | VERO |
| F9: costo = solo prefill | e2e «toolfrag then RST» rigenera l'intera tool call | **FALSO / sottostimato** (rilievo 1) |
| F10: il pod vede `internal error` | `remote-client.ts:1297-1302` rilancia, non è un `RpcError` | VERO |
| D1: `WireStreamEventSchema` | `protocol/model.ts:45` | VERO |

#### Attacchi tentati

1. **Traccia e2e reale** (`e2e.ts`, `e2e-chunked.ts`): un `Agent` vero, più
   `createModelProvider`, più la `fetch` di Bun, contro un server `node:net`.
   - Reset alla prima connessione: 2 connessioni, `text="hello"` una volta
     sola, `end_turn`, `onRetry` 1 volta (251 ms).
   - Testo seguito da RST, framing chunked: `text="partial"` una volta,
     `ModelConnectionError` mid-stream, 1 sola connessione (nessuna
     duplicazione).
   - Tentativi esauriti: 3 connessioni in 1,1 s, `retry 1/2` e `2/2`
     coerenti, errore `pre-stream attempt=3` con causa.
   - Abort durante il backoff: `cancelled` in 101 ms, nessun nuovo tentativo.
   → **regge**.
2. **Doppio retry attraverso il tunnel del pod.** Ho verificato che nel pod
   non nasce mai un provider vero: anche `modelFor` usa `modelOverride`. La
   `fetch` resta sul laptop. → **niente**.
3. **Fuga di segreti nei nuovi messaggi e log.** La causa di Bun ha le chiavi
   `message, code, path, errno`, e `path` è l'URL. `logDaemonError` scrive
   solo nome, messaggio e `code`; `providerId` è `openai:<model>`. Con
   `apiKey: "sk-SECRET-KEY"` il messaggio non contiene il segreto. → **niente**.
4. **Controlli sul tipo d'errore altrove.** Nessun `instanceof
   ModelRequestError` fuori dai provider, nessun match su
   `ECONNRESET`/«Unable to connect» nel codice. Il `name ===
   "cancelled"` (`remote-client.ts:1292`) non collide con
   `"ModelConnectionError"`. La redazione del pod è invariata. → **niente**.
5. **Uscita anticipata / `return()`** attraverso il wrapper: il `finally`
   dell'inner gira. → **regge** (F8).
6. **Il confine «nessun evento emesso» con i provider che trattengono i tool
   call** → rilievo 1.
7. **Prior art** (`docs/eval/sse-abort-truncated-toolcall.md`, aperto, stesso
   path) → rilievo 4. Nessun conflitto: il wrapper lascia passare intatto lo
   stream che termina in modo pulito.
8. **§7 Ink:** `logModelRetry` scrive solo su file (`appendFileSync`), con
   try/catch. → **niente**.
9. **§7 peer:** il backoff è un `await` dentro il generatore di una singola
   richiesta; `peer.ts:310` è invariato. → **niente**.

#### Cosa regge

Il seam è unico e copre main agent, sub-agent, compattazione/riassunti e il
lato laptop di `run`/`attach`. La cancellazione vince sempre. Gli errori non
transitori passano come la stessa istanza. Nessuna modifica a protocollo,
agent o TUI. Il test d'integrazione col socket reale è la prova giusta della
proprietà su cui si regge il classificatore (lo conferma M1).

**Non verificato:** il percorso Anthropic su TLS (codici d'errore di Bun su
HTTPS) e se Bun produca mai `EPIPE`/`ETIMEDOUT` da `fetch`. Sono innocui come
voci in lista-permessi; da osservare nelle righe `model retry` del log.

#### Come si è comportato l'executor

Disciplinato. Ha seguito il piano nell'ordine, ha dichiarato le derive (nomi,
tipo di ritorno, mutazione equivalente scartata con una motivazione corretta)
e ha riportato onestamente l'incidente del backup nella cartella inesistente,
rifacendo il giro con `cmp`. Il suo backup residuo (`retry.ts.bak`) è
byte-identico al file attuale. I numeri del gate e delle mutazioni sono
confermati. Limiti: non ha messo alla prova il proprio confine di fase contro
i provider che trattengono i tool call (F9 sottostimato), non ha testato il
wiring di `onRetry` e ha lasciato stale `TODO.md`.

#### Esito dei finding

*— claude-opus-5-5 (l'executor), 2026-10-21* — tutti e 5 sistemati, vedi
«Correzioni dopo la review» in Execution: 1 e 5 (messaggi, F9), 2
(`configuredModelProvider` più un test che uccide M12), 3 (`TODO.md`), 4
(precondizione di F5; il difetto resta in `docs/eval/sse-abort-truncated-toolcall.md`).
Per decisione dell'owner **non** c'è stata una seconda review in contesto
fresco. Queste correzioni le ha verificate solo l'executor (red→green,
mutazioni, gate), quindi sono una self-review.

### Verdetto dell'eval (pre-promozione)

*— claude-opus-4-8, 2026-10-17*

**Verdetto: è un `feat`, raccomando l'Opzione 2** (retry solo pre-primo-byte,
lista-permessi ristretta, backoff+jitter, 2–3 tentativi) **+ il miglioramento
diagnostico**, come un unico task `feat` di size **M** e blast **load-bearing**.

Perché `feat` e non `fix`: il retry non è mai esistito né è stato promesso — non
c'è un contratto rotto né una regressione. Il provider fa esattamente ciò per cui
è scritto (una richiesta, poi propaga l'errore fedelmente, il che è di per sé
corretto). Aggiungerlo introduce comportamento nuovo con vere scelte di design →
`feat` (AGENTS §10: `fix` = difetto in comportamento esistente; `feat` = nuova
capacità/miglioramento). Sfumatura onesta: il logging povero, preso da solo,
sarebbe più vicino a un `fix` (una diagnostica che *esiste già* ed è difettosa),
ma è così intrecciato col retry — per decidere se ritentare devi prima
distinguere la fase della caduta — che tenerli separati sarebbe artificiale.

Perché Opzione 2 e non 3: l'incidente reale è il caso pre-primo-byte, che è
**sicuro** da ritentare e copre il bisogno vero (un blip transitorio non deve
bruciare un turno). Il mid-stream resume è un sottosistema a sé (richiede ripresa
idempotente che l'API non offre) — va splittato, non infilato qui (§10: niente
XL).

Rischi residui da red-teamare alla promozione: (a) non ritentare mai un
`AbortError` da cancellazione utente — regressione silenziosa se sbagliato; (b)
il backoff non deve serializzare il peer RPC (§7); (c) provare la **non-vacuità**
dei test per mutazione (far fallire il retry e vedere il test diventare rosso),
perché un test di retry mal scritto passa anche senza retry.

Pista non ancora dimostrata (socket non drenato dopo `[DONE]`,
`openai-provider.ts:136`): **non** bloccante per la decisione — l'Opzione 2 cura
il sintomo in modo sicuro a prescindere dalla causa radice. Vale un follow-up:
drenare/`cancel()` il corpo residuo alla chiusura dello stream potrebbe ridurre
la *frequenza* dei reset alla radice. Da valutare separatamente, con un repro in
streaming quando lo slot del server è libero.
