# TUI input editing — log di esecuzione

**Stato: COMPLETO.** `bun run check` (typecheck+lint+test intero) **VERDE**:
604 pass / 1 skip (il live-k8s opt-in) / 0 fail. Tutte le slice (editor,
history, input-view, hooks, App wiring, LineInput render, test ink) fatte e
verificate. Vedi **§7 (completamento as-built)** per la chiusura — che
**corregge** alcune affermazioni di §1/§3/§4 scritte prima (in particolare il
root-cause di Home/End).
Questo doc è il resoconto as-built di come è stato eseguito il piano
`docs/tui-input-editing.md` (che resta lo storico: non toccato).
Basato su `main` @ `f5a2a10`, branch **`feat/tui-input-editing`**.

> ⚠️ **Le sezioni §1–§6 qui sotto sono il log storico (parzialmente stantio).**
> La verità as-built è in **§7**. In particolare §1 afferma che
> `key.home`/`key.end` sono "popolati al runtime": è **FALSO**, verificato sulla
> fonte Ink (vedi §7).

## 0. Spec dell'utente (sostituisce la decisione (C) del piano)

Il piano originale aveva Up/Down = **solo history**. L'utente ha confermato
una **spec più ricca** (shell-standard):

- **Up/Down plain = navigazione verticale della bozza** (una riga logica,
  colonna preservata); la **history si attiva solo al bordo**: Up sulla prima
  riga → entry più vecchia; Down sull'ultima → entry più recente; oltre la più
  recente → **ripristino della bozza live** salvata al primo Up.
- **Shift+Up/Down = MAI history**: restano dentro la bozza ed estendono la
  selezione di una riga. Ai bordi: Shift+Up sulla prima riga → pos 0;
  Shift+Down sull'ultima → fine buffer.
- **Modello history** = `recall()` già previsto nel piano: indice parte dallo
  slot "bozza" (`index === items.length`), Up decrementa, Down incrementa;
  entrando la prima volta si salva la bozza; a indice 0 un altro Up = no-op.
- **Dopo un recall il cursore va a FINE dell'entry** (convenzione shell).
- **Implicazione editor.ts (fuori dal piano)**: serve `moveVertical(dir,
  extend?)` + **`desiredCol`** persistito in `EditorState` (colonna
  "richiesta", non quella clamped: riga lunga → corta → lunga torna alla
  colonna originale).

## 1. Verifiche precondizioni (tutte confermate post-rename)

- `editor.ts` puro, `App.tsx:549` `useInput`, routing Up/Down→`applyScroll`
  (733-740), Left/Right→`moveCursor(±1)` (780-787), `submit` (436) — righe
  stabili, il rename non ha spostato nulla.
- **Probe empirico su Ink 5.0.1** (non da memoria):
  - `key.home`/`key.end` **popolati al runtime** (`\e[H`,`\e[F`,`\e[1~`,`\e[4~`)
    ma **ASSENTI nel type `Key`** (`build/hooks/use-input.d.ts`) → serve un
    cast locale in `App.tsx`.
  - `\e[1;5C`→`right+ctrl`, `\e[1;3C`→`right+meta`, `\e[1;2A`→`up+shift`,
    `ESC b`→`char "b"+meta` (fallback mac) — tutti confermati.
- **Parser autorevole letto** (`ink/build/parse-keypress.js`, copiato da
  enquirer): tabella byte→flag definitiva. Sequenze da usare nei test ink:
  `\e[1;2A` up+shift · `\e[6B`/`\e[1;6B` down+shift · `\e[C` right+shift (rxvt)
  · `\e[5C` ctrl+right · `\e[H`/`\e[F` home/end · `ESC b` meta+b. **Nessun
  altro probe serve.**

## 2. Slice fatte — VERDE

| Slice | File | Stato |
| --- | --- | --- |
| 1 editor | `packages/tui/src/editor.ts` (riscritto) | ✅ 34 test |
| 2 history | `packages/tui/src/history.ts` (NUOVO) | ✅ 9 test |
| input-span | `packages/tui/src/input-view.ts` (`inputSelectionSpan`) | ✅ nel file |
| 3 hooks | `packages/tui/src/hooks.ts` (`moveWord/moveLine/moveVertical`, `extend`) | ✅ typecheck |
| test | `editor.test.ts` (esteso), `history.test.ts` (NUOVO), `input-view.test.ts` (esteso) | ✅ **53/53** |

`bun run typecheck` **pulito** e `bun test packages/tui/test/{editor,history,input-view}.test.ts`
**53 pass / 0 fail** (verificato in questo turno).

**Design editor.ts (as-built):**
- `EditorState { value, cursor, anchor: number|null, desiredCol?: number|null }`.
- `selectionRange` = `[min,max)` se `anchor!==null && anchor!==cursor`, else `null`.
- `applyMove(state,target,extend,edge)` helper condiviso: `extend` fissa
  `anchor` (se null) e muove il cursore; no-`extend` con selezione **collassa
  sull'edge percorso** (`"min"`/`"max"`), `anchor=null`.
- `insert`/`deleteBack` selection-aware (sostituisce/cancella il range,
  `anchor=null`, `desiredCol=null`); azzerano anche un **anchor collassato**
  (stale selection state).
- `moveWord(dir,extend)`: ordine **gap→word** (readline); `word=/[\p{L}\p{N}_]/u`;
  newline = non-word (un salto non oltrepassa fine riga logica).
- `moveVertical(dir,extend)`: `lineIndex/lineStart/lineLen` per riga logica;
  `desiredCol = state.desiredCol ?? col`; **al bordo buffer**: plain → no-op
  (l'App lo trasforma in history), **extend → seleziona fino a 0 / fine**.
- `moveLine(edge,extend)`: Home/End dentro la riga logica corrente.

**Design history.ts (as-built):** `pushHistory` (trim, skip vuoto, dedup
consecutivo, **ritorna copia mutabile** `[...items]` — fix TS4104). `recall`:
se `index>=n` (su bozza) e `dir=-1` e `n>0` → entra in history a `n-1`;
altrimenti no-op sulla bozza; `dir=+1` da indice in history → `index+1`, e se
`index+1>=n` → **ripristina la draft** a `index=n`.

## 3. Slice in corso — App.tsx (NON funzionante end-to-end)

- **Fatto:** import `import { pushHistory, recall } from "./history.ts";`
  (`App.tsx:20`) — verificato presente e corretto.
- **NON fatto (il cuore del wiring):**
  - i 3 refs (`historyRef`, `histIndexRef`, `draftRef`);
  - `submit` → `pushHistory` (dopo `field.reset()`, solo prompt non `/`);
  - routing `useInput` (735-791): Up/Down → `moveVertical` + history al bordo
    (rule prima/ultima riga della spec, **Shift mai history**), word-move
    (`(ctrl||meta)&&(left||right)` + fallback `meta`+`"b"/"f"`), shift-select
    (`moveCursor(±1, shift)`), Home/End con cast locale `key.home/key.end`;
  - il vecchio `applyScroll(o,"lineUp"/"lineDown")` a 735/739 **deve sparire**
    (ora è ancora lì → Up/Down scrollano ancora, la feature non si attiva).

**Verificato in questo turno:** `bun test packages/tui/test/app.test.tsx`
**23 pass / 0 fail** (il routing è ancora intatto, nessun test rotto).

## 4. Slice non iniziate

- **6 — `LineInput.tsx`:** render inverse-video della selezione (usa
  `inputSelectionSpan` + `<Text inverse>`, come già fa per il cursore).
  **File intatto** (git: non modificato).
- **7 — test ink in `app.test.tsx`:** solo **costanti chiave** aggiunte
  (44-50: `DOWN`,`SHIFT_UP`,`SHIFT_DOWN`,`SHIFT_RIGHT`,`XTERM_SHIFT_RIGHT`,
  `XTERM_CTRL_RIGHT`,`XTERM_ALT_RIGHT`); **nessun test nuovo ancora**.
  Manca il red→green comportamentale: *Up richiama il prompt e NON scrolla*
  (assert transcript fermo), shift-select+backspace, word-jump, desiredCol
  round-trip + **non-vacuità per mutation** (col vecchio routing Up→scroll il
  test history fallisce — AGENTS.md §9).
- **Lint ri-verificato post auto-fix:** `bun run check` **VERDE** (typecheck,
  lint, test intero: 590 pass / 1 skip / 0 fail). "No new issues" è ora
  claimabile. Il test ink comportamentale (Up richiama, non scrolla) resta da
  scrivere: serve il wiring di `App.tsx` (slice 3/5) per essere non-vuoto.

## 5. Errori di esecuzione (onesti)

- Più `fs_multi_edit` su `App.tsx` con `old_string` corrotte (testi inventati,
  non riletto) → falliti **atomicamente** (niente scritto), ma step sprecati.
- Typo ripetuto `usePrintScheduler` (export inesistente) nell'import di
  `App.tsx`; corretto, e l'ultima riga 19 verificata buona (`useLineEditor,
  usePaintScheduler`).
- **Lezione:** per `App.tsx` fare **un edit alla volta da read fresco**, non
  multi-edit da memoria.

## 6. Prossimi passi (ordine dipendenze)

1. `App.tsx`: refs history + `submit`→`pushHistory` + routing Up/Down/word/
   shift-select/Home-End (un edit alla volta, da read fresco di 731-804).
   Rimuovere il vecchio `applyScroll lineUp/lineDown`.
2. `LineInput.tsx`: inverse-video sulla selezione.
3. `app.test.tsx`: test ink red-first (le costanti già ci sono) + mutation.
4. `bun run check` (typecheck+lint+test intero) verde prima di "done".

**One-sentence check (§2):** so per certo che `bun run check` è VERDE
(590 pass / 1 skip) e che `App.tsx` ha solo l'import aggiunto (routing ancora
intatto, `app.test.tsx` 23/23); il mio prossimo test più economico è aggiungere
i 3 refs + il routing in `App.tsx` e far fallire- poi-passare il primo test ink
"Up richiama, non scrolla".

## 7. Completamento as-built (sessione di chiusura)

Chiusura della feature a partire dallo stato di §3/§4 (wiring già presente ma
feature incompleta). **Occhio critico applicato alle affermazioni precedenti: le
ho ri-verificate sulla fonte, non prese per buone.**

### 7.1 Home/End — root-cause CORRETTO, bind a Ctrl+A/Ctrl+E

§1 diceva "`key.home`/`key.end` popolati al runtime, assenti solo nel type".
**Falso.** Verificato sulla fonte Ink 5.0.1:
- `parse-keypress.js` mappa `[H`→`home`, `[F`→`end` (+ `OH/OF`, `[1~`, `[4~`,
  `[7~`, `[8~`…) e `nonAlphanumericKeys = [...Object.values(keyName), …]`
  **include `home`/`end`**.
- `use-input.js:68`: se `name ∈ nonAlphanumericKeys` → `input = ""`; e il `key`
  object (`use-input.js:47-66`) **non ha** `home`/`end`.
- → Home/End arrivano come `input=""` senza flag: **indistinguibili** nel layer
  `useInput`. Nessun cast "recupera" un flag che non esiste.

**Decisione (utente):** valutare un upgrade Ink; se non conviene, usare
Ctrl+A/Ctrl+E. Verificato: `key.home`/`key.end` esistono solo da **ink ≥ 6**,
che richiede **React 19** (migrazione maggiore). Nessun 5.x li espone. →
**bind a Ctrl+A/Ctrl+E** (convenzione readline; `key.ctrl` esposto pulito).
`App.tsx` key handler. Test red→green in `app.test.tsx` ("Ctrl+A/Ctrl+E").

### 7.2 Artefatto di render del cursore — FIX (bug upstream Ink)

Scoperto durante i test: con il cursore a metà riga raggiunto per *re-render*
successivi, l'ultimo char sforava sulla riga del bordo (`❯ Xhell` + `──o──`).
Isolato con riproduzione deterministica pura (no App/useInput): il
`<Text inverse>` **annidato** fa mis-misurare Yoga. Bug **upstream**, corretto
in **ink ≥ 6.6** (richiede React 19) — tracciato in `docs/library-bugs.md`.
**Fix senza upgrade:** cursore come `<Text>` **fratelli** (vedi §7.3).
Regressione in `app.test.tsx` ("one clean line").

### 7.3 Slice 6 — `inputRender` puro + `LineInput` dumb

Per la direttiva architetturale (logica fuori dai componenti, vedi
AGENTS.md §7): tutta la logica di proiezione (selezione inverse + cursore +
windowing) sta in **`inputRender(value, cursor, anchor, maxRows)`** puro in
`input-view.ts` → righe di segmenti `{text, inverse}`. `LineInput.tsx` è un
renderer banale (mappa segmenti → `<Text>`, aggiunge solo accent/placeholder).
Bonus: la selezione — non osservabile dal frame (SGR strippati) — diventa
**unit-testabile** (`input-view.test.ts` "inputRender", 6 test: cursore,
EOL, selezione, selezione multi-riga, vuoto, windowing). `inputView` espone ora
`windowStart`. Il cursore è reso come segmenti fratelli → immune all'artefatto
§7.2.

### 7.4 Slice 7 — test d'integrazione (App)

`app.test.tsx`, describe "navigation, history & selection": Up→history sulla
riga singola; Up dentro bozza multi-line → `moveVertical` (NON history);
Down oltre la più recente → ripristino bozza; Shift+Right + Backspace cancella
il range; Ctrl+Right word-jump. **Non-vacuità per mutazione** verificata sul
routing chiave (forzato `onFirstLine=true` → il test multi-line fallisce, poi
revert). Escape verificati sulla fonte (`[2C` shift+right, `[5C` ctrl+right).

### 7.5 Altro

- `docs/library-bugs.md` creato (bug librerie + versione di fix).
- AGENTS.md §7: aggiunta la best-practice "logica nei moduli puri, componenti
  solo render".
- Rimossi i probe throwaway; `bun run check` verde (604 pass / 1 skip / 0 fail).

### 7.6 Debito lasciato (consapevole)

- **Estrazione dell'handler tasti di `App.tsx`** in una funzione pura
  `resolveKey(key, char, ctx) → Action` (testabile senza ink): raccomandata,
  da fare come **refactor dedicato separato** con i test d'integrazione §7.4
  come rete di caratterizzazione. Non mescolata a questa feature.
- Upgrade Ink 5→8 + React 18→19 (darebbe Home/End nativi + fix §7.2): valutato,
  rimandato (migrazione maggiore non giustificata ora).
