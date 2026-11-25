# eval/public-benchmark — un numero pubblico e credibile sull'harness tentacle

> **Status:** eval (Context + Review; Implementation/Execution vuote finché non promossa)
> **Branch:** nessuno — un `eval` va committato direttamente su `main` (AGENTS §10)
> Type: eval · Size: — · Blast: — · Suited: —
> **Changelog:** none

## Context

*— claude-opus-5-5, 2026-11-22*

**Richiesta dell'owner (22/11):** «Come faccio il benchmark pubblico?» — un numero pubblico
che dica se tentacle è un harness di frontiera, contro Claude Code, Codex CLI e altri.
Vincolo: «più soldi risparmiamo meglio è».

**La domanda.** Quale benchmark, con quale confronto minimo che isoli l'**harness** (stesso
modello, stessi task), quanto costa, e come si aggancia tentacle.

**Fatti dal web (verificati 22/11).**
- Terminal-Bench 2.0 gira su **Harbor**: `harbor run -d terminal-bench@2.0 -a <agente> -k 5 -n <concorrenza>`;
  89 task in container (Docker locale di default, o Daytona/Modal/E2B)
  ([docs Harbor](https://docs.harborframework.com/sandboxes/pre-integrated-sandboxes),
  [run a job](https://docs.harborframework.com/jobs/run-a-job),
  [TB 2.1](https://www.tbench.ai/news/terminal-bench-2-1)).
- Agente custom: **installed** (`BaseInstalledAgent`: `install()` + `run()` dentro il container,
  «prefer») o **external** (`BaseAgent`: il loop resta su Harbor e agisce con `environment.exec`).
  Si passa `-a module.path:ClassName`
  ([custom agents](https://docs.harborframework.com/agents/custom-agents)).
  `claude-code`, `codex`, `terminus-2` sono già integrati
  ([pre-integrated](https://docs.harborframework.com/agents/pre-integrated-agents)).
- Leaderboard: **minimo 5 trial per task**, PR su Hugging Face con cartella job + `metadata.yaml`;
  `timeout_multiplier` = 1.0, niente override di timeout/CPU/RAM; l'agente **non può accedere**
  al sito o al repo Terminal-Bench. Nessuna regola sul modello. Il README dice
  «SUBMISSIONS CLOSED … check back by end of June»: stato attuale **non verificato**
  ([leaderboard repo](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)).
  Le regole nuove chiedono **traiettorie ATIF** per ogni trial passato, con controllo da un
  agente giudice ([integrity](https://www.tbench.ai/news/leaderboard-integrity-update),
  [ATIF](https://docs.harborframework.com/agents/atif)). Per il 2.1 le submission della
  community sono chiuse ([repo 2.1](https://github.com/harbor-framework/terminal-bench-2-1)).
- DeepSeek ha un endpoint Anthropic (`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`)
  e una guida ufficiale per far girare **Claude Code su DeepSeek**
  ([guida](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code.md),
  [compatibilità](https://api-docs.deepseek.com/guides/anthropic_api.md)).
- Prezzi per 1M token, picco: `deepseek-flash` hit $0.006 · miss $0.30 · output $1.20;
  fuori picco la metà ([pricing](https://api-docs.deepseek.com/quick_start/pricing)).
  Claude Sonnet 5.5: input $2 · cache hit $0.10 · output $10
  ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

**Fatti dal codice (main `a2b4d508`).**
- Il one-shot `tentacle "<prompt>"` esiste già, senza Ink: un turno, risposta su stdout,
  traccia su stderr, poi esce (`packages/cli/src/main.ts:2338-2385`).
- Il one-shot **approva tutto**: `buildAgent` senza broker (`main.ts:2347`) crea
  `new PermissionBroker()` (`packages/cli/src/wiring.ts:507`), che senza `holdUntilSet` usa
  `allowAll` (`packages/core/src/permission.ts:177`, `:218`).
- `run --image … --detach --prompt … --auto-accept` crea il **suo** container
  (`packages/cli/src/flags.ts:865`, `main.ts:297-309`); `attach <name>` entra in uno esistente
  ma solo con la TUI (`main.ts:310-320`, nessun `--prompt`/`--detach` in `flags.ts` per attach).
- Binario Linux per container già prodotto: `bun-linux-x64`/`arm64`
  (`packages/cli/src/pod-binary-build.ts:262`), scaricabile dalla release
  (`packages/cli/src/pod-binary-download.ts:114`).
- `maxIterations` di default è **16** (`packages/config/src/defaults.ts:11`), env
  `TENTACLE_MAX_ITERATIONS` (`packages/config/src/key-docs.ts:510-519`).
- Un budget token esiste nell'agente (`packages/agent/src/agent.ts:572-580`) ma il top-level
  riceve solo `maxIterations` (`wiring.ts:793`): nessun tetto token per il turno principale.

## Implementation

## Execution

## Review

*— claude-opus-5-5, 2026-11-22*

### 1. Quale benchmark per primo: Terminal-Bench 2.0

Terminal-Bench misura **agente + modello** in un terminale, ed è nato per gli harness: in
classifica ci sono Claude Code, Codex CLI, Terminus. Harbor ha già gli adapter dei concorrenti,
quindi lo stesso comando li fa girare sul **nostro** modello. 89 task: costo contenuto.

SWE-bench Verified, invece: 500 task, solo repository Python, immagini pesanti
([verified](https://swebench.com/verified)). La classifica *bash-only* fissa l'harness a
mini-SWE-agent: confronta modelli, non harness, quindi tentacle lì non può comparire
([bash-only](https://swebench.com/bash-only.html)). Ed è quasi saturo (fonti terze danno
~97% ai modelli di punta, [vals.ai](https://www.vals.ai/benchmarks/swebench)): un buon
harness non si distingue. Secondo, se mai.

### 2. Il confronto più economico e credibile

**Stesso modello per tutti: DeepSeek Flash.** Tentacle già lo usa (`--profile deepseek`,
`docs/eval/deepseek-efficiency.md`). Claude Code gira su DeepSeek secondo la guida ufficiale.
Avversari: `claude-code` e `terminus-2` (l'harness di riferimento di Terminal-Bench), stessi
task, stessi timeout. Il numero pubblicato è il **delta** tra harness, non il valore assoluto.
Limite onesto: DeepSeek ignora alcune funzioni Anthropic (es. `cache_control`, alcuni
`tool_choice`), e questo può penalizzare Claude Code; va scritto accanto al risultato.

**Quanti task.** Con p≈0.5 e un trial, l'errore al 95% è ±31 punti su 10 task, ±10 su 89. Su
89 task × 5 trial, con confronto appaiato, si vedono differenze di ~6-8 punti. Quindi: **10
task = solo smoke test** (funziona, non crasha), **89×5 = il numero pubblico**.

**Tabella costi (STIME).** Ipotesi per trial: ~40 round, 1,5M token input totali (85% in
cache), 30k output.

| Esecuzione | Trial | DeepSeek Flash (picco) | Sonnet 5.5 |
|---|---|---|---|
| per trial | 1 | ~$0.11 | ~$1.0 |
| smoke 10 task × 1 | 10 | ~$1 | ~$10 |
| completa 89 × 5, un harness | 445 | ~$50 (~$25 fuori picco) | ~$450 |
| apples-to-apples, 3 harness | 1335 | ~$150 (~$75 fuori picco) | ~$1350 |

Docker locale: zero costi di sandbox. Raccomandazione: **tutto su DeepSeek, fuori picco** (weekend).

### 3. Come si aggancia tentacle

**(b) Installed agent — raccomandato.** Una classe Python `TentacleAgent(BaseInstalledAgent)`:
`install()` scarica il binario Linux; `run()` esegue
`TENTACLE_MAX_ITERATIONS=… tentacle --profile deepseek "<istruzione>"` nella cartella del
task. È la forma che Harbor preferisce, funziona su ogni sandbox, e il one-shot esiste già
(`main.ts:2338-2385`). Costo: la **chiave del modello entra nel container**. È un'eccezione
voluta a AGENTS §7, limitata al benchmark: chiave DeepSeek dedicata, con credito basso.

**(a) Tentacle sull'host con `attach` — dopo, forse.** Modello sul laptop, ma Harbor crea lui il container, quindi `run --image` non serve; `attach` oggi è solo
TUI (`main.ts:310-320`); e passerebbe dal nostro client Docker, non da `environment.exec`,
quindi solo Docker locale.

**Regola di sicurezza.** Il one-shot approva ogni tool (`wiring.ts:507`,
`permission.ts:218`). È accettabile **solo** perché ogni container di task è usa-e-getta e
contiene solo il task. Mai riusare questa configurazione (né `--auto-accept`) altrove, e mai
con chiavi o credenziali reali.

**Gap (cose che mancano).**
1. **Traiettoria ATIF**: il one-shot non salva la sessione (`main.ts:2366` chiama `agent.run`
   direttamente) ed emette solo testo su stderr. Serve `--trajectory <file>` in ATIF,
   obbligatoria per la leaderboard.
2. **Exit status**: esce 0 a fine loop anche se ha esaurito i round (`main.ts:2375`). Serve
   uno stop reason leggibile (`end_turn` / `max_iterations` / `max_token_budget`).
3. **Tetto token** per il turno principale: oggi non è cablato (`wiring.ts:793`).
4. **Usage leggibile da macchina** (token input/cache/output) per `populate_context_post_run`.
5. **Round**: 16 è troppo poco per Terminal-Bench; va alzato e dichiarato.
6. Da verificare: il binario `bun-linux` gira sulle immagini dei task (glibc vs musl).

### 4. Piano MVP a slice

| # | Slice | Size · Blast |
|---|---|---|
| S1 | `feat/oneshot-bench-output`: `--trajectory` ATIF, stop reason ed exit code, usage JSON, tetto token top-level (gap 1-4) | M · cross-module |
| S2 | Adapter Harbor `TentacleAgent` (Python, fuori dal monorepo TS o in `tools/bench/`) | S · contained |
| S3 | Smoke: 10 task × 1, DeepSeek, tentacle + claude-code; controllo a mano di 3 traiettorie | S · contained |
| S4 | Run completo 89 × 5 × 3 harness, DeepSeek, fuori picco | M · contained |
| S5 | Pubblicazione: PR leaderboard (se aperta) + pagina tentacle.so con tabella, comandi esatti e traiettorie | S · contained |

### 5. Rischi

- **Regole leaderboard.** Accesso a tbench.ai o al repo: tentacle non ha tool web, ma lo
  shell può usare `curl`; serve un'istruzione nel prompt e un controllo sulle traiettorie.
  Niente override di timeout/risorse. Submission forse ancora chiuse: allora pubblichiamo solo
  sul nostro sito, con job completi scaricabili.
- **Costi fuori controllo.** Tetto token per task (S1), `-n` basso, credito DeepSeek
  prepagato. DeepSeek tende a girare a vuoto (`docs/eval/deepseek-efficiency.md`): lo smoke lo
  dirà subito.
- **Task instabili.** 5 trial e confronto appaiato; segnaliamo i task falliti da *tutti* gli
  harness.
- **Risultato brutto.** Tentacle sotto Claude Code. Decide l'owner se pubblicare.
- **Versioni.** Esistono TB 2.1 (submission chiuse) e, secondo [tbench.ai/benchmarks](https://www.tbench.ai/benchmarks),
  versioni successive non verificate qui: ricontrollare prima di S4.

### 6. Domande per l'owner

1. **Modello: solo DeepSeek, o anche un run Claude?** Raccomando solo DeepSeek per il primo
   numero (~$75-150); un run Sonnet (~$450 per harness) solo se il delta è buono.
2. **Chiave nel container (forma b)?** Raccomando sì, con chiave dedicata a credito basso.
3. **Se tentacle esce peggio, pubblichiamo?** Raccomando: pubblicare comunque sul nostro sito
   dopo un giro di fix, perché un numero onesto vale più di nessun numero.
4. **Leaderboard ufficiale o solo nostro sito?** Raccomando entrambi; se la leaderboard è
   chiusa, il nostro sito con job completi riproducibili.

### Verdetto

**GO-with-conditions** — condizioni: tutto su DeepSeek fuori picco, tetto token per task,
container usa-e-getta, pubblicazione decisa dall'owner. Prima slice: **S1
`feat/oneshot-bench-output`** (traiettoria ATIF, exit status, usage, tetto token).
