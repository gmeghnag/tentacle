# Steering over RPC — piano: "Queue a task…" (enqueue) su worker/pod/remote

> **Status:** implementation — not started: `daemon/src/mapping.ts:104` still drops `steer`, no `session/enqueue` (verified 2026-10-17); tracked in `TODO.md` Block 4 · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

**Stato:** **non implementato** (piano). Referenziato da `TODO.md` Block 4
(entry "Mid-turn 'Queue a task…' silently no-ops on the worker and pod paths").
Basato su `1170d40` (branch `feat/pod-exec-attach`).

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
