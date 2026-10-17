<!--
The spawn-time brief for a FRESH agent executing one task. Copy its body into
the agent's prompt, filling <type>/<slug>. It operationalises AGENTS §10 — it
does not restate the rules; it points at them. Keep it ≲ one screen. See
docs/feat/agent-briefs.md for why this exists. Reviewer's counterpart:
docs/REVIEWER-BRIEF.md.
-->

# Executor brief

You are executing exactly ONE task in this repository: **`<type>/<slug>`**.

**Before anything else, read:**
1. `AGENTS.md` — especially §0 (hard stop / anti-loop rules), §4 (verification),
   §9 (writing tests), §10 (task workflow). You do not already have it in memory.
2. The task doc `docs/<type>/<slug>.md` — its **Context** and **Implementation**
   are the plan, to be verified against the code (not trusted). Open only the
   files the Implementation names.

**Reproduce first** (before any edit): run the Context's **Repro** (or write the
smallest one) on current `main`, in `.tentacle/tmp/<slug>/` (AGENTS §6), and
record its output in Execution. For a feat,
show the capability is actually missing. If it does not reproduce, **STOP and
report** — the task may be stale or wrong.

**While working:**
- Work only on the task's branch. Keep edits minimal and faithful to the
  Implementation's **Design**; do not reformat or touch unrelated lines.
- Never invent file contents you have not read. If a site does not look like the
  plan describes, reconcile it with the Design — or **STOP and report** what you
  found. Never retry with guessed text (that is the `fs_edit`-corruption loop
  §0 forbids).
- For a fix: write the regression test and show it **RED on the buggy code
  first** (§9), then make it green. A test green on both proves nothing; it must
  be red **on the assertion of the property**, not on an import/compile error.
- Follow the Implementation's order; run the **narrow** test file per slice (§4),
  not the whole suite.

**Before you declare done:**
- Fill the task doc's **Execution** section honestly: the as-built, in order,
  and **any drift from the Implementation (and why)**. Facts, not a re-narration
  of the plan.
- Run the task's own acceptance checks (grep-guards, specific tests it names)
  **and** `bun run check` (typecheck → lint → test). It must be **green**,
  compared to the lint baseline in AGENTS §6. If it is not, you are not done.
- Report per AGENTS §5: what changed (`file:line`), why in one sentence, the
  evidence. If something is unverified, say so in one line and how to verify it.

If you get blocked (missing access, ambiguous requirement, repeated failure):
**escalate, don't spin** (§0) — stop and report in 2–3 sentences what was tried,
what is known, and the specific decision needed.
