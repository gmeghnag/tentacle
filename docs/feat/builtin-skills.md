# feat/builtin-skills — skills that ship inside tentacle (`tentacle`, `a2a`, `workflows`)

> **Status:** implementation (APPROVED — orchestrator, delegated; one owner question open, see below)
> **Branch:** `feat/builtin-skills`
> **Size:** M · **Blast:** cross-module (skills scan, config, session switches, build) · **Suited:** Opus plan → Sonnet/DeepSeek exec → fresh-context Opus review
> **Changelog:** `changelog.d/builtin-skills.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

**Question (owner, 26/11 ~21:20).** «vorrei che tentacle avesse in seno (codificate, ma come tutte le skills silenziabili) le skills per a2a (creare card ecc), e per tentacle (almeno funzionamento comandi essenziali e come fare cosa)» — then «anche su come creare workflows», «questi qui spenti di default».

**Why.** The model does not know tentacle. Evidence: in the a2a TUI test of 26/11 the agent ran `sed -n 1,80p ~/.config/tentacle/config.jsonc` and seven literal `apiKey`s entered the conversation (TODO `fix/config-file-guard`) instead of using `tentacle config get` / `tentacle explain`. A2A setup (an agent card, `harnesses.<name>` with `adapter: a2a`, `card`, `tokenCommand`, `serve --a2a-token`) and writing a workflow (`.tentacle/workflows/<name>.yaml`, steps, `where`, approval by content hash, schedules) are multi-step procedures a model gets wrong without a guide.

**What exists (docs/architecture/skills.md).** Agent Skills are found in three scopes, first name wins: project `.agents/skills/` (nearest folder), `<configDir>/skills/`, `~/.agents/skills/`. Progressive disclosure: only name + description reach the prompt's catalog; the body loads when the skill is used. Off switches: `/skills` per session (also before the first message), `loadSkills: false` / `TENTACLE_NO_SKILLS` for all. Packages can also bundle skills.

### Eval verdict and the owner's decisions

*— claude-opus-5-5, 2026-11-26*

**GO.** Three built-in skills, each costing one catalog line when on; the body loads only on use.

Owner decisions (26/11 ~21:25–21:35):

1. **Three skills.**
   - **`tentacle`**: the essential commands (`run`, `attach`, `ps`, `rm`, `logs`, `serve`, `connect`, `pair`, `devices`, `config`, `explain`, `update`), the TUI's slash commands, "how to do X" recipes (keep a pod and come back, resume, detach, connect through the relay, register tentacle in Claude Code over MCP), and rules such as «for settings use `tentacle config get` / `tentacle explain`; never read `config.jsonc`, it holds credentials».
   - **`a2a`**: A2A inside tentacle AND agent cards in general — exposing a `serve` over A2A (`--a2a-token`, the card at `/.well-known/agent-card.json`, `POST /a2a`), configuring a remote agent (`harnesses.<name>`, `adapter: a2a`, `card`, `tokenCommand`, never a literal token), testing it (`curl`); in a separate reference file, how to write and validate an Agent Card for any agent.
   - **`workflows`**: how to create a workflow — the file in `.tentacle/workflows/`, its step types and `where`, inputs, approval by content hash (an edit needs a new approval), asks during unattended runs, scheduled starts, and how to run and follow one (TUI and phone).
2. **All three OFF by default.** They are switched on by the user. Switches: `/skills` per session and `loadSkills` for all, as for every other skill. Open point: a lasting way to turn one ON (→ Owner questions below).
3. **The reference part is generated from the code** (the CLI usage text, the config key registry `packages/config/src/key-docs.ts`, the workflow schema) with a drift test that fails when a shipped skill no longer matches, like the config table of `docs/guide/configuration.md`. Only the "how to" recipes are hand-written.

Design notes from the eval: a fourth, lowest-precedence **built-in** scope embedded in the binary (a project/user skill of the same name shadows it, with the usual diagnostic); **available in pods** when switched on (plain text, no secrets; the pod's own config decides); **model-invocable** when on.

**Repro (capability missing, 2026-11-26).** `rg -n "builtin" packages/config/src/skills-scan.ts` → no match; `skillRoots` (`packages/config/src/skills-scan.ts:49-91`) returns only project roots, `<configDir>/skills`, `~/.agents/skills` and package roots. The executor re-runs T1 (below) on current `main` first: it is red because no skill named `tentacle` is discovered from an empty home/config dir.

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, owner-delegated details, 2026-11-26). No choice below weakens an AGENTS §7 trust rule (nothing new crosses pod→laptop; the laptop receives no new data; skill text is already redacted and already pod-local in pods). Execution may start on the recommended answer to Q1; if the owner picks the other shape only `builtinDefaultOff`, the schema entry and the key docs change.

### Load-bearing assumption

**"Off by default" can be the session's existing per-skill switch, seeded from config, at zero model cost.** Proven:

- A skill in the session's `disabledSkills` is cut out of the system prompt's catalog (`projectSystem`, `packages/agent/src/capabilities.ts:217`) and out of the `skill` tool's enum (`projectTools`, `capabilities.ts:153-181`) on EVERY request — a projection, never a mutation (`capabilities.ts:10-13`). So a built-in that is off costs no tokens.
- It can be turned on for the session with `/skills` because the composed catalog holds every discovered skill (`renderSkillsCatalog(skills)`, `packages/config/src/resolve.ts:618`), and `projectSystem` re-advertises only names in the COMPOSED block (`capabilities.ts:203-216`). A skill that was never composed could not be switched on mid-session — so built-ins must be DISCOVERED, then seeded off; they must not be filtered out of discovery.
- The user's own `/name` still runs an off skill (`packages/protocol/src/skills.ts:39-44`): an ad-hoc use without switching it on for the model.
- The config→session seed already exists for tools: `buildAgent` seeds `capabilities: { ...NO_CAPABILITIES, disabledTools }` (`packages/cli/src/wiring.ts:1565-1567`), including a default-off group (`browserDefaultOff`, `packages/core/src/tool-groups.ts:48-53`; `wiring.ts:1482-1491`); a hosted session created by this host starts from the agent's state (`packages/daemon/src/hosted-session.ts:1396-1400`); a client seed is UNIONED, off wins (`seedCapabilities`, `hosted-session.ts:4245-4251`). Built-in skills reuse exactly this path with `disabledSkills`.

Second fact the shape stands on: **a skill body is read from a real file through the session env** (`readSkillBody` → `ctx.env.readFile(skill.location)`, `wiring.ts:207-210`), bundled files are listed from the directory (`listBundledFiles`, `skills-scan.ts:94-138`) and read by the model with `fs_read`, and the truncation pointer is `fs_read <location>:<line>` (`packages/tools/src/skill.ts:130`). An in-memory body would need a parallel reader AND would leave the a2a reference file unreadable. Hence D2: materialize the embedded files to disk and scan them as a normal root.

### Preconditions

- Discovery: `discoverSkills` (`packages/config/src/load.ts:406-428`) → `skillRoots` (`skills-scan.ts:49-91`, precedence = order, dedup by realpath) → `scanSkills` (`skills-scan.ts:146-210`, never throws; every problem is a diagnostic) → `mergeSkills` (`packages/config/src/skills.ts:185-202`, first name wins, the shadowed one is a diagnostic). `loadSkills:false` / `TENTACLE_NO_SKILLS` short-circuit before any scan (`load.ts:409-411`).
- Text assets embed in the compiled binary with `import x from "…" with { type: "text" }` (precedent `packages/cli/src/browser-extension-assets.ts:1-28`, one `@ts-expect-error` per non-TS import). Pod binaries are built with the SAME `buildBinary` options (`packages/cli/src/pod-binary-build.ts:1-19`), so a pod daemon carries the same assets.
- Sub-agents read the parent's capabilities LIVE (`packages/agent/src/subagent.ts:383-387`), so an off built-in is off for them too.
- Serve reload: the record wins, except a default-off TOOL this host built off stays off, because "a record cannot tell turned-on from written-before-it-existed" (`hosted-session.ts:1378-1395`, `isDefaultOffTool` `tool-groups.ts:55-63`). Pre-feature records contain no built-in names, so without the same rule they would reload with the built-ins ON.
- Wire: `SkillListEntrySchema.scope` is `z.enum(["project","user"])` (`packages/protocol/src/skills.ts:29`); fields are strip (AGENTS §7 forward compat), so an optional field is free and an older phone/TUI drops it.
- Name collisions: `/workflows` is a TUI alias of `/workflow` (`packages/tui/src/commands/registry.ts:85`) and a built-in command wins over a skill (`docs/architecture/skills.md` "The user's `/skill-name`"); `/a2a` is planned (TODO `feat/a2a-reload`).
- Generated-docs precedent: markers in a Markdown file + `bun run docs:config` (`scripts/config-docs.ts`) + drift test `packages/config/test/readme-config-table.test.ts:1-40`. Sources: CLI usage `USAGE` (`packages/cli/src/flags.ts:922`), the key registry (`packages/config/src/key-docs.ts`, `harnesses.*` at `:727-820`, `tools.enabled` at `:1757-1775`), the workflow spec (`packages/core/src/workflow-spec.ts:25-140`), the slash-command registry (`packages/tui/src/commands/registry.ts`).
- `skill` results pass secret redaction (`docs/architecture/skills.md` "The result pipeline"): an example key in a shipped body would arrive masked.

#### Orchestrator decisions

- **D1 — names: `tentacle`, `tentacle-a2a`, `tentacle-workflows`.** A bare `workflows` is unreachable as `/workflows` (the TUI alias wins, `registry.ts:85`) and `a2a` would be once `/a2a` lands; the prefix also keeps them from colliding with a user's own generic `a2a`/`workflows` skill. Shadowing still works by exact name.
- **D2 — delivery: embedded → materialized → scanned.** Sources in `packages/config/builtin-skills/<name>/…`, embedded as text. At discovery, written to `<configDir>/builtin-skills/<hash>/<name>/…` (`<hash>` = first 16 hex of sha-256 over the sorted (path, bytes) table, so two builds with different text never share a dir and identical builds do), each file compared and, if missing or different, rewritten atomically (temp + rename). That dir is the LAST root (after package roots), flagged `builtin`. Everything after that is today's code: scan, bundled files, body read at activation, `/compact` re-read, truncation pointer, `/skills` location.
- **D3 — off by default = seeded into the session's `disabledSkills`** at `buildAgent`, for each WINNING skill with `builtin: true` (a user/project skill that shadows a built-in is never seeded off) not turned on by the config key (Q1). `/skills` switches it per session; `/name` loads it ad hoc.
- **D4 — serve reload: off wins for built-ins this host built off** (same rule and reason as `isDefaultOffTool`). Consequence, documented: a built-in switched on with `/skills` goes back off after a `serve` restart; the lasting switch is the config key.
- **D5 — wire: an optional `builtin: true` on `SkillListEntrySchema`, `scope` stays `"user"`.** Scope is the TRUST axis (`project` = repo-supplied); a built-in ships with tentacle, so it is not repo-supplied. Additive → no `protocol.d/` note, no `PROTOCOL_VERSION` bump, the installed iPhone app keeps working (it shows `user`). TUI `/skills` and the phone's skill chip show `built-in`.
- **D6 — pods: the pod's own config decides; the laptop seeds no skill state.** Unchanged pod path (the laptop's `baseDisabledTools` seed, `packages/cli/src/engine-runtime.ts:866-868`, stays tools-only). Built-ins in a pod are off unless the pod's config turns them on or the user uses `/skills` / `/name`.
- **D7 — generated blocks**: `<!-- generated:<id> -->` … `<!-- /generated:<id> -->` inside the shipped Markdown, filled by `bun run skills:gen` (`scripts/builtin-skills-gen.ts`); a drift test regenerates and compares. Generated: the CLI command list (from `USAGE`), the TUI slash-command list (from the registry: name + one-line description), the config keys RELEVANT to each skill (`tentacle`: the top-level sections, key + summary only, never the full table — the body says "`tentacle explain <key>` for the rest"; `tentacle-a2a`: `harnesses.*` and the `serve` A2A keys/flags; `tentacle-workflows`: the step fields, limits and defaults from `workflow-spec.ts`). Hand-written: recipes and rules only.
- **D8 — size budget**: each `SKILL.md` ≤ 12 000 chars (well under `MAX_SKILL_BODY_CHARS` 50 000, `tools/src/skill.ts:23`), description ≤ 300 chars and phrased as a trigger ("Use when the user asks how to …"). The Agent Card how-to is `tentacle-a2a/references/agent-card.md`, read with `fs_read` only when the body says so. Examples use placeholders (`<token>`), never key-shaped strings.
- **D9 — the `tentacle` skill's rules** include: settings via `tentacle config get <key>` / `tentacle explain <key>`; never read or print `config.jsonc` or a credential key; tokens via `tokenCommand`, never literal.

### Owner questions

- **Q1 — the lasting way to turn a built-in ON.** **Recommendation: a map `skills.builtin: { "tentacle": true }`** (absent/empty = all off), the same shape as `tools.enabled` (`schema.ts:849`, `key-docs.ts:1757-1775`): each leaf is a boolean, so it is settable from the shell with `tentacle config set skills.builtin.tentacle true`, per profile, and an unknown name is a config error (names are static per build, as for tools). Alternative: the list `skills.builtin: ["tentacle"]` from the eval — same behaviour, but adding one skill means rewriting the whole array. Not recommended: a `/skills` action that writes the config file from the TUI (a new write path for one convenience).

### Design

1. **Assets (config).** `packages/config/builtin-skills/{tentacle,tentacle-a2a,tentacle-workflows}/SKILL.md` + `tentacle-a2a/references/agent-card.md`. `packages/config/src/builtin-skills.ts` imports each as text and exports `BUILTIN_SKILL_FILES: Readonly<Record<string, Readonly<Record<string, string>>>>` (name → relPath → text) and `builtinSkillsHash()`. `BUILTIN_SKILL_NAMES` lives in `packages/core/src/builtin-skills.ts` (pure, tiny; the daemon needs it for D4 and core is already its dependency, `hosted-session.ts:105`), with `builtinDefaultOff(skills: readonly {name, builtin?}[], enabled: Record<string, boolean>): string[]` — the winners with `builtin` not set `true` in `enabled`, sorted.
2. **Materialize + scan (config).** `materializeBuiltinSkills(configDir): Promise<{ root?: string; diagnostics: string[] }>` in `skills-scan.ts`: mkdir -p, compare, atomic rewrite; on any error → `built-in skills unavailable: cannot write <dir>: <err>` and no root. Never throws. `SkillRoot` and `SkillInfo` gain `builtin?: true`; `scanSkills` copies it. `discoverSkills` (`load.ts:406`) calls it only when enabled and appends the root last.
3. **Config key (config).** `skills: z.object({ builtin: z.record(z.boolean()).optional() }).strict().optional()` in `schema.ts`; unknown names refused where `tools.enabled` refuses its own (resolve); `ResolvedConfig.builtinSkillsEnabled` like `toolsEnabled` (`resolve.ts:964`); key-docs entries `skills`, `skills.builtin`, `skills.builtin.*` (`carried: "no"`, as `tools.enabled`); `bun run docs:config`.
4. **Seed (cli).** `wiring.ts:1565-1567`: `capabilities: { ...NO_CAPABILITIES, disabledTools, disabledSkills: builtinDefaultOff(config.skills, config.builtinSkillsEnabled ?? {}) }`. Every runtime (worker, plain, one-shot, `serve`, pod daemon) goes through it.
5. **Reload (daemon).** `hosted-session.ts:1388-1394`: also `builtOffSkills = agent.capabilities().disabledSkills.filter(isBuiltinSkillName)` unioned into the record's `disabledSkills`.
6. **Listing / wire.** `SkillListingEntry.builtin?` (`agent/src/session-skills.ts:12-23`), filled in `buildSessionSkills` (`wiring.ts:236-245`); `toSkillList` (`daemon/src/mapping.ts:88-`) passes it; protocol `builtin: z.literal(true).optional()`; `bun run schema:export`.
7. **UI.** TUI `SkillView.builtin` (`tui/src/skills-panel.ts:23-31`): the row reads `built-in` instead of the scope, and an off built-in's detail says "off by default — keep it on: `tentacle config set skills.builtin.<name> true`". Phone: the chip in `apps/mobile/src/session-info.ts:1088,1104` reads `built-in`.
8. **Generator.** `scripts/builtin-skills-gen.ts` (+ `"skills:gen"` in `package.json`): imports `USAGE`, the TUI `COMMANDS`, `KEY_DOCS`, the workflow-spec constants; rewrites each generated block; formats nothing else.
9. **Docs.** `docs/architecture/skills.md`: the fourth scope, the off-by-default rule, `skills.builtin`, the reload rule; `changelog.d/builtin-skills.added.md` (one bullet).

### Files

In dependency order: `packages/core/src/builtin-skills.ts` (new) + core index export · `packages/protocol/src/skills.ts` + `packages/protocol/schema/protocol.json` (generated) · `packages/config/builtin-skills/**` (new) · `packages/config/src/{builtin-skills.ts (new), skills.ts, skills-scan.ts, load.ts, schema.ts, resolve.ts, key-docs.ts, index.ts}` · `docs/guide/configuration.md` (generated) · `packages/agent/src/session-skills.ts` · `packages/daemon/src/{hosted-session.ts, mapping.ts}` · `packages/cli/src/wiring.ts` · `packages/tui/src/skills-panel.ts` · `apps/mobile/src/session-info.ts` · `scripts/builtin-skills-gen.ts` + `package.json` · `docs/architecture/skills.md` · `changelog.d/builtin-skills.added.md`. Tests listed below.

### Failure modes

| Case | Convergence |
|---|---|
| `<configDir>` unwritable (read-only FS, OpenShift `HOME=/`, ENOSPC) | One `[skills]` diagnostic, no built-ins, startup and other skills unaffected. |
| A materialized file edited/deleted between runs | Rewritten at the next discovery (start, rescan, context reset). An edit between discovery and activation is the same exposure as any file in `<configDir>/skills` (same uid). |
| Two processes materialize at once | Identical bytes, per-file temp+rename: last rename wins with the same content. |
| Two tentacle versions share `<configDir>` | Different `<hash>` dirs; neither touches the other's. Old dirs are not pruned (debt, ~30 KB each). |
| A project/user skill named `tentacle` | It wins, the usual shadowed diagnostic; NOT seeded off (only `builtin` winners are). A cloned repo's same-named skill is repo-supplied text, as today (future folder-trust gate). |
| `loadSkills:false` / `TENTACLE_NO_SKILLS` | No scan, no write, no built-ins. |
| Unknown name in `skills.builtin` | Config error at load, like `tools.enabled`. |
| `serve` reload of a pre-feature record, or one where `/skills` turned it on | Off (D4); the lasting switch is the key. |
| Older phone/TUI against a new daemon | `builtin` stripped; the row shows `user`. No version mismatch. |
| Pod | Pod daemon materializes in the pod's config dir; off unless the pod config / `/skills` / `/name`. Nothing new to the laptop. |
| > 97 user skills | Built-ins are last, so the existing 100-skill cap drops them first, with its diagnostic. |
| Body redaction | A key-shaped example would be masked: T8 pins redaction as identity on every shipped file. |
| Generated block stale (a flag, key or step field changed) | T8 fails with "run `bun run skills:gen`". |

### Tests

Red before green: each test is written first and shown failing on `main` (T1–T7 fail on the missing behaviour, T8–T9 on the missing files/script), then green. Non-vacuity by mutation for T3 (drop the `builtin` filter → T3b must fail) and T5 (remove the D4 union → must fail).

- **T1** `packages/config/test/skills-builtin.test.ts`: `discoverSkills` with empty temp home/config/cwd → exactly the 3 built-ins, last, `builtin: true`, `scope: "user"`, `tentacle-a2a` lists `references/agent-card.md`, `location` exists on disk.
- **T2** same file: a `<configDir>/skills/tentacle/SKILL.md` wins; a diagnostic names both; the winner has no `builtin`.
- **T3** same file / `packages/core/test/builtin-skills.test.ts`: `builtinDefaultOff` → all 3 with `{}`; 2 with `{ tentacle: true }`; (b) a shadowed built-in is not in the result.
- **T4** materialization: a tampered file is restored; a `configDir` that is a FILE (unwritable) → diagnostic, no built-ins, no throw; a second call writes nothing (mtime unchanged).
- **T5** `packages/daemon/test/session-settings.test.ts` (or the capabilities test that covers the browser B4 reload): a host session built with built-ins off, reloaded from a record WITHOUT them → still off; a created session's projected system prompt and `skill` enum lack them; after `setCapability({kind:"skill", name:"tentacle", enabled:true})` the projected catalog lists `tentacle`.
- **T6** config: `skills.builtin` parses; an unknown name is refused; key-docs has the three entries (the existing `key-docs.test.ts` / `readme-config-table.test.ts` go red until `docs:config` runs).
- **T7** protocol: `SkillListEntrySchema` accepts `builtin: true` and the old shape; `json-schema.test.ts` green after `schema:export`.
- **T8** `packages/cli/test/builtin-skills.test.ts`: every generated block equals the generator's output; every shipped `SKILL.md` parses with `parseSkillManifest` with ZERO warnings, name = dir, ≤ 12 000 chars; redaction is identity on every shipped file.
- **T9** same file: `BUILTIN_SKILL_FILES` lists every file under `packages/config/builtin-skills/` with identical bytes (the browser-assets precedent).
- TUI/phone label: one assertion each in the existing `skills-panel` and `session-info` tests.

## Execution

*— (executor), (date)*

## Review

*— (reviewer), (date)*
