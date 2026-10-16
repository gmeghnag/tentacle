# Rename `agent-harness` → `tentacle` — log di esecuzione

**Stato:** implementato (branch `chore/rename-tentacle` da `main @ 7bb38f3`).
Questo doc è il resoconto as-built di come è stato eseguito il piano
`docs/rename-to-tentacle.md` (che resta lo storico: non toccato).

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
`bun.lock` e `docs/rename-to-tentacle.md`.

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
  `docs/steering-over-rpc.md:268` ("stesso `harness` dei test esistenti" =
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
   storico `docs/rename-to-tentacle.md` (voluto).
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
