# TUI input editing: word-jump, shift-selection, prompt history

**Stato:** **in corso** — slice pure (editor/history/hooks/input-span) verdi;
wiring `App.tsx` + render `LineInput` + test ink non ancora fatti. Resoconto
as-built: `docs/tui-input-editing-esecution.md`.
⚠️ La **decisione (C) qui sotto è stata raffinata dall'utente**: Up/Down plain
navigano la **bozza verticale**, la history si attiva **solo al bordo**
(prima/ultima riga); Shift+Up/Down **mai** history (estendono la selezione).
Vedi §0 del log di esecuzione. Tre feature della riga di input della TUI.
Decisioni utente **confermate** (vedi §3). Basato su `main` @ `7bb38f3`.
**Nota:** da implementare DOPO che il rename `→ tentacle` è atterrato (tocca gli
stessi file); ri-verificare i `file:line` citati, che il rename può aver spostato
di poco (identificatori di lunghezza simile → righe stabili).

---

## 1. Problema / scope

La riga di input non supporta: (A) salto per parola (Option+←/→ su mac, Ctrl+←/→
su Linux); (B) selezione di testo nell'input (Shift+frecce) cancellabile con
Backspace; (C) Up/Down fanno **scroll della chat** invece di richiamare il
prompt precedente (stile shell). Vogliamo input come un editor/readline normale.

## 2. Preconditions (verificate)

- **`editor.ts` è puro** (`EditorState{value,cursor}`, ops `insert`/`deleteBack`/
  `moveCursor(±1)`/`setValue`) → unit-test senza Ink (red-green facile).
- **`App.tsx` possiede il key handling** (`useInput`, `App.tsx:549`): nessun input
  di terze parti echi un control key. Tutte le modifiche di routing sono qui.
- **Routing attuale** (`App.tsx`): Up/Down→`applyScroll` (`733-740`),
  PgUp/PgDn→scroll (`741-748`), Left/Right→`field.moveCursor(±1)` (`780-787`),
  Backspace→`field.deleteBack()` (`788-791`). La "selezione" esistente
  (`selection.ts`) è **mouse→clipboard sul transcript** (sola lettura), NON
  sull'input — da non confondere.
- **`hooks.ts` `LineEditor`/`useLineEditor`** (`60-86`) è l'unico ponte stato↔ops.
- **`input-view.ts` `inputView(value,cursor,maxRows)`** (`26`) mappa l'offset in
  (row,col) per il box; il render dell'input legge `view.lines` in `App.tsx`.
- **Test TUI**: `ink-testing-library` + pattern SGR in `tui/test/app.test.tsx`
  (AGENTS.md §1). Catturare frame, non ragionare a mente.

## 3. Decisioni (confermate dall'utente)

- **(B)** Selezione **in-app con Shift+frecce** nell'input (NO selezione mouse
  dell'input). Shift+←/→ (char), Shift+Option/Ctrl+←/→ (parola), Shift+Home/End
  (riga) estendono; Backspace o digitare **sostituisce** la selezione.
- **(C)** Up/Down = **solo history** dell'input (stile shell). La chat si scorre
  con **PgUp/PgDn + rotella** (già esistenti) — Up/Down non scrollano più.
- **(A)** Salto parola: Option+←/→ (mac) / Ctrl+←/→ (Linux).

## 4. Design

### 4a. `editor.ts` — selezione + word/line ops (puro)
- `EditorState` aggiunge `readonly anchor: number | null` (ancora della
  selezione; `null` = nessuna). La selezione è `[min(anchor,cursor),
  max(anchor,cursor)]` quando `anchor !== null && anchor !== cursor`.
- `selectionRange(state): readonly [number, number] | null`.
- `moveCursor(state, delta, extend = false)`:
  - `extend` → se `anchor === null` fissa `anchor = cursor`, poi muove `cursor`.
  - non-`extend` → se c'è selezione **collassa** sul bordo (←→min, →→max),
    `anchor = null`; altrimenti muove e tiene `anchor = null`.
- `moveWord(state, dir: -1|1, extend = false)`: calcola il confine di parola
  (salta non-word poi word, come readline; `word = /[\p{L}\p{N}_]/u`), stessa
  logica `extend`/collapse.
- `moveLine(state, edge: "start"|"end", extend = false)`: Home/End **nella riga
  corrente** del value multi-linea (confine = `\n` o estremi).
- `insert(state, text)`: se c'è selezione → sostituisce il range (cursor=min+len,
  anchor=null); altrimenti come ora.
- `deleteBack(state)`: se c'è selezione → cancella il range (cursor=min,
  anchor=null); altrimenti cancella il char prima.
- `setValue(...)`: `anchor = null`. `EMPTY_EDITOR` include `anchor: null`.

### 4b. `hooks.ts` — esporre le nuove ops
- `LineEditor` aggiunge `anchor: number | null` e:
  `moveCursor(delta, extend?)`, `moveWord(dir, extend?)`, `moveLine(edge, extend?)`.
  `insert`/`deleteBack`/`set`/`reset` restano (ora selection-aware via `editor.ts`).

### 4c. `history.ts` (NUOVO, puro) — prompt history stile shell
- Stato: `{ items: string[]; index: number }` dove `index === items.length`
  significa "sulla bozza corrente" (non in history).
- `pushHistory(items, text)`: append se `text` non vuoto e `!== last` (dedup
  consecutivi, come bash); ritorna il nuovo array.
- `recall(items, index, dir: -1|1, draft)`: ritorna `{ index, value }`.
  Up (`dir=-1`) da `index===len` salva `draft` e va a `len-1`; continua indietro
  fino a 0. Down (`dir=+1`) avanza; quando torna a `len` ripristina `draft`.
- App tiene refs: `historyRef(string[])`, `indexRef(number)`, `draftRef(string)`.

### 4d. `App.tsx` — routing `useInput`
- **Up/Down** (`733-740`): rimuovere lo scroll; sostituire con history —
  Up: `const { index, value } = recall(historyRef.current, indexRef.current, -1,
  draftRef.current); indexRef.current = index; field.set(value)` (salvare la
  bozza in `draftRef` prima del primo Up). Down: `dir=+1`. **PgUp/PgDn restano**.
- **Word move** (prima di Left/Right plain, `780`): se
  `(key.meta || key.ctrl) && (key.leftArrow || key.rightArrow)` →
  `field.moveWord(dir, key.shift)`. Fallback Option-as-ESC+ di macOS:
  `key.meta && (char === "b" || char === "f")` → word ∓1.
- **Shift-select char** (`780-787`): se `key.shift && left/right` →
  `field.moveCursor(±1, true)`; altrimenti `field.moveCursor(±1, false)`
  (collassa la selezione).
- **Shift+Home/End** (o Shift+Cmd+←/→ su mac): `field.moveLine(edge, true)`.
  (Home/End plain opzionali: `moveLine(edge, false)`.)
- **Backspace** (`788`): invariato come chiamata (`field.deleteBack()`), ora
  selection-aware. **Digitare**: `field.insert(clean)` ora sostituisce.
- `submit` (`App.tsx:436`): dopo l'invio, `historyRef.current =
  pushHistory(historyRef.current, text)`, `indexRef.current = len`,
  `draftRef.current = ""`.

### 4e. Render della selezione nell'input
- Nuovo helper (in `input-view.ts` o `selection.ts`):
  `inputSelectionSpan(value, range, row, rowColOffset)` → `[c0,c1]` per riga
  visibile, analogo a `rowSelectionRange` del transcript.
- Dove `App.tsx` rende `view.lines`, applicare **video inverso** (SGR `\e[7m…\e[27m`)
  sul range selezionato della riga (riuso dell'approccio inverse-video già usato
  per la selezione del transcript).

## 5. Test

- `tui/test/editor.test.ts` (esteso, **puro**): word move avanti/indietro
  (inizio/fine, punteggiatura, multi-newline); `moveLine` su value multi-linea;
  selezione: Shift estende, non-Shift collassa su bordo corretto; `deleteBack`
  cancella la selezione; `insert` la sostituisce; `setValue` azzera `anchor`.
- `tui/test/history.test.ts` (NUOVO, puro): `pushHistory` dedup consecutivi +
  skip vuoto; `recall` Up/Down attraversa, salva/ripristina la bozza ai bordi.
- `tui/test/input-view.test.ts` (o selection): span di selezione per riga,
  inclusa selezione a cavallo di `\n`.
- `tui/test/app.test.tsx` (ink, pattern esistente): Shift+→→→ + Backspace
  cancella la selezione; Option/Ctrl+→ salta la parola; **Up richiama il prompt
  precedente, NON scrolla** (assert: il frame mostra il testo recuperato
  nell'input e il transcript non si muove); Down ripristina la bozza.
  Non-vacuità per mutation (AGENTS.md §9): col vecchio routing Up→scroll il test
  dell'history fallisce.

## 6. Validazione

1. `bun run check` verde (editor/history puri + ink). Iterare sul singolo file
   (`bun test packages/tui/test/editor.test.ts`), suite intera prima di done.
2. **Manuale (TTY reale — i sequence dei modificatori dipendono dal terminale):**
   su mac (Terminal.app **e** iTerm2) e Linux: Option/Alt+←/→ salta parola,
   Shift+←/→ seleziona (evidenziata), Backspace cancella la selezione, Up/Down
   scorre la history, PgUp/PgDn + rotella scorrono la chat.

## 7. Note / debiti

- **Sequence dei modificatori terminal-dipendenti** (il punto fragile): xterm/Linux
  mandano arrow modificate (`\e[1;2D` shift, `\e[1;3D` alt, `\e[1;5D` ctrl) → Ink
  popola `key.shift/meta/ctrl` + `leftArrow`. macOS Terminal/iTerm **di default**
  mandano Option+←/→ come `\eb`/`\ef` (meta+lettera) a meno di "Option as
  Meta/ESC+" → gestiamo **entrambe** le forme (§4d). Se Option+arrow non salta,
  l'utente può attivare "Use Option as Meta key" (Terminal) / "Esc+" (iTerm);
  documentarlo nel README.
- **Up/Down sono pure history** (scelta (C), opzione shell): in una bozza
  **multi-linea** Up/Down NON muovono il cursore tra le righe — si usa
  Left/Right/word/Home-End. L'opzione "smart multi-linea" (declinata) lo
  ripristinerebbe: riattivabile in futuro senza rompere nulla.
- **History in-memory per sessione** (non persistita su disco). Persistenza
  (es. `<configDir>/history`) è un follow-up opzionale.
- **Selezione mouse dell'input** esplicitamente **fuori scope** (scelta (B)); la
  selezione mouse del transcript (copia) resta invariata.
