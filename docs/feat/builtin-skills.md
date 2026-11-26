# feat/builtin-skills — skills that ship inside tentacle (`tentacle`, `a2a`, `workflows`)

Type: feat · Size: M · Blast: cross-module (skills scan, config, build) · Suited: Opus plan

## Context

*— claude-opus-5-5, 2026-11-26*

**Question (owner, 26/11 ~21:20).** «vorrei che tentacle avesse in seno (codificate, ma come tutte le skills silenziabili) le skills per a2a (creare card ecc), e per tentacle (almeno funzionamento comandi essenziali e come fare cosa)» — then «anche su come creare workflows», «questi qui spenti di default».

**Why.** The model does not know tentacle. Evidence: in the a2a TUI test of 26/11 the agent ran `sed -n 1,80p ~/.config/tentacle/config.jsonc` and seven literal `apiKey`s entered the conversation (TODO `fix/config-file-guard`) instead of using `tentacle config get` / `tentacle explain`. A2A setup (an agent card, `harnesses.<name>` with `adapter: a2a`, `card`, `tokenCommand`, `serve --a2a-token`) and writing a workflow (`.tentacle/workflows/<name>.yaml`, steps, `where`, approval by content hash, schedules) are multi-step procedures a model gets wrong without a guide.

**What exists (docs/architecture/skills.md).** Agent Skills are found in three scopes, first name wins: project `.agents/skills/` (nearest folder), `<configDir>/skills/`, `~/.agents/skills/`. Progressive disclosure: only name + description reach the prompt's catalog; the body loads when the skill is used. Off switches: `/skills` per session (also before the first message), `loadSkills: false` / `TENTACLE_NO_SKILLS` for all. Packages can also bundle skills.

## Review — verdict and the owner's decisions

*— claude-opus-5-5, 2026-11-26*

**GO.** Three built-in skills, each costing one catalog line when on; the body loads only on use.

Owner decisions (26/11 ~21:25–21:35):

1. **Three skills.**
   - **`tentacle`**: the essential commands (`run`, `attach`, `ps`, `rm`, `logs`, `serve`, `connect`, `pair`, `devices`, `config`, `explain`, `update`), the TUI's slash commands, "how to do X" recipes (keep a pod and come back, resume, detach, connect through the relay, register tentacle in Claude Code over MCP), and rules such as «for settings use `tentacle config get` / `tentacle explain`; never read `config.jsonc`, it holds credentials».
   - **`a2a`**: A2A inside tentacle AND agent cards in general — exposing a `serve` over A2A (`--a2a-token`, the card at `/.well-known/agent-card.json`, `POST /a2a`), configuring a remote agent (`harnesses.<name>`, `adapter: a2a`, `card`, `tokenCommand`, never a literal token), testing it (`curl`); in a separate reference file, how to write and validate an Agent Card for any agent.
   - **`workflows`**: how to create a workflow — the file in `.tentacle/workflows/`, its step types and `where`, inputs, approval by content hash (an edit needs a new approval), asks during unattended runs, scheduled starts, and how to run and follow one (TUI and phone).
2. **All three OFF by default.** They are switched on by the user. Switches: `/skills` per session and `loadSkills` for all, as for every other skill.
   *Open point for the plan:* "off by default" needs a lasting way to turn one ON that today's switches do not give (`/skills` is per session; `loadSkills` covers every skill). Recommendation: one config key that lists the enabled built-ins, e.g. `skills.builtin: ["tentacle", "a2a"]` (empty by default), so «on» survives a restart. To confirm with the owner when the plan is written.
3. **The reference part is generated from the code** (the CLI usage text, the config key registry `packages/config/src/key-docs.ts`, the workflow schema) with a drift test that fails when a shipped skill no longer matches, like the config table of `docs/guide/configuration.md`. Only the "how to" recipes are hand-written.

Design notes for the plan (to verify against the code):

- **A fourth scope, lowest precedence: built-in**, embedded in the binary (compiled assets, versioned with the release), so a project or user skill of the same name shadows it, with the usual diagnostic.
- **Available in pods** (`run`/`attach`) when switched on: plain text, no secrets; the pod's own config decides, as for its other skills.
- Model-invocable when on (the agent can answer «how do I …» by itself).

**Promoted to feat** (owner 26/11 ~21:40 «vai ora»). Next: the source-verified Implementation (Opus), in the four-section format of docs/TASK-TEMPLATE.md.
