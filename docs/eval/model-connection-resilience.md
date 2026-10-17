# eval/model-connection-resilience — Resilienza della connessione al modello (retry + diagnostica)

> **Status:** context · ~~implementation~~ · ~~execution~~ · review (verdict)
> **Branch:** nessuno — `eval`, committato direttamente su `main` (AGENTS §10)
> **Size:** M · **Blast:** load-bearing · **Suited:** se promosso → modello forte esegue, Review in contesto fresco obbligatoria (tocca l'agent loop e il seam `ModelProvider`, §7)

<!-- eval: solo Context + un verdetto in Review. Implementation/Execution restano
     vuote finché l'eval non è promosso (il git mv in feat/ apre il branch). -->

## Context

*— claude-opus-4-8, 2026-10-17*

> *Line cites in `openai-provider.ts` refreshed after the anthropic-api-support
> merge (`a4cb875`) shifted them; content unchanged. — claude-opus-5-5, 2026-10-17*

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

*(vuota: si compila alla promozione, quando il git mv in `docs/feat/` apre il
branch — AGENTS §10. Abbozzo del Design, da verificare allora riga per riga.)*

### Seam

- Punto unico: avvolgere la **creazione dello stream fino al primo evento** in un
  helper di retry, condiviso dai due provider, **senza** toccare `agent.ts` (il
  confine "primo byte" coincide con "prima che `stream` emetta il primo evento",
  quindi l'helper può vivere a livello provider o in un piccolo wrapper
  `ModelProvider`). Decidere allora quale dei due è il seam più pulito.

### Politica di retry (raccomandata)

- **Numero: 3 tentativi totali (2 retry).** Il valore è quasi tutto nel primo
  retry (un reset transitorio pre-primo-byte si risolve quasi sempre subito); il
  secondo copre il raro doppio-blip. Dal terzo in poi non è più un blip — il
  server è giù o la rete è partita — e si *vuole* far emergere l'errore, non
  martellare un server a slot singolo che si sta riprendendo. Esporre come knob
  di config `maxRetries` (default 2), nello stile degli altri default del repo
  (`defaults.ts`).
- **Attesa: backoff esponenziale corto + jitter.**
  `delay = random(0, min(cap, base * 2^tentativo))`, con `base = 500ms`,
  `cap = 4s` → retry 1 ≈ 0,5 s, retry 2 ≈ 1 s. Jitter (±50%) per non
  sincronizzare padre e sub-agent se cadono insieme. **Corto** di proposito: il
  reset è istantaneo (non un timeout), la pausa serve solo a far sedimentare una
  condizione transitoria; il modello locale è già lento (~100 t/s), aggiungere
  attese lunghe è UX pessima. Peggior caso recuperabile: ~1,5 s totali aggiunti.
- **Lista-permessi ristretta:** ritentare solo su errori di connessione
  transitori (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, reset del socket).
  **Mai** su status HTTP 4xx (`ModelRequestError`, non transitorio) né su
  `AbortError` da cancellazione utente.

### UX a schermo (silenzioso quando si risolve, rumoroso solo se fallisce)

- Il retry **non** si stampa raw sul terminale (§7 "mai scrivere raw mentre Ink
  possiede lo schermo"). Diventa un **evento** emesso dal modulo del provider
  (es. un `retry`/`notice` event nello stream `AgentEvent`), reso dalla TUI:
  decisione nel modulo puro, render nel componente (§7 "logica nei moduli puri,
  i componenti solo rendono").
- **Durante il retry:** riga di stato discreta e *transitoria* — es.
  `⟳ connessione interrotta, riprovo (1/2)…` — **sostituita** appena il tentativo
  riesce. Siccome si ritenta solo pre-primo-byte, a schermo non c'è output
  parziale da arrotolare: l'indicatore sparisce pulito e il turno prosegue.
- **Se riesce:** nessun rumore permanente nello scrollback. Un blip risolto non
  deve sembrare un errore.
- **Se esauriscono i tentativi:** l'errore emerge in evidenza (turno fallito
  davvero, come oggi) ma con diagnostica buona — tentativo, `error.code`, fase —
  invece dell'attuale `(no stack)`.

### Failure modes

- 4xx non ritentabile · `AbortError` utente (resta cancellazione pulita,
  `agent.ts:233`) · esaurimento tentativi (propaga l'ultimo errore, non
  silenziare) · caduta mid-stream (fuori scope: propaga) · backoff che non deve
  bloccare un `session/enqueue` concorrente (§7 "non serializzare il peer").

### Tests

- Red-before-green (§9): `fetch` iniettato (`OpenAIProviderConfig.fetch` già
  esiste, `openai-provider.ts:34`) che fallisce N volte poi riesce → asserire
  che `stream` emette comunque il contenuto; `fetch` che fallisce con 4xx →
  asserire **nessun** retry; errore **dopo** il primo delta → asserire
  **nessun** retry e propagazione; esaurimento tentativi → asserire che l'ultimo
  errore propaga (non viene silenziato). Guidare il backoff con un clock fake
  (niente attese reali nei test).

## Execution

*(vuota finché non promosso.)*

## Review

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
