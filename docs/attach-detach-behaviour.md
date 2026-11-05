# Run, detach, attach, quit: il comportamento atteso

> **Nave maestra.** Questa pagina dice come tentacle DEVE comportarsi. Ogni round futuro su `run` / `--detach` / `attach` / `quit` / `ps` / `rm` si verifica contro di essa: se il codice o una nuova decisione la contraddicono, si aggiorna QUI, prima del codice.
> Stato verificato su `main` (commit `7bcae4b`), 2026-11-05. Verifica su codice e test; nessuna prova dal vivo in questo aggiornamento.
> Legenda **Stato**: ✅ così su main (verificato nel codice o da un test) · 🔜 deciso, in un task (follow-up o feature) · ❓ non deciso · ⚠ il codice non rispetta ancora una decisione.

*— claude-opus-5-5, 2026-11-03*
*— claude-opus-5-5, 2026-11-05 (aggiornamento)*

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
| `tentacle run` (keep predefinito) | Prima della TUI: `[container] <name> still running · tentacle attach <name>`; la riga resta visibile dopo l'uscita | Resta | Record del laptop dopo ogni turno | ✅ |
| `run --keep=false` (senza `--detach`) | La TUI; all'uscita viene rimosso | Cancellato all'uscita, anche con Ctrl+C o un crash (rete di sicurezza incondizionata: non è in nessun indice) | Record del laptop | ✅ (decisione owner) |
| `run … "<prompt>"` | L'ultima parola è il primo messaggio: la TUI lo manda una volta sola, come testo grezzo (anche se inizia con `/`) | Come `run` | Come `run` | ✅ |
| `run --name <n>` | Dà il nome al workload; senza, nome automatico. `run mypod` è il prompt `mypod`, senza avviso | — | — | ✅ |
| Prompt non valido | Errore prima di creare qualcosa: posizionale e `--prompt` insieme; prompt vuoto; prompt con `--resume`/`--continue`; `--prompt -` senza `--detach` | Non creato | — | ✅ |
| `run --detach "<prompt>"` o `--prompt <testo\|->` | Solo la riga `[container] <name> still running · tentacle attach <name>`, poi la shell. Se stdout non è un terminale, stampa lì il nome | Resta. Un relay sul laptop guida il turno | Il relay salva dopo ogni turno | ✅ |
| `run --detach` senza prompt | Errore `--detach needs a prompt: "<prompt>", --prompt <text>, or --prompt - for stdin` | Non creato | — | ✅ |
| `run --detach --keep=false` | La riga dice anche `removed when the run ends` | Rimosso quando il relay esce pulito (60 s a riposo, nessun altro uso), solo dopo un salvataggio confermato | Relay | ✅ |
| `run --detach --auto-accept` | Il relay approva da solo i tool del run; `ps` mostra `· auto` | — | — | ✅ |
| `run --auto-accept` senza `--detach` | La TUI parte con auto-accept attivo; Shift+Tab lo spegne | — | — | ✅ |
| Il Mac a riposo durante un turno | `caffeinate -i` lo tiene sveglio; chiudere il coperchio lo addormenta comunque | — | — | ✅ |
| `--model <id>` su `run` (e sulla TUI semplice) | Usa quel modello, sull'endpoint del profilo attivo; l'indice e `ps` lo registrano, il relay lo usa | — | — | ✅ |
| Avvio fallito | Una riga: `[container] failed: <causa> · log: <path>`, con ` · still up: tentacle rm <name>` se il workload è rimasto | Tenuto: resta. Altrimenti rimosso | — | ✅ |
| Stderr del daemon | Mai a schermo: va in `daemon.log`. Un guasto vero stampa una riga: `daemon stopped unexpectedly · log: <path>` | — | `daemon.log` | ✅ |
| `--rm` al posto di `--keep`, `-d` per `--detach` | Oggi sono `unknown option`. Deciso: `--rm` rimuove a fine run, predefinito tiene | — | — | 🔜 `fix/run-rm-flag` |
| `run` one-shot in streaming, stdin non terminale | Oggi `--prompt -` richiede `--detach` | — | — | 🔜 `feat/run-oneshot` |
| Immagine di un'altra architettura (amd64 su arm64) | Oggi: binario sotto qemu, `MemoryExhaustion`. Deciso: immagine nativa, e rifiuto prima di copiare il binario | — | — | 🔜 fix in `TODO.md` |

### 2.2 Attach

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `attach <name>` con il relay vivo | Hand-over: la TUI prende il turno in corso, vede tutta la cronologia e lo streaming | Resta | Da qui salvano le TUI, non più il relay | ✅ |
| Attach mentre il run aspetta un permesso | La richiesta è a schermo; rispondi tu | — | — | ✅ |
| Attach a metà di una risposta lunga | Entra; ogni pezzo di testo arriva una volta sola, in ordine | — | — | ✅ |
| Attach a un run che si sta avviando | `the detached run is still starting; retry in a moment` | — | — | ✅ |
| Attach a un run staccato senza terminale | `attaching to a detached run needs a terminal (its quit ends the run)` | — | — | ✅ |
| N terminali sulla stessa sessione | Stessa vista; una richiesta di permesso compare su tutti, vale la prima risposta. `ps`: `attached (N)` | — | Ogni TUI salva la stessa sessione | ✅ |
| Attach dopo la fine del run (relay uscito) | La sessione viva del pod, con tutta la cronologia | — | La TUI salva subito lo stato attuale (al momento dell'apertura) | ✅ |
| Attach a una sessione chiusa (dopo `/quit`+`y`) | La sessione viene riaperta dal record del laptop, letto appena prima di aprirla; due TUI restano sincronizzate | — | Il record più recente, mai una copia vecchia | ✅ |
| Attach da una cartella qualsiasi | Si comporta come se partisse dalla cartella del run. Se quella cartella non esiste più, funziona lo stesso | — | Sotto il percorso originale del run | ✅ |
| Attach a un `run` tenuto, non staccato | Riapre l'ultima sessione salvata dal run, con tutta la cronologia; segue `/clear` e `/resume`. Vincono `--resume` e `--continue` | Resta | Record del laptop | ✅ |
| … il record manca o non si legge | Una nota, poi una sessione nuova. Una voce vecchia senza id: sessione nuova, senza nota | — | — | ✅ |
| … il run era `--auto-accept` | Auto-accept spento: lo stato non viene registrato | — | — | ❓ (buco 11) |
| Due terminali in attach sullo stesso `run` non staccato | Riaprono lo stesso id; nessun `y/N` e nessun `attached (N)`. Effetto reale non provato | — | — | ❓ (buco 10) |
| `attach <name>` con `--engine`/`--namespace`/`--context`/`--container` su un `run` non staccato | I flag saltano l'indice: sessione nuova, cartella corrente, modello del laptop | — | — | ❓ (buco 9) |
| Pod con più container, senza `--container` | Un solo container: quello. Annotazione `default-container` valida: quella. Altrimenti `a container name must be specified for pod X, choose one of: [a b] · pass --container <c>`, prima di ogni exec | — | — | ✅ |
| Nome sconosciuto | Una riga: `not in tentacle ps, and no <noun> with that name …`; nessuna cartella di log | — | — | ✅ |
| Il workload non esiste più | `… no longer exists — … cannot be re-attached; its transcript is kept on this laptop` | Sparito | Record del laptop | ✅ |
| Binario nel pod più vecchio del laptop | Oggi solo `connection closed`. Deciso: dire che è vecchio e come rimediare, oppure ricopiarlo | — | — | 🔜 fix in `TODO.md` |
| Modello all'attach | Quello del run (il suo profilo e l'id mostrato in `ps`), anche nella barra di stato. Vince `--model` / `--profile` / `TENTACLE_PROFILE` / `TENTACLE_MODEL` | Il pod non riceve nulla | — | ✅ |
| Attach con `--model X` | Solo questa TUI usa X; `ps` e l'indice tengono il modello del run | — | — | ✅ |
| Auto-accept all'attach di un run staccato | ON se il run era `--auto-accept`, con l'avviso `auto-accept on (Shift+Tab to turn it off)`. Shift+Tab vale per la sessione ed è condiviso tra le sue TUI | Lo stato non passa mai per il pod | File sul laptop | ✅ |
| Attach a un run `keep=false` | Avviso: `Quitting removes the <noun> if no other session is in use, a running turn stops.` | — | — | ✅ |
| Barra di stato dopo un turno fallito o un attach | `↑– ↓–` e `ctx –` finché questa TUI non misura un turno | — | — | ✅ |
| Barra di stato nel pod | Deciso: badge con engine e nome; modello sul bordo dell'input; `ctx` sempre col massimo, stima con `~`; `↑↓` nascosti finché non misurati | — | — | 🔜 `feat/tui-target-badge` |

### 2.3 Uscita da un run staccato

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `/quit`, unico terminale | Esce subito; un turno in corso viene fermato prima | keep=true: resta. keep=false: rimosso se il salvataggio è confermato e nessun'altra sessione è in uso; altrimenti resta e la riga dice perché | Cronologia completa; un turno tagliato termina con `Interrupted: …`; una chiamata tagliata dice `Interrupted` se era partita, `Not run` se no | ✅ |
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
| Esc (annulla) a metà streaming | Il turno si ferma | — | Oggi né nota né testo parziale. Da tenere: testo parziale e nota `Interrupted: cancelled` (Q-B1) | 🔜 `feat/resume-after-model-loss` |
| Sessione chiusa a metà streaming | La nota c'è, ma il testo parziale si perde | — | 🔜 tenere anche il testo parziale (Q-B2) | 🔜 `feat/resume-after-model-loss` |
| `attach` di un workload tenuto ma non staccato | Uscire non cancella mai nulla: il workload è dell'utente | Resta | — | ✅ |
| `/detach` dalla TUI | Oggi non esiste. In programma: lascia la sessione al relay ed esce | Resta | — | 🔜 S5 in `TODO.md` |

### 2.4 Relay e laptop

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| Coperchio chiuso o standby a metà risposta | All'attach: la risposta parziale e poi `Failed: model connection lost mid-stream (ECONNRESET). The turn stopped here; …` | Resta | Testo parziale e nota, sia nel daemon sia sul laptop | ✅ |
| … ripresa automatica | Il turno si mette in pausa, aspetta la rete (con un limite), poi continua con la nota `connection lost … resumed`, senza duplicati | — | — | 🔜 `feat/resume-after-model-loss` |
| Errore di connessione al modello a metà risposta | Come sopra; `ps`: `failed: model connection lost …` | — | Parziale e nota | ✅ |
| Modello che non risponde al connect | Fallisce in 15 s (`f2a5bfc`): `model unreachable: the model endpoint did not answer`; il laptop mostra il messaggio completo | — | Vedi la riga sotto | ✅ |
| Errore del modello prima del primo token | `failed: <causa>` | — | Il laptop non rilegge: la sua copia non ha la nota `Failed` | 🔜 (Q-N1, vedi §3, `feat/resume-after-model-loss`) |
| Altro errore del modello in un pod (401, 5xx) | `Failed: internal error`; `ps`: `failed: internal error`: la causa non attraversa il tunnel | — | — | ⚠ (principio 7, buco 8) |
| Rete laptop↔pod persa e poi ripresa | Riconnessione automatica e riallineamento; nessun evento perso o doppio | — | — | ✅ |
| … intanto la sessione condivisa è sparita dal pod | La TUI esce con `the session ended in the <noun>`; nulla viene ricreato dalla sua copia | — | Copia del laptop | ✅ |
| Relay a riposo per 60 s | Il relay esce | keep=true: resta. keep=false: rimosso (dopo il salvataggio) | Relay | ✅ |
| Relay fermato (`kill`, o `rm` che lo ferma) | Turno annullato e salvato | keep=false: rimosso dopo il salvataggio confermato | — | ✅ |
| … il turno non si ferma entro 5 s | `ps`: `interrupted (the relay was stopped before the turn ended; not saved — workload kept: tentacle rm <name>)` | Resta | Detto | ✅ |
| Secondo SIGTERM o crash del relay | — | Cancellato solo se il salvataggio è confermato; altrimenti resta con `not saved` | — | ✅ |
| keep=true, il relay esce con l'ultimo turno non salvato | `ps`: `not saved — the laptop copy lacks the last turn` | Resta | Detto | ✅ |
| … ma il run è fallito | `ps`: `failed: <causa> · not saved — the laptop copy lacks the last turn` (Q13). Eccezione: il fallimento prima del primo evento (buco 1) | Resta | Detto | ✅ |

### 2.5 `ps` e `rm`

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| Stati in `ps` | `running · attached` / `attached (N)` · `detached · running <N>m`, `detached · idle`, `detached · waiting: permission (<tool>)` · `· auto` · `closing` · `idle (<nota>)` · `interrupted (<nota>)` · `failed: <causa>` | — | — | ✅ |
| Colonna WHERE su kubernetes | `<cluster>/<namespace>`, ricavato dal kubeconfig del laptop solo per la vista. Indice, `attach` e `rm` non cambiano | — | — | ✅ |
| Engine non raggiungibile | La riga resta; su stderr una nota breve `not reachable (skipped) — …`. Exit 0 | — | — | ✅ |
| Proprietario sparito a metà run | `relay lost` / `tui lost`; con keep=false anche `· not saved` | Resta finché c'è | — | ✅ |
| Workload sparito | Nascosto in `ps`, visibile con `ps -a`, eliminato da `rm`. Resta visibile se un relay o una TUI vivi ci lavorano ancora | — | — | ✅ |
| `ps` vuoto | Solo l'intestazione, come `docker ps` | — | — | ✅ |
| `ps -q` | Elenca anche le righe `gone`: non interroga l'engine | — | — | ❓ (buco 5) |
| `ps -v` senza righe | Non stampa niente, nemmeno l'intestazione | — | — | ❓ (buco 6) |
| `rm <name>` su un workload in esecuzione | `… is running — a session may be attached. Remove it? [y/N]` (`-f` non chiede). Ferma il relay, poi cancella | Rimosso solo se ha le etichette di tentacle | Le sessioni sul laptop restano | ✅ |
| … senza terminale | Errore: `… Pass -f to remove it without asking.` | Resta | — | ✅ |
| `rm a b c` | Più nomi, `y/N` per ciascuno, prosegue anche se uno fallisce, exit 1 se anche uno solo è fallito | — | — | ✅ |
| File `.aside` (copie vecchie messe da parte) | Se ne vanno con la loro sessione | — | — | ✅ |
| Dove va l'output | Stdout solo per i dati: tabella di `ps`, nomi di `ps -q`, nome rimosso da `rm`, nome di `run --detach` se non è un terminale. Tutto il resto, compresi errori e `y/N`, su stderr | — | — | ✅ |

### 2.6 `connect` / `serve` e scelta del modello

| Situazione | Cosa vedi | Il pod/container | Cosa resta salvato | Stato |
|---|---|---|---|---|
| `connect`, poi `/quit` | Stacca: la sessione e un turno in corso restano su `serve` | — | Nessuna copia sul laptop: il record di `serve` è la verità | ✅ |
| Sessione chiusa su `serve` | Archiviata; la riapre solo un `reopen` esplicito, mai una riconnessione | — | Daemon `serve` | ✅ |
| `--model` / `--profile` / `TENTACLE_PROFILE` / `TENTACLE_MODEL` | Scelgono profilo e modello del laptop. I flag vanno dopo il comando di sessione (`run`, `attach`, `serve`, `tentacle` senza comando) | Il pod non riceve nulla | — | ✅ |
| `tentacle serve --model <id>` | I client `connect` usano quel modello | — | — | ✅ |
| `connect --model` | Rifiutato, con l'indicazione `tentacle serve --model <id>` | — | — | ✅ |

## 3. ❓ Buchi (casi che un utente può incontrare e che nessuna decisione copre)

1. **Turno fallito prima del primo token** (modello irraggiungibile, chiave sbagliata). Il laptop non rilegge la sessione, quindi la sua copia non ha la nota `Failed`, e per keep=true `ps` non dice `not saved`. Ancora aperto: `local-runtime.ts:377-396`, fissato da `relay.test.ts:859`. Assegnato il 2026-11-03 a `feat/resume-after-model-loss`, non ancora fatto.
   **Raccomandazione:** rileggere e salvare a ogni fine turno, anche se fallito, in quel task.
2. **`attach <name>` dopo un `/clear`.** ✅ Chiuso per il `run` non staccato (`dabcfb8`). Ancora aperto per il run staccato: riapre la sessione originale, non l'ultima usata (`attach-plan.ts:73`, `attach-run.ts:485-511`).
   **Raccomandazione:** registrare l'ultima sessione anche nel record del run staccato, come fa già l'indice, e stampare l'id dell'altra con `--resume <id>`.
3. ✅ **Deciso 2026-11-04, fatto (`8570e25`):** nessun messaggio; `ps` vuoto (o con sole righe `gone`) stampa solo l'intestazione, come `docker ps`.
4. ✅ **Deciso 2026-11-03, fatto (`8570e25`):** `--model` e `--profile` sono flag SOLO dei comandi di sessione (`run`, `attach`, `serve`, `tentacle` senza comando), scritti dopo il comando. Prima del comando → errore con la forma giusta; su `ps`/`rm`/`update`/`hooks`/`package`/`install` → `unknown option`; `connect` li rifiuta. `ps` mostra sempre tutti i container, indipendentemente dal profilo.
5. **`ps -q` elenca anche le righe `gone`** (non interroga l'engine, per essere veloce), mentre `ps` le nasconde (`kept-cmd.ts:157-161`).
   **Raccomandazione:** stesse righe di `ps`, con `-a` per averle tutte: `ps -q | xargs tentacle rm` deve vedere ciò che vede `ps`. Costa una lettura dell'engine.
6. **`ps -v` senza righe non stampa niente**, nemmeno l'intestazione (`kept-cmd.ts:175-177`; `ps` stampa l'intestazione).
   **Raccomandazione:** lasciarlo così: `-v` stampa blocchi, non ha un'intestazione da mostrare.
7. **`tentacle run --help`** (e gli altri sottocomandi) mostra l'help generale, non quello del sottocomando (`main.ts:454-456`).
   **Raccomandazione:** stampare su stdout `USAGE` del sottocomando, più un rimando a `tentacle --help`.
8. **Nuovo. Errori del modello non di connessione in un pod (401, 5xx).** Il tunnel traduce solo gli errori di connessione; gli altri restano opachi (`remote-client.ts:1858-1859`), quindi si legge `internal error` contro il principio 7. Letto nel codice, non provato dal vivo con un 401 vero.
   **Raccomandazione:** costruire sul laptop un testo sicuro dal solo codice HTTP (`model error 401`), mai dal messaggio, e mostrare al laptop quello completo.
9. **Nuovo. `attach <name>` con flag espliciti su un `run` non staccato.** I flag saltano l'indice (`main.ts:1203-1205`, `:1302`, `:1436`): niente sessione del run, né cartella, né modello.
   **Raccomandazione:** se i flag indicano lo stesso posto della voce nell'indice, usare quella voce, come fa già il run staccato (`main.ts:1321`).
10. **Nuovo. Due terminali in attach sullo stesso `run` non staccato.** Dopo `dabcfb8` riaprono lo stesso id, ma senza presenza né `y/N` (`main.ts:1482-1542`). Effetto del `/quit` di uno sull'altro non verificato.
    **Raccomandazione:** stessa regola del run staccato (principio 5); intanto una prova dal vivo per fissare il comportamento di oggi.
11. **Nuovo. `run --auto-accept` non staccato, poi `attach`.** La scelta vale solo per la prima TUI (`main.ts:1123`, `:1542`), a differenza del run staccato.
    **Raccomandazione:** lasciarla spenta all'attach (è il default più sicuro) e dirlo nell'help.

## Fonti (main, salvo dove indicato)

- **Decisioni:**
  - `docs/fix/detach-live.md:15-26` (D1–D4, estensione R6), `:28-36` (Q2–Q7), `:38-46` (R9, Q2, Q10, Q9, Q12, Q14), `:48-51` (A, B lid), `:1793-1794` (Q-B1, Q-B2).
  - Follow-up: `docs/fix/detach-live-followups.md:36` (OQ1–OQ13), `:40-47` (decisioni A–C), `:322-331` (R-F9), `:362` (Q-N1), `:508` (risposte del 2026-11-04).
  - `docs/feat/run-prompt.md:89-96` (Q2–Q6); `docs/fix/attach-any-folder.md:19-23`; `docs/fix/attach-plain-resume.md:23-28`; `docs/fix/cli-output-streams.md:22-44` (D1–D7).
  - `TODO.md:429` (`fix/run-rm-flag`), `:432` (`feat/tui-target-badge`), `:1129` (`/detach`), `:1133-1136` (follow-up, Q-N1, Q-B1/Q-B2).
- **2.1:**
  - `flags.ts:117-133` (`run`), `:182-223` (prompt e `--detach`); `main.ts:887-912`, `:1085-1087` (nome su stdout), `:1123-1131` (`--auto-accept`, primo prompt).
  - `engine-runtime.ts:176` (daemon), `:464-467` (riga `still running`), `:518-520` (rete incondizionata del `run` semplice); `pod-stderr-log.ts:145-149` (`failed:`); `relay.ts:152` (modello del run), `:709` (launcher in silenzio); `relay-state.ts:13` (60 s), `:253` (`exitPlan`); `keep-awake.ts:4`.
  - Test: `run-prompt-args.test.ts`, `initial-prompt.test.tsx`, `main.test.ts:858`, `relay.test.ts:438`.
- **2.2:**
  - `attach-run.ts:318` (workload sparito), `:371` (avvio), `:464` (avviso keep=false), `:477` (auto-accept); `shared-auto-accept.ts`; `run-model.ts:15`; `main.ts:1182` (terminale), `:1242` (`useRunModel`), `:1280-1301` (`moveTo`), `:1462-1491` (riapertura del `run` semplice).
  - `attach-plan.ts:144-149` (`plainResumeUid`); `kept-index.ts:119-170` (`trackKeptSession`); `engine-k8s.ts:211` (più container); `pod-stderr-log.ts:162` (nome sconosciuto); `session-reducer.ts:15` (buffer per i replay lunghi); `StatusBar.tsx:38,104`, `status-view.ts`.
  - Test: `main.test.ts:1437,1483` (owner A, `--model`), `:1762,1778` (cartelle), `attach-plain-resume.test.ts`, `engine-runtime.test.ts:854`, `attach-run.test.ts:264,279` (KO4/R8), `local-runtime.test.ts:1179,1277` (KO4, R9), `status-view.test.ts`.
- **2.3:**
  - `commands.ts:204-218` (Ctrl+C / `/quit`), `:243-262` (conferma `y/N`); `attach-plan.ts:108` (`quitPlan`); `attach-run.ts:553-560` (righe di chiusura), `:460` (nota della rete); `local-runtime.ts:243-262` (`cutHistory`), `:471` (`saveConfirmed`), `:475` (`cutTurn`), `:669-675` (`dispose`, senza taglio); `daemon/persisted-session.ts:466-470,520` (note).
  - Rete: `engine-runtime.ts:307,332`.
  - Test: `relay.test.ts:1744-1818` (D13/D14), `attach-run.test.ts:238` (R6), `local-runtime.test.ts:1760,1774` (live item 6).
- **2.4:**
  - `daemon/persisted-session.ts:525` (`Failed`), `:537` (`closeFailedTurn`); `remote-client.ts:1861-1889` (causa del modello), `:294` e `:1572` (sessione sparita, R7/Q10); `attach-run.ts:558`.
  - `relay.ts:269` (`not saved — workload kept`), `:535-544` (keep=true `not saved`, anche fallito).
  - Test: `relay.test.ts:833` (F6), `:859` (Q-N1), `:907-951` (R6), `reattach.test.ts:514,545` (R7).
- **2.5:** `run-state.ts:412-481` (`statusOf`); `kept.ts:224` (`whereOf`), `:350` (`shownInPs`), `:489`, `:512` (`unreachableNote`); `kept-cmd.ts:142-195` (`ps`), `:332-342` (`rm`), `:388-396` (senza terminale), `:428` (nome su stdout); `agent/session-store.ts:570-586` (`.aside`). Test: `kept-cmd.test.ts:172-202` (F4), `:294-313`, `:458` (R6), `kept-where.test.ts`, `output-streams.test.ts`, `session-store.test.ts:510` (Q11).
- **2.6:** `main.ts:187-188,225` (help di `connect`: uscire stacca); `commands.ts:200-202` (`connect` `/exit`); `flags.ts:71`; AGENTS.md §7 (Persistence, `serve` archive). Test: `profile-flag.test.ts:110`, `session-flags.test.ts:169,190,221`.
