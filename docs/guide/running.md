# Ways to run

**Standalone:** the agent runs on your machine, in the current folder.

```sh
tentacle                                          # interactive TUI
tentacle "summarise src/ and suggest a refactor"  # one-shot
tentacle -- explain how config works              # one-shot starting with a subcommand word
tentacle --plain                                  # line REPL (pipes / no TTY)
tentacle --resume                                 # resume a saved session of this folder
```

A first word that names a subcommand (`run`, `explain`, `update`, …) **is** that
subcommand, so a one-shot prompt that starts with one needs `--` first:
`tentacle -- explain how config works` sends it to the model.

**`run`: in a new Kubernetes pod or Docker/Podman container.** tentacle
creates it, copies itself in (the pod binaries from [Install](../../INSTALL.md)), and
by default leaves it up on exit (also on Ctrl+C), printing one line,
`[container] <name> still running · tentacle attach <name>` (`[pod]` on Kubernetes),
to come back — printed once the TUI opens, never before a setup failure.
Informational status lines are dim grey on a terminal (not with `NO_COLOR`).
The pod daemon's own stderr is never printed: it goes to `daemon.log` in the run's
state dir (`~/.config/tentacle/kept/runs/<id>/`, else `~/.config/tentacle/logs/<name>/`;
mode 0600; every run/attach APPENDS after a `--- <time> run|attach <name> ---` line, the
newest 64 KiB kept). A real failure (the daemon dies, the link ends or never comes back —
a reconnect that recovered is not one — or the TUI fails) prints ONE line,
`[container] <name>: daemon stopped unexpectedly · log: <path>`;
a failed startup prints `[container] failed: <short cause> · log: <path>` (plus
` · still up: tentacle rm <name>` when a kept workload was left running) and the log
holds the full text. A model or turn error is not a failure: the TUI already showed
it. The startup status line redraws in place (cut to the terminal width, never
padded). `--rm` (or `rm: true` in the config or a profile)
removes it when the run ends instead (`--rm=false` overrides the config); flag > profile > user config > default (kept). The model key and the approvals
stay on your machine; sessions are saved locally, so `--resume` works. Each session
is one append-only log, `~/.config/tentacle/sessions/<folder>/<uid>.jsonl`;
`sessions: { keepSuperseded: true }` also keeps the history a compaction or a
context reset replaced (default off).

```sh
tentacle run --image <ref> [-n <namespace>] [--rm] [--name <n>] ["<prompt>"]        # Kubernetes (default)
tentacle run --engine docker --image <ref> [--context <ctx>] [--network <name|none>] [--name <n>] ["<prompt>"]  # Docker
tentacle run --engine podman --image <ref> [--network <name|none>] [--name <n>] ["<prompt>"]                    # Podman
```

`--name <n>` names the workload (a random name when omitted). The optional
`"<prompt>"` (or `--prompt <text>`; not both) is the **first message**: the TUI
opens and sends it at once, as plain text (a leading `/` is not a command). It
cannot be combined with `--resume`/`--continue`. `--auto-accept[=true]` starts
the TUI with auto-accept already on (the state Shift+Tab toggles); `=false`
changes nothing.

**With no TUI.** `tentacle run -d|--detach "<prompt>" --image <ref> [--name <n>]`
(or `--prompt <text|->`; `--prompt -` reads the prompt from stdin, only with `--detach`)
creates the workload, then a background process on your machine runs the turn,
serves the model and saves the session, and leaves after 60 s of idle. A tool
that needs permission waits for you unless `--auto-accept` (pod tool asks only,
allow once, logged in `<configDir>/kept/runs/<id>/relay.log`). `tentacle attach
<name>`, from a terminal in the same folder, takes the run over at any moment,
mid-turn or at a held permission, and it opens the run's session after the
process left too. More terminals can attach: they share the session, an ask shows
on each and the first answer wins. An `--auto-accept` run stays auto-accept for
the terminals that attach; Shift+Tab flips it for every terminal on that session,
and a session turned off stays off. `/quit` closes the session for every terminal on it (asking `y/N`
first when others are attached): a running turn stops, the last save is taken,
and the others leave with `session closed by another terminal`. Ctrl+C at idle
leaves only that terminal. With `--rm` the quit that closes the session
removes the workload, if no other session in it is in use. A workload deleted
outside tentacle is said as such, naming the session uid.

A successful `run --detach` prints one dim line, `[container] <name> still running ·
tentacle attach <name>`, and nothing else; `attach` to a run prints no `resolved …` or
`[resume] …` line either (failures still say why).

With `--rm` (or `rm: true`) the workload is listed in `ps` while the
run lives and removed when it goes idle or is stopped, a held permission keeping
it alive. `kill <pid>` counts as a stop, and so does a laptop shutdown that sends
SIGTERM. Its files go with it, a mounted laptop folder excepted; the transcript
stays in `tentacle --resume <uid>`, and its `relay.log` is deleted with it. A run
that failed or was interrupted, or a workload another client is using, stays:
`tentacle rm <name>` clears it. So does a crash the exit net could not catch (a
`kill -9`, a power loss), shown as `relay lost`. On macOS the Mac stays awake
while a turn runs (`detach: { keepAwake: false }` turns it off); closing the lid
still sleeps it, and the run then ends `interrupted`.

**Your folder, in the container (Docker/Podman).** On a local engine `run`
bind-mounts the current folder read-write at the same path, and the agent works
in it: your real files, with the container's own processes, packages and
network. `--no-mount` opts out. Only the cwd is mounted (never a parent or the
git root). Secrets inside the folder are hidden behind an empty read-only
overlay (checked after start): by default `~/.ssh`, `~/.aws`, `~/.kube`,
`~/.config/gcloud`, `~/.docker` (the folder), `~/.netrc` — `"mount": {"hide": […]}`
in `config.jsonc` (or a profile) replaces that list, `"hideExtra"` adds to it;
tentacle's config dir and the `apiKeyCommand` key file (`cat <file>`, also
`cat "$HOME/…"`) are always hidden; for any other command the file cannot be
named, and the run warns that it is NOT hidden. On a case-insensitive disk
(macOS, exFAT/NTFS, ext4 casefold — checked on the disk, not by OS) a hidden
FILE is still readable under another spelling (`KEY` for `Key`), so the run
refuses, in two lines: `[container] won't mount <folder>: <file> would be readable
inside the container` and `  fix: add `<its folder>/` to .tentacle/hide` (a directory
mask holds for every spelling) or `move <file> out of the folder` when it sits in the
mount root. `--confirm-mount` overrides this for your own entries (and warns,
naming them) — never for the key file. A project can add its own with `.tentacle/hide` in the folder
(gitignore-style: `#` comments, globs and `**`, a trailing `/` for directories;
`!` only un-hides what that same file hid — never the lists above). It only
ADDS, and the patterns are resolved to the paths that exist when the container
starts: a file created later is NOT hidden. More than 200 matches stops the run
(narrow the patterns); a pattern or symlink pointing outside the folder is
ignored with a warning. A `.tentacle/hide` that is unreadable, not a regular
file (a FIFO…), a link out of the folder or over 64 KiB stops the run. Mounting `/`, `/usr`, `/usr/local[/bin]`, `~/.ssh` or the config
dir (or a folder inside them) is refused. Your home, its parents, a system dir
or a folder on the hide list asks first, in two lines — `⚠ mount ~ (your home) into
the container? hidden: .ssh .aws .kube .config/gcloud .docker .config/tentacle`, then
`Continue? [y/N]` (names relative to the folder; the paths from `.tentacle/hide` are
counted, `+12 from .tentacle/hide`). Without a terminal it is refused, in one line,
unless `--confirm-mount`. A remote engine
(`tcp://`, `ssh://`) mounts nothing and says so. On rootful Docker on Linux the
agent runs as your uid:gid (files stay yours); Docker Desktop and rootless
Podman need nothing; SELinux hosts get `label=disable` for the container. The
image's code can write your folder (`.git/hooks`, `package.json` scripts…):
run only images you trust there, or use `--no-mount`. A kept container keeps its
mount; `attach <name>` works from any folder, as if launched from the one it mounts (the laptop's kept index records it; a run started with no mount: the folder it was launched from, also recorded; that folder may have been deleted or renamed, the attach still works).

**`attach`: in a pod or container that already exists.** Same as `run`, but
tentacle never creates, starts or deletes it: closing the TUI detaches and it
stays up.

**`/move`: the live session changes place (Docker/Podman).** In the interactive
TUI, `/move container [<image>]` hands the running conversation to a NEW
docker/podman container with your folder bind-mounted at the same path,
`/move attach <engine>:<name>[/<container>]` joins a workload already running,
and `/move local` brings it back. The session uid, its history and the
scrollback stay the same, and the TUI keeps running. A move happens at the end
of the turn, and only when the session is idle (a `/move` during a turn — or
while messages are queued — waits for it); it is refused, with one line, while a
background job, a sub-agent, a compaction or a broken link is in flight. An
attach is refused, before anything is dialled, when a detached run of yours owns
that workload, when another client is already in it, or when it still holds a
running copy of the session being moved. The workload a move creates is kept
and listed by `tentacle ps`; it is deleted only on `--rm` and only if that move
created it, never a workload you joined. The model can propose the same move
with `move_session`, which only ever asks you through the usual permission
prompt at the end of the turn. Details:
[`docs/feat/session-hop.md`](../feat/session-hop.md).

**What of your config reaches a pod or container (`run`, `attach`).** Each new
session takes your resolved settings. `subagents.*`, `model.contextWindow` and
`model.autoTitle` are always yours. `maxIterations`, `tools.*`, `contextAwareness`,
`contextReset`, `loadAgentsMd` and `loadSkills` are yours unless the container's own
environment or config file sets them, and tentacle shows you the values that win. A
session already running keeps the settings it was created with, and shows you those
that differ from yours:

```
Session settings: { "maxIterations": 3, "tools.dedupOutput": false } (/settings sync to use this terminal's values, or /clear)
```

The values that win from the container's own config are shown the same way:

```
Container config: { "maxIterations": 7 }
```

`/settings` shows all the session's settings and how this terminal differs:

```
Session settings:
{
  "maxIterations": 7, // (container) this terminal: 3
  "tools": {
    "dedupOutput": false, // this terminal: true
    "execution": "parallel"
  }
}
1 differs from this terminal (/settings sync to use this terminal's values)
```

`/settings sync` applies this terminal's settings (as they were when it started) to
the running session, between turns. The conversation, background jobs, your approvals
and other attached terminals stay; those terminals are told what changed. Values the
container's own config sets still win.

```sh
tentacle attach <pod> [-n <namespace>] [-c <container>]
tentacle attach --engine docker|podman <container>
```

**Kept pods and containers: `ps` → `attach <name>` → `rm`.** Every kept `run`
is recorded on your machine (`<configDir>/kept/`, where it was created — no
credentials). `tentacle ps` lists them, checked against their engine (NAME
ENGINE WHERE MOUNT MODEL AGE STATUS; one removed outside tentacle is `gone` and
hidden unless `-a` — or while a detached run or terminal still acts on it — and
`tentacle rm <name>` drops its entry; an engine that does not answer within 3 s is a dim `not reachable (skipped)`
line, never an error); `--engine` filters, `-q` prints names, `-v` details. A
detached run shows its state: `detached · running 3m`, `detached · waiting:
permission (shell)`, ` · auto` with `--auto-accept`, `attached (2)` with two
terminals on it (`-v` lists their pids), `tui lost` when the last one died without
quitting, `running · relay lost` if its
process died; `-v` adds its pid, session and log.
`tentacle attach <name>` needs no `--engine`: the engine and location are looked
up (an explicit `--engine`/`-n`/`--context`/`-c` skips the lookup).
`tentacle rm <name>` removes it — only a workload that still carries tentacle's
managed and kept labels, re-checked right before the delete; a running one asks
`[y/N]` (`-f` skips; without a terminal, `-f` is required). A live detached run
is named in that question and stopped first (turn cancelled and saved). A name
that now belongs to something else is left alone and its stale entry dropped.
Several names are removed one by one, each as above; a failure does not stop the
others (exit 1 if any failed).

```sh
tentacle ps [--engine <e>] [-a] [-q|-v]
tentacle rm [--engine <e>] [-f] <name>...
```

**Reading a session without the TUI: `logs`.** Every session is already a typed
log on your machine (`<configDir>/sessions/<folder>/<uid>.jsonl`), so
`tentacle logs` prints it as one line per event — turn boundaries, messages, tool
calls and results, the title, sub-agent markers — the newest session of the
current folder by default, or the `<uid>` you name (looked up in this folder's
store, then this folder's `serve` daemon's, then other folders; the file it read
is named on stderr). `--tail N` keeps the last N events (default 20), `--only
turn,tool,error,…` filters by category, `--json` prints NDJSON for scripts (a
versioned `v` field), and `--summary` counts tools used and files touched and
reports the turns and the last outcome. It is read-only: no lock, no write, and
a corrupt log is refused with the parser's reason and the path, never
half-shown. For a `serve` session it stops at the entry the daemon's state file
marks, so a crash's uncommitted tail is not shown. `-f` follows the FILE
(committed events only), resuming by entry id and saying so when the log is
rewritten. A session a `serve` daemon owns is followed LIVE instead:
`tentacle logs -f <uid> --connect <url>` (the `connect` token/TLS flags) starts a
read-only watch on that daemon and prints streaming text, asks and their
answers, and the turn's end — `--only ask,error,turn` narrows the stream, and a
queue that overflows says how many events it lost. The follower is never a
client of the session: it takes no model call, answers no ask, and never shows
up in `ps`. Ctrl+C stops it cleanly. `--tail --connect` reads that daemon's
committed log the same way, without opening anything. A **detached run** is
reached by its name instead of a uid: `tentacle logs -f <run-name>` finds the
run in your kept index, dials its pod's resident daemon through the engine's
exec bridge (the same one `attach` uses — no model link, no broker, no saved
session, no exit net) and runs the same read-only watch; `tentacle logs --tail
<run-name>` reads the copy the relay saved on this laptop. A run that has ended
is not dialled at all: `-f` says so and follows that saved copy. A name used at
more than one place with none of them live is refused, never guessed.

```sh
tentacle logs [<uid>|<run-name>] [--tail N] [--only <categories>] [--json] [--summary] [-f]
tentacle logs -f <uid> --connect ws://host:port [--token T|--token-command CMD] [--ca-cert FILE]
tentacle logs -f <run-name>
```

**Engines.** `--engine kubernetes|docker|podman` picks where it runs; the
default is `kubernetes`, or set `"engine"` in `config.jsonc` (or a profile), or
`TENTACLE_ENGINE` (precedence: flag › env › profile › config file). Kubernetes
uses your kubeconfig (current context, or `$KUBECONFIG`); no `kubectl` needed.
Docker uses the engine the docker CLI would (`--context` › `DOCKER_HOST` ›
`DOCKER_CONTEXT` › current context; unix socket, `tcp://` with TLS, or
`ssh://`); no `docker` CLI needed. A plaintext `tcp://` engine is refused
unless `--insecure-docker-tcp`. Podman's socket is found automatically
(`podman machine` on macOS, rootless/rootful on Linux; `CONTAINER_HOST`
overrides it) — no `DOCKER_HOST` needed. `-n`/`-c` are Kubernetes-only;
`--context`/`--insecure-docker-tcp`/`--network` are Docker/Podman-only. A
container's network is chosen at create: `--network <name|none>` (or
`TENTACLE_NETWORK`, or `"network"` in `config.jsonc` — flag › env › profile ›
file › the engine's default `bridge`), where `none` is an air-gapped run; a
network with `--engine kubernetes` is an error (a pod's network is the
cluster's), and `attach` has no such flag. Read-only root
filesystem? Add `--bin-dir /tmp`. Details:
[`docs/architecture/F4-pod-execution.md`](../architecture/F4-pod-execution.md),
[`docs/feat/docker-engine-cli.md`](../feat/docker-engine-cli.md).


On a remote host instead: [`serve`, `connect`, A2A and MCP](remote.md).

`tentacle --help` lists every flag.
