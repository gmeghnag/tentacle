# Steering over RPC — piano: "Queue a task…" (enqueue) su worker/pod/remote

> **Status:** merged to `main` (2026-10-19, branch `fix/steering-over-rpc`, two adversarial reviews + post-review fixes): `daemon/src/mapping.ts` now maps `steer` → `{ type: "steer", text }` and `session/enqueue` is wired end-to-end (protocol → daemon → client → cli → tui), with the TUI reconciling the optimistic ⏳ row on an enqueue reject. See §Execution below. · legacy doc (pre-AGENTS §10); §1–§7 are the approved plan, §Execution is the as-built record

`Type: fix · Size: M · Blast: load-bearing · Suited: strong model`

**Stato:** implementato; fix post-review applicati (vedi *Fix post-review* in fondo). Referenziato da `TODO.md` Block 4.

---

## 1. Problema

Il TUI in mezzo al turn invia il task con `sessionRef.current?.enqueue(text)`
(`tui/App.tsx:451`) — metodo **opzionale** su `SessionController`. Esiste solo
sul `Session` locale (`agent/src/session.ts:83`); le altre tre vie
(worker default, `run`, `exec`, `connect`) costruiscono il controller da
`RemoteSession` avvolto in `persistingController`
(`cli/local-runtime.ts`), che **non espone `enqueue`** → il task viene
**droppato in silenzio** (niente ⏳, niente notifica, niente errore).

Inoltre il daemon **scarta** gli eventi `steer` del modello
(`daemon/mapping.ts`, `case "steer": return null` — "not yet wired over the
wire"), quindi anche se l'enqueue arrivasse, il TUI non saprebbe che il
messaggio è stato iniettato (la riga ⏳ resterebbe a schermo).

La parte agent-side è già tutta fatta: `Session.enqueue` spinge nella
`steering` queue e `Agent.runMessages` la drena a ogni model-round boundary,
emettendo `{ type: "steer", text }` (`agent.ts:198-270`, incluso il
late-steer prima di `turn_end`). Manca solo il **wire**.

## 1b. Precondizione architetturale (VERIFICATA — non romperla)

L'intera feature dipende dal fatto che il daemon processi le request inbound
**in parallelo**, non in serie: `session/prompt` è una request long-running
(dura tutto il turn) e `session/enqueue` deve essere servita **mentre quella è
ancora in volo**. Verificato nel codice:

- `transport/peer.ts:176` fa `void this.handleRequest(...)` (fire-and-forget,
  **non-awaited**) → ogni request inbound gira concorrente.
- `daemon/connection.ts` non ha mutex/coda: lo `switch` sul metodo invoca
  l'handler direttamente, nessuna serializzazione per-connessione o per-sessione.

**Conseguenza per chi implementa:** NON introdurre await/lock che serializzino
gli handler della `Connection` (annullerebbe il meccanismo: l'enqueue
arriverebbe solo a turn finito). L'handler di `session/enqueue` è sincrono
(push nella queue + `return {}`), quindi risolve immediatamente anche con un
`session/prompt` in corso.

## 2. Design

Due aggiunte **additive** al protocollo (versione resta **1**):

1. **`session/enqueue`** — request client→daemon:
   `params: { sessionId, text }`, `result: {}`.
   Il daemon la inietta nella `steering` queue della `Session` host-side;
   il modello la vede al prossimo boundary, come in locale.
2. **`steer`** — nuova variante di `session/update`
   (`{ type: "steer", text }`), streamata dal daemon al momento dell'
   iniezione. Il TUI (`App.tsx:316`) fa già `setQueued(q => q.slice(1))`
   su evento `steer` → la riga ⏳ si rimuove **FIFO**.

### 2a. Compatibilità di versione (precisazione — la v1 del piano era imprecisa)

Client e daemon di norma **shippano insieme** (stesso binario/versione), quindi
nel caso comune non esistono "client vecchi". La coppia è comunque sicura, ma
NON per i motivi scritti prima; i meccanismi reali, che contano SOLO per
`connect` verso un daemon remoto di versione diversa (F3):

- **Metodo (`session/enqueue`):** un daemon **vecchio** risponde
  `MethodNotFound` (−32601). È un errore **pulito e catchabile** → lo gestiamo
  lato client riconciliando la lista ⏳ + un avviso (vedi §3 `tui`). Questo è il
  vero motivo per cui la scelta *request* (non notification) ripaga: il fallimento
  è osservabile.
- **Update (`steer`):** un **client vecchio** che riceve un `type:"steer"`
  sconosciuto **non lo "ignora"**: la union `SessionUpdateSchema` non ha un
  membro corrispondente, quindi il parse lato client lo scarta/erra. Non è un
  problema di correttezza (il client vecchio semplicemente non mostra l'echo;
  `turn_end` ripulisce comunque la lista ⏳, vedi sotto), ma **non va descritto
  come "ignorato grazie a membri non-`.strict()`"**: `.strict()` riguarda campi
  extra su un oggetto, non un discriminante `type` sconosciuto.

### 2b. Semantica e convergenza dello stato ⏳ (il punto delicato)

L'`enqueue` ha senso solo **durante un turn** (il TUI lo chiama solo se
`stateRef.current.running`). La lista ⏳ (`queued` in `App.tsx`) è stato
**ottimistico** del client: una riga viene aggiunta appena si chiama `enqueue`,
e rimossa **FIFO** quando arriva l'echo `steer`. Su un boundary il modello drena
`this.steering.splice(0)` (TUTTI i pending) e `agent.ts` emette **un `steer` per
testo, in ordine** → N enqueue ⇒ N echo `steer` ⇒ N rimozioni FIFO: i conteggi
combaciano.

Divergenze possibili SOLO via RPC (assenti in locale, dove `enqueue` è sincrono
e non può fallire), e come convergono:

- **Enqueue che arriva al daemon dopo `turn_end` (race di latenza):** l'handler
  fa comunque `push` nella queue e **risponde `{}` (successo)**; quel testo
  resta nella `steering` e viene **azzerato dal prossimo `send`**
  (`Session.send` → `this.steering = []`). Lato client, a `turn_end`
  `App.tsx:329` fa `setQueued([])`. Gli stati **convergono**: nessun fantasma
  persistente. L'unica perdita è un messaggio digitato nell'ultimissima finestra
  del turn, scartato silenziosamente — ambiguità accettabile.
- **Enqueue che fallisce davvero (reject):** solo `MethodNotFound` (daemon
  remoto vecchio via `connect`), oppure un drop del transport a metà turn. NB:
  `UnknownSession` da `/clear` mid-turn **non** si verifica, perché `/clear` è
  già guardato durante un turn (Block 6, `isSessionMutating`). In questi casi la
  entry ⏳ ottimistica **non riceverà mai** un `steer` → va **riconciliata** sul
  reject (vedi §3 `client` item 8 + `tui`), altrimenti maschera un invio mai
  avvenuto come se fosse riuscito (stessa classe del bug originale, solo con un
  ⏳ transitorio fino a `turn_end`).

**Decisione:** `session/enqueue` resta una **request** (non notification) e il
suo esito viene **usato** (prima il piano lo buttava via con `.catch(()=>{})`):
su reject si rimuove una entry ottimistica dalla lista ⏳ e si mostra un avviso.
Questo chiude il silent-drop e rende coerente la scelta request-vs-notification.

## 3. File da modificare (11)

### protocol (fonte di verità condivisa)
1. `packages/protocol/src/session.ts` — dopo `SnapshotResultSchema`:
   ```ts
   // --- session/enqueue (steering) ----------------------------------------
   export const EnqueueParamsSchema = z
     .object({ sessionId: SessionIdSchema, text: z.string().min(1) })
     .strict();
   export type EnqueueParams = z.infer<typeof EnqueueParamsSchema>;

   export const EnqueueResultSchema = z.object({}).strict();
   export type EnqueueResult = z.infer<typeof EnqueueResultSchema>;
   ```
2. `packages/protocol/src/methods.ts` — import dei due schemi;
   `Method.Enqueue: "session/enqueue"`; voce in `RequestSchemas`.
3. `packages/protocol/src/updates.ts` —
   ```ts
   /** A user message queued mid-turn was injected into the running turn. */
   export const SteerSchema = z.object({
     type: z.literal("steer"),
     text: z.string(),
   });
   ```
   + `SteerSchema` nell'array di `SessionUpdateSchema`.

### daemon
4. `packages/daemon/src/hosted-session.ts` — delega alla `Session` host-side
   (riuso totale della steering queue esistente):
   ```ts
   /** Queue a user message for injection at the next model-round boundary. */
   enqueue(text: string): void {
     this.session.enqueue(text);
   }
   ```
5. `packages/daemon/src/connection.ts` — import `EnqueueParams`/`EnqueueResult`;
   `case Method.Enqueue: return this.enqueue(params as EnqueueParams);`;
   handler privato (stesso pattern di `compact`/`snapshot`):
   `UnknownSession` se assente, `hosted.enqueue(text)`, `return {}`.
6. `packages/daemon/src/mapping.ts` (`eventToUpdate`) —
   ```ts
   case "steer":
     return { type: "steer", text: event.text };
   ```
   e rimuovere `steer` dal gruppo `return null` + il commento
   "Steering is a local-TUI interaction; not yet wired over the wire".
   Copre da solo **entrambi** i punti di iniezione di `agent.ts`
   (drain a inizio-round e late-steer pre-`turn_end`): entrambi
   `yield { type: "steer", text }` e `HostedSession.prompt` mappa ogni
   evento con `eventToUpdate`.

### client
7. `packages/client/src/remote-client.ts` —
   ```ts
   /** Queue a user message for the running turn (steering, mid-turn only). */
   enqueue(sessionId: string, text: string): Promise<void> {
     return this.peer
       .request(Method.Enqueue, { sessionId, text })
       .then(() => undefined);
   }
   ```
8. `packages/client/src/remote-session.ts` — **ritorna la Promise, NON
   ingoiare** l'esito (così il TUI può riconciliare la riga ⏳ su un fallimento,
   vedi `tui` sotto). La firma passa a `Promise<void>`:
   ```ts
   /**
    * Queue a user message mid-turn (steering). Resolves when the daemon has
    * accepted it; REJECTS on a delivery failure (MethodNotFound from an older
    * remote daemon, or a transport drop) so the caller can reconcile the
    * optimistic ⏳ entry. A no-op (resolved) before the first send.
    */
   enqueue(text: string): Promise<void> {
     if (!this.id) {
       return Promise.resolve();
     }
     return this.client.enqueue(this.id, text);
   }
   ```
   (Rispetto alla v1 del piano: via il `void … .catch(() => {})`. Chi assorbe
   l'errore è ora il chiamante nel TUI, che lo USA per riconciliare.)
9. `packages/client/src/mapping.ts` (`updateToEvent`) —
   `case "steer": return { type: "steer", text: update.text };` → fluisce
   già nella `AsyncQueue` di `RemoteSession.send`; niente altro.

### cli
10. `packages/cli/src/local-runtime.ts` (`persistingController`) —
    pass-through che **propaga** l'eventuale Promise (come `compact`):
    ```ts
    enqueue(text) {
      return inner.enqueue(text);
    },
    ```
    `inner` è il `RemoteSession`: ritorna la sua `Promise<void>`. (Il tipo del
    metodo nel `SessionController` diventa `void | Promise<void>` — vedi item 11
    — così il pass-through è valido sia che `inner` ritorni `void` sia `Promise`.)

### tui (interfaccia + riconciliazione — NON più solo cosmetico)
11. `packages/tui/src/App.tsx` — tre modifiche:

    **(a) Allargare la firma** del controller a `void | Promise<void>` (il
    `Session` locale resta `void`, il remoto ritorna `Promise`), e aggiornare il
    doc-comment (via "(local sessions only)"):
    ```ts
    /** Queue a message mid-turn (steering); optional. */
    enqueue?(text: string): void | Promise<void>;
    ```
    (`SessionController.enqueue`, oggi `App.tsx:48`, `?(text: string): void`.)

    **(b) Riconciliare la lista ⏳ sul fallimento della delivery.** Il blocco
    submit mid-turn (oggi `App.tsx:450-456`) oggi è:
    ```ts
    if (stateRef.current.running) {
      if (sessionRef.current?.enqueue) {
        sessionRef.current.enqueue(text);
        setQueued((q) => [...q, text]);
      }
      return;
    }
    ```
    diventa:
    ```ts
    if (stateRef.current.running) {
      const ctrl = sessionRef.current;
      if (ctrl?.enqueue) {
        setQueued((q) => [...q, text]); // ottimistico (UX reattiva)
        // enqueue può essere sincrono (locale) o una Promise (worker/pod/
        // connect). Su un reject (MethodNotFound da un daemon remoto vecchio,
        // o transport drop) la entry non riceverà mai un echo `steer`: va tolta,
        // altrimenti maschera un invio mai avvenuto. `Promise.resolve(...)`
        // normalizza il caso sincrono (non rigetta mai → nessun cambiamento in
        // locale). Si rimuove UNA entry (la lista è a conteggio, come la
        // rimozione FIFO su `steer`); quale label è cosmetico.
        Promise.resolve(ctrl.enqueue(text)).catch(() => {
          setQueued((q) => (q.length > 0 ? q.slice(0, -1) : q));
          pushNotice("_steering non disponibile su questo daemon — messaggio non accodato._");
        });
      }
      return;
    }
    ```
    `pushNotice` esiste già (`App.tsx:280`). Non toccare la rimozione su `steer`
    (`App.tsx:316`, `slice(1)`) né il clear a `turn_end` (`App.tsx:329`).

    **(c)** Nessun'altra modifica al TUI: il routing update→`send`→`steer`→
    `slice(1)` è già in piedi.

## 4. Test da aggiungere (6 file)

1. `packages/protocol/test/updates.test.ts` — `{ type: "steer", text: "…" }`
   nell'array `variants` (parse) + select della union.
2. `packages/protocol/test/methods.test.ts` — `session/enqueue` presente in
   `Method` con params+result; `EnqueueParamsSchema` valida
   `{ sessionId, text }` e rifiuta senza `text` / `text: ""`.
3. `packages/daemon/test/integration.test.ts` — end-to-end in-memory
   (stesso `harness` dei test esistenti). **Due casi:**
   - **happy path:** model `ScriptedProvider` a 2 round (round 1: `tool_call`
     + `done`; round 2: `text` + `done`); `initialize` → `session/new` →
     `client.request("session/prompt", …)` **senza await** → `tick()` →
     `client.request("session/enqueue", { sessionId, text: "steer me" })` →
     await del prompt. Assert: negli `updates` c'è un `steer` con
     `text: "steer me"`; il prompt risolve con `end_turn` (il modello ha fatto
     la round in più — se l'enqueue non arrivasse, terminerebbe dopo la round 1).
   - **ordine con enqueue multipli (NUOVO):** model a ≥3 round; durante il turn
     due enqueue consecutivi `"A"` poi `"B"` **sullo stesso boundary**; assert
     che gli `updates` contengono `steer "A"` **prima** di `steer "B"` (N
     enqueue ⇒ N echo, **in ordine** — è l'invariante da cui dipende la
     rimozione FIFO lato TUI). Verificare che la concorrenza regge: l'enqueue
     risolve mentre il `prompt` è ancora pending (non deve andare in timeout).
4. `packages/client/test/remote.test.ts` — `RemoteSession.enqueue`, **due casi:**
   - **happy path:** schema a 2 round; dentro un `for await` sulla `send`
     (prima round) chiamare `await session.enqueue("steer me")`; assert che gli
     eventi raccolti includono `{ type: "steer", text: "steer me" }` e che
     `turn_end` è l'ultimo.
   - **reject propagato (NUOVO):** un peer finto in cui `Method.Enqueue`
     risponde `MethodNotFound` (o il canale è chiuso); assert che
     `session.enqueue("x")` **rigetta** (la Promise non viene ingoiata) — è ciò
     che permette al TUI di riconciliare. Verificare anche il no-op pre-`send`:
     `enqueue` prima della prima `send` risolve senza toccare il peer.
5. `packages/cli/test/local-runtime.test.ts` — `persistingController`:
   stub `inner` con `enqueue: spy` che ritorna una Promise; assert che
   `controller.enqueue(text)` chiama `inner.enqueue(text)` **e ne ritorna il
   valore** (propagazione della Promise, non solo fire-and-forget).
6. `packages/tui/test/app.test.tsx` (o il file di steering TUI esistente) —
   **riconciliazione ⏳ (NUOVO):** render con un `createSession` finto il cui
   `enqueue` ritorna `Promise.reject(...)`; avviare un turn (model che resta in
   un tool call), digitare un messaggio mid-turn + Enter; assert che la riga
   `⏳` compare **e poi sparisce** dopo il reject, e che un avviso
   ("non accodato") viene mostrato. Caso gemello di controllo: con `enqueue`
   che **risolve** ma senza emettere `steer`, la riga resta finché non arriva
   l'echo (o `turn_end`). Copre il buco che la v1 del piano lasciava aperto.

Stile repo: double quotes, trailing commas, **niente `!`** (assert
condizionali alla maniera dei test esistenti).

## 5. Validazione

1. `bun run typecheck` → 0.
2. `bun run lint` → 0 error.
3. `bun test` → verde (baseline del branch al momento dell'implementazione +
   i nuovi; al 2026-10-16 la baseline è 540 pass / 0 fail / 1 skip).
4. Manuale (da fare dopo, con il binary): TUI locale via worker (default),
   turn lungo (es. task con tool call), in mezzo digitare "poi anche X" +
   Enter → si vede la riga `⏳ poi anche X`; quando il modello la inietta
   la riga scompare e il modello risponde a entrambi. Stesso su
   `run`/`exec`/`connect`.
5. **Non-regress**: `--in-process` continua a funzionare (il controller
   locale non è toccato); `steer` resta assente dalle snapshot/persist
   (non è una `ChatMessage`, è solo un evento di rendering).

## 6. Note / debiti

- `session/enqueue` è un **request** (risposta `{}`): la scelta è giustificata
  SOLO perché l'esito viene **usato** (riconciliazione ⏳ su reject, §3 `tui`).
  Se mai lo si degradasse a notification (niente round-trip), allora i failure
  tornerebbero invisibili e la riconciliazione andrebbe tolta dal piano: le due
  cose vanno insieme.
- Correlazione `steer`↔`enqueue` **per conteggio FIFO**, non per id: ereditata
  dal design locale (il `steer` agent-side porta solo `text`). È accettabile —
  N enqueue ⇒ N echo in ordine (test 3, caso ordine) + clear a `turn_end`
  garantiscono convergenza. Un id esplicito (TUI→enqueue→steering→steer→TUI)
  renderebbe la rimozione puntuale ma toccherebbe l'`Agent` core: **fuori
  scope**, debito annotato. Nota conseguenza: due enqueue con lo **stesso testo**
  mostrano due righe ⏳ indistinguibili (cosmetico — vengono comunque rimosse
  una per echo).
- Se il client si disconnette a metà-turn, il text enqueue'd resta nella queue
  host-side e viene azzerato al prossimo `send` — coerente con locale.
- Guard `sessionRef.current?.enqueue` (`App.tsx:451`): dopo il fix **tutte** le
  vie espongono `enqueue`, quindi la guard ha sempre un metodo. Il fallimento di
  *delivery* (daemon remoto vecchio via `connect`) NON è coperto dalla guard —
  è coperto dalla riconciliazione sul reject (§3 `tui`).

## 7. Riepilogo delle revisioni rispetto alla v1 del piano

1. **§1b (nuovo):** esplicitata la precondizione di concorrenza delle request
   (verificata: `peer.ts:176` non-awaited, nessun mutex in `connection.ts`) con
   il monito di non serializzare gli handler.
2. **§2a:** corretta la motivazione sulla compatibilità di versione (la v1 diceva
   "ignorato grazie a membri non-`.strict()`", sbagliato; i meccanismi reali sono
   `MethodNotFound` lato metodo e scarto del discriminante sconosciuto lato
   update, rilevanti solo per `connect`/F3).
3. **§2b + §3 item 8 + item 11:** `session/enqueue` non è più fire-and-forget;
   `RemoteSession.enqueue` ritorna la Promise, il TUI **riconcilia la lista ⏳
   sul reject** (chiude il silent-drop che la v1 lasciava aperto, e rende
   coerente la scelta request-over-notification).
4. **§4:** aggiunti i due casi che mancavano (ordine con enqueue multipli;
   reject propagato) + il test TUI di riconciliazione; `local-runtime` ora
   asserisce la propagazione della Promise.

---

## Execution (as-built, 2026-10-19 — Qwen3.8-27B)

Seguito il piano §3 nell'ordine protocol → daemon → client → cli → tui.
Tutti i 11 file + i 6 test file del §4 sono fatti; nessun drift di design.

**Precondizioni verificate contro il source (prima di scrivere):**
- `transport/peer.ts` dispatch concorrente (`void this.handleRequest`, non
  awaited) e `daemon/connection.ts` senza mutex → §1b confermato.
- `AgentEvent` ha già la variante `steer` (`agent.ts:87`), emessa da **entrambi**
  i punti di iniezione (drain a inizio-round `agent.ts:204` e late-steer
  `agent.ts:274`) → il `case "steer"` in `mapping.ts` copre entrambi da solo.
- La firma `SessionController.enqueue` era `?(text): void` (`App.tsx:50`), allargata
  a `void | Promise<void>` (item 11a del piano).

**Deviazioni dal piano (tutte di dettaglio, nessuna di design):**
1. **Righe `App.tsx` stantie:** il piano citava 48/316/329/450-456; nel code
   corrente il blocco mid-turn è a `App.tsx:495-511`, la rimozione su `steer` a
   `App.tsx:354`, il clear a `turn_end` a `App.tsx:366`. Logica identica; toccati
   solo i punti corretti (allargamento firma + riconciliazione sul reject).
2. **Test daemon §4.3 — la "window" di enqueue non è un `SlowProvider` nel
   round 1 ma una `slowEnv` (exec 200 ms).** Il modello scripted è istantaneo,
   quindi il turno finiva prima che l'enqueue arrivasse (drain vuoto → nessun
   `steer`). La window deterministica è lo **slow tool exec**: il client vede
   l'update `tool_call` mentre l'exec è ancora in corso → l'enqueue atterra prima
   del prossimo boundary. In più il round 2 del modello **echoa l'ultimo user
   message** (`echo-steer`), così il test asserisce che il modello ha davvero
   *visto* il testo steered (`model.calls[1].messages.at(-1) === "steer me"`) —
   più forte (non vacuo) del solo "c'è un update `steer`".
3. **Test client §4.4 reject:** `RemoteClient.peer` è `private`, quindi il
   "daemon vecchio che risponde `MethodNotFound`" è simulato con un **peer fake
   grezzo** (`RpcPeer`) che risponde a `initialize`/`session/new`/`session/prompt`
   e getta `RpcError(MethodNotFound)` su `session/enqueue`. Si asserisce
   `rejects.toMatchObject({ code: -32601 })` (la proprietà esatta che abilita la
   riconciliazione TUI). Il no-op pre-`send` è testato a sé (enqueue risolve senza
   toccare il peer).
4. **Test cli §4.5:** `persistingController` è testato **direttamente** (stub
   `inner` con `enqueue` che resolve/rigetta + cast), asserendo la propagazione
   della Promise (il caso reject fallisce se la Promise viene ingoiata).

**Non-vacuity (mutation, §9) — 3 mutazioni, tutte fanno fallire un test:**
- Rimossa la `.catch` di riconciliazione in `App.tsx` → il test TUI reject
  fallisce (⏳ resta + unhandled rejection). Revert → green.
- `mapping.ts` `case "steer": return null` (vecchio comportamento) → falliscono
  i 3 test dell'echo `steer` (daemon ×2 + client ×1). Revert → green.
- `local-runtime.ts` `enqueue` che `void inner.enqueue()` (non propaga) → il
  test cli fallisce sul caso reject. Revert → green.

**Gate:** `bun run typecheck` 0 · `bun run lint` 0 · `bun test` 739 pass /
1 skip (opt-in k8s) / 0 fail (baseline del ramo + 7 nuovi test).

---

## Review (adversarial, fresh context)

*— claude-opus-5-5, 2026-10-19 (modello diverso dall'executor Qwen3.8-27B; contesto fresco, stessa sessione del richiedente)*

**Verdetto: REQUEST-CHANGES** — il wire è corretto e i test non sono vacui, ma
restano **due silent-drop** della stessa classe del bug originale (F1, F2).

**Gate (rieseguito):** `bun run check` → typecheck 0 · lint 0 (256 file) ·
`bun test` **739 pass / 1 skip (opt-in k8s) / 0 fail**. Coincide con Execution.

### Findings

1. 🟠 **Silent drop al primo turno (non coperto dal piano).**
   `client/src/remote-session.ts:45` — `enqueue` con `this.id` ancora nullo
   risolve no-op. Ma `id` viene assegnato solo dopo `await openSession` dentro
   `send`, mentre il TUI ha già `running = true`: un messaggio digitato durante
   l'RTT di `session/new` (più ampio su `connect`/pod e con `--resume`, che invia
   i seed) risolve "con successo", non arriva mai al daemon, e la riga ⏳ sparisce
   a `turn_end` come se fosse stata iniettata. Repro (`.tentacle/tmp/steering-review/race.ts`,
   daemon reale in-memory): `send()` avviato → `enqueue("early")` subito →
   `enqueue: resolved | steer events: 0 | model saw: ["go"]`.
   Fix suggerito: memorizzare la Promise di `openSession` e farla attendere a
   `enqueue` (o rigettare se nessuna sessione è in apertura).
2. 🟡 **Enqueue a turno finito = successo finto.** `daemon/src/connection.ts:155`
   accetta l'enqueue anche a sessione idle, e il prossimo `Session.send`
   (`agent/src/session.ts:65`) lo azzera. Repro: dopo `send("t1")` completo,
   `enqueue("late")` → `resolved`, il modello non vede mai `late`. Il piano (§2b)
   lo accetta esplicitamente, ma AGENTS §8 dice "a silent drop is a bug — design
   it out or surface it", e su RPC la finestra è la latenza di rete, non un tick.
   Rimedio economico: `HostedSession.running` esiste già
   (`hosted-session.ts:68`) → rigettare se `!running` (il TUI già riconcilia +
   avvisa). Resta una finestra residua tra l'ultimo drain late-steer
   (`agent.ts:270`) e `controller = null`: decisione del proprietario se basta.
3. nit — `tui/src/App.tsx:507`: l'avviso dice "steering not available on this
   daemon" per **qualsiasi** reject (transport drop, `UnknownSession`, e il
   futuro `!running` di F2): fuorviante. Meglio un testo neutro o mappare il code.
4. nit — `cli/src/local-runtime.ts:88`: il commento "Steering is fire-and-forget
   at this seam" contraddice il codice (la Promise viene propagata apposta).
5. nit — test TUI (`tui/test/queue.test.tsx`) basati su delay 20/80/140 ms:
   rischio flaky sotto carico; accettabile perché ricalca lo stile del file.
6. processo — header doc ancora con `**Stato:** **non implementato** (piano)`
   (riga 5) e senza la riga `Type · Size · Blast · Suited`. Blast reale:
   **load-bearing** (schema di protocollo + invariante di concorrenza del peer):
   AGENTS §10 instrada load-bearing a un modello forte; l'ha eseguito Qwen 27B.
   Il risultato è buono, ma F1 è esattamente un buco da "modello debole su path
   load-bearing" (race non enumerata nei failure modes).

### Tabella premesse

| Premessa | Esito |
|---|---|
| Sintomo: su worker/pod l'enqueue è droppato (`persistingController` senza `enqueue`, daemon `steer → null`) | TRUE (diff rimuove entrambi) |
| `transport/peer.ts` dispatch concorrente | TRUE (`peer.ts:291` `void this.handleRequest`) |
| `connection.ts` senza mutex | TRUE |
| `agent.ts` emette `steer` in entrambi i punti | TRUE (`agent.ts:204`, `:274`) |
| `Session.send` azzera la steering queue | TRUE (`session.ts:65`) — è ciò che rende silenzioso F2 |
| "enqueue prima della prima send non accade" (implicito in §3 item 8) | **FALSE** — accade durante `openSession` (F1) |

### Mutation (rifatte da me, non fidandomi di Execution)

| Mutazione | Esito |
|---|---|
| daemon `mapping.ts` `steer → null` | 3 fail (daemon + client) ✅ |
| `RemoteSession.enqueue` ingoia (`.catch(()=>{})`) | 1 fail ✅ |
| `Connection.enqueue` non chiama `hosted.enqueue` | 2 fail ✅ |
| TUI: rimosso `pushNotice` nel catch | 1 fail ✅ |
| client `mapping.ts` `steer → null` | 1 fail ✅ |

Revert verificato: hash di `git diff` identico prima/dopo.

### Attacchi tentati

- **Race primo turno** (enqueue durante `openSession`) → **trovato F1**.
- **Race fine turno** (enqueue dopo `turn_end`) → **trovato F2**.
- **Ordinamento prompt/enqueue back-to-back** (l'enqueue può arrivare prima del
  reset `steering = []`?) → nulla: `HostedSession.prompt` arriva a `session.send`
  senza await intermedi e le request sono dispatchate in ordine di arrivo.
- **Pod non fidato (§7)**: un pod può inviare `steer` fasulli → effetto solo
  cosmetico (rimuove righe ⏳ lato laptop), nessuna approvazione né effetto
  laptop-side. Nulla.
- **Version skew**: un client vecchio non riceve mai `steer` (si genera solo da
  un enqueue, che il vecchio client non invia); daemon vecchio → `MethodNotFound`
  → riconciliato (test client + TUI). Regge.
- **Persistenza**: il testo steered entra in `messages` come `user`
  (`agent.ts:273`) → finisce nello snapshot e su disco; l'evento `steer` no.
  Regge (§7 "persist only ChatMessages").
- **Prior art**: `docs/eval/remote-execution-model.md` impone "dopo il pezzo 1"
  (`pod-model-streaming`, done) → rispettato. Nota: senza il pezzo 2
  (`rpc-flow-control`) un enqueue in pod può accodarsi dietro dati bulk — non
  bloccante, ma va tenuto a mente.

### Cosa regge

Wire additivo e simmetrico (protocol → daemon → client → cli → tui), versione 1
intatta, nessuna serializzazione del peer, riconciliazione ⏳ sul reject
funzionante, test non vacui (incluso il controllo che il modello *veda* il testo
steered, più forte del piano).

### Comportamento dell'executor

Ha seguito il piano in ordine, documentato le derive con onestà e rafforzato i
test oltre il piano (echo del modello, peer fake per `MethodNotFound`); le
mutazioni dichiarate sono riproducibili. Non ha però messo in discussione il
piano: F1 è una race fuori dai failure modes enumerati, F2 è stata ereditata
come "accettabile" senza confrontarla con AGENTS §8. Header del doc non aggiornato.

---

## Fix post-review (2026-10-19)

*— claude-opus-5-5, 2026-10-19 (lo stesso modello della Review precedente: serve una nuova Review in contesto fresco)*

Applicati F1–F4 della Review. Ogni fix ha un test **visto rosso** sul codice
precedente, poi verde.

1. **F1, primo turno** — `client/src/remote-session.ts`: `send` tiene la Promise
   di `session/new` in `opening`; `enqueue` senza `id`, ma con `opening` in
   volo, la attende e poi invia. L'ordine resta prompt → enqueue (la reazione di
   `send` sulla stessa Promise è registrata per prima). Senza nessuna `send`
   resta un no-op. Test: `remote.test.ts` "enqueue while the first send is still
   opening the session is delivered" (prima: 0 eventi `steer`).
2. **F2, enqueue a sessione idle** — nuovo `DomainErrorCode.NoTurnRunning`
   (`-32008`, additivo, `transport/src/errors.ts`); `Connection.enqueue` lo
   lancia se `!hosted.running`, e il TUI già riconcilia e avvisa. Test:
   `integration.test.ts` "session/enqueue with no turn running rejects with
   NoTurnRunning". **Nessun residuo sui transport reali:** dal drain late-steer
   (`agent.ts:270`) a `controller = null` il percorso è tutto sincrono e passa
   solo per microtask (yield di `turn_end` lungo la catena di generator,
   `persist()` sincrono). Un messaggio di transport (WS, worker `postMessage`,
   exec WS del pod) è un macrotask e non può inserirsi. Fa eccezione solo il
   canale in-memory dei test (`queueMicrotask`). La garanzia è un invariante
   implicito, ora scritto come commento su `agent.ts` (nessuna `await`, quindi
   niente hook di fine turno né persist asincrono, in quel tratto). Non c'è un
   test: dipenderebbe dall'ordine dei microtask e sarebbe fragile.
3. **F3, avviso TUI** — `App.tsx`: il notice riporta la causa reale
   (`message not queued: <error.message>`) invece di presumere un "daemon
   vecchio". Test: `queue.test.tsx` asserisce `method not found`.
4. **F4** — corretto il commento "fire-and-forget" in `cli/src/local-runtime.ts`.

E2E (`.tentacle/tmp/steering-review/race.ts`): race1 →
`steer events: 1 | model saw: [... "early"]`; race2 →
`rejected RpcError: no turn is running`.

**Gate:** `bun run check` → typecheck 0 · lint 0 · `bun test` **741 pass / 1 skip
(opt-in k8s) / 0 fail** (+2 test rispetto alla Review).

---

## Review 2 (adversarial, fresh context)

*— claude-opus-5-5, 2026-10-19. **Stesso modello** della Review 1 e dei fix post-review: contesto fresco, ma i punti ciechi del modello possono sopravvivere a entrambi i passaggi. Per un task `load-bearing` AGENTS §10 chiede un modello diverso.*

**Verdetto: REQUEST-CHANGES.** È una richiesta piccola. Il codice è corretto e il gate è verde. La finestra late-steer → `controller = null` è chiusa sui transport reali: l'ho misurato. Due cose però non reggono:
(1) l'invariante che la tiene chiusa non è coperta da nessun test: con la mutazione la suite resta verde e sui transport reali si perdono messaggi in silenzio (F2);
(2) la frase "drenato oppure rifiutato" è falsa sul percorso `max_iterations`, raggiungibile col default di 16 round (F1).

**Gate (rieseguito):** `bun run check` → typecheck 0 · lint 0 (256 file) · `bun test` **741 pass / 1 skip (opt-in k8s) / 0 fail** (742 test, 91 file). Coincide con *Fix post-review*.

### Findings

1. 🟠 **Medium: un enqueue accettato va perso in silenzio quando il turno finisce per `max_iterations`.** Riferimenti: `agent/src/agent.ts:341-404` (il percorso del cap non ha nessun drain), `daemon/src/connection.ts:162`.
   - Durante l'ultimo round consentito (exec del tool, poi il round finale in prosa senza tool) `hosted.running` è `true`, quindi l'enqueue riceve `{}`.
   - Il percorso del cap però non chiama mai `drainSteering`: il testo resta nella coda e il prossimo `send` lo azzera. Il TUI vede `turn_end` e svuota la riga ⏳ come se il messaggio fosse stato iniettato.
   - Repro (`maxiter.ts`, sotto): `max_iterations | enqueue: resolved | steer events: 0 | last: turn_end:max_iterations | model saw: false`.
   - Il difetto esiste già in locale (`Session.enqueue` si comporta allo stesso modo), quindi non è una regressione di questo diff. Ma il commento in `agent.ts:270-275` e il *Fix post-review* §2 ("drained here or rejected") lo presentano come un caso chiuso: valgono solo per `end_turn`.
   - Il default è `DEFAULT_MAX_ITERATIONS = 16` (`config/src/defaults.ts:11`), e un turno lungo è proprio quello in cui l'utente fa steering.
   - Rimedio minimo: limitare commento e doc al percorso `end_turn` e aprire una voce TODO. Rimedio vero: drenare nel round finale (iniettare i testi in `finalMessages` ed emettere `steer`), oppure segnalare i testi rimasti.
   - Su `cancelled` la perdita è voluta (l'ha chiesta l'utente). Su `model_error` il messaggio era già stato drenato (repro: `steer events: 1 | model saw: true`).
2. 🟠 **Medium: l'invariante "nessuna `await` dal late drain a `turn_end`" non è coperta da test.**
   - Mutazione M4: `await new Promise((r) => setTimeout(r, 1))` prima di `yield { type: "turn_end", reason: "end_turn" }`. Risultato: **suite verde (741/1/0)**.
   - Lo stress test (`window.ts`) con la stessa mutazione dà **DROPPED 51–103 su 150** sia su MessagePort sia su WebSocket. Senza la mutazione dà 0.
   - L'invariante quindi regge davvero il carico ed è protetta solo da un commento. Il doc rinuncia al test perché "fragile", ma un test deterministico esiste.
   - Come scriverlo, in `agent` o in `session`: nel callback `drainSteering`, alla chiamata che ritorna `[]`, programmare `setTimeout(() => (fired = true), 0)`, poi verificare che il consumer riceva `turn_end` con `fired === false`. Una `await` su timer o I/O inserita dopo viene programmata più tardi e fa fallire il test. Non dipende dall'ordine dei microtask.
   - Rischio concreto: `docs/fix/daemon-compact-turn-guard.md` prevede di toccare proprio lo stato busy di `HostedSession.prompt`.
3. 🟡 **Low: la riconciliazione di un reject in ritardo è a conteggio e non legata al turno.** Riferimento: `tui/src/App.tsx:505-506`.
   - Sequenza: un `NoTurnRunning` della corsa di fine turno arriva dopo che l'utente ha già avviato il turno successivo e accodato un altro messaggio.
   - Effetto: `slice(0, -1)` toglie la riga ⏳ del messaggio **nuovo**, che è stato accettato. La riga sparisce prima del tempo, ma il messaggio viene consegnato e compare come user item allo `steer`.
   - È solo cosmetico e la finestra dura un RTT. Fix possibile: legare la riconciliazione a un contatore di turno.
4. nit: **sul `NoTurnRunning` di fine turno il testo digitato si perde** (resta solo il notice). Si potrebbe rimetterlo nell'input oppure inviarlo come nuovo turno.
5. nit, sul doc (*Fix post-review* §2):
   - "Un messaggio di transport è un macrotask" è impreciso per `streamChannel` (`transport/src/stream-channel.ts:43-54`, pod stdio): le righe di un chunk vengono consegnate **in modo sincrono nello stesso task**. La conclusione regge lo stesso: tra una riga e l'altra non girano microtask, quindi un enqueue nello stesso chunk finisce *prima* del drain.
   - Il drain citato a `agent.ts:270` ora è a `:276`.
6. nit, §7 pod non fidato: `App.tsx:507-508` mostra nel notice un `error.message` scelto dal pod. È la stessa classe del percorso `failTurn` già esistente: nessun privilegio nuovo, nessun effetto lato laptop, ma niente sanitizzazione.
7. Osservazione fuori scope, letta nel codice e non eseguita: un Esc durante `opening` non annulla il turno. `onAbort` viene registrato solo dopo l'apertura (`remote-session.ts:79`), e se il signal è già abortito il listener non scatta mai. Esisteva già prima di questo diff, che non lo cambia.

### Tabella premesse (claim nuovi del *Fix post-review*)

| Premessa | Esito |
|---|---|
| Sintomo originale (worker/pod scartano l'enqueue) | TRUE: il diff aggiunge `persistingController.enqueue` (`local-runtime.ts:90`) e `steer` in `daemon/mapping.ts` |
| Dal late drain a `controller = null` girano solo microtask (yield di generator, `persist()` sincrono) | TRUE: letto `hosted-session.ts:93-117` e `session.ts:62-75`. Il daemon non ha `onPersist` (grep). Confermato da M4 e dallo stress test |
| I transport reali non si inseriscono in quella finestra | TRUE: Worker reale 200/200 con microtask drenati tra due `message` (`worker-drain.ts`). MessagePort e WS: 0 DROPPED su 600+600 prove. `streamChannel` vedi F5 |
| Solo il canale in-memory (`queueMicrotask`) apre la finestra | TRUE: in-memory DROPPED 43/150 (sync) e 14/150 (micro). `createChannelPair` non è usato da nessun `src` di produzione (grep: solo `transport/src/channel.ts`) |
| "L'enqueue viene drenato oppure rifiutato" | **FALSE** sul percorso `max_iterations` (F1) |
| Ordine prompt → enqueue su `opening` (la reazione di `send` è registrata per prima) | TRUE: M3 lo rompe e il test fallisce |
| `--in-process` non viene toccato | TRUE: `main.ts:508-523` usa `Session` direttamente (enqueue sincrono, `Promise.resolve` normalizza) |

### Mutation (rifatte da me)

| Mutazione | Esito |
|---|---|
| M1 `Connection.enqueue` senza il controllo `!hosted.running` | 1 fail ("…rejects with NoTurnRunning") ✅ |
| M2 `RemoteSession.enqueue` senza il ramo `opening` | 1 fail ("…still opening the session is delivered") ✅ |
| M3 `await Promise.resolve()` in `send` prima di `prompt` (l'enqueue scavalca il prompt) | 1 fail (stesso test) ✅ |
| M4 `await setTimeout(1)` tra late drain e `turn_end` | **0 fail** ❌ → F2 (lo stress mostra drop reali) |
| M5 notice TUI senza la causa | 1 fail (`queue.test.tsx`, reject) ✅ |

Revert: `git diff | shasum` = `d98e3ff520a294dd6650d9e5a48636a1c1a583fb` prima e dopo. Nessun file nuovo fuori da `.tentacle/`.

### Attacchi tentati

- **Finestra late-steer su transport reali.** Stress con 3 transport × 4 tempi di enqueue (sincrono sull'evento `text`, dopo 0–40 microtask, `setTimeout` 0 e 1) × 150 turni. Risultato: MessagePort e WS sempre `drained` o `rejected:-32008`, **0 DROPPED**. In-memory: DROPPED. **Regge.**
- **Togliere l'invariante (M4)** → suite verde, drop reali → **F2.**
- **Altri percorsi di fine turno** (`max_iterations`, errore del modello, cancel) → **F1** su `max_iterations`. Errore: drenato. Cancel: stessa semantica del locale.
- **Ordinamento `opening`** (enqueue durante `session/new`, anche con i seed di `--resume`) → regge, ed è coperto da test (M3).
- **Chiamanti e percorsi.** `--in-process` (Session diretta), worker e pod run/attach (`createLocalRuntime` → `persistingController`, `local-runtime.ts:129`), `connect` (RemoteSession diretta, `connect.ts:28`; typecheck verde). `/clear` mid-turn è protetto e crea un nuovo RemoteSession. Cancel/Esc: semantica del locale. `/compact`: `running` è false, quindi ora l'enqueue viene **rifiutato e segnalato** invece di essere perso. Nessuna regressione.
- **Codice nuovo `-32008`.** Lo lancia solo `Connection.enqueue`. Non c'è una tabella esaustiva dei codici da aggiornare (grep). È additivo, la versione resta 1. **Regge.**
- **Pod non fidato.** Un `steer` falsificato ha effetto solo cosmetico. `error.message` arriva nel notice (F6). Nessuna approvazione e nessun effetto lato laptop. **Regge.**
- **Prior art.** `daemon-compact-turn-guard` toccherà `HostedSession.prompt` (rischio per F2). `model-connection-resilience` chiede di non serializzare il peer: rispettato, `enqueue` resta sincrono.

### Cosa regge

Il wire additivo è simmetrico. Il fix F1 della Review 1 (`opening`) è corretto e coperto da test. `NoTurnRunning` chiude davvero la finestra di fine turno sui transport reali. La riconciliazione nel TUI e la propagazione della Promise funzionano. Con l'eccezione di M4, ogni mutazione fallisce come deve.

### Comportamento dell'executor (fix post-review)

Ha applicato F1–F4 come richiesto. I test aggiunti erano rossi prima del fix. Ha dichiarato onestamente che l'invariante non ha test. Due cose non le ha fatte: non ha cercato altri percorsi di fine turno oltre a `end_turn` (F1), e ha scartato il test dell'invariante come "fragile" senza cercare una formulazione deterministica (F2).

<details><summary>Repro (<code>.tentacle/tmp/steering-review-2/</code>)</summary>

`window.ts` (stress della finestra di fine turno):
```ts
// Stress the late-steer window: enqueue at varied moments near the end of a
// turn; classify each enqueue as drained / rejected / ACCEPTED-BUT-DROPPED.
import { Agent } from "@tentacle/agent";
import { PermissionBroker, type ChatRequest, type ExecutionEnvironment, type ModelProvider, type StreamEvent } from "@tentacle/core";
import { Connection, SessionHost, startWsServer } from "@tentacle/daemon";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair, messagePortChannel, type MessageEndpoint } from "@tentacle/transport";

const seen = new Set<string>();
const model: ModelProvider = {
  id: "m",
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    for (const m of req.messages) seen.add(m.content);
    const d = Math.floor(Math.random() * 3);
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    yield { type: "text", delta: "x" };
    const d2 = Math.floor(Math.random() * 3); if (d2 > 0) await new Promise((r) => setTimeout(r, d2 - 1));
    yield { type: "done" };
  },
};
const env: ExecutionEnvironment = { id: "n", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} };
const host = () => new SessionHost({ defaultCwd: "/tmp/x", createAgent: () => { const permissions = new PermissionBroker(); return { agent: new Agent({ model, tools: new ToolRegistry().register(shellTool), env, requestPermission: (r) => permissions.request(r) }), permissions }; } });

type Mode = "sync" | "micro" | "t0" | "t1";
async function trial(s: ReturnType<RemoteClient["newSession"]>, mode: Mode, n: number) {
  const text = `steer-${mode}-${n}-${Math.random()}`;
  let outcome: Promise<string> | null = null;
  const fire = () => { outcome = s.enqueue(text).then(() => "resolved", (e) => `rejected:${(e as { code?: number }).code}`); };
  for await (const e of s.send("go")) {
    if (e.type === "text" && !outcome) {
      if (mode === "sync") fire();
      else if (mode === "micro") { let p = Promise.resolve(); for (let i = 0; i < Math.floor(Math.random() * 40); i++) p = p.then(() => {}); p.then(fire); }
      else setTimeout(fire, mode === "t0" ? 0 : 1);
    }
  }
  await new Promise((r) => setTimeout(r, 5));
  const o = outcome ? await outcome : "never-fired";
  if (o === "resolved") return seen.has(text) ? "drained" : "DROPPED";
  return o;
}
async function run(label: string, client: RemoteClient) {
  await client.initialize();
  const s = client.newSession();
  for (const mode of ["sync", "micro", "t0", "t1"] as Mode[]) {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 150; i++) { const r = await trial(s, mode, i); tally[r] = (tally[r] ?? 0) + 1; }
    console.log(label, mode, JSON.stringify(tally));
  }
  client.close();
}
{ const [d, c] = createChannelPair(); new Connection(d, host()); await run("in-memory", new RemoteClient(c, new PermissionBroker())); }
{ const mc = new MessageChannel(); new Connection(messagePortChannel(mc.port1 as unknown as MessageEndpoint), host()); await run("messageport", new RemoteClient(messagePortChannel(mc.port2 as unknown as MessageEndpoint), new PermissionBroker())); }
{ const server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: host() }); await run("websocket", new RemoteClient(await connectWebSocket(server.url), new PermissionBroker())); server.stop(); }
process.exit(0);
```

`maxiter.ts` (percorsi `max_iterations` ed errore del modello):
```ts
// Enqueue accepted during the last allowed round → never drained.
import { Agent } from "@tentacle/agent";
import { PermissionBroker, type ChatRequest, type ExecutionEnvironment, type ModelProvider, type StreamEvent } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { RemoteClient } from "@tentacle/client";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";

for (const scenario of ["max_iterations", "model_error"] as const) {
  const seen: string[] = [];
  let call = 0;
  const model: ModelProvider = { id: "m", async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    call++; seen.push(...req.messages.map((m) => m.content));
    if (call === 1) { yield { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) } }; yield { type: "done" }; return; }
    if (scenario === "model_error") throw new Error("upstream 500");
    yield { type: "text", delta: "summary" }; yield { type: "done" };
  } };
  const env: ExecutionEnvironment = { id: "slow", exec: async () => { await new Promise((r) => setTimeout(r, 100)); return { stdout: "ok", stderr: "", exitCode: 0 }; }, readFile: async () => "", writeFile: async () => {} };
  const host = new SessionHost({ defaultCwd: "/tmp/x", createAgent: () => { const permissions = new PermissionBroker(); permissions.setRequester(async () => ({ allowed: true, scope: "once" }) as never); return { agent: new Agent({ model, tools: new ToolRegistry().register(shellTool), env, maxIterations: scenario === "max_iterations" ? 1 : 16, requestPermission: async () => ({ allowed: true }) as never }), permissions }; } });
  const [d, c] = createChannelPair(); new Connection(d, host);
  const client = new RemoteClient(c, new PermissionBroker()); await client.initialize();
  const s = client.newSession();
  let enq = "not-fired"; const events: string[] = [];
  try {
    for await (const e of s.send("go")) {
      events.push(e.type === "turn_end" ? `turn_end:${e.reason}` : e.type);
      if (e.type === "tool_start") enq = await s.enqueue("PLEASE ALSO X").then(() => "resolved", (err) => `rejected ${err}`);
    }
  } catch (err) { events.push(`send threw: ${String(err)}`); }
  console.log(scenario, "| enqueue:", enq, "| steer events:", events.filter((t) => t === "steer").length, "| last:", events.at(-1), "| model saw:", seen.includes("PLEASE ALSO X"));
  client.close();
}
```

`worker-drain.ts` + `w.ts` (Worker Bun: i microtask vengono drenati tra due eventi `message`?):
```ts
const w = new Worker(new URL("./w.ts", import.meta.url).href, { type: "module" });
const tally: Record<string, number> = {};
let n = 0;
w.addEventListener("message", (e) => { tally[e.data] = (tally[e.data] ?? 0) + 1; if (++n === 200) { console.log("worker", JSON.stringify(tally)); w.terminate(); } else { w.postMessage("a"); w.postMessage("b"); } });
w.postMessage("a"); w.postMessage("b");
// w.ts
let flag = false;
self.addEventListener("message", (e: MessageEvent) => {
  if (e.data === "a") { flag = false; let p = Promise.resolve(); for (let i = 0; i < 5000; i++) p = p.then(() => {}); p.then(() => { flag = true; }); }
  else if (e.data === "b") postMessage(flag ? "drained-between" : "INTERLEAVED");
});
```

Output (codice del branch):
```
in-memory sync {"drained":107,"DROPPED":43}      messageport sync {"drained":106,"rejected:-32008":44}
in-memory micro {"rejected:-32008":42,"drained":94,"DROPPED":14}   messageport/websocket micro|t0|t1: 0 DROPPED
websocket sync {"drained":109,"rejected:-32008":41}
worker {"drained-between":200}
max_iterations | enqueue: resolved | steer events: 0 | last: turn_end:max_iterations | model saw: false
model_error | enqueue: resolved | steer events: 1 | last: send threw: RpcError: internal error | model saw: true
```
Con M4: messageport/websocket DROPPED 51–103 su 150 per ogni modalità.
</details>

---

## Fix post-Review 2 (2026-10-19)

*— claude-opus-5-5, 2026-10-19 (stesso modello di Review 1/2: una nuova review in contesto fresco resta raccomandata)*

1. **Review 2 F1, `max_iterations`** — `agent/src/agent.ts`, ramo del limite di
   round: la coda di steering ora viene svuotata **prima** del round finale
   senza tool, quindi il report può rispondere al messaggio, e **dopo** il round
   finale (un messaggio scritto durante il report finisce nello storico con il
   suo `steer` e il modello lo vede al turno successivo). Prima veniva accettato
   e poi perso. Test (rossi prima): `agent/test/steering.test.ts` "…reaches the
   final report (max_iterations)" e "…kept in history, not dropped
   (max_iterations)". Repro del reviewer (`steering-review-2/maxiter.ts`): ora
   `steer events: 1 | model saw: true`.
2. **Review 2 F2, invariante senza test** — `daemon/test/integration.test.ts`
   "no macrotask fits between the last steering drain and the turn's end"
   (casi `end_turn` e `max_iterations`): un timer armato dentro il drain deve
   trovare `HostedSession.running === false`. Non-vacuità: `await` di 1 ms dopo
   il late drain → fallisce il caso `end_turn`; dopo il drain finale del cap →
   fallisce `max_iterations`; tolto il drain pre-report → fallisce il test agent.
   Tree identico dopo il revert (`git diff | shasum`). Rettifica alla mia
   affermazione precedente ("un test sarebbe fragile"): era sbagliata.
3. **Review 2 F3 + nit** (rimozione ⏳ per conteggio, testo perso sul reject,
   Esc durante `openSession`) → `TODO.md` Block 4, "Steering follow-ups".
4. **Rettifica doc:** il riferimento `agent.ts:270` di *Fix post-review* ora è
   `agent.ts:276`. "Macrotask" non è esatto per `streamChannel` (stdio del pod),
   che consegna in modo sincrono le righe dello stesso chunk. La conclusione
   regge: un enqueue in quel chunk viene servito prima che il prompt arrivi al
   drain.
