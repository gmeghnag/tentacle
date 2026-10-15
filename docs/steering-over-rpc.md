# Steering over RPC — piano: "Queue a task…" (enqueue) su worker/pod/remote

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

## 2. Design

Due aggiunte **additive** al protocollo (versione resta **1**: nuovo metodo =
`MethodNotFound` per client vecchi che non lo chiamano mai; nuova variante
update ignorata dai client vecchi perché i membri dell'union update non sono
`.strict()`):

1. **`session/enqueue`** — request client→daemon:
   `params: { sessionId, text }`, `result: {}`.
   Il daemon la inietta nella `steering` queue della `Session` host-side;
   il modello la vede al prossimo boundary, come in locale.
2. **`steer`** — nuova variante di `session/update`
   (`{ type: "steer", text }`), streamata dal daemon al momento dell'
   iniezione. Il TUI (`App.tsx:316`) fa già `setQueued(q => q.slice(1))`
   su evento `steer` → la riga ⏳ si rimuove **FIFO** esattamente come in
   locale. Niente da cambiare nel TUI.

Semantica: l'`enqueue` ha senso solo **durante un turn** (il TUI lo chiama
solo se `stateRef.current.running`). Un enqueue a turn idle resta nella
queue ma viene azzerato dall'inizio del prossimo `send`
(`Session.send` → `this.steering = []`) — comportamento identico a locale
(test esistente: "enqueue clears between turns").

## 3. File da modificare (10)

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
8. `packages/client/src/remote-session.ts` —
   ```ts
   /** Queue a user message mid-turn (steering). No-op before the first send. */
   enqueue(text: string): void {
     if (!this.id) {
       return;
     }
     // Fire-and-forget: the contract is `void`; a failed enqueue must not
     // surface as an unhandled rejection (the turn is already running).
     void this.client.enqueue(this.id, text).catch(() => {});
   }
   ```
9. `packages/client/src/mapping.ts` (`updateToEvent`) —
   `case "steer": return { type: "steer", text: update.text };` → fluisce
   già nella `AsyncQueue` di `RemoteSession.send`; niente altro.

### cli
10. `packages/cli/src/local-runtime.ts` (`persistingController`) —
    ```ts
    enqueue(text) {
      inner.enqueue(text);
    },
    ```
    (pass-through, come `compact`.)

### doc-comment (cosmetic, 1 file)
- `packages/tui/src/App.tsx:47` — `/** Queue a message mid-turn (steering);
  optional (local sessions only). */` → togliere "(local sessions only)"
  (dopo il fix è disponibile su tutte le vie).

## 4. Test da aggiungere (5 file)

1. `packages/protocol/test/updates.test.ts` — `{ type: "steer", text: "…" }`
   nell'array `variants` (parse) + select della union.
2. `packages/protocol/test/methods.test.ts` — `session/enqueue` presente in
   `Method` con params+result; `EnqueueParamsSchema` valida
   `{ sessionId, text }` e rifiuta senza `text` / `text: ""`.
3. `packages/daemon/test/integration.test.ts` — end-to-end in-memory
   (stesso `harness` dei test esistenti): model `ScriptedProvider` a 2
   round (round 1: `tool_call` + `done`; round 2: `text` + `done`);
   `initialize` → `session/new` → `client.request("session/prompt", …)`
   **senza await** → `tick()` → `client.request("session/enqueue", {
   sessionId, text: "steer me" })` → await del prompt. Assert:
   - negli `updates` c'è un `steer` con `text: "steer me"`;
   - il prompt risolve con `end_turn` (il modello ha fatto la round in più
     — se l'enqueue non arrivasse, il prompt terminerebbe dopo la round 1).
4. `packages/client/test/remote.test.ts` — `RemoteSession.enqueue`:
   stesso schema a 2 round; dentro un `for await` sulla `send` (prima
   round) chiamare `session.enqueue("steer me")`; assert che gli eventi
   raccolti includono `{ type: "steer", text: "steer me" }` e che
   `turn_end` è l'ultimo.
5. `packages/cli/test/local-runtime.test.ts` — `persistingController`:
   stub `inner` con `enqueue: spy`; assert che
   `controller.enqueue` è una function e chiama `inner.enqueue`.

Stile repo: double quotes, trailing commas, **niente `!`** (assert
condizionali alla maniera dei test esistenti).

## 5. Validazione

1. `bun run typecheck` → 0.
2. `bun run lint` → 0 error.
3. `bun test` → verde (baseline 530/0/1 + i nuovi).
4. Manuale (da fare dopo, con il binary): TUI locale via worker (default),
   turn lungo (es. task con tool call), in mezzo digitare "poi anche X" +
   Enter → si vede la riga `⏳ poi anche X`; quando il modello la inietta
   la riga scompare e il modello risponde a entrambi. Stesso su
   `run`/`exec`/`connect`.
5. **Non-regress**: `--in-process` continua a funzionare (il controller
   locale non è toccato); `steer` resta assente dalle snapshot/persist
   (non è una `ChatMessage`, è solo un evento di rendering).

## 6. Note / debiti

- `session/enqueue` è un request (risposta `{}`): dà al client la
  conferma di delivery (o l'errore, es. `UnknownSession` dopo un `/clear`
  nel mezzo) a costo di una frame in più; alternativa fire-and-forget
  (notification) scartata perché nasconderebbe i failure.
- Se in futuro il client si disconnette a metà-turn, il text enqueue'd
  resta nella queue host-side e viene azzerato al prossimo `send` —
  coerente con locale.
- Il TUI non ha bisogno di nessun fallback "steering unavailable": dopo il
  fix **tutte** le vie espongono `enqueue`, quindi la guard
  `sessionRef.current?.enqueue` di `App.tsx:451` ha sempre un metodo.
