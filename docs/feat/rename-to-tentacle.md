# Rename `agent-harness` → `tentacle`

> **Status:** done — no `agent-harness` left in `*.ts|*.tsx|*.json` (verified 2026-10-17); the as-built log is at the end of this doc · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

**Stato originale (superato — vedi Status sopra):** **non implementato** (piano, da eseguire dal modello locale seguendo
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

---

# Esecuzione — log as-built (ex `docs/rename-to-tentacle-esecution.md`, accorpato)


**Stato:** implementato (branch `chore/rename-tentacle` da `main @ 7bb38f3`).
Questo doc è il resoconto as-built di come è stato eseguito il piano
`docs/feat/rename-to-tentacle.md` (che resta lo storico: non toccato).

## 0. Derive rispetto al piano

- **Base di commit**: il piano era su `main @ 221caaf`; l'esecuzione è partita
  da `main @ 7bb38f3` (branch `feat/pod-exec-attach` già mergeata, tree pulito).
  Verificato punto per punto che i riferimenti del piano fossero ancora validi
  (drift di riga: pod-name-prefix a `cli/pod-runtime.ts:185` invece di `:146`,
  valore identico).
- **Baseline pre-rename**: `bun run check` verde — **545 pass / 1 skip / 0
  fail** (typecheck + lint + test).
- **Bun 1.4.3** (minimo richiesto da `engines.bun`).

## 1. I 4 replace meccanici (§2 del piano, in ordine, case-sensitive)

Eseguiti con `git grep -l -I <token>` → `sed -i ''` file per file, esclusi
`bun.lock` e `docs/feat/rename-to-tentacle.md`.

| # | Token → Sostituto | File toccati | Residui dopo |
|---|---|---|---|
| 1 | `agent-harness` → `tentacle` | 155 | 0 |
| 2 | `HARNESS_` → `TENTACLE_` | 24 | 0 |
| 3 | `HarnessConfig` → `TentacleConfig` | 12 | 0 |
| 4 | `.harness` → `.tentacle` | 6 | 0 |

**Ramo "bare `Harness` → `Tentacle`" (§2.3): no-op.** Verificato prima di
eseguire: zero identificatori TS `Harness` bare (word-boundary, esclusi i
file `.md`) — l'unica "bare Harness" del piano era già coperta o era prosa
(TODO.md, trattata nel §3). Nessun falso positivo da valutare.

Copertura concreta del replace #1 (campioni verificati):
- `package.json:2` root `"name": "tentacle"`, `"bin"` in `packages/cli`.
- scope `@agent-harness/*` → `@tentacle/*` in tutti i 14 `package.json`
  (name + workspace deps) e nei `tsconfig*.json` (`paths`/`references`).
- outfile `scripts/build.ts` → `dist/tentacle`; fallback versione
  `cli/pod-binary.ts` → `"tentacle"`.
- `POD_BIN_PATH` → `/usr/local/bin/tentacle` (`cli/pod-binary.ts`); argv
  in-pod `["tentacle","serve","--stdio","--model-proxy"]` e
  `["tentacle","--version"]` (`cli/pod-runtime.ts`); pod-name prefix
  `` `tentacle-${uuid8}` `` (`cli/pod-runtime.ts:185`); cache
  `dist/pod-bin/tentacle-<target>` (`cli/pod-binary-build.ts`).
- label k8s `app.kubernetes.io/managed-by: tentacle` (`k8s/pod.ts`);
  **`AGENT_CONTAINER = "agent"` intatto** (punto NB del piano).
- config dir default → `~/.config/tentacle` + `$XDG_CONFIG_HOME/tentacle`
  (`config/load.ts`); commenti in `config/defaults.ts`.
- spill dir `.harness/` → `.tentacle/` (`agent/agent.ts`, `config/defaults.ts`
  comment, `.gitignore`, 3 test).
- HELP, doc, commenti vari (coperti dal substring).

## 2. `bun.lock` — rename chirurgico del lock (NON rigenerazione da zero)

Il piano §3 diceva "`bun install` per rigenerare `bun.lock`". **Non va fatto
così**: `rm bun.lock && bun install` **drifta il grafo transitivo**. Qui
risolvendo da zero, l'albero `@types/ws` si è risolto con `@types/node@26.6.5`
+ `undici-types@8.9.0` in più rispetto al lock pininato originario → due copie
di `undici-types` → due tipi `Response` non compatibili → **typecheck rotto**
(`TS2322` in `k8s/test/client.test.ts`, `providers/test/openai-provider.test.ts`,
ecc. — errori `Response`/`Promise<Response>`, non import rotti).

Metodo corretto (graph transitivo identico all'originale, solo i nomi
workspace cambiati):

```sh
git checkout bun.lock     # ripristina il grafo pininato + i nomi vecchi
bun install               # NON cancellando il lock: preserva le versioni pin,
                          # aggiorna i 14 workspace @agent-harness/* → @tentacle/*
```

Unico residuo dopo `bun install`: **`bun.lock:6`** — il `name` del workspace
root, che `bun install` **non** aggiorna (quirk: preserva il nome del root dal
lock preesistente; i 14 workspace `@tentacle/*` sono già giusti). Il root è
`private` e **nessun import lo usa per nome** (tutti gli import sono
`@tentacle/*`), quindi è puro metadata. Corretto **a mano, 1 sola riga**:
`"name": "agent-harness"` → `"name": "tentacle"`. Nessuna versione/hash/integrity
toccata.

Esito: **0** occorrenze `agent-harness` nel lock, 14 workspace `@tentacle/*`,
graph transitivo **identico** all'originale (`undici-types@5.26.5` solo, no
`@types/node@26`/`undici-types@8.9.0`).

## 3. Sweep manuale dei residui (§5.2 — l'unico passo non meccanico)

Dopo i 4 replace: `git grep -in harness` (esclusi `bun.lock` + piano) →
**46** occorrenze. Decisione per caso:

**Rinnovato (4):**
- `tui/src/App.tsx` — `WELCOME = "Agent harness ready. …"` →
  `"Tentacle ready. …"` (stringa user-facing, nome prodotto). Asserzioni
  collegate aggiornate in `tui/test/app.test.tsx`:
  - commento matematica del drag (riga welcome) → "Tentacle" col 3;
  - `copied[0].startsWith("Agent")` → `startsWith("Tentacle")`
    (matrice drag 3→13 invariata: 10 char, `Tentacle` = 8 + " re");
  - `expect(frame).not.toContain("Agent harness ready")` →
    `not.toContain("Tentacle ready")` (altrimenti l'assertion diventava
    vacua: la vecchia stringa non appare più in nessun caso).
- `tui/src/App.tsx` — filename `/save`
  `harness-transcript-<ts>.md` → `tentacle-transcript-<ts>.md`
  (verificato: nessun test fissa il nome).
- `TODO.md:74` — "Harness-internal + confined" → "Tentacle-internal +
  confined".

**Lasciato volutamente (41), con motivo:**
- **Sostantivo comune** (non nome prodotto; la prosa resta corretta):
  "A SOTA agent harness" (`README.md:3`, `ARCHITECTURE.md:9`), "the harness
  runs/scaffolds/separates/…" (`ARCHITECTURE.md:69`, `README.md:20`,
  `TODO.md:4`, `docs/F4-pod-execution.md:41`), commenti di sorgente
  "the harness's value-add layer / process / touches"
  (`agent/result-pipeline.ts:2,5`, `cli/wiring.ts:83`,
  `config/index.ts:2`, `exec/host-execution.ts:3`, `k8s/types.ts:2`,
  `mcp/tool-adapter.ts:2`, `tui/theme.ts:7`),
  `docs/fix/steering-over-rpc.md:268` ("stesso `harness` dei test esistenti" =
  helper di test, vedi sotto).
- **Fixture di test** (stringhe locali, zero impatto comportamentale):
  prefissi `mkdtemp "harness-*"` in 13 test, nome pod
  `` `harness-live-…` `` (`k8s/integration.live.test.ts:38`), helper
  `function harness(...)` + 10 call site (`daemon/integration.test.ts`).
- **Path di esempio** nei doc: `~/.cache/harness-remote-token`
  (`docs/BUILD.md:22`, `docs/F3-remote-control.md:394`) — non è un path reale
  (nessun riferimento in `packages/`); lasciato per non toccare esempi
  illustrativi.

## 4. Effetto collaterale: 9 import ri-formattati da biome

Il rename dello scope ha accorciato i descrittori
(`@agent-harness/*` → `@tentacle/*`), facendo rientrare in una riga 9
import multilinea che prima non entravano (lineWidth 100). `bun run lint`
li segnalava come format errors; risolti con `bun run lint --write .`
(solo reflow di import, zero cambi di semantica):

- `packages/agent/test/subagent.test.ts`
- `packages/cli/src/local-runtime.ts`
- `packages/cli/src/main.ts`
- `packages/cli/src/serve.ts`
- `packages/cli/test/model-proxy.test.ts`
- `packages/cli/test/pod-runtime.test.ts`
- `packages/cli/test/repl.test.ts`
- `packages/daemon/src/mapping.ts`
- `packages/tui/test/auto-approve.test.tsx`

## 5. Validazione (gate §6)

1. `git grep` dei 4 token → **0** residui in tutto il tree (compreso
   `bun.lock`); unico file che cita ancora il vecchio nome: il piano
   storico `docs/feat/rename-to-tentacle.md` (voluto).
2. `bun run typecheck` → 0 (nessun import `@agent-harness/*` rotto; i
   workspace si risolvono via tsconfig `paths`, root `private` non
   materializza symlink in `node_modules`).
3. `bun run lint` → 0 (dopo il reflow di §4). `bun test` →
   **545 pass / 1 skip / 0 fail** (invariato rispetto al baseline; lo
   skip è il live-k8s opt-in `TENTACLE_K8S_SERVER`).
4. Test TUI stretto dopo il cambio WELCOME:
   `bun test packages/tui/test/app.test.tsx` → 23 pass / 0 fail (verifica
   empirica della matrice drag).
5. **Non eseguita qui (territorio utente, §6.4/§7):**
   - **LIVE** `tentacle run` / `tentacle exec` contro pod UBI9: l'injection
     scrive `/usr/local/bin/tentacle`, argv `["tentacle","serve",…]` parte,
     label `managed-by: tentacle`, delete-on-exit con env `TENTACLE_POD_*`.
     I test NON coprono le stringhe in-pod.
   - **Rebuild dei 3 binari** (`dist/` gitignored): linux-x64, linux-arm64,
     macOS (`dist/tentacle`, firma ad-hoc) + cache
     `dist/pod-bin/tentacle-<target>`.
   - **Migrazione manuale**: `mv ~/.config/agent-harness ~/.config/tentacle`;
     env esportate `HARNESS_*` → `TENTACLE_*`.

## 6. Stato finale

- Branch `chore/rename-tentacle`, commit su esplicito OK.
- `AGENT_CONTAINER="agent"` e subcomando `__delete-pod` intatti (come da
  piano §3 "NON toccare").
- Git history non riscritta: i commit vecchi citano `agent-harness`
  (accettato, §8 del piano).
