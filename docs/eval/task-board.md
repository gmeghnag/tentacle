# eval/task-board — a public, derived board of the agents' tasks on tentacle.so

> **Type:** eval · **Size:** — · **Blast:** contained (site only; no product code)

## Context

**Owner (2026-11-10):** "pubblicare nel sito una pagina dinamica dove si mostrano tutte le
issues todo/eval/bugs in backlog ed in lavorazione in quel momento dai nostri agents: tu o
tentacle, con pickup date, stato, chiusura su quale commit e rilascio su quale versione.
dovrebbe lavorare via api in quanto non voglio appesantire un agente di dover fare azioni
troppo elaborate per aggiornare tali cards/tasks."

**Already decided (owner):** the page is public and shows only these fields: title, type,
size/blast, status (backlog · in progress · in review · merged · released), pickup date, who
works on it, the merge commit and the release version. It shows no descriptions. A security
fix appears only once it is merged. Delivery is in two steps: **A**, a `tasks.json` generated
from what the repo already holds and re-published on every merge (S), then **B**, a small
events API fed by the orchestrator's launchers and never by the agents (M). Agents do
nothing extra.

**The question this eval decides:** for each field, the exact rule that derives it. Where
the code and the page live, how the data is published and how the security filter and the
redaction work. The shape of B. The risks.

### Facts the design stands on (verified)

- **Task identity is `<type>/<slug>`, and it shows up in four places.**
  1. Docs: `docs/feat/` (129), `docs/fix/` (52), `docs/eval/` (41).
  2. The H1, e.g. `# fix/agent-task-scope — <title>` (`docs/fix/agent-task-scope.md:1`).
  3. TODO entries such as `- [ ] **feat/agent-status** (…)` (`TODO.md:470`).
  4. Merge commits: 185 first-parent merges on `main` read `Merge branch '<type>/<slug>'`
     (`git log --merges --first-parent main`), and only 3 of them are not `feat/`/`fix/`.
- **Size and blast** appear in two formats:
  - the doc header `> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** …`
    (`docs/fix/agent-task-scope.md:5`; 137 docs have it);
  - the plain TODO line `Type: fix · Size: S · Blast: contained` (`TODO.md:354`; 142 lines).
  Older entries give only Type and Size (`TODO.md:331`).
- **Who signs each section.** Each section ends with `*— <model>, <date>*`. Examples:
  - `*— claude-opus-5-5, 2026-11-10*` signs the plan and the review
    (`docs/feat/subagent-panel.md:9,58,569`);
  - `*— deepseek (tentacle --profile deepseek), 2026-11-10*` signs the execution
    (`docs/feat/subagent-panel.md:376`; `docs/fix/agent-task-scope.md:194`).
- **Merges are recorded unevenly in TODO.** Free text such as `merged 5d1ef0e (2026-11-06)`
  appears in 30 entries (`TODO.md:51,428`). Some sub-tasks merged inside another branch
  (`feat/explain-cmd` "merged … inside `feat/config-explain`", `TODO.md:480`). Dropped tasks
  are written `~~**feat/subagent-slots**~~ DROPPED` (`TODO.md:464`).
- **Releases are git tags** (`v0.1.0-beta.1`, `v0.1.0`, `v0.2.0`, `v0.3.0`) and match the
  `## [x.y.z] - date` sections of the CHANGELOG (`CHANGELOG.md:162,334,415,492`). Everything
  not yet tagged sits under `## [Unreleased]` (`CHANGELOG.md:9`). The CHANGELOG never names a
  task slug, so **tag ancestry is the mapping**, not the CHANGELOG. For example,
  `git merge-base --is-ancestor 9e1cfc3 v0.3.0` holds, so `feat/tui-light-theme` shipped in
  `v0.3.0`.
- **The launchers already log a pickup line.** Each launcher appends
  `<phase>-<slug> (<actor>) HH:MM` to `runs/sessions.txt`
  (`.tentacle/tmp/orchestration/run-exec-subagent-panel.sh:3`), for example
  `exec-agent-status (tentacle --profile deepseek) 16:29`. Some lines also carry a session id
  (`run-review2-subagent-panel.sh:5`: `review2-…=b63280eb-… (condo, opus, …)`). The line has
  no date and no end event. The exit code only goes to stdout (`:6`).
- **The site** is static: Caddy serves `/srv/tentacle.so` with `file_server`
  (`.tentacle/site/Caddyfile:6-17`). It is deployed over ssh as root with a personal key
  (`cutover.sh:3`). An app already runs on the host as a podman container behind
  `reverse_proxy 127.0.0.1:8000` (`Caddyfile:29-36`). The landing page uses CSS tokens
  `--bg/--surface/--ink/--muted/--line/--brand*`, with a `prefers-color-scheme: dark` block
  and Red Hat Display/Mono fonts (`www/index.html:19-58,71-72`).
- **TODO prose is not publishable.** One entry carries a user path and a session uuid
  (`TODO.md:468`: `~/trash/new`, `tentacle --resume fc027317-…`), and many carry file paths
  and line numbers. Titles must come from a vetted source and pass a redaction check.

*— claude-opus-5-5, 2026-11-10*

## Proposal (the eval's content)

### 1. A card and where each field comes from

The generator builds each card from scratch out of an allowlist of fields. It never copies
parsed text through.

| field | rule (first match wins) | if missing |
|---|---|---|
| `id` = `type/slug` | the doc's path `docs/<type>/<slug>.md` · the TODO bold `**<type>/<slug>**` (also `**<type>: …**` with no slug, which is skipped) · the merge subject `Merge branch '<type>/<slug>'` | no card |
| `type` | the `<type>` in the id (`feat` \| `fix` \| `eval`) | — |
| `title` | the doc's H1 after ` — ` · otherwise the slug humanized (`agent-status` → "Agent status"). Never the TODO prose. After redaction (§2.4) | the humanized slug |
| `size`, `blast` | strip the `*` from the doc header, then match `Type:\s*\w+[^·]*·\s*Size:\s*([SML](?:[–-][SML])?)(?:\s*·\s*Blast:\s*(contained\|cross-module\|load-bearing))?` · the same regex on the TODO entry's text | `—` |
| `status` | the ladder below | `backlog` |
| `pickup` | first commit date of the branch: `git log --reverse --format=%as <M>^1..<M>^2` for a merge `M`, or `main..<branch>` for an open branch · for an eval, the date its doc was added (`git log --follow --diff-filter=A --format=%as`) · B: the first `start` event | `—` |
| `people[]` | each section's signature, by role: Context/Implementation → planner, Execution → executor, Review → reviewer. Each signer is mapped through a fixed table (`claude-opus-*` → Opus, `claude-sonnet-*` → Sonnet, `deepseek (tentacle…)` → DeepSeek via tentacle, `qwen*` → Qwen3 local, orchestrator → Claude (orchestrator)). An unknown signer becomes `agent`, so raw text is never echoed | `[]` |
| `merge` | the first-parent merge `M` matching the id, with `{commit: short hash, date: %as}` · otherwise a TODO `merged <hex7+>` note, kept only if `git merge-base --is-ancestor <hex> main` holds | `null` |
| `release` | the earliest tag `v*` that contains `M` (`git tag --contains M --sort=v:refname`, first one) · otherwise `"unreleased"` once merged | `null` |
| `live` | **B only**: `{phase, actor, since, state}` | absent |

**Status ladder**, top first. Precedence is what removes drift: git beats TODO, and A's
terminal states beat B's events.

1. `released`: `merge` is set and `release` is a tag.
2. `merged`: `merge` is set.
3. `in review`: the branch `refs/heads/<type>/<slug>` exists, is unmerged, and its doc's
   `## Review` section on that branch (`git show <branch>:docs/…`) has a signature. With B,
   a live event with `phase ∈ {review, review2…}` also counts.
4. `in progress`: the branch or a worktree `.tentacle/worktrees/<slug>` exists. With B, a
   running event also counts. This is derivable today, with no B: `feat/agent-status` has a
   branch and an exec run.
5. `backlog`: a TODO `- [ ]` entry or a doc exists, with no branch.

Dropped tasks (`~~…~~`) are excluded. An **eval** has no branch: its status goes `backlog`
(only in TODO) → `in progress` (its doc is on `main`, the Review is unsigned) →
`in review` (the Review says "pending owner verdict") → `merged`, shown as **decided**,
which means a verdict was signed or the doc was moved to `feat/` or `fix/`.

**What cannot be derived, and goes to B:** the phase running *right now* (plan, exec,
review or fix, and who runs it), from when, and whether it ended or failed. Git only sees a
phase once it is committed. `people[]` is complete only after each section is signed.

### 2. Step A: the generator

**2.1 Where it lives (recommendation).** Put it in `.tentacle/site/board/`, next to the site
it publishes, and make `.tentacle/site/` its own small private git repo (`git init` inside a
gitignored folder). That way it is versioned, it creates no product-repo task (no §10
branch, no gate churn), and the Caddyfile, `cutover.sh` and the landing page stop being
unversioned too. The alternatives: the product repo `scripts/board/` costs a `feat` branch
and review for site-only code; a separate GitHub repo is the same as the recommendation plus
a remote.

**2.2 Files**, in Bun TypeScript like the repo's tooling:
- `board/gen.ts`: reads the main checkout (path as an argument), runs `git` through
  `Bun.spawn` with argv arrays, and writes `out/tasks.json`.
  Shape: `{schema:1, generatedAt, cards:[…]}`.
- `board/redact.ts`: the title check plus a whole-output scan (§2.4). It is pure and has
  tests.
- `board/overrides.json`: `{hide:[id], public:[id], title:{id:"…"}}`, for the rare manual
  fix.
- `board/gen.test.ts`: fixtures for each rule in §1. They include the security and redaction
  cases and check that the run fails closed.
- `board/publish.sh`: runs gen, compares the output's hash with the last published hash, and
  uploads only when it changed.
- `www/board/index.html`: the page (§2.5). It has no build step and no dependencies.
- `Caddyfile`: adds `header /board/tasks.json Cache-Control "no-cache"`. `file_server`
  already sends an ETag, so a poll costs a 304.
- `~/Library/LaunchAgents/so.tentacle.board.plist`: runs `publish.sh` every 5 min.

**2.3 When it runs.** A launchd timer every 5 min, plus one call by the orchestrator right
after each merge or tag. The timer catches what has no hook: a new branch (a pickup), a
direct `docs(todo)` commit on `main`, a release tag. With a hash compare, an idle run costs
one `git` scan and no upload. **Publish:** `rsync` the file to `board/tasks.json.tmp`, then
rename it over ssh, so the swap is atomic. Use a **dedicated deploy key** restricted in
`authorized_keys` to `command="rrsync -wo /srv/tentacle.so/board"`, never the root key from
`cutover.sh`, which a timer must not hold.

**2.4 Security filter and redaction (fail-closed).**
- **Marker.** Add `Security: yes` to the metadata line (`Type: fix · Size: S · Blast: … ·
  Security: yes`), in the doc header or in TODO. A **keyword net** backs it up: a title or
  id matching `csrf|bypass|leak|inject|exfil|escape|privilege|credential|secret|token|auth`
  is treated as security too. Today the CSRF fix (`TODO.md:221`) carries no marker, and the
  net would catch it.
- **What a security card does.** It is **omitted entirely**, with no count or placeholder,
  until `merge` is set. The generator prints the hidden ids to its own stderr so the
  orchestrator can see them. `overrides.public` lets a false positive through.
- **Title check.** A title is rejected if it matches any of: `/` followed by a path segment
  with a `.`, `~/`, `:\d+`, an IPv4 address, a uuid, a hex run of 12 or more characters,
  `@`, `sk-`, `key=`, or a length over 100. A rejected title falls back to the humanized
  slug. Backticks are kept as `<code>`, so the page renders them as text, never as HTML.
- **Whole-output scan.** Before upload, the serialized JSON is checked for `/Users/`,
  `.tentacle/`, `142.132.`, `condo`, any uuid, any email address, `--profile` and
  `--resume`. One hit aborts the publish (exit ≠ 0, nothing uploaded), and the page keeps
  serving the last good file.

**2.5 The page `/board`.**
- **Look:** the landing's tokens and fonts, light and dark through
  `prefers-color-scheme`, the same nav bar. The mockup is `board-mockup.html`.
- **Layout:** on screens ≥ 1100 px, five columns (Backlog · In progress · In review ·
  Merged · Released) with counts. Narrower screens get the same five as stacked sections,
  with Released collapsed. Released shows the last 30, plus "show all".
- **Card:** the id in mono, the title, size and blast chips (blast colour-coded), the people
  with their roles, the pickup date, the merge `hash · date` and the version. A live card
  gets a pulsing dot with `exec · DeepSeek · since 16:29`.
- **Filters:** type, who, size, blast and a title search, kept in the URL hash so a view can
  be shared. The footer says "updated N min ago" (from `generatedAt`).
- **Polling:** `tasks.json` every 60 s and `/api/board/live` every 15 s (B), both paused
  while `document.hidden`. A failed fetch keeps the last data.

### 3. Step B: the events API

- **Endpoints:**
  - `POST /api/board/events` requires `Authorization: Bearer <token>`. Body:
    `{v:1, id:"feat/agent-status", phase:"plan|exec|review|fix|live|eval|mockup", n?:1-9,
    actor:"opus|sonnet|deepseek|qwen|orchestrator", event:"start|end", ok?:bool}`. Every
    field is an enum or a regex (`id` matches `^(feat|fix|eval)/[a-z0-9-]{1,60}$`), so there
    is **no free text** to leak. The server stamps the time itself. It answers 204, or 400 or
    401.
  - `GET /api/board/live` returns `{updatedAt, items:[{id, phase, actor, since, state:
    "running"|"ended"|"stale", ok}]}`: the latest event per id from the last 7 days, with
    `max-age=10`. **It returns only ids present in the published `tasks.json`**, which it
    mounts read-only. An event about a hidden security fix therefore never reaches the
    public. A brand-new id appears once A's next run publishes it, within 5 min.
  - `GET /api/board/health`.
- **Service:** about 150 lines of `Bun.serve` in `board/api/server.ts`. It runs in podman as
  `--network host`, listening on `127.0.0.1:8787`, with `--read-only`, a non-root user,
  `--restart always` and `oven/bun:1-alpine`, and mounts `/srv/board-data:/data` plus
  `/srv/tentacle.so/board:/pub:ro`. Caddy adds, in the `tentacle.so` block:
  `handle /api/board/* { request_body { max_size 1KB } reverse_proxy 127.0.0.1:8787 }`, and
  the existing `file_server` moves into `handle { }`.
- **Storage:** an append-only `events.jsonl`, reduced in memory at boot and rotated at 5 MB.
  The volume is a few hundred events a day, so SQLite adds nothing.
- **Auth:** the server keeps only the token's **SHA-256**, in a podman secret, and compares
  in constant time. On the laptop the token sits in `~/.config/tentacle-board/auth-header`
  (0600, one line `Authorization: Bearer …`). curl reads it with `-H @file`, so it never
  appears in argv (AGENTS §7: secrets via env or file, never argv).
- **Limits:** 1 KB bodies; 120 POST per minute in total; after 10 bad tokens in a minute
  every POST gets 401 for 5 min; GET is cached for 10 s.
- **Launcher side:** one helper, `orchestration/board-event.sh <id> <phase> <actor>
  start|end [exit]`, that runs
  `curl -fsS --max-time 3 -H @"$AUTH" --json "$body" https://tentacle.so/api/board/events
  >/dev/null 2>&1 &`. It runs in the background, its failure is ignored and **it never
  blocks a launcher**. The orchestrator's launcher template gains two lines, next to the
  existing `sessions.txt` line (`run-exec-subagent-panel.sh:3`) and after the run (`:5-6`).
  The agents do nothing.
- **Convergence.** The page merges B's events on top of A's data, and a card that A shows
  as merged or released ignores live events. A `running` event with no `end` after 12 h
  shows as `stale`, dimmed. If B is down, the page shows A's data with "live: offline".
  If A is stale, B still shows what is running for ids A already published.

### 4. Risks

| risk | mitigation |
|---|---|
| Private info from a private repo leaks (paths, session ids, hostnames, TODO prose) | Fields are an allowlist; titles come only from doc H1s; the redaction regex plus the whole-output scan fail closed; B accepts only enums and ids |
| A security fix is visible early (its slug, or a live event) | The marker plus the keyword net; the card is omitted entirely; B filters through the published ids |
| TODO, git and events disagree | The ladder: git > TODO, and terminal states > events; `stale` events time out; this costs nothing, because nobody edits the board by hand |
| A new public write endpoint on a host that also serves another app | Loopback only, read-only container, 1 KB bodies, rate limits, hashed token, no free-text fields; a Caddy access log; a token rotation runbook in `board/README` |
| The laptop is asleep, so A goes stale | "updated N min ago" is shown, and nothing breaks |
| Running cost | One ~40 MB container on the existing host, a 5-min launchd job, about 0 € more |
| Commit hashes link nowhere because the repo is private | Show them as plain text with no link (Q5) |

### 5. Owner questions (recommendation first)

1. **Where the board code lives.** **(a)** `.tentacle/site/` becomes its own private git repo
   (rec.) · (b) it stays gitignored and unversioned · (c) `scripts/board/` in the product
   repo, on a `feat` branch.
2. **What counts as a card.** **(a)** only tasks with an id: a `type/slug` doc, a TODO
   entry or a merge (rec.) · (b) also the legacy 🔴🟡🔵 review findings in TODO Blocks 1–11.
   These are ~170 items with no slug and the highest leak risk.
3. **The security marker.** **(a)** an explicit `Security: yes` plus the keyword net, fail
   closed (rec.) · (b) the explicit marker only · (c) an owner-kept list in
   `overrides.json`.
4. **Dropped tasks.** **(a)** hide them (rec.) · (b) a greyed "dropped" status.
5. **The merge commit.** **(a)** the short hash as text (rec.) · (b) a link, once a public
   mirror exists.
6. **The URL.** **(a)** `tentacle.so/board`, linked from the landing's nav (rec.) ·
   (b) `board.tentacle.so` · (c) not linked (unlisted).
7. **People on older tasks.** Many older docs have unsigned sections. **(a)** show `—` (rec.)
   · (b) parse TODO's free text ("Sonnet exec, Opus PASS"). That parsing is unreliable and
   becomes a free-text path to the public.

*— claude-opus-5-5, 2026-11-10*


**Answers (owner, 2026-11-10):** Q1 private for now — `.tentacle/site/` as its own private git repo (no remote); the owner may later move it into the product repo · Q2 (a) only `type/slug` tasks · Q3 (a) `Security: yes` marker + keyword net, hidden when in doubt (overrides for false positives) · Q4 (a) dropped tasks hidden · **Q5 (b) the merge commit is a LINK** to `github.com/gmeghnag/tentacle/commit/<hash>` (a 404 for visitors while the repo is private) · Q6 (a) `tentacle.so/board`, linked from the landing's nav · Q7 (a) `—` when no signature.

## Implementation

— (eval)

## Execution

— (eval)

## Review

**Verdict:** pending the owner's verdict.

**Recommendation:** build **A** first, with the generator in `.tentacle/site/` as its own
repo. Its status ladder already covers "in progress" from branches and worktrees, so the
board is useful before B exists. Then build **B** as specified, with the public `live` feed
filtered through A's published ids. Both steps are contained to the site. None of them is a
product-code task, so §10's one-code-task rule is not affected.

**Sizes:**
- **A** is S for the generator, redaction and publish (about 250 lines plus tests). With the
  page (about 350 lines of HTML, CSS and JS) it reaches the low end of M.
- **B** is M: a ~150-line service, its container and Caddy change, the launcher helper and
  the template edits.

*— claude-opus-5-5, 2026-11-10*
