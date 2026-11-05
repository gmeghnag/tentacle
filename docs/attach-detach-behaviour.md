# Run, detach, attach, quit: il comportamento atteso

> **Nave maestra.** Questa pagina dice come tentacle DEVE comportarsi. Ogni round futuro su `run` / `--detach` / `attach` / `quit` / `ps` / `rm` si verifica contro di essa: se il codice o una nuova decisione la contraddicono, si aggiorna QUI, prima del codice.
> Stato verificato su `main` (merge `0edf0be` di `fix/detach-live`), 2026-11-03.
> Legenda **Stato**: ✅ così su main (verificato nel codice o da un test) · 🔜 deciso, in un task (follow-up o feature) · ❓ non deciso · ⚠ il codice non rispetta ancora una decisione.

*— claude-opus-5-5, 2026-11-03*

## 1. Principi

1. **Il laptop è l'identità:** il modello (endpoint e chiave), le decisioni di permesso e la cronologia salvata stanno sul laptop. Il pod/container è solo lo spazio di lavoro (codice, shell, build): non riceve mai credenziali e non decide nulla per il laptop.
2. **Un turno concluso non si perde mai in silenzio:** o è nel record del laptop, o un messaggio visibile (`not saved …`) dice dove si trova.
3. **Si cancella un workload solo dopo un salvataggio confermato.** Nel dubbio resta, e `tentacle rm` chiude la questione.
4. **`keep=true` (predefinito):** uscire stacca soltanto, il container resta. **`keep=false`:** il container se ne va quando la sessione finisce davvero, mai sotto un altro terminale o un'altra sessione in uso.
5. **Una sessione, più terminali:** tutti vedono la stessa cosa. `/quit` confermato chiude la sessione per tutti; Ctrl+C a riposo, la chiusura della finestra o un crash staccano solo quel terminale.
6. **Un run staccato vive in un relay sul laptop:** se il laptop dorme, il modello non risponde.
7. **Ogni fine ha la sua causa vera, scritta:** nella cronologia (`Interrupted: …`, `Failed: <causa>`) e in `ps`. Mai `internal error` quando la causa è nota.

## 2. Comportamento per area

### 2.1 Avvio

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `tentacle run` (keep predefinito) | La TUI. All'uscita: `kept <name> — resume with: tentacle attach …` | Resta | Record del laptop dopo ogni turno | ✅ |
| `run --keep=false` (senza `--detach`) | La TUI; all'uscita viene rimosso | Cancellato all'uscita, anche con Ctrl+C o un crash (rete di sicurezza incondizionata: non è in nessun indice) | Record del laptop | ✅ (decisione owner) |
| `run --detach --prompt …` | Il launcher stampa `Attach any time: tentacle attach …` (più la nota sul sonno del Mac) e torna alla shell | Resta. Un relay sul laptop guida il turno | Il relay salva dopo ogni turno | ✅ |
| `run --detach` senza `--prompt` | Errore `--detach needs --prompt <text>` | Non creato | — | ✅ |
| `run --detach --keep=false` | Come sopra, più la frase che verrà rimosso a fine run | Rimosso quando il relay esce pulito (60 s a riposo, nessun altro uso), solo dopo un salvataggio confermato | Relay | ✅ |
| `run --detach --auto-accept` | Il relay approva da solo i tool del run; `ps` mostra `· auto` | — | — | ✅ |
| Il Mac a riposo durante un turno | `caffeinate -i` lo tiene sveglio; chiudere il coperchio lo addormenta comunque | — | — | ✅ |
| `--model <id>` su `run` (e sulla TUI semplice) | Usa quel modello, sull'endpoint del profilo attivo | — | — | 🔜 follow-up, non ancora su main |

### 2.2 Attach

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `attach <name>` con il relay vivo | Hand-over: la TUI prende il turno in corso, vede tutta la cronologia e lo streaming | Resta | Da qui salvano le TUI, non più il relay | ✅ |
| Attach mentre il run aspetta un permesso | La richiesta è a schermo; rispondi tu | — | — | ✅ |
| Attach a metà di una risposta lunga | Entra; ogni pezzo di testo arriva una volta sola, in ordine | — | — | ✅ |
| Attach a un run che si sta avviando | `the detached run is still starting; retry in a moment` | — | — | ✅ |
| N terminali sulla stessa sessione | Stessa vista; una richiesta di permesso compare su tutti, vale la prima risposta. `ps`: `attached (N)` | — | Ogni TUI salva la stessa sessione | ✅ |
| Attach dopo la fine del run (relay uscito) | La sessione viva del pod, con tutta la cronologia | — | La TUI salva subito lo stato attuale (al momento dell'apertura) | ✅ |
| Attach a una sessione chiusa (dopo `/quit`+`y`) | La sessione viene riaperta dal record del laptop, letto appena prima di aprirla; due TUI restano sincronizzate | — | Il record più recente, mai una copia vecchia | ✅ |
| Il workload non esiste più | `… no longer exists — … cannot be re-attached; its transcript is kept on this laptop` | Sparito | Record del laptop | ✅ |
| Modello all'attach | Quello del run (il suo profilo e l'id mostrato in `ps`), anche nella barra di stato. Vince `--profile` / `TENTACLE_PROFILE` / `TENTACLE_MODEL` | Il pod non riceve nulla | — | ✅ |
| Attach con `--model X` | Solo questa TUI usa X; `ps` e l'indice tengono il modello del run | — | — | 🔜 follow-up, non ancora su main |
| Auto-accept all'attach | ON se il run era `--auto-accept`, con l'avviso `auto-accept on (Shift+Tab to turn it off)`. Shift+Tab vale per la sessione ed è condiviso tra le sue TUI | Lo stato non passa mai per il pod | File sul laptop | ✅ |
| Attach a un run `keep=false` | Avviso: `Quitting removes the container if no other session is in use, a running turn stops.` | — | — | ✅ |
| Barra di stato dopo un turno fallito o un attach | Oggi `↑0 ↓0 · ctx 0%`. Deciso: `↑– ↓–` e `ctx –` finché questa TUI non misura un turno | — | — | 🔜 follow-up, non ancora su main |

### 2.3 Uscita da un run staccato

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `/quit`, unico terminale | Esce subito; un turno in corso viene fermato prima | keep=true: resta. keep=false: rimosso se il salvataggio è confermato e nessun'altra sessione è in uso; altrimenti resta e la riga dice perché | Cronologia completa; un turno tagliato termina con `Interrupted: …` | ✅ |
| `/quit` con altri terminali sulla stessa sessione | `N other terminals attached — close the session for all? (y/N)`. Qualsiasi tasto diverso da `y` vale No: non cambia nulla | — | — | ✅ |
| … risposta `y` | Turno fermato, ultimo salvataggio, sessione chiusa. Gli altri escono con `session closed by another terminal` (mai un `RpcError`) | keep=false: lo rimuove chi ha chiuso, dopo che gli altri sono usciti | Cronologia completa | ✅ |
| Un altro terminale è su un'altra sessione (`/clear`) | Quel terminale resta intatto. keep=false: `not removed: another terminal is on another session` | Resta | — | ✅ |
| Ctrl+C | A metà turno ferma solo il turno. A riposo stacca questo terminale: la sessione resta agli altri, e si chiude se era l'ultimo | keep=false, ultimo terminale: come `/quit` da solo | — | ✅ |
| Chiusura finestra / SIGHUP / crash, keep=true | Il terminale si stacca e basta | Resta | Ultimo turno salvato | ✅ |
| … keep=false, non era l'ultimo terminale | Si stacca | Resta | — | ✅ |
| … keep=false, ultimo terminale | — | Cancellato solo se il salvataggio è confermato (nessun turno in corso); altrimenti resta e `ps` dice `idle (not saved — workload kept: tentacle rm <name>)` | — | ✅ |
| SIGKILL, blackout | Nessun gestore gira | Resta. `ps`: `tui lost · not saved` / `relay lost · not saved` (keep=false) | Fino all'ultimo turno salvato | ✅ |
| Salvataggio non confermato al `/quit` | Riga `the last save was not confirmed — …` | keep=false: non rimosso | Detto, mai in silenzio | ✅ |
| `/quit` di un `run` semplice (non staccato) a metà streaming | Il turno si ferma | Come in 2.1 | ⚠ resta solo il prompt, senza la nota `Interrupted` (Q-B1, assegnato a `feat/resume-after-model-loss`) | ⚠ |
| Esc (annulla) o chiusura a metà streaming | La nota c'è, ma il testo parziale si perde | — | 🔜 tenere anche il testo parziale | 🔜 `feat/resume-after-model-loss` |
| `attach` di un workload tenuto ma non staccato | Uscire non cancella mai nulla: il workload è dell'utente | Resta | — | ✅ |

### 2.4 Relay e laptop

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| Coperchio chiuso o standby a metà risposta | All'attach: la risposta parziale e poi `Failed: model connection lost mid-stream (ECONNRESET). The turn stopped here; …` | Resta | Testo parziale e nota, sia nel daemon sia sul laptop | ✅ |
| … ripresa automatica | Il turno si mette in pausa, aspetta la rete (con un limite), poi continua con la nota `connection lost … resumed`, senza duplicati | — | — | 🔜 `feat/resume-after-model-loss` |
| Errore del modello a metà risposta | Come sopra; `ps`: `failed: model connection lost …` | — | Parziale e nota | ✅ |
| Errore del modello prima del primo token | `failed: <causa>` | — | Il laptop non rilegge: la sua copia non ha la nota `Failed` | ❓ (Q-N1, vedi §3) |
| Rete laptop↔pod persa e poi ripresa | Riconnessione automatica e riallineamento; nessun evento perso o doppio | — | — | ✅ |
| … intanto la sessione condivisa è sparita dal pod | La TUI esce con `the session ended in the container`; nulla viene ricreato dalla sua copia | — | Copia del laptop | ✅ |
| Relay a riposo per 60 s | Il relay esce | keep=true: resta. keep=false: rimosso (dopo il salvataggio) | Relay | ✅ |
| Relay fermato (`kill`, o `rm` che lo ferma) | Turno annullato e salvato | keep=false: rimosso dopo il salvataggio confermato | — | ✅ |
| … il turno non si ferma entro 5 s | `ps`: `interrupted (the relay was stopped before the turn ended; not saved — workload kept: tentacle rm <name>)` | Resta | Detto | ✅ |
| Secondo SIGTERM o crash del relay | — | Cancellato solo se il salvataggio è confermato; altrimenti resta con `not saved` | — | ✅ |
| keep=true, il relay esce con l'ultimo turno non salvato | `ps`: `not saved — the laptop copy lacks the last turn` | Resta | Detto | ✅ |
| … ma il run è fallito | `ps` mostra solo `failed: <causa>`, senza `not saved` (decisione Q3 non applicata a questo caso) | Resta | — | ⚠ (lo chiude F6 del follow-up, non ancora su main) |

### 2.5 `ps` e `rm`

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| Stati in `ps` | `running · attached` / `attached (N)` · `detached · running`, `detached · idle`, `detached · waiting: permission (<tool>)` · `· auto` · `closing` · `idle (<nota>)` · `interrupted (<nota>)` · `failed: <causa>` | — | — | ✅ |
| Proprietario sparito a metà run | `relay lost` / `tui lost`; con keep=false anche `· not saved` | Resta finché c'è | — | ✅ |
| Workload sparito | Oggi la riga `gone` resta per sempre. Deciso: nascosta in `ps`, visibile con `ps -a`, eliminata da `rm` | — | — | 🔜 follow-up, non ancora su main |
| `rm <name>` su un workload in esecuzione | `… is running — a session may be attached. Remove it? [y/N]` (`-f` non chiede). Ferma il relay, poi cancella | Rimosso solo se ha le etichette di tentacle | Le sessioni sul laptop restano | ✅ |
| `rm a b c` | Oggi un solo nome. Deciso: più nomi, `y/N` per ciascuno, prosegue anche se uno fallisce, exit 1 se anche uno solo è fallito | — | — | 🔜 follow-up, non ancora su main |
| File `.aside` (copie vecchie messe da parte) | Oggi non vengono mai rimossi. Deciso: se ne vanno con la loro sessione | — | — | 🔜 follow-up, non ancora su main |

### 2.6 `connect` / `serve` e scelta del modello

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `connect`, poi `/quit` | Stacca: la sessione e un turno in corso restano su `serve` | — | Nessuna copia sul laptop: il record di `serve` è la verità | ✅ |
| Sessione chiusa su `serve` | Archiviata; la riapre solo un `reopen` esplicito, mai una riconnessione | — | Daemon `serve` | ✅ |
| `--profile` / `TENTACLE_PROFILE` / `TENTACLE_MODEL` | Scelgono profilo e modello del laptop | Il pod non riceve nulla | — | ✅ |
| `tentacle --model <id> serve` | I client `connect` usano quel modello | — | — | 🔜 follow-up, non ancora su main |
| `connect --model` | Rifiutato, con l'indicazione `tentacle --model <id> serve` | — | — | 🔜 follow-up, non ancora su main |

## 3. ❓ Buchi (casi che un utente può incontrare e che nessuna decisione copre)

1. **Turno fallito prima del primo token** (modello irraggiungibile, chiave sbagliata). Il laptop non rilegge la sessione, quindi la sua copia non ha la nota `Failed`, e per keep=true `ps` non dice `not saved`.
   **Raccomandazione:** rileggere e salvare a ogni fine turno, anche se fallito (dal round 10 un turno fallito cambia sempre la cronologia del daemon). Si accorpa a `feat/resume-after-model-loss`.
2. **`attach <name>` dopo un `/clear`** riapre la sessione originale del run, non l'ultima usata (osservato nel live round 3).
   **Raccomandazione:** riaprire l'ultima sessione usata nel run (il run la registra a ogni `/clear`) e stampare l'id dell'altra con `--resume <id>`.
3. ✅ **Deciso 2026-11-04, fatto (`8570e25`):** nessun messaggio; `ps` vuoto (o con sole righe `gone`) stampa solo l'intestazione, come `docker ps`.
4. ✅ **Deciso 2026-11-03, fatto (`8570e25`):** `--model` e `--profile` sono flag SOLO dei comandi di sessione (`run`, `attach`, `serve`, `tentacle` senza comando), scritti dopo il comando. Prima del comando → errore con la forma giusta; su `ps`/`rm`/`update`/`hooks`/`package`/`install` → `unknown option`; `connect` li rifiuta. `ps` mostra sempre tutti i container, indipendentemente dal profilo.
5. **`ps -q` elenca anche le righe `gone`** (non interroga l'engine, per essere veloce), mentre `ps` le nasconde.
   **Raccomandazione:** da decidere.
6. **`ps -v` senza righe non stampa niente**, nemmeno l'intestazione (`ps` stampa l'intestazione).
   **Raccomandazione:** da decidere.
7. **`tentacle run --help`** (e gli altri sottocomandi) mostra l'help generale, non quello del sottocomando.
   **Raccomandazione:** da decidere.

## Fonti (main, salvo dove indicato)

- **Decisioni:**
  - `docs/fix/detach-live.md:15-26` (D1–D4, estensione R6), `:28-36` (Q2–Q7), `:38-46` (R9, Q2, Q10, Q9, Q12, Q14), `:48-51` (A, B lid).
  - Follow-up: `detach-live-followups/docs/fix/detach-live-followups.md:36` (OQ1–OQ13), `:352-354` (Q-N1), `:448-451` (Q-R1…R3), `:316-323` (R-F9).
  - `TODO.md:1116-1117`.
- **2.1:** `flags.ts:163`; `engine-runtime.ts:385` (riga kept / removed), `:422` (rete incondizionata del `run` semplice); `relay.ts:665-672` (riga del launcher); `relay-state.ts:13` (60 s), `:253` (`exitPlan`); `keep-awake.ts:4`.
- **2.2:**
  - `attach-run.ts:316` (workload sparito), `:369` (avvio), `:462` (avviso keep=false), `:475` (auto-accept); `shared-auto-accept.ts`; `run-model.ts:15`; `main.ts:1107` (`useRunModel`).
  - `session-reducer.ts:39` (buffer per i replay lunghi).
  - Test: `main.test.ts:976` (owner A), `attach-run.test.ts:264,279` (KO4/R8), `local-runtime.test.ts:1146,1244` (KO4, R9).
- **2.3:**
  - `commands.ts:204-218` (Ctrl+C / `/quit`), `:243-262` (conferma `y/N`); `attach-plan.ts:108` (`quitPlan`); `attach-run.ts:553-556` (righe di chiusura), `:458` (nota della rete); `local-runtime.ts:702` (`cutTurn`), `:447` (`saveConfirmed`).
  - Rete: `engine-runtime.ts:260,285`.
  - Test: `relay.test.ts:1678-1752` (D13/D14), `attach-run.test.ts:238` (R6).
- **2.4:**
  - `daemon/persisted-session.ts:416` (`Interrupted`), `:433` (`closeFailedTurn`); `remote-client.ts:1866` (causa del modello), `:289` e `:1440` (sessione sparita, R7/Q10).
  - `relay.ts:264` (`not saved — workload kept`), `:535` (keep=true `not saved`).
  - Test: `relay.test.ts:776-899` (R5/R6), `reattach.test.ts:472,503` (R7).
- **2.5:** `run-state.ts:417-478` (`statusOf`); `kept.ts:417`, `kept-cmd.ts:349` (`rm`); `kept-cmd.test.ts:303` (R6 `ps`).
- **2.6:** `main.ts:207` (help di `connect`: uscire stacca); `commands.ts:200-202` (`connect` `/exit`); AGENTS.md §7 (Persistence, `serve` archive).
