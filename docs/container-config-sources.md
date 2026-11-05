# Da dove una sessione in container prende la sua configurazione

> **Aggiornato da `feat/config-carry`:** il laptop porta i suoi valori nel pod per
> sessione, con `session/open.settings` (`docs/feat/config-carry.md`). Dove il testo
> sotto cita ancora `--context-window` o `--auto-title`, vale §1, §2.1, §2.9 e §3.

Scopo: elencare, per ogni pezzo di setup, **chi lo legge** (laptop o
container/daemon), **da quale percorso**, **quando**, e **cosa passa** dal
laptop al container. Casi: `tentacle run` / `run --detach` / `attach` su
Kubernetes (pod), Docker e Podman; per confronto la sessione locale e
`connect` verso un daemon `serve`. Fonte: codice su `main` @ `7bcae4b`.

Glossario breve:
- **laptop** = il processo `tentacle` dell'utente (TUI, relay di `--detach`).
- **pod daemon** = `tentacle serve --bridge` → `serve --resident` dentro il
  workload (pod o container). Stesso codice per k8s, Docker e Podman.
- **configDir** = `TENTACLE_CONFIG_DIR` > `$XDG_CONFIG_HOME/tentacle` >
  `~/.config/tentacle`, risolto **sul lato che legge** con il suo env e il suo
  `HOME`.

## 1. Tabella riassuntiva

| Voce | locale (worker) | k8s (`run`/`attach`) | docker | podman | `connect` → `serve` |
|---|---|---|---|---|---|
| `config.jsonc` + profilo | laptop | laptop (modello, engine, keep, mount) **+ pod** (tutto il resto) | come k8s | come k8s | host di `serve` |
| `--profile` / `--model` | laptop | solo laptop; non inoltrati al pod | come k8s | come k8s | flag di `serve`; vietati su `connect` |
| context window | laptop | laptop → `session/open.settings` (P) | come k8s | come k8s | host di `serve` |
| provider, endpoint, API key | laptop | laptop (tunnel `model/stream`) | come k8s | come k8s | host di `serve` |
| server MCP | laptop (worker) | **nessuno** | **nessuno** | **nessuno** | **nessuno** |
| skill | laptop | pod (FS del pod) | container (+ progetto montato) | come docker | host di `serve` |
| sub-agent (`agents/*.md`) | laptop | pod configDir | container configDir | come docker | host di `serve` |
| `PROMPT.md` + `AGENTS.md` | laptop | pod | container (AGENTS.md dal mount) | come docker | host di `serve` |
| workspace root | cwd laptop | `WORKDIR` dell'immagine | cwd laptop montato (stesso path) / `WORKDIR` con `--no-mount` | come docker | cwd di `serve` |
| hook utente | laptop | pod config | container config | come docker | host di `serve` |
| project hooks + trust | laptop, trust salvato | pod scopre, laptop chiede, **mai salvato** | come k8s | come k8s | `serve` scopre, laptop chiede, mai salvato |
| permessi | broker unico laptop | broker unico laptop (via RPC) | come k8s | come k8s | broker laptop (via RPC) |
| `tools.*` | laptop | env/file del pod, altrimenti laptop (W) | env/file del container, altrimenti laptop (W) | come docker | host di `serve` |
| `subagents.*`, `model.autoTitle` | laptop | sempre laptop (P) | come k8s | come k8s | host di `serve` |
| binario | — | laptop inietta in `/usr/local/bin` (o `--bin-dir`) | come k8s | come k8s | — |
| storia sessioni | laptop `<configDir>/sessions` | laptop; pod solo in memoria | come k8s | come k8s | solo `serve` (`<configDir>/daemon/…`) |

## 2. Dettaglio per voce

### 2.1 File di config, profili, configDir

- File: `<configDir>/config.jsonc` (non `config.json`)
  (`packages/config/src/defaults.ts:51`). Ordine di precedenza: env >
  profilo > file > default (`packages/cli/src/main.ts:238`,
  `packages/config/src/index.ts:4`).
- configDir: `resolveConfigDir` (`packages/config/src/load.ts:374-385`):
  opzione esplicita > `TENTACLE_CONFIG_DIR` > `$XDG_CONFIG_HOME/tentacle` >
  `$HOME/.config/tentacle`. Si usa l'env **del processo che legge**.
- Profilo: `--profile` > `TENTACLE_PROFILE` (`load.ts:455`), applicato prima
  di qualunque lettura (`load.ts:453-460`, `profile.ts:47-57`). `--model` va in
  una copia di env come `TENTACLE_MODEL` (`load.ts:414-416`); la context
  window resta quella del profilo (`main.ts:209-211`).
- **Laptop**: un solo `loadConfig` all'avvio, con scaffold
  (`main.ts:541-546`). Il worker locale riceve **la config del laptop**
  per messaggio di bootstrap (`packages/cli/src/worker.ts:55`).
- **Pod daemon**: lo stesso `main.ts` gira nel pod e chiama `loadConfig`
  con `scaffold: false` per le modalità `stdio/bridge/resident/…`
  (`main.ts:530-546`, `pod-resident.ts:757-764`). Legge quindi la configDir
  **del pod** (env e `HOME` del container). File assente → default
  (`load.ts:449-451`).
- Cosa passa al pod: argv di `podDaemonCommand` è solo `serve --bridge
  --model-proxy`; i valori viaggiano per sessione in `session/open.settings`
  (`packages/cli/src/carried-settings.ts`): 7 chiavi P (decide il laptop) e 14 W
  (il valore del laptop è il livello più basso; env e file del pod vincono). Nessuna
  env: il container Docker/Podman è creato "no env" (`engine-docker.ts:85-106`), il
  pod k8s non ha `env` nel manifest (`packages/k8s/src/pod.ts:54-60`). `--profile` e
  `--model` non arrivano al pod: un profilo vale tramite i valori che risolve.
- Quando: il pod daemon legge la **sua** config una volta, all'avvio del resident
  (senza eseguire `apiKeyCommand` né leggere `agentTaskDescriptionFile`). I valori del
  laptop si applicano a ogni sessione **creata**; una sessione viva tiene i suoi, e il
  laptop avvisa delle differenze.
- `run --detach`: il relay (processo laptop) ricarica `config.jsonc` al suo
  avvio con il profilo dello spec (`packages/cli/src/relay.ts:604-608`); il
  modello è quello registrato nell'entry kept, non dall'env
  (`relay.ts:148-152`).
- `attach`: usa il modello/profilo del run, salvo `--profile`/`--model`
  espliciti (`main.ts:1242-1264`); ricarica la config come se fosse lanciato
  dalla cartella del run (`main.ts:1280-1297`).
- `serve`: `loadConfig` normale sull'host del daemon, con i suoi
  `--profile`/`--model` (`main.ts:212-215`, `main.ts:541-546`).

### 2.2 Modello: provider, endpoint, API key

- Sempre risolti sul **laptop** per run/attach: `laptopModels`
  (`engine-runtime.ts:98-111`) → `configuredModelProvider`
  (`packages/cli/src/model-provider.ts:16-26`). L'API key viene da
  `TENTACLE_MODEL_API_KEY` / `apiKey` / `apiKeyCommand` (`load.ts:515-521`).
- Il pod non ha provider: `tunnelledAgent` mette un `ProxyModelProvider` che
  chiama il laptop via `model/stream(Chunked)` (`packages/cli/src/serve.ts:370-406`).
  Il laptop serve con il **suo** provider (`packages/client/src/remote-client.ts:1840-1851`,
  `1909-1922`); il model id nel payload è quello del laptop
  (`packages/providers/src/anthropic-provider.ts:92`).
- Override per tipo di sub-agent ignorati nel tunnel (`wiring.ts:243-247`,
  `wiring.ts:384`). Titoli: decide il laptop (`--auto-title`, `titleModel`)
  (`serve.ts:359-366`).
- `serve`: il provider e la chiave sono quelli dell'**host di serve**
  (`wiring.ts:280`); `connect` non manda modello (`connect.ts:129`, provider
  `undefined`).

### 2.3 Server MCP

- Avviati **solo** nelle sessioni locali: worker (`worker.ts:74-93`),
  in-process (`main.ts:1606-1614`), one-shot (`main.ts:1662`). Config:
  `mcpServers` del laptop (+ pacchetti, `load.ts:524-528`).
- `serve` e pod daemon **non avviano MCP** (`packages/daemon/src/session-host.ts:125-128`;
  nessuna chiamata in `serve.ts` / `pod-resident.ts`). I `mcpServers` del
  laptop non vanno nel pod, e quelli del pod non vengono usati.
- I pacchetti del laptop non sono caricati in un pod (avviso
  `main.ts:637-641`).

### 2.4 Skill

- Radici (`packages/config/src/skills-scan.ts:49-74`): `.agents/skills/`
  risalendo dal cwd fino a `.git` (e mai oltre `HOME`), poi
  `<configDir>/skills/`, `~/.agents/skills/`, poi le `skills/` dei pacchetti.
  Disattivabili con `loadSkills:false` / `TENTACLE_NO_SKILLS` (`schema.ts:198-205`).
- Quando: scan all'avvio (`load.ts:487-496`). Hot reload: rescan dell'utente
  e reset di contesto rileggono le cartelle, non `config.jsonc`
  (`load.ts:274-364`, `wiring.ts:184-228`). Il set del **modello** resta
  quello d'avvio; il set `/name` dell'utente segue l'ultimo scan
  (`wiring.ts:341-363`).
- Run/attach: le skill sono **del pod** (sua config, suo FS)
  (`serve.ts:427-429`, `main.ts:615-619`); il corpo si legge dall'env della
  sessione, cioè dal FS del pod (`wiring.ts:114-121`). Con Docker/Podman e
  mount, le `.agents/skills/` del progetto sono le stesse del laptop (stesso
  path); quelle utente (`~/.agents/skills`, configDir) sono del container.

### 2.5 Definizioni sub-agent

- `<configDir>/agents/*.md`, poi `agents/` dei pacchetti; vince il primo
  (`wiring.ts:60-112`). Letto in `buildAgent` a ogni creazione di agente,
  cioè per sessione (`wiring.ts:375-379`).
- Run/attach: configDir **del pod** (nessun pacchetto). Locale: laptop.
  Diagnostica stampata solo dove la config del laptop costruisce l'agente
  (`main.ts:619-636`).

### 2.6 Istruzioni di progetto e workspace

- Prompt d'identità: `TENTACLE_SYSTEM_PROMPT` > `systemPromptFile` /
  `<configDir>/PROMPT.md` > default (`load.ts:462-472`, `load.ts:298-300`).
- Istruzioni di progetto: **solo `AGENTS.md`** (`defaults.ts:57`), il più
  vicino risalendo dal cwd, stop a `.git` (`load.ts:172-196`). `CLAUDE.md` non
  è letto (non trovato nel codice). Disattivabile: `loadAgentsMd:false` /
  `TENTACLE_NO_AGENTS_MD` (`schema.ts:192-197`). Riletto a ogni reset di
  contesto (`load.ts:285-314`, `wiring.ts:397-418`).
- Nel pod tutto questo è letto **dal pod daemon**, dal suo cwd.
- Workspace root nel container: il daemon usa il **suo** `defaultCwd`; il
  `cwd` mandato dal laptop in `session/open` non è onorato
  (`session-host.ts:5-7`, `serve.ts:430-431`, `engine-runtime.ts:979`).
  - k8s: l'exec non ha working dir (`k8s/src/exec-channel.ts:250`), quindi è il
    `WORKDIR` dell'immagine. Nessun mount possibile (`engine-k8s.ts:145-148`).
  - Docker/Podman con mount locale: cwd del laptop montato allo stesso path,
    exec con `WorkingDir` = target e user mappato (`engine-docker.ts:222-229`,
    `354-363`); in `attach` ricavato dalle label (`engine-docker.ts:115-125`,
    `287-291`). Sempre nascosti: configDir e file della chiave
    (`workspace-mount.ts:19-20`, `schema.ts:273-280`), più `.tentacle/hide`
    (`workspace-mount.ts:201-215`).
  - Docker/Podman con `--no-mount` o engine remoto: `WORKDIR` dell'immagine
    (`main.ts:274-279`).
  - Podman usa lo stesso `dockerEngineHost` (`engine-select.ts:548`).

### 2.7 Hook e project trust

- Hook utente: `hooks` di config + pacchetti (`load.ts:524-528`). Nel pod:
  quelli della config **del pod** (`wiring.ts:306-331`).
- Project hooks: `.agents/hooks.json` risalendo dal cwd
  (`packages/config/src/hooks-scan.ts:16`, `120`), scoperti all'avvio
  (`load.ts:498-504`) dal lato che costruisce l'agente.
- Trust: deciso **sul laptop**. Il daemon chiede con `hooks/trust` via RPC
  (`packages/daemon/src/connection.ts:449-451`); il laptop risponde con il
  broker unico (`local-runtime.ts:540-549`).
  - Locale (worker): decisione salvata in `<configDir>/hooks-trust.json`
    (`hooks-trust.ts:20`, `100-104`; `local-runtime.ts:874-877`).
  - Pod (c'è `modelProvider`): store **mai** passato, si chiede ogni volta
    (`local-runtime.ts:541-547`).
  - `connect`: mai salvato (`connect.ts:132-133`).
- Nel tunnel un hook non può fare `allow` e i hook `model_request` sono spenti
  (`wiring.ts:316-328`).

### 2.8 Permessi / approvazioni

- Il daemon fa rispondere al broker della sessione via RPC
  (`packages/daemon/src/hosted-session.ts:442`). L'unico broker interattivo è
  quello del laptop passato a `RemoteClient` (`local-runtime.ts:551`) e alla
  TUI (invariante §7). Vale uguale per k8s, Docker, Podman e `connect`.
- `run --auto-accept` è stato della TUI del laptop (`main.ts:808-833`).

### 2.9 Impostazioni dei tool (`tools.*` e simili)

- Schema: `tools.maxInlineOutputChars`, `redactSecrets`, `dedupOutput`,
  `tabulateJson`, `summarizeLargeOutput`, `execution`, `maxParallel`
  (`schema.ts:296-327`). Applicate in `buildAgent` (`wiring.ts:287-339`,
  `437`).
- Run/attach: env e file del pod, altrimenti il valore del laptop portato in
  `session/open.settings`. Idem `maxIterations`, `contextAwareness`,
  `contextReset`, `loadAgentsMd`, `loadSkills`. `subagents.*` è sempre del laptop.
  `autoWake` non viaggia: lo legge solo la TUI del laptop.
- Output grande: spill in `.tentacle/tool-output/<tool>-<id>.txt` **relativo
  al workspace della sessione** (`packages/agent/src/agent.ts:1722-1739`):
  nel FS del pod; con mount Docker/Podman finisce nella cartella del laptop.
  Cambio pianificato in `TODO.md:428` (fix/tool-output-location).
- `summarizeLargeOutput` nel pod usa il modello del tunnel (`wiring.ts:291-295`).

### 2.10 Binario nel pod

- Scelto **sul laptop** (`pod-binary-build.ts:1-16`, `246-280`):
  1. `TENTACLE_POD_BIN` (path esplicito, mai build/cache);
  2. release: solo `<configDir>/bin/tentacle-<target>` con marker di versione
     uguale (`pod-binary-build.ts:155-159`, `193-215`), altrimenti errore
     "tentacle update"; controllato prima di creare il pod
     (`engine-runtime.ts:425-427`);
  3. da sorgente (`dev`): configDir/bin → cache `dist/pod-bin` → build.
- Installato in `${--bin-dir | TENTACLE_POD_BIN_DIR | /usr/local/bin}/tentacle`
  (`main.ts:914`, `engine-runtime.ts:408`, `pod-binary.ts:33`), verificato
  con `--version` (`pod-binary.ts:344-357`).
- `attach`: prova prima il path d'installazione, poi `tentacle` sul `PATH`;
  riusa solo se è la versione attesa, altrimenti sostituisce (se nessun run
  detached lo usa) (`engine-runtime.ts:782-929`).

### 2.11 Storia / persistenza

- Laptop: `<configDir>/sessions/<projectKey(cwd)>/` (`main.ts:780`,
  `relay.ts:318`), scritto dal saver di `createLocalRuntime`
  (`engine-runtime.ts:23-24`, `627`, `978`).
- Pod daemon: **nessuna** persistenza; sessioni solo in memoria nel resident
  (`serve.ts:422-454`, nessun persister). Solo `serve` scrive
  `<configDir>/daemon/<projectKey(cwd)>/` (`serve.ts:91-133`).
- `connect`: nessuna copia sul laptop; vale il record di `serve`
  (AGENTS.md §7).
- Log errori locale: `<configDir>/logs/daemon-errors.log` (`worker.ts:134`).

## 3. Punti da rivedere

1. **(Fatto per `tools.*`, `maxIterations`, `subagents`, `contextAwareness`,
   `contextReset`: `feat/config-carry`. Restano `PROMPT.md`, `hooks`, `agents/`.)**
   **La config "di comportamento" è quella del pod, non del laptop.** In
   Docker/Podman la configDir del laptop è sempre nascosta, in k8s non c'è
   proprio: in pratica il pod gira con i **default** (`PROMPT.md`, `tools.*`,
   `maxIterations`, `subagents`, `hooks`, `agents/`). L'utente vede il suo
   `config.jsonc` applicato solo a metà. → Decidere esplicitamente; proposta:
   inoltrare dal laptop un sottoinsieme non segreto (`tools.*`,
   `maxIterations`, `subagents`, `contextAwareness`/`contextReset`) come flag,
   come già si fa per `--context-window`.
2. **MCP assente in run/attach/serve.** I `mcpServers` del laptop spariscono
   e quelli del pod non vengono avviati (`session-host.ts:126`). → Decidere
   se il pod debba avviare i *suoi* MCP (calcolo vicino al codice, §7) e
   dirlo all'utente all'avvio come per i pacchetti.
3. **(Fatto per le chiavi portate: `feat/config-carry`. L'avviso per `hooks`,
   `mcpServers`, `PROMPT.md`, `agents/` è il task successivo.)**
   **`--profile`/`--model` cambiano solo il modello.** Un profilo che
   modifica `tools.*` o `hooks` non ha effetto nel pod. → Avvisare quando il
   profilo attivo tocca chiavi che il pod ignora.
4. **(Fatto: `feat/config-carry`.)**
   **Resident con flag "congelati".** Un `attach` con `--context-window`
   o `autoTitle` diversi entra in un resident che tiene i flag del primo exec
   (`engine-runtime.ts:74`). → Avvisare sulla differenza, o far viaggiare
   questi valori per sessione/connessione invece che in argv.
5. **Workspace k8s implicito.** Il cwd è il `WORKDIR` dell'immagine (spesso
   `/`), senza flag per sceglierlo; `AGENTS.md`, skill e hook di progetto
   dipendono da questo. → Aggiungere `--workdir` (o un default esplicito)
   e mostrarlo nella status bar.
6. **Skill e sub-agent utente: silenziosamente quelli del pod.** Le
   diagnostiche del pod vanno nel log, non a terminale (`main.ts:615-619`).
   → Mostrare all'avvio il conteggio skill/agent del pod (`session/skills`
   esiste già).
7. **Spill dei tool output nel mount.** Con Docker/Podman e mount, il pod
   scrive `.tentacle/tool-output/` dentro la cartella del laptop. → Già
   coperto da fix/tool-output-location: verificare che la nuova cartella
   (`~/.cache` del *container*) non finisca nel mount.
8. **`apiKeyCommand` / env del laptop non vanno nel pod — bene — ma
   neanche `TENTACLE_SYSTEM_PROMPT`, `TENTACLE_NO_AGENTS_MD`, ecc.** Le env
   `TENTACLE_*` del laptop valgono solo lato laptop. → Documentarlo in
   `--help` (oggi elenca le env senza dire su quale lato valgono).
9. **Trust dei project hooks nel pod mai ricordato.** Corretto per §7, ma con
   un mount Docker la cartella è la stessa del laptop e si chiede a ogni
   sessione. → Lasciare così (sicurezza); al massimo spiegarlo nel prompt.

## 4. Fonti

- `packages/config/src/load.ts`, `schema.ts`, `defaults.ts`, `profile.ts`,
  `skills-scan.ts`, `hooks-scan.ts`
- `packages/cli/src/main.ts`, `serve.ts`, `pod-resident.ts`,
  `engine-runtime.ts`, `engine-docker.ts`, `engine-k8s.ts`,
  `engine-select.ts`, `wiring.ts`, `worker.ts`, `local-runtime.ts`,
  `connect.ts`, `relay.ts`, `hooks-trust.ts`, `pod-binary.ts`,
  `pod-binary-build.ts`, `model-provider.ts`, `workspace-mount.ts`
- `packages/daemon/src/session-host.ts`, `hosted-session.ts`,
  `connection.ts`, `proxy-model.ts`
- `packages/client/src/remote-client.ts`
- `packages/k8s/src/pod.ts`, `exec-channel.ts`
- `packages/agent/src/agent.ts`; `packages/providers/src/anthropic-provider.ts`
- `TODO.md:428`; AGENTS.md §7

**Non verificato**: il valore effettivo di `HOME`/`WORKDIR` nel pod (dipende
dall'immagine); che il k8s exec non erediti altre env oltre a quelle
dell'immagine (non provato su cluster); l'assenza di `CLAUDE.md` è verificata
solo per grep, non a runtime. Nessun controllo empirico eseguito (né cluster
né docker).

*— claude-opus-5-5, 2026-11-05*
