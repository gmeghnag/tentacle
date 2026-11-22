# eval/agent-workflows — workflow agentici che il modello scrive e tentacle esegue, a step

> **Status:** feat — promoted from eval 2026-11-22 (owner GO); Implementation being written
> **Branch:** `feat/agent-workflows`
> Type: eval · Size: — · Blast: — · Suited: —
> **Changelog:** none

## Context

*— claude-opus-5-5, 2026-11-22*

**Richiesta dell'owner (22/11 01:55, testuale):** «creare in tentacle la possibilità di far
comprendere al modello dei workflow di lavoro agentico che lui può creare, a step, con le
eccezioni, la sequenza ecc, pensa a tekton per agenti, anche n8n è un'idea di ispirazione; con
lui che fa da orchestratore ma soprattutto anche creatore, magari una build usa un agente su
docker, con ogni step il suo prompt ecc.. che ne pensi? mi farai un report con pro contro cosa
ha senso cosa no ecc». 01:58: «anche la visualizzazione in TUI e in app, deve essere magnifica
per livello di accuratezza ma semplicità di utilizzo».

**La domanda.** Ha senso un workflow agentico *dichiarato* (step, sequenza, eccezioni,
dove gira ogni step), scritto dal modello e approvato dall'utente? Se sì, quale forma minima
costruiamo per prima?

### 1. Che cosa sarebbe, in termini di tentacle

Un workflow è un **file nel repo** (es. `.tentacle/workflows/<nome>.yaml`). Lo scrive il modello,
l'utente lo approva. Ogni step ha: un prompt, un modello, un *dove* (locale / docker / pod),
input e output, e una regola in caso di errore. Il motore **non è un nuovo agent loop**: ogni
step è un sub-agente, cioè la stessa chiamata di `agent_task` (`packages/tools/src/task.ts:363`),
che già accetta `model` per step (`task.ts:339-349`) e `background` (`task.ts:350-358`). Uno step
"comando" (build, test) è uno shell; su docker/pod c'è già `workload_shell`
(`packages/tools/src/workload-shell.ts:65` `WorkloadTarget`, permesso in
`packages/agent/src/permission-gate.ts:70`). Il trigger a orario esiste già: `schedule_create`
(`packages/core/src/tool-groups.ts:22`, `docs/feat/cron-tool.md`). Ogni permesso passa dal
**solo** `PermissionBroker` (`packages/core/src/permission.ts:211`). Il modello resta sul laptop
(`ProxyModelProvider`, `packages/daemon/src/proxy-model.ts:179`). Lo stato del run vive nel log
della sessione, come già i marker dei sub-agenti (AGENTS §7, persistenza). Nuovo è solo **un formato file + un piccolo esecutore deterministico**.

**Prova concreta che serve: noi stessi.** In `.tentacle/tmp/orchestration/` ci sono **963
script zsh** scritti a mano. `night-task3.sh` (59 righe) è proprio un workflow: plan (Opus) →
exec (DeepSeek, con retry su `ECONNRESET`, riga 24) → review Opus → loop fix/review fino a 3
round (righe 44-49) → lock di merge (riga 54) → gate su `main`, e se rosso revert (riga 58).
`chain-cron-tool.sh` concatena 6 slice, alcune su Opus, e si ferma al primo non-PASS.
`chain-ios-build-pushcore.sh` crea worktree → plan → exec → merge. Il verdetto si legge con
`grep "PASS"` (`night-task3.sh:27`): fragile. Dal telefono non si vede niente.

### 2. Tre forme, dalla più piccola alla più grande

**A — "Piano vivo" senza file.** Il modello dichiara un piano (lista step) con un tool, e lo
esegue lui stesso con `agent_task`. tentacle mostra solo il piano e lo stato degli step.
*Vede:* una rail di step sopra la chat (TUI e iPhone). *Costo:* S–M. *Sblocca:* visibilità.
*Limite:* nessuna garanzia. Il modello può saltare step, inventare un PASS, non ripetere.

**B — Workflow file + esecutore deterministico (consigliato).** Il file sopra. Il modello lo
crea (è un file: diff, review, git). L'utente lo approva una volta *come testo*. Poi un
esecutore in codice (non il modello) segue la sequenza: step per step, verdetto da un output
strutturato (non da `grep`), retry con limite, ramo d'eccezione, budget token totale.
*Vede:* `/workflow run <nome>`, una vista run (rail + dettaglio step), approvazioni dove
servono. *Costo:* L → da spezzare in slice M. *Sblocca:* sostituire i nostri script zsh,
ripetibilità, run da telefono, run staccati (detached) che continuano senza TUI.

**C — Motore completo stile n8n.** Trigger (webhook, push git, cron), editor visuale,
connettori, run paralleli multipli. *Costo:* L×n, un sottosistema nuovo. *Sblocca:* uso
"prodotto" per terzi. *Rischio:* rifare GitHub Actions/n8n peggio.

## Implementation

## Execution

## Review

*— claude-opus-5-5, 2026-11-22*

### 3. Pro, contro, rischi

**Pro.**
- Ripetibile: lo stesso workflow gira uguale stanotte e domani.
- Il modello giusto per ogni step (DeepSeek esegue, Opus rivede): già oggi facciamo così, a mano.
- Dove gira ogni step è esplicito: build in docker, review in locale.
- Visibile e controllabile da TUI e iPhone; sostituisce 963 script fragili.

**Contro.**
- Un altro formato da mantenere e versionare (come un on-disk record: `schemaVersion`).
- Il modello che scrive YAML sbaglia: serve una validazione rigida, con errori chiari.
- Per compiti piccoli è più lento che chiedere all'agente.

**Sicurezza (§7) — le regole non negoziabili.**
- **Un workflow scritto dal modello non si concede mai permessi.** Un campo tipo
  `allow: [shell]` nel file **non vale niente** finché l'utente non l'approva sul laptop,
  tramite il broker unico. L'approvazione è legata all'**hash del file**: se il modello lo
  modifica, si richiede di nuovo.
- **Step non presidiati vs domande di permesso.** Uno step che chiede un permesso in un run
  notturno **si ferma e aspetta** (stato `in attesa`, notifica sul telefono). Mai auto-approvare
  di notte. Solo prefissi di comando approvati in anticipo dall'utente (come le grant
  `workload_shell`, `packages/agent/src/session-grants.ts:15`) passano da soli.
- **Un pod non è fidato.** L'output di uno step in pod è *dato*, non istruzione: non può
  cambiare il workflow, né il ramo successivo se non tramite un verdetto tipizzato e validato
  sul laptop. La chiave del modello non va mai nel pod (step in pod = `ProxyModelProvider`).

**Costo token e loop infiniti.** Ogni step ha un tetto (esiste già il budget per sub-agente,
`docs/feat/subagent-token-budget.md`). Il workflow ha un tetto totale e un numero massimo di
retry (default 2) e di round di review (come i nostri 3). Niente cicli liberi: solo `retry` e
`on_fail: goto <step>` con contatore. Superato il tetto → stop, stato `fermato: budget`.

**Determinismo e debug.** Il *flusso* è deterministico (codice); il *contenuto* di ogni step no
(LLM). Per il debug: ogni step salva prompt, modello, dove, input, output, token, durata, nel
log della sessione. Si può rilanciare **un solo step** con gli stessi input.

**Fallimenti e retry: come converge.** Ogni step finisce in uno di 4 stati: `ok`, `errore`,
`fermato` (budget/annullato), `in attesa` (permesso). Il workflow va avanti solo su `ok`; su
`errore` segue la regola (`retry N` → `goto` → `stop`). Uno step interrotto (crash, laptop
chiuso) al reload è **chiuso onestamente** e rifatto da capo, come oggi un turno tagliato
(AGENTS §7: "any other turn cut short is closed honestly"). Mai "ripreso a metà" in silenzio.

**Differenza dal "chiedilo all'agente".** L'agente da solo può farlo, ma: dimentica uno step,
dichiara PASS senza prova, non è ripetibile, non è visibile come sequenza. Il workflow sposta
**la sequenza e le regole nel codice**, lascia al modello solo il lavoro dentro lo step.

**Sovrapposizioni.**
- *Già in tentacle:* `agent_task` (step singolo), `schedule_create` (trigger orario), detached
  run (girare senza TUI), skills (istruzioni riusabili — ma non eseguono una sequenza).
- *GitHub Actions:* rubare il formato YAML semplice (`steps`, `needs`, `if`). Non rubare: il
  runner remoto e i segreti nel cloud.
- *Tekton:* rubare "ogni step ha la sua immagine/workspace". Non: CRD e cluster obbligatorio.
- *n8n:* rubare la vista a nodi e il "vedi l'output di ogni nodo". Non: l'editor visuale.
- *Temporal:* rubare la storia degli eventi rigiocabile e i retry con politica. Non: il server.
- *LangGraph:* rubare stato tipizzato tra nodi e i checkpoint. Non: grafi con cicli liberi.

### 4. Ora / dopo / mai

- **Ora:** forma B, ridotta (MVP sotto).
- **Dopo:** step paralleli (`needs`), trigger su push git, workflow lanciato da `schedule_create`,
  libreria di workflow condivisi tra progetti.
- **Mai:** editor visuale drag-and-drop; connettori stile n8n (Slack, Gmail…: ci sono gli MCP);
  un workflow che si auto-approva o si auto-modifica durante il run.

**MVP (prima slice).** Un file `.tentacle/workflows/*.yaml`, solo **sequenziale**. Tipi di step:
`agent` (prompt + modello + dove) e `run` (comando shell, locale o `workload_shell`). Ogni step
`agent` termina con un verdetto tipizzato (`pass` / `fail` + motivo), non con `grep`. Regole
d'errore: `retry: N`, `on_fail: <step>`, `stop`. Tetto token totale. `/workflow run` in TUI,
vista run in TUI e iPhone. Approvazione per hash. Niente trigger, niente parallelismo.

**Esempio reale: il nostro `night-task3.sh` come workflow.**

```yaml
name: task
inputs: [slug, doc]
budget: { tokens: 3M }
steps:
  - id: plan    ; agent: { model: opus,     where: local,  prompt: plan.md }
  - id: exec    ; agent: { model: deepseek, where: local,  prompt: exec.md }; retry: 1
  - id: review  ; agent: { model: opus,     where: local,  prompt: review.md }
                  on_fail: { goto: fix, max: 3 }
  - id: fix     ; agent: { model: deepseek, where: local,  prompt: fix.md }; next: review
  - id: gate    ; run: "bun run check";      where: docker; on_fail: stop
  - id: merge   ; approve: user              # approvazione esplicita, sempre
  - id: ios     ; run: "bun run e2e";        where: local
```

(Sintassi indicativa; la forma esatta va decisa nella Implementation.)

### 4b. Visualizzazione

Principi: **lo stato non si dice mai solo col colore** (owner daltonico). Ogni stato ha un
glifo + una parola: `✓ ok`, `✗ errore`, `▸ in corso`, `○ in attesa`, `‖ fermato`, `? da
approvare`, `↻ 2/3` (retry). Il *dove* è un'etichetta testuale: `[local]` `[docker]` `[pod]`.

**TUI — idea 1: rail nella chat.** Il run è un blocco nella trascrizione, come oggi il blocco
del sub-agente (`packages/tui/src/subagent-view.ts`: testa + ultimi 5 step,
`SUBAGENT_TAIL_ROWS`). Una riga per step; lo step attivo mostra la coda live.

```
workflow task · cron-tool · 4/7 · 1.2M/3M tok
 ✓ plan    opus     [local]   2m  doc scritto
 ✓ exec    deepseek [local]  14m  ↻ 1/1 · 9 file
 ✗ review  opus     [local]   3m  REQUEST-CHANGES (2)
 ▸ fix     deepseek [local]   …   ↳ edit packages/x.ts
 ○ review  ↻ 2/3
 ○ gate    [docker]
 ? merge   attende te          ⏎ apri
```

**TUI — idea 2: pannello a due colonne** (si apre con un tasto, come il pannello sub-agenti).
A sinistra la rail; a destra il dettaglio dello step scelto: prompt, input, output, token, e
il ramo d'eccezione preso.

```
┌ steps ─────────┬ review (round 1) · opus · [local] ───────┐
│ ✓ plan         │ ✗ errore: REQUEST-CHANGES                │
│ ✓ exec         │ 1. task.ts:380 manca abort               │
│›✗ review       │ 2. test vacuo (mutation non fallisce)    │
│ ▸ fix  ↻1/3    │ → on_fail: goto fix (1 di 3)             │
│ ○ gate         │ in 41k · out 3k · 3m12s                  │
│ ? merge        │ [r] rilancia step  [o] output completo   │
└────────────────┴──────────────────────────────────────────┘
```

**iPhone — idea 1: rail verticale** (riusa `stepRail`/`stepNode` di `tools/mockup-kit/kit.js:153,180`,
stati `ok`/`error`/`running`/`pending`, `docs/feat/mobile-mockup-kit.md:337`). Tap su uno step
→ si apre il dettaglio. Lo step da approvare è un bottone grande in fondo.

```
 task · cron-tool        4/7
 │ ✓ plan     opus   local
 │ ✓ exec     ds     local  ↻1
 │ ✗ review   opus   local
 │   └ 2 problemi → fix
 │ ▸ fix      ds     local
 │ ○ gate            docker
 ┃ ? merge — attende te
 [  Approva merge  ] [ Ferma ]
```

**iPhone — idea 2: card riassunto + timeline.** In alto una card: nome, `4/7`, step attivo,
token, una sola azione richiesta. Sotto, la timeline compatta con solo gli step *cambiati*
(errori, retry, approvazioni). Pensata per il controllo veloce dal lock screen / notifica.

```
┌ task · cron-tool ─────────┐
│ ▸ fix (deepseek, local)   │
│ 4 di 7 · 1.2M tok · 23m   │
│ ? merge attende te        │
└───────────────────────────┘
 02:14 ✗ review → fix (1/3)
 02:01 ↻ exec ritentato
 01:47 ✓ plan
```

Consiglio: TUI 1 + pannello 2 al tasto; iPhone 1, con la card del 2 come notifica/hub.
Mockup HTML dopo la scelta (`docs/MOCKUP-BRIEF.md`).

### 5. Domande per l'owner

1. **Dove vive il file?** `.tentacle/workflows/` (gitignored, personale) o `workflows/` nel repo
   (condiviso)? *Consiglio:* nel repo, versionato; approvazione per hash sul laptop.
2. **Chi esegue la sequenza: codice o modello?** *Consiglio:* codice (forma B). Il modello crea
   e modifica il workflow, non decide il prossimo step a runtime.
3. **Primo `where` supportato?** *Consiglio:* `local` + `docker` per gli step `run`; step
   `agent` in pod dopo (dipende da `docs/eval/subagent-in-pod.md`, ancora aperta).
4. **Step con permesso in un run notturno:** aspettare o fallire? *Consiglio:* aspettare, con
   notifica al telefono e timeout configurabile → poi `fermato`.
5. **Il merge può essere automatico?** *Consiglio:* no nell'MVP: `approve: user` obbligatorio
   prima di ogni merge/push. Lo rilassiamo dopo, se i run si dimostrano affidabili.

### Verdetto

**GO — forma B ridotta:** workflow sequenziale da file, esecutore deterministico, approvazione
per hash, vista run TUI + iPhone. Primo banco di prova: sostituire `night-task3.sh`.
Size L complessiva → da spezzare in slice M (formato+validazione · esecutore · vista TUI · vista
iPhone). Blast: load-bearing (broker, persistenza, pod trust): modello forte + Review a contesto
fresco obbligatoria.
