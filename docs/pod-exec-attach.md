# `tentacle attach` — piano: aggancio a un pod esistente

**Stato:** **implementato** (branch `feat/pod-exec-attach` da `c5b7f58`).
Questo doc nasce come piano; §10 è l'as-built. Basato su `c5b7f58` (branch
`feat/pod-binary-injection`), che ha consegnato `run` + iniezione binario
(F4.e) + delete-on-exit + status line a riga singola.

---

## 1. Obiettivo e relazione con `run`

`tentacle attach <pod>` aggancia la TUI locale a un **pod già esistente**:
inietta l'agent se serve, apre l'exec del daemon (`serve --stdio`) e parte la
TUI. **Non crea e non cancella nulla**: il pod è del user, il ciclo di vita
resta suo.

`run` e `exec` condividono ~l'80% del flusso; le differenze sono solo
lifecycle:

| | `run` (esiste) | `exec` (nuovo) |
|---|---|---|
| Input | `--image <ref>` obbligatorio | **nome pod** (posizionale), no `--image` |
| Pod | `createPod` (manifest `buildPodManifest`) | `getPod` — deve già esistere |
| Ready | `waitForReady` (default 120 s) | se non ready: **attesa breve** (~60 s, `waitForReady` riusato); terminale/missing → errore |
| Iniezione binario | sì (F4.e) | sì, **identica** — ma con preflight: se `tentacle --version` già risponde, **salta l'intera iniezione** (pod riagganciato / image pre-baked) |
| Daemon exec | `openExec(["tentacle","serve","--stdio","--model-proxy"])` | **identica** |
| TUI / persist / model-proxy / permissions | `startTui` + `createLocalRuntime` | **identica** (sessioni su laptop, reverse-tunnel invariato) |
| Delete su exit | **sì**: `dispose` → `deletePod` + safety net `process.once("exit")` → `deletePodBestEffort` | **NO**: al detach il pod resta `Running`. Nessun `deletePod`, **nessun `registerPodCleanup`** |
| Errori | create 404 ns → `podCreateError` | pod 404 → "usa `kubectl get pods`… o `run` se vuoi crearlo" |

Decisione chiave (consentire implicitamente): **al detach non si tocca il pod**.
Motivazione: è user-owned, potrebbe essere riusato (ed è proprio il caso d'uso
principale di `exec`); cancellarlo sarebbe una side effect distruttiva di un
comando "attach". Se vuoi pulire dopo, `kubectl delete pod <name>`.

---

## 2. Superficie CLI

```
tentacle attach <pod> [--namespace <ns>] [--container <c>] [--resume [uid]]
```

- `<pod>`: posizione 1, **obbligatoria** (se manca → usage, exit 1).
- `--namespace`: stessa catena di `run` — flag > `TENTACLE_POD_NAMESPACE` >
  namespace del kubeconfig context. (Attenzione: se il context del cluster è su
  un namespace diverso da quello del pod, serve il flag — stesso caveat di `run`.)
- `--container`: opzionale; se omesso l'API sceglie l'unico/contenitore default
  (già il comportamento di `ExecTarget.container?`). Per i nostri pod `run` è
  sempre `agent`; il flag serve a pod altrui multi-containere.
- `--resume [uid]`: **identico** a `run` (le sessioni persistono su
  `~/.config/tentacle/sessions`, il pod è stateless).

Aggiunta al `HELP` (`main.ts`), accanto alla voce `run`:

```
  tentacle attach <pod> [--namespace <ns>] [--container <c>] [--resume [uid]]
                                attach the TUI to an existing pod (inject if needed);
                                the pod is NOT deleted on exit
```

---

## 3. Sequenza

```
main: "exec"
 ├─ parseFlags(args.slice(1)) → pod name (pos 1), flags
 ├─ config = loadConfig()                       (stesso di run)
 ├─ auth: TENTACLE_K8S_SERVER? : loadKubeClientOptions({ namespace? })   (stesso blocco di run)
 ├─ store + --resume                            (stesso blocco di run)
 └─ startExecRuntime(config, deps)              ← NUOVA (pod-runtime.ts)
     ├─ 1. kube.getPod(name)
     │     · 404 KubeApiError  → "pod "<n>" not found in namespace "<ns>" (kubectl get pods -n <ns>) — or `run` to create one"
     │     · terminale (Succeeded/Failed) → "pod "<n>" is <phase>; cannot attach"
     ├─ 2. se non podIsReady(pod) → kube.waitForReady(name, { timeoutMs: 60_000 })
     ├─ 3. preflight: runExec(["tentacle","--version"]) timeout 15 s
     │     · exit 0 → version = stdout, SALTA iniezione
     │     · altrimenti → injectAgentBinary({ kube, podName: name,
     │                                        container,   // undefined → API sceglie il solo/default
     │                                        podArch: () => probePodArch(…),
     │                                        resolveBinary: (t) => resolvePodBinary(t, {…}),
     │                                        log, onStatus })   (stesso wiring di run)
     │       · exit code / loader error → throw CON `libcMismatchHint` (stessi messaggi di run)
     ├─ 4. status.finish(); (piped: "[pod] <version> attached to <name>; starting the agent daemon")
     ├─ 5. kube.openExec({ pod: name, container, command: ["tentacle","serve","--stdio","--model-proxy"] },
     │                     { onStderr: (t) => log(`[pod ${name}] ${t}`) })
     ├─ 6. modelProvider = new OpenAIProvider(config)  (reverse-tunnel, identico a run)
     └─ 7. createLocalRuntime({ channel,
                                disposeTransport: () => channel.close(),   ← NO deletePod
                                permissions, store, cwd, model, resume,
                                modelProvider })
 main: startTui(…) → finally: runtime.dispose()   ← chiude solo channel + client
```

Status line TTY (riga singola, `StatusLine` riusata) — le fasi 1-2 hanno i loro
testi, le fasi 3-4 **riusano i testi di `run`**:

```
[pod] resolving <name> in <ns>…
[pod] waiting for <name> to become ready…        (solo se non già ready)
[<name>] resolving bun-linux-x64 binary…         (solo se serve iniettare)
[<name>] injecting tentacle ▓▓▓░ 47% 41.9/89.0 MB
[<name>] verifying…
→ clear → TUI
```

Piped: una riga per fase + riga finale
`[pod] <version> attached to <name>; agent daemon running — closing the TUI detaches, the pod stays up`
(e la riga "injection" di `run`, che in TTY è soppressa).

---

## 4. Implementazione per file

### 4.1 `packages/cli/src/pod-runtime.ts` (il cuore)

- `PodCluster`: aggiungere `getPod(name: string, signal?: AbortSignal): Promise<Pod>;`
  (esiste già su `KubeClient`; `FakeCluster` nei test lo implementa — 5 righe).
- Nuova funzione **`startExecRuntime(config, deps): Promise<LocalRuntime>`**
  con `PodExecRuntimeDeps`:

  ```ts
  export interface PodExecRuntimeDeps {
    readonly kube: PodCluster;
    readonly namespace: string;
    readonly podName: string;          // obbligatorio (a differenza di run: name?)
    readonly container?: string;       // undefined → container unico/default
    readonly permissions: PermissionBroker;
    readonly store: JsonSessionStore;
    readonly resume: SessionRecord | null;
    readonly log: (line: string) => void;
  }
  ```

  Corpo: sequenza §3. Reuso diretto, senza copia: `StatusLine` (stesso gate
  `process.stdout.isTTY ?? false` + stesso pattern `phase()`/`onStatus` di
  `startPodRuntime`), `injectAgentBinary`, `probePodArch`, `resolvePodBinary`,
  `createLocalRuntime`. **Deliberatamente assente**: `createPod`,
  `registerPodCleanup` (niente safety net — il pod non deve morire al
  detach), `podCreateError`.
- `disposeTransport` = `() => channel.close()` (solo). `runtime.dispose()`
  chiude client + channel; il pod continua a girare (keepalive `sleep
  infinity` del manifest `run`).

> **Rafforzamento opzionale (1 riga, stesso commit):** in `startPodRuntime` il
> `registerPodCleanup` sta oggi *dopo* `createPod`, fuori dal `try` che
> avvolge `waitForReady` — un Ctrl+C durante l'attesa ready (o un throw di
> `waitForReady`) lascierebbe il pod orfano. Sollevare la registrazione
> sopra il `try` chiude il gap. Correzione di hardening di `run`, non di `exec`.

### 4.2 `packages/cli/src/main.ts`

- Nuovo blocco `if (args[0] === "exec")` **dopo** il blocco `run`:
  - parse: `podName = pos[0]` (obbligatoria), `namespace` (stessa catena),
    `container = flags.get("container")`, `--resume` (stessa logica);
  - auth: stesso `try/catch` di `run` (`[exec] cluster auth failed: …`);
  - `startExecRuntime(...)` in `try/catch` → `[exec] failed: …`, exit 1;
  - `startTui(null, { … })` identico al blocco `run` (stessi deps), `finally:
    runtime.dispose()`;
  - **no** `deletePod` da nessuna parte.
- **Dedupe (piccolo):** estrare in un helper locale (es. `resolveExecAuth(flags)`
  o `resolvePodAuth(namespace)`) il blocco auth run/exec e il blocco store+resume,
  così i due blocchi restano simmetrici e corti.
- `HELP`: voce `exec` (§2).

### 4.3 `packages/k8s`

Niente di nuovo: `getPod` esiste già. Eventualmente re-export già presente
(`KubeApiError`, `Pod` — già esportati da `index.ts`).

### 4.4 Documentazione (stesso commit)

- `docs/F4-pod-execution.md`: §1 scope + riga di uso; §6 lifecycle: paragrafo
  "attach mode (`exec`): no create, no delete; preflight version-probe skips
  re-injection".
- `docs/pod-binary-injection.md`: nota al checkpoint — il preflight
  version-probe è una terza modalità d'uso di `injectAgentBinary` (skip se già
  presente).
- Questo file: sezione "as-built" al fine.

---

## 5. Errori e UX

| Condizione | Messaggio (prefix `[pod <name>]`) | Exit |
|---|---|---|
| pod non trovato (404) | `pod "<n>" not found in namespace "<ns>" (kubectl get pods -n <ns>) — or use \`run\` to create one` | 1 |
| pod in fase terminale | `pod "<n>" is <Succeeded\|Failed>; cannot attach to a terminated pod` | 1 |
| non ready, timeout ~60 s | (quello di `waitForReady`, già leggibile) | 1 |
| iniezione fallita | **identici** a `run` (exit code + stderr + `libcMismatchHint` per musl) — **pod NON toccato** | 1 |
| RBAC: `pods/get` o `pods/exec` negati | `KubeApiError` 403 non tradotto (messaggio già leggibile) — stesso criterio di `run` | 1 |
| cluster/auth | `[exec] cluster auth failed: …` (stesso di `run`) | 1 |
| daemon fallisce in pod (dopo handshake) | `[pod <name>] …` via `onStderr` (già cablato) | — |

Note UX:

- **Ctrl+C / chiusura TUI** → detach pulito: il channel exec si chiude, il
  daemon `serve --stdio` muore (è legato all'exec), il pod resta `Running`.
  Nessun delete, nessun child process, nessun `reset` anomalo (la safety net di
  `run` non è registrata — è il comportamento voluto).
- **Pod riagganciato**: la seconda `exec` sullo stesso pod fa solo preflight
  `--version` (sub-second) → niente re-iniezione, niente transfer di 89 MB.
- **Pod già usato da `run`** (es. orphanato da un crash): il preflight trova il
  binario iniettato → si aggancia; l'eventuale vecchio daemon stdio era morto
  con la chiusura del suo exec, quindi nessun conflitto.

---

## 6. Test

### 6.1 Unit (Bun test, stile esistente — nessun `!`, throw-guards)

`packages/cli/test/pod-runtime.test.ts` — nuovo `describe("startExecRuntime")`,
`FakeCluster` esteso con `getPod` (scriptato per caso):

1. **happy path**: getPod ready → preflight `--version` exit 0 → **nessuna**
   install exec → `exec:<pod>:tentacle serve --stdio --model-proxy` →
   handshake → TUI-ready. Assert su `calls`: presente `runexec:…--version`,
   **assente** `runexec:…head -c`, **assenti** `delete:*` e `besteffort:*`,
   `dispose` non produce delete.
2. **iniezione richiesta**: preflight exit 1 (binario assente) → presente
   `runexec:…head -c` → `--version` ok → exec aperto.
3. **pod 404**: `getPod` rigetta `KubeApiError(404, …)` → throw con
   `not found` + suggerimento `run`; nessun'altra chiamata al cluster.
4. **pod terminale**: `getPod` → `status.phase = "Failed"` → throw `cannot
   attach`.
5. **iniezione fallita (musl)**: preflight + install ok, `--version` exit 1 con
   stderr `error while loading shared libraries…` → throw contiene la hint
   glibc; **nessun** `delete:*` nel log delle chiamate (differenza cruciale da
   `run`).
6. **non ready → ready**: prima `getPod` Pending, `waitForReady` (finto)
   risolve → flusso completo (verifica che l'attesa breve sia invocata).
7. **status line TTY** (se il test di `run` copre già le fasi di iniezione,
   basta 1 caso che `startExecRuntime` passi `onStatus` al `StatusLine` —
   assert sul frame finale "verifying…" e sul clear; altrimenti si appoggia ai
   test `status-line.test.ts` esistenti).

`packages/cli/test/main.test.ts`: caso `exec` senza nome pod → usage, exit 1
(anche solo parse-level, come i casi `run` esistenti).

### 6.2 Validazione live (cluster x86_64, namespace `test00` — fai tu, come al solito)

```sh
./dist/tentacle run --image registry.access.redhat.com/ubi9/ubi:latest --namespace test00 keep1
# (chiudi la TUI SENZA lasciare che il pod muoia? no: run lo cancella all'exit —
#  quindi per la prova exec, crea il pod manualmente oppure usa run in un
#  secondo terminale e aggancia exec MENTRE è aperto; alternativa pulita:)
kubectl -n test00 run keep1 --image=registry.access.redhat.com/ubi9/ubi --restart=Never -- sleep infinity
kubectl -n test00 wait --for=condition=Ready pod/keep1

./dist/tentacle attach keep1 --namespace test00          # 1ª volta: inietta 89 MB
#  → TUI, un prompt, /clear, esc
kubectl -n test00 get pod keep1                              # Running (NON cancellato)
./dist/tentacle attach keep1 --namespace test00          # 2ª volta: solo --version, aggancio immediato
kubectl -n test00 exec keep1 -- tentacle --version     # binario presente, 755
./dist/tentacle attach missing-pod --namespace test00    # 404 → messaggio azionabile
kubectl -n test00 run busybox1 --image=busybox --restart=Never -- sleep infinity   # (o kubectl)
./dist/tentacle attach busybox1 --namespace test00       # --version fallisce → hint glibc/musl, pod intatto
kubectl -n test00 delete pod keep1 busybox1
```

Checklist live: (a) TUI si apre e risponde; (b) sessione salvata su laptop e
`--resume` funziona sul ri-aggancio; (c) Ctrl+C → pod `Running`; (d) 2ª exec
senza transfer; (e) errori come da §5; (f) `bun run typecheck && bun run lint &&
bun test` green.

---

## 7. Order of work (un solo commit)

1. `pod-runtime.ts`: `getPod` su `PodCluster` + `startExecRuntime` (+ hoist
   safety-net in `startPodRuntime` se si approva il §4.1).
2. `main.ts`: blocco `exec` + helper auth/resume dedupe + `HELP`.
3. Test unit (§6.1).
4. Docs (§4.4).
5. Build (`TARGET=bun-linux-x64 bun run compile` → cache `dist/pod-bin` PRIMA,
   poi `bun run compile` per `dist/tentacle`) + validazione live (§6.2).
6. Commit singolo:
   `feat(cli): exec subcommand — attach TUI to an existing pod (inject-if-needed, no delete on exit)`.

---

## 8. Open (fuori scope v1, decisione tua)

- **Cleanup orphans**: `tentacle pod ls` / `tentacle pod rm <name>`
  (filtro label `app.kubernetes.io/managed-by=tentacle`) per i pod di
  `run` rimasti orfani. Utile proprio perché `exec` non cancella.
- **Detach senza chiudere** (`--detach`: TUI in background, ri-aggancio col
  solo `attach <pod>`): oggi `exec` ricrea sempre un nuovo daemon stdio; è
  sufficiente, il detach vero richiede un daemon persistente nel pod
  (out of scope, come da F4 §1).
- `--namespace` **implicito dal pod**: `getPod` in tutti i namespace
  (`/api/v1/pods?fieldSelector=metadata.name=…`) per non doverlo specificare —
  richiede `list` in più RBAC; lo lascerei fuori.
- Container auto-select interattiva per pod multi-containere (oggi: flag o
  container unico).

---

## 10. As-built (what actually shipped)

Implementato fedele al piano, con queste divergenze da nota:

- **`getPod`** è già su `KubeClient`; l'ho solo aggiunto all'interface
  `PodCluster` (`pod-runtime.ts`) — niente di nuovo in `packages/k8s`.
- **`startExecRuntime`** (`pod-runtime.ts`): `getPod` → 404 → errore azionabile
  (con suggerimento `run`); fase terminale → `cannot attach`; `podIsReady`
  falso → `waitForReady({ timeoutMs: 60_000 })`; **preflight `tentacle
  --version`** (timeout 15 s) che salta `injectAgentBinary` se risponde, altr.
  iniezione F4.e identica a `run`; poi `openExec(serve --stdio --model-proxy)` +
  reverse-tunnel + `createLocalRuntime`. `disposeTransport = channel.close()` —
  **niente `deletePod`, niente `registerPodCleanup`**.
- **`main.ts`**: `run` e `exec` refactorati su helper condivisi
  (`loadPodAuth`, `loadPodResume`, `runPodTui`) — comportamento di `run`
  invariato; nuovo blocco `attach <pod> [--namespace] [--container <c>|-c <c>]
  [--resume]` (nome pod posizionale obbligatorio → usage/exit 1); `-c` alias
  corto estratto PRIMA di `parseFlags` (che legge solo `--`); `containerExecError`
  traduce "exec channel closed before the command reported a status" → hint
  container sbagliato (alias `-c` incluso); HELP aggiornato.
- **Il "hardening" del `registerPodCleanup` del piano è un no-op** (revertito):
  il codice già registrado il cleanup dopo `createPod`, *prima* di
  `waitForReady` — il gap non c'era. `startPodRuntime` invariato.
- **Bug HELP**: i backtick attorno a `` `run` `` dentro la template-literal la
  chiudevano (TS1005) — corretti.

**Test** (`pod-runtime.test.ts`, `describe("startExecRuntime")`, 8 casi + 1 in
`main.test.ts`): attach senza re-iniezione (preflight ok, exec **senza**
container → l'API sceglie il solo/default, mai `delete:*`/`besteffort:*`);
container esplicito (`container: "dns"`) → l'exec target lo porta; iniezione
quando la preflight fallisce (probe arch → install `head -c` → verify); 404
`getPod` → errore azionabile; pod terminale → `cannot attach`; pod Pending →
wait boundato → attach; exec senza status (container sbagliato) → errore
azionabile; iniezione fallita (musl) → hint glibc e pod **intoccato**.

**Validazione**: `bun run typecheck` 0 · `bun run lint` 244 file 0 · `bun test`
528 pass / 0 fail / 1 skip (il skip = k8s live opt-in `TENTACLE_K8S_SERVER`).

**Live** (da fare su `test00`, x86_64): UBI9 iniezione + TUI, ri-aggancio
senza transfer, 404, busybox/musl → hint, pod lasciato `Running` al detach.
