# Ephemeral injected binary — self-destruct on `exec` (leave-no-trace)

> **Status:** open — not implemented, no record of approval (no self-unlink in `packages/`, verified 2026-10-17); the `exec` command it names is now `tentacle attach` · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

**Stato:** **non implementato** (piano). Scope: solo il comando `exec`
(attach a un pod user-owned). Basato su `main` @ `d3dcf94`.

---

## 1. Problema (con evidenza)

`exec` inietta `tentacle` in `/usr/local/bin/tentacle`
(`POD_BIN_PATH`, `cli/pod-binary.ts`) quando il preflight `--version` fallisce,
poi avvia il daemon e al detach fa solo `channel.close()`
(`pod-runtime.ts:439-443`). Il pod è user-owned e **non** viene cancellato →
il binario iniettato **resta nel container** dopo il detach. Per un pod che
sopravvive all'utente, questo lascia una traccia (89 MB) che l'utente non ha
messo lì.

Vogliamo un comportamento **leave-no-trace di default** per `exec`: il binario
iniettato si auto-rimuove, con opt-out per chi vuole il re-attach veloce.

## 1b. Idea di design (perché l'auto-distruzione, non un `rm` al teardown)

Il daemon gira **dal** binario a `POD_BIN_PATH`. Appena parte, cancella il
proprio file su disco in modo nativo (`node:fs` `unlinkSync`). Su Linux si può
`unlink` un eseguibile in esecuzione: l'inode resta vivo finché il processo è
attivo (kernel mantiene il mapping), quindi il daemon continua a funzionare; il
file sparisce **subito** dal filesystem e quando il daemon muore — detach,
Ctrl+C, SIGKILL, crash, OOM — il kernel reclama l'inode. La rimozione è
**front-loaded all'avvio**, non al teardown: nessuna dipendenza dalla via
d'uscita pulita, nessun secondo exec, nessuna dipendenza da un `rm` nell'immagine.

## 2. Preconditions (invarianti verificate su cui il piano si appoggia)

- **Un binario Bun compilato, una volta avviato, è memory-mapped e non rilegge
  il file da disco** (tutto è embedded in `$bunfs`). Quindi `unlink` del proprio
  path all'avvio è sicuro per il resto dell'esecuzione. **Da validare LIVE** (su
  kind/UBI9) che Bun non riapra `execPath` on-demand per asset embedded — è il
  comportamento standard, ma è l'unica assunzione da confermare empiricamente
  prima di dichiarare done.
- **Il daemon in-pod non spawna worker da disco.** `startStdioDaemon`
  (`cli/serve.ts:57`) costruisce `SessionHost`/`buildAgent` **direttamente**,
  senza `new Worker("./worker.ts")` (il worker è una leva laptop-side). Quindi
  non c'è un secondo processo che rilegge il binario. (Se mai cambiasse,
  risolverebbe comunque da `$bunfs`, non dal path su disco.)
- **La stderr del daemon è bufferizzata client-side** (`createStderrSink`,
  `pod-runtime.ts`), quindi un log di self-destruct (anche di fallimento) NON
  corrompe la TUI e resta diagnosticabile al flush.
- **`run` è fuori scope**: il suo pod viene cancellato all'uscita
  (`registerPodCleanup` + `deletePod`), quindi il binario muore col pod. Il
  flag NON va aggiunto alla `openExec` di `startPodRuntime` (`pod-runtime.ts:207`).

## 3. Semantica (decisioni prese)

- **`--ephemeral` default `true`** su `exec`. Opt-out esplicito
  `--ephemeral=false` per **tenere** il binario (ripristina il re-attach
  sub-secondo: il prossimo `exec` lo trova col preflight e salta il transfer).
- **Self-destruct solo se l'abbiamo iniettato NOI in questa sessione.**
  `effectiveSelfDestruct = ephemeral && didInject`. Se il preflight `--version`
  trova il binario già presente (`probe.exitCode === 0`, `pod-runtime.ts:395`) →
  `didInject = false` → **mai** auto-distruzione, qualunque sia `--ephemeral`
  (non è nostro: potrebbe essere dell'immagine o lasciato apposta da un
  `--ephemeral=false` precedente).
- Conseguenza accettata: con il default `true`, ogni re-attach ri-trasferisce
  89 MB (vedi §7 Notes). È il prezzo del leave-no-trace di default.

## 4. File da modificare (4)

### cli/serve.ts
1. **Estrarre un helper testabile** + eseguirlo all'avvio del daemon stdio.
   ```ts
   import { unlinkSync } from "node:fs";

   /**
    * Best-effort self-removal of the injected binary at daemon startup
    * (leave-no-trace for `exec --ephemeral`). On Linux the running process keeps
    * its mapping, so the daemon survives; the kernel reclaims the inode on exit.
    * Never throws: a read-only FS / missing file just logs.
    */
   export function selfRemoveBinary(path: string, log?: (line: string) => void): void {
     try {
       unlinkSync(path);
       log?.(`self-removed ${path} (ephemeral)`);
     } catch (error) {
       log?.(`self-destruct failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
     }
   }
   ```
   `startStdioDaemon` (`serve.ts:57`): allargare `options` a
   `{ modelProxy?: boolean; selfDestruct?: string }` e, **come primissima cosa**
   nel corpo (prima di costruire `SessionHost`), se `options.selfDestruct` →
   `selfRemoveBinary(options.selfDestruct, log)`.

### cli/main.ts
2. **serve dispatch** (`main.ts:180-184`): passare il path dal flag
   `--self-destruct` alle options:
   ```ts
   await startStdioDaemon(config, (line) => process.stderr.write(`[daemon] ${line}\n`), {
     modelProxy: bools.has("model-proxy"),
     ...(flags.get("self-destruct") ? { selfDestruct: flags.get("self-destruct") } : {}),
   });
   ```
3. **exec dispatch**: risolvere `ephemeral` dai flag e passarlo a
   `startExecRuntime`. Aggiungere `ephemeral` all'oggetto `deps`:
   ```ts
   ...(container ? { container } : {}),
   ephemeral: resolveEphemeral(execFlags, execBools),
   ```
   e aggiornare la riga `exec` dell'HELP: `[--ephemeral=false]` con nota
   "il binario iniettato si auto-rimuove all'uscita; `--ephemeral=false` lo
   tiene per un re-attach veloce".

### cli/flags.ts
4. **Helper puro** (home dei parser flag, accanto a `resolveToken`):
   ```ts
   /**
    * Resolve the `--ephemeral` tri-state for `exec`. Default TRUE (leave-no-trace);
    * only an explicit `--ephemeral=false|0|no` (or `--ephemeral false`) disables it.
    * A bare `--ephemeral` (bool) is TRUE, same as the default.
    */
   export function resolveEphemeral(flags: Map<string, string>, _bools: Set<string>): boolean {
     const v = flags.get("ephemeral");
     if (v !== undefined) {
       return v !== "false" && v !== "0" && v !== "no";
     }
     return true;
   }
   ```
   (`_bools` non serve nella logica — un bare `--ephemeral` cade nel default
   `true` — ma si tiene la firma `(flags, bools)` per uniformità/estensione.)

### cli/pod-runtime.ts
5. `PodExecRuntimeDeps`: aggiungere `readonly ephemeral?: boolean;`
   (doc: "Self-remove the injected binary on exit (leave-no-trace). Default true;
   only honoured when THIS attach injected the binary.").
   In `startExecRuntime`:
   - import di `POD_BIN_PATH` da `./pod-binary.ts` (già importa
     `injectAgentBinary`, `probePodArch` da lì).
   - tracciare l'iniezione: nel ramo `else` (`pod-runtime.ts:397-412`) impostare
     `didInject = true` (dichiarare `let didInject = false;` prima del preflight;
     il ramo `probe.exitCode === 0` lo lascia `false`).
   - costruire il comando serve col flag SOLO se `(deps.ephemeral ?? true) && didInject`:
     ```ts
     const serveCommand = ["tentacle", "serve", "--stdio", "--model-proxy"];
     if ((deps.ephemeral ?? true) && didInject) {
       serveCommand.push(`--self-destruct=${POD_BIN_PATH}`);
     }
     const channel = deps.kube.openExec(
       { pod: name, container, command: serveCommand },
       { onStderr: stderr.onStderr },
     );
     ```
     (sostituisce il `command: ["tentacle","serve","--stdio","--model-proxy"]`
     literal a `pod-runtime.ts:424`.)
   - (opzionale, piped-mode) nella riga "attached …" (`pod-runtime.ts:416`)
     aggiungere ", il binario si auto-rimuoverà all'uscita" quando il flag è attivo.

## 5. Test da aggiungere (3)

1. `packages/cli/test/pod-runtime.test.ts` — `describe("startExecRuntime")`, tre
   casi che asseriscono il **comando `serve`** registrato dal fake cluster
   (`POD_BIN_PATH` è già importato nel file di test):
   - **default (ephemeral implicito) + preflight FALLITO (inietta):** il comando
     `serve` contiene `--self-destruct=${POD_BIN_PATH}`.
   - **`ephemeral: false` + inietta:** il comando `serve` **non** contiene
     `--self-destruct`.
   - **preflight OK (binario già presente, `didInject=false`) + ephemeral true:**
     il comando `serve` **non** contiene `--self-destruct` (non è nostro).
   Non-vacuità: senza il gate `didInject`, il terzo caso fallirebbe (verifica per
   mutation come da AGENTS.md §9).
2. `packages/cli/test/serve.test.ts` (o nuovo) — `selfRemoveBinary`: crea un file
   temporaneo nello scratchpad, chiama l'helper, assert che **non esiste più**;
   un path inesistente → **non lancia** (best-effort), e logga una riga.
3. `packages/cli/test/flags.test.ts` (o `main.test.ts`) — `resolveEphemeral`:
   assente → `true`; `--ephemeral=false` → `false`; `--ephemeral=0`/`no` →
   `false`; bare `--ephemeral` → `true`; `--ephemeral=true` → `true`.

Stile repo: double quotes, trailing commas, **niente `!`**. Iterare sul singolo
file; suite intera solo prima di "done".

## 6. Validazione

1. `bun run typecheck` → 0.
2. `bun run lint` → 0 (attenzione a `noDelete`/`noAssignInExpressions`).
3. `bun test` → verde (baseline del branch + i nuovi).
4. **LIVE (obbligatoria per questa feature — tocca il runtime in-pod):** su kind
   o OpenShift, `exec` su un pod UBI9 senza il tool:
   - default → l'injection parte, il daemon serve, la TUI si apre; `kubectl exec
     <pod> -- ls -l /usr/local/bin/tentacle` → **No such file** mentre la
     TUI è ancora attaccata (self-destruct all'avvio, inode vivo); dopo il detach
     resta No such file. Il modello risponde normalmente (binario in esecuzione).
   - `--ephemeral=false` → il file **c'è** dopo il detach; un secondo `exec` è
     sub-secondo (preflight OK, nessun transfer) e **non** auto-distrugge.
   - Pod la cui immagine SHIPpa `tentacle` → nessuna auto-distruzione
     (preflight OK, `didInject=false`), con o senza `--ephemeral`.
5. **Non-regress:** `run` invariato (nessun `--self-destruct` nel suo `openExec`);
   `serve` locale (laptop) invariato (mai `--self-destruct`).

## 7. Note / debiti

- **Il default `true` annulla il re-attach veloce** (89 MB ri-trasferiti a ogni
  attach su pod senza il tool). È una scelta esplicita (leave-no-trace di
  default su pod altrui); chi fa attach ripetuti usa `--ephemeral=false` al primo
  attach e i successivi trovano il binario.
- **Perché passare il path esplicito** (`--self-destruct=${POD_BIN_PATH}`) e non
  affidarsi a `process.execPath` nel daemon: `POD_BIN_PATH` è la posizione
  d'installazione nota e univoca; `process.execPath` potrebbe essere un path
  risolto via PATH. Esplicito = robusto e impossibile da attivare per sbaglio
  localmente (il flag si passa solo dall'injector di `exec`).
- **Pod con root FS read-only** (hardened): `unlink` fallisce → best-effort,
  logga e prosegue; il binario resta (come oggi). Accettabile.
- Possibile alias più amichevole `--keep-binary` (= `--ephemeral=false`): non
  incluso per non allargare la superficie; aggiungibile se emerge l'esigenza.
