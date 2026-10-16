# Rename `agent-harness` → `tentacle`

**Stato:** **non implementato** (piano, da eseguire dal modello locale seguendo
AGENTS.md §8 "Following it" — ordine dei passi, `bun run check` verde prima di
"done", e se un passo contraddice il codice STOP e aggiorna il piano). Lavoro
meccanico ma **certosino**: alcune occorrenze sono identificatori, altre stringhe
user-facing, altre path runtime — NON una `sed` globale cieca. I **messaggi di
commit git NON si toccano** (storici, va bene che citino il vecchio nome).
Decisioni §4 **confermate**. Basato su `main` @ `221caaf`.

---

## 1. Superficie (verificata con `git grep`)

- **`agent-harness` literal** — **505** occorrenze in codice (no-md) + **127** nei
  `.md`. Include: `bun.lock` (65 — **rigenerato**, mai a mano), `tsconfig.json`
  paths, `package.json` `name`/`bin`, stringhe argv in-pod, HELP, commenti.
- **scope `@agent-harness/`** — **398** occorrenze in **137** file (import +
  `package.json` name/deps + `tsconfig` `paths`). È un **sottoinsieme** del punto
  sopra: sostituendo il substring `agent-harness` si rinomina anche lo scope.
- **env prefix `HARNESS_`** — **~34 variabili distinte** (`HARNESS_MODEL*`,
  `HARNESS_K8S_*`, `HARNESS_POD_*`, `HARNESS_REMOTE_*`, `HARNESS_CONFIG_DIR`,
  `HARNESS_APP_VERSION`, `HARNESS_CWD`, `HARNESS_SUBAGENT*`, `HARNESS_AUTO_WAKE`,
  `HARNESS_POD_DELETE_*`, `HARNESS_POD_TLS_*`, …).
- **identificatore `HarnessConfig`** — 27 occorrenze (+ 1 bare `Harness`).
- **`.harness/`** (spill dir) — `agent/src/agent.ts:398`, `.gitignore:26`, 3 test.
- **case-insensitive `harness`** — tocca **172 file** (molti dentro i token sopra;
  il resto è prosa/commenti da passare a mano, §5).

### Punti-decisione concreti (riferimenti verificati)
- Nome pacchetto root: `package.json:2` `"name": "agent-harness"`.
- Bin: `packages/cli/package.json` `"bin"`; outfile `scripts/build.ts:23`
  `dist/agent-harness`; fallback versione `pod-binary.ts:203`.
- Config dir default: `packages/config/src/load.ts:89,91`
  (`$XDG_CONFIG_HOME/agent-harness`, `~/.config/agent-harness`).
- In-pod: `POD_BIN_PATH = /usr/local/bin/agent-harness` (`cli/pod-binary.ts:31`);
  argv `["agent-harness","serve",…]` / `["agent-harness","--version"]`
  (`pod-runtime.ts:253,385,424`, `pod-binary.ts:189`); cache file
  `dist/pod-bin/agent-harness-<target>` (`pod-binary-build.ts`).
- Pod manifest: label `app.kubernetes.io/managed-by: agent-harness`
  (`k8s/src/pod.ts:73`); pod name prefix `agent-harness-<uuid>`
  (`pod-runtime.ts:146`). **NB** `AGENT_CONTAINER = "agent"` (`pod.ts:15`) **non**
  è il nome del tool → **non si tocca**.

## 2. Mappa di sostituzione (ordine OBBLIGATORIO)

Quattro replace distinti, in quest'ordine (ognuno seguito da niente commit finché
§4 non è verde). Tutti **case-sensitive**.

1. `agent-harness` → `tentacle`
   Copre: nome bare, scope `@agent-harness/`→`@tentacle/`, bin, outfile
   `dist/agent-harness`→`dist/tentacle`, `POD_BIN_PATH`
   `/usr/local/bin/agent-harness`→`/usr/local/bin/tentacle`, argv in-pod, cache
   file prefix, label managed-by, pod name prefix, config-dir subdir, HELP,
   commenti, doc.
2. `HARNESS_` → `TENTACLE_`
   Tutte le env (schema/resolve/load + ogni reader + lo script `bun -e` in
   `k8s/pod-cleanup.ts` `buildPodDeleteScript` + `deletePodFromEnv` + la
   popolazione env in `spawnPodDelete` + doc + test).
3. `HarnessConfig` → `TentacleConfig`, e il bare `Harness` → `Tentacle`
   (identificatori TS; verifica che il bare `Harness` non sia un falso positivo
   dentro una parola).
4. `.harness/` → `.tentacle/`
   Spill dir: `agent/src/agent.ts`, `.gitignore`, i 3 test. (Non contiene
   `agent-harness`, quindi il replace #1 lo salta: va fatto a parte.)

## 3. File / categorie toccate

- **Tutti i `package.json`** (14 pkg + root): `name`, `@agent-harness/*` deps,
  `bin`. → poi **`bun install`** per rigenerare `bun.lock` (**mai** editarlo).
- **Tutti i `tsconfig*.json`**: `paths`/`references` a `@agent-harness/*`.
- **Sorgenti + test**: import `@agent-harness/*`, `HarnessConfig`, env, argv,
  `POD_BIN_PATH`, label, HELP, `.harness/`.
- **Doc**: `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `docs/*.md` (inclusi i
  piani; NON questo file se vuoi tenerne lo storico — vedi §7).
- **NON toccare**: `bun.lock` a mano; i commit message; `AGENT_CONTAINER="agent"`;
  il subcomando interno `__delete-pod` (non è il nome del prodotto — lascialo,
  salvo tu voglia uniformare).

## 4. Decisioni di backward-compat (CONFERMATE dall'utente — rename pieno, no dual-read)

Rename **pulito e pieno**, nessun fallback dual-read. La migrazione dei dati
personali è un passo **manuale** (§6), non codice.

- **D1 — Config dir** `~/.config/agent-harness` → `~/.config/tentacle`
  (`load.ts:89,91`). Rinomina SOLO il default nel codice (il substring
  `agent-harness`→`tentacle` lo copre). **Nessun** fallback al vecchio path. La
  migrazione dei dati esistenti (sessioni, `PROMPT.md`, `logs/`) è il `mv`
  manuale di §6.
- **D2 — Env prefix** `HARNESS_` → `TENTACLE_` ovunque. **Nessun** dual-read.
- **D3 — Spill dir** `.harness/` → `.tentacle/`. Effimera e **gitignored** →
  nessuna migrazione; vecchi file restano orfani nel workspace (innocui).

## 5. Metodo (il "certosino")

1. Replace meccanici #1–#4 nell'ordine §2 (find-replace per-token su tutto il
   tree tranne `bun.lock`), un token alla volta.
2. **Sweep manuale dei residui** — l'unico passo non meccanico: dopo i 4 replace,
   `git grep -i harness` e **decidere a mano** ogni `harness`/`Harness` di prosa
   rimasto: se è il **nome prodotto** → `tentacle`/`Tentacle`; se è il **sostantivo
   comune** ("test harness", "the harness loop") → riscrivere o lasciare. Questo è
   il punto dove una `sed` cieca sbaglierebbe.
3. `bun install` (rigenera `bun.lock`).

## 6. Validazione (gate)

1. `grep` di controllo tornano **puliti** salvo residui voluti:
   `git grep -i "agent-harness\|HARNESS_\|HarnessConfig\|\.harness"` → solo
   (eventuale) storia/questo doc.
2. `bun run typecheck` → 0 (prova che nessun import `@agent-harness/*` è rimasto
   rotto dopo il rename dello scope).
3. `bun run lint` → 0. `bun test` → verde (baseline 545/1 skip + invariato).
4. **LIVE (obbligatoria — i test non coprono le stringhe in-pod):** `tentacle run`
   / `tentacle exec` contro un pod UBI9: l'injection scrive `/usr/local/bin/tentacle`,
   l'argv `["tentacle","serve",…]` parte, la label `managed-by: tentacle` è sul
   pod (`kubectl get pod <p> -o yaml | grep managed-by`). Il delete-on-exit
   (`spawnPodDelete` + env `TENTACLE_POD_*`) cancella il pod.

## 7. Step manuali / post-rename

- **D1 migrazione:** `mv ~/.config/agent-harness ~/.config/tentacle` (una volta).
- **D2:** aggiorna le tue env esportate `HARNESS_*` → `TENTACLE_*`.
- **Rebuild dei 3 binari** (`dist/` è gitignored): linux-x64, linux-arm64,
  macOS (`dist/tentacle`, firma ad-hoc) — serve ad `exec`/`run` e alla cache
  `dist/pod-bin/tentacle-<target>`.
- **Opzionale:** rinominare la working dir `…/agent-harness` → `…/tentacle`
  (fuori da git). Nota: ri-chiave la project-memory di Claude Code (keyed sul
  path) — non un problema, solo da sapere.

## 8. Note / debiti

- **Git history intatta** (per tua scelta): i commit vecchi citano `agent-harness`,
  accettato. Nessun rebase/rewrite.
- `AGENT_CONTAINER="agent"` e `__delete-pod`: lasciati — non sono il nome del
  prodotto. Se poi vuoi uniformare `__delete-pod`, è un replace isolato a parte.
- **Commit suggeriti:** (a) `chore: rename @agent-harness/* → @tentacle/* +
  bun.lock`, (b) `chore: rename binary/env/config agent-harness → tentacle`,
  (c) `docs: rename agent-harness → tentacle`. Oppure un unico `chore(rename):
  agent-harness → tentacle` se preferisci un diff atomico (è grande ma meccanico).
