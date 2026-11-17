/**
 * The Session info view-model (docs/feat/mobile-session-info.md, Owner decisions
 * 1–2). Pure, so every state the sheet can be in is decided and asserted HERE,
 * not in a `.tsx` the harness cannot import (AGENTS §7).
 *
 * The states are enumerated per section (loading/ready/empty/error/unsupported/
 * offline/not-open), because the plan's whole point is that ONE section failing
 * must never take the others down (F2, F3, F4).
 */
import { describe, expect, test } from "bun:test";
import type { McpServerStatus, ScheduleRow } from "@tentacle/protocol";
import {
  type CapabilitySwitches,
  type InfoFacts,
  type Pull,
  capabilityChanges,
  contextMeter,
  devicesText,
  rowIdentity,
  sanitizeDisplay,
  sessionInfoView,
  settledOp,
  shortModel,
  shortenPath,
  switchPhase,
  tokensText,
} from "../src/session-info.ts";

const ready = <T>(value: T): Pull<T> => ({ state: "ready", value });
/** The two classes a terminal must never receive, as `client/schedules.ts` tests them too. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const loading = <T>(): Pull<T> => ({ state: "loading" });
const failed = <T>(kind: "error" | "unsupported" | "offline" | "not-open"): Pull<T> => ({
  state: "error",
  kind,
});

const server = (over: Partial<McpServerStatus> & { name: string }): McpServerStatus => ({
  state: "connected",
  tools: [],
  moreTools: 0,
  ...over,
});

function facts(over: Partial<InfoFacts> = {}): InfoFacts {
  return {
    phase: "open",
    link: "up",
    now: new Date(2026, 10, 17, 12, 0, 0).getTime(),
    title: "Fix the flaky test",
    computerName: "MacBook Pro",
    daemon: { version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 },
    mcp: ready({ servers: [] }),
    skills: ready({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: ready({ used: 0, exact: true }),
    entry: ready({
      sessionId: "s-1",
      title: "Fix the flaky test",
      cwd: "/Users/me/tentacle/apps",
      createdAt: 0,
      updatedAt: 0,
      running: false,
      attached: 1,
      archived: false,
      jobs: 0,
    }),
    autoAccept: false,
    ...over,
  };
}

const section = (f: InfoFacts, id: string) => {
  const found = sessionInfoView(f).sections.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`no ${id} section`);
  }
  return found;
};

describe("shortModel (Owner decision 2: model under the title)", () => {
  test("a slashed id shows only its last segment (owner)", () => {
    expect(shortModel("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(
      "DeepSeek-V4.1-Flash-1017",
    );
    expect(shortModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(shortModel(undefined)).toBeNull();
    // Nothing after the slash: never an empty word in the header.
    expect(shortModel("rits/")).toBe("rits/");
  });
});

describe("contextMeter (the sheet's exact figures, Owner decision 4)", () => {
  test("percent and both figures when the window is known", () => {
    const meter = contextMeter({ used: 84_000, exact: true }, 200_000);
    expect(meter.text).toBe("42 % · 84k of 200k");
    expect(meter.percent).toBe(42);
    expect(meter.tone).toBe("running");
  });

  test("an estimate is prefixed ≈, an exact count is not", () => {
    expect(contextMeter({ used: 84_000, exact: false }, 200_000).text).toBe("≈ 42 % · 84k of 200k");
    expect(contextMeter({ used: 84_000, exact: true }, 200_000).text.startsWith("≈")).toBe(false);
  });

  test("the meter turns to attention at 80 % (the TUI's warn zone)", () => {
    expect(contextMeter({ used: 160_000, exact: true }, 200_000).tone).toBe("attention");
    expect(contextMeter({ used: 159_000, exact: true }, 200_000).tone).toBe("running");
    // Over 100 %: the bar is clamped, the numbers are not.
    expect(contextMeter({ used: 300_000, exact: true }, 200_000).percent).toBe(100);
  });

  test("no window known → tokens only, and NO meter (F6)", () => {
    const meter = contextMeter({ used: 84_000, exact: true }, undefined);
    expect(meter.text).toBe("84k tokens");
    expect(meter.percent).toBeNull();
    expect(meter.tone).toBeNull();
  });

  test("tokens read as k and M", () => {
    expect(tokensText(950)).toBe("950");
    expect(tokensText(84_000)).toBe("84k");
    expect(tokensText(1_200_000)).toBe("1.2M");
    expect(tokensText(200_000)).toBe("200k");
  });
});

describe("devicesText (attached counts THIS phone, so others = attached − 1)", () => {
  test("alone, one other, many others", () => {
    expect(devicesText(1)).toBe("Only this phone");
    expect(devicesText(2)).toBe("This phone + 1 other");
    expect(devicesText(3)).toBe("This phone + 2 others");
  });
});

describe("shortenPath", () => {
  test("last two components, with an ellipsis when there were more", () => {
    expect(shortenPath("/Users/me/tentacle/apps")).toBe("…/tentacle/apps");
    expect(shortenPath("tentacle/apps")).toBe("tentacle/apps");
    expect(shortenPath("/")).toBe("/");
    expect(shortenPath("/srv")).toBe("/srv");
  });
});

describe("sanitizeDisplay (Hostile strings, F10)", () => {
  test("bidi overrides and zero-width characters are stripped", () => {
    expect(sanitizeDisplay("a\u202eb\u200bc")).toBe("abc");
    expect(sanitizeDisplay("ok\u2066name\u2069")).toBe("okname");
    expect(sanitizeDisplay("plain name")).toBe("plain name");
  });

  test("a huge error is clamped", () => {
    expect(sanitizeDisplay("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe("the MODEL section", () => {
  test("the daemon's model, mono, with the context row under it (Owner 1: no provider)", () => {
    const model = section(facts(), "model");
    expect(model.phase).toBe("ready");
    const [modelRow, contextRow] = model.rows;
    expect(modelRow?.title).toBe("Model");
    expect(modelRow?.value).toBe("claude-sonnet-4-5");
    expect(modelRow?.mono).toBe(true);
    expect(contextRow?.title).toBe("Context");
    expect(contextRow?.value).toBe("0 % · 0 of 200k");
    // There is no "API" row: the owner chose the model name only.
    expect(model.rows.some((row) => row.title === "API")).toBe(false);
  });

  test("an older daemon that reports nothing says so (F6)", () => {
    const model = section(facts({ daemon: undefined }), "model");
    expect(model.rows[0]?.value).toBe("Not reported");
    // No daemonInfo at all: no context row either (nothing to report it from).
    expect(model.rows).toHaveLength(1);
  });

  test("a slashed model id is shown in FULL here (only the header shortens it)", () => {
    const model = section(
      facts({ daemon: { model: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" } }),
      "model",
    );
    expect(model.rows[0]?.value).toBe("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });

  test("a context pull that is still loading shows the loading row, not a fake 0", () => {
    const model = section(facts({ context: loading() }), "model");
    expect(model.phase).toBe("ready");
    expect(model.rows[1]?.loading).toBe(true);
  });

  test("an unsupported context pull says the daemon is too old (F2)", () => {
    const model = section(facts({ context: failed("unsupported") }), "model");
    expect(model.rows[1]?.value).toBe("Needs a newer tentacle on MacBook Pro");
  });
});

describe("the SESSION section", () => {
  test("project (shortened), devices, background only when there are jobs", () => {
    const one = section(facts(), "session");
    expect(one.rows.map((row) => row.title)).toEqual(["Project", "Devices"]);
    expect(one.rows[0]?.value).toBe("…/tentacle/apps");
    expect(one.rows[0]?.accessibilityLabel).toBe("/Users/me/tentacle/apps");
    expect(one.rows[1]?.value).toBe("Only this phone");

    const busy = section(
      facts({
        entry: ready({
          sessionId: "s-1",
          title: "t",
          cwd: "/srv/app",
          createdAt: 0,
          updatedAt: 0,
          running: false,
          attached: 3,
          archived: false,
          jobs: 2,
        }),
      }),
      "session",
    );
    expect(busy.rows.map((row) => row.title)).toEqual(["Project", "Devices", "Background"]);
    expect(busy.rows[1]?.value).toBe("This phone + 2 others");
    expect(busy.rows[2]?.value).toBe("2 jobs running");
  });

  test("a session missing from the first list page omits the rows, never '0' (F8)", () => {
    expect(section(facts({ entry: ready(null) }), "session").phase).toBe("empty");
    const listed = section(facts({ entry: ready(null) }), "session");
    expect(listed.rows).toHaveLength(0);
    expect(listed.empty?.title).toBe("Not in the first page");
  });

  test("the session's own last figure wins over the pulled one (a live bar)", () => {
    const live = section(facts({ context: ready({ used: 100_000, exact: false }) }), "model");
    expect(live.rows[1]?.value).toBe("≈ 50 % · 100k of 200k");
  });
});

describe("the MCP section", () => {
  const servers = [
    server({
      name: "strict-legacy",
      tools: ["read", "write", "search"],
      moreTools: 2,
      latencyMs: 4,
    }),
    server({ name: "ghost", state: "failed", error: "spawn /nonexistent ENOENT" }),
    server({ name: "slow", state: "unresponsive", error: "ping timed out after 10000ms" }),
    server({ name: "gone", state: "closed" }),
  ];

  test("one row per server, in daemon order, with its state", () => {
    const mcp = section(facts({ mcp: ready({ servers }) }), "mcp");
    expect(mcp.phase).toBe("ready");
    expect(mcp.rows.map((row) => row.title)).toEqual(["strict-legacy", "ghost", "slow", "gone"]);
    // tools.length + moreTools, never the names alone.
    expect(mcp.rows[0]?.value).toBe("5 tools");
    expect(mcp.rows[0]?.tone).toBe("online");
    expect(mcp.rows[1]?.tone).toBe("attention");
    expect(mcp.rows[1]?.value).toBe("failed");
    expect(mcp.rows[1]?.subtitle).toBe("spawn /nonexistent ENOENT");
    expect(mcp.rows[1]?.glyph).toBe("exclamationmark.triangle");
    expect(mcp.rows[2]?.tone).toBe("attention");
    expect(mcp.rows[3]?.tone).toBe("offline");
    expect(mcp.rows[3]?.value).toBe("closed");
  });

  test("the tool names are the expanded text, never the row's own", () => {
    const mcp = section(facts({ mcp: ready({ servers }) }), "mcp");
    expect(mcp.rows[0]?.expand).toBe("read, write, search, +2 more");
    expect(mcp.rows[0]?.subtitle).toBeUndefined();
  });

  test("the footer counts what connected, and says 'on <computer>' (daemon-wide)", () => {
    const mcp = section(facts({ mcp: ready({ servers }) }), "mcp");
    expect(mcp.title).toBe("MCP servers · on MacBook Pro");
    expect(mcp.footer).toBe("1 of 4 connected");
  });

  test("no servers is an empty section with the config hint", () => {
    const mcp = section(facts({ mcp: ready({ servers: [] }) }), "mcp");
    expect(mcp.phase).toBe("empty");
    expect(mcp.empty?.title).toBe("No MCP servers on MacBook Pro");
    expect(mcp.empty?.footnote).toContain("mcpServers");
  });

  test("each of the four pull states reads differently", () => {
    expect(section(facts({ mcp: loading() }), "mcp").phase).toBe("loading");
    expect(section(facts({ mcp: failed("unsupported") }), "mcp").empty?.title).toBe(
      "Needs a newer tentacle on MacBook Pro",
    );
    expect(section(facts({ mcp: failed("error") }), "mcp").phase).toBe("error");
    expect(section(facts({ mcp: failed("offline") }), "mcp").phase).toBe("offline");
  });
});

describe("the SKILLS section", () => {
  const skill = (
    over: Partial<{
      name: string;
      description: string;
      scope: "project" | "user";
      user: boolean;
      model: boolean;
      location: string;
    }> = {},
  ) => ({
    name: "e2e-demo",
    description: "A demo skill",
    scope: "user" as const,
    user: true,
    model: true,
    location: "/tmp/x/SKILL.md",
    ...over,
  });

  test("a user skill is /name, a project-only one is bare, with its scope chip", () => {
    const skills = section(
      facts({
        skills: ready({
          slash: [],
          skills: [
            skill(),
            skill({ name: "repair", user: false, scope: "project", description: "Fix builds" }),
          ],
          problems: [],
          moreProblems: 0,
        }),
      }),
      "skills",
    );
    expect(skills.rows[0]?.title).toBe("/e2e-demo");
    expect(skills.rows[0]?.chip).toBe("user");
    expect(skills.rows[0]?.subtitle).toBe("A demo skill");
    expect(skills.rows[1]?.title).toBe("repair");
    expect(skills.rows[1]?.chip).toBe("project");
    // The location (a path on the computer) is never shown.
    expect(JSON.stringify(skills)).not.toContain("/tmp/x/SKILL.md");
  });

  test("a skill neither the user nor the model can use now is 'off'", () => {
    const skills = section(
      facts({
        skills: ready({
          slash: [],
          skills: [skill({ user: false, model: false })],
          problems: [],
          moreProblems: 0,
        }),
      }),
      "skills",
    );
    expect(skills.rows[0]?.value).toBe("off");
    expect(skills.rows[0]?.dim).toBe(true);
    expect(skills.rows[0]?.title).toBe("e2e-demo");
  });

  test("100 rows at most, then 'and N more' (F9)", () => {
    const many = Array.from({ length: 130 }, (_unused, index) =>
      skill({ name: `s${index}`, description: `d${index}` }),
    );
    const skills = section(
      facts({ skills: ready({ slash: [], skills: many, problems: [], moreProblems: 0 }) }),
      "skills",
    );
    expect(skills.rows).toHaveLength(100);
    expect(skills.rowsNote).toBe("and 30 more");
  });

  test("skipped skills are a footer pointing at the computer", () => {
    const skills = section(
      facts({
        skills: ready({
          slash: [],
          skills: [skill()],
          problems: ["broken: no frontmatter"],
          moreProblems: 1,
        }),
      }),
      "skills",
    );
    expect(skills.footer).toBe("2 skills skipped — open /skills on the computer for details");
  });

  test("no skills at all is an empty section with the skills-dir hint", () => {
    const skills = section(
      facts({ skills: ready({ slash: [], skills: [], problems: [], moreProblems: 0 }) }),
      "skills",
    );
    expect(skills.phase).toBe("empty");
    expect(skills.empty?.title).toBe("No skills");
    expect(skills.empty?.footnote).toContain(".agents/skills");
  });

  test("a not-attached session is `not-open`, never a fresh session's skills (F4)", () => {
    const skills = section(facts({ phase: "failed", skills: failed("not-open") }), "skills");
    expect(skills.phase).toBe("not-open");
    expect(skills.empty?.title).toBe("Open the session to see its skills");
  });
});

describe("the sheet as a whole", () => {
  test("four sections, in the plan's order, under the session's title", () => {
    const view = sessionInfoView(facts());
    expect(view.sections.map((s) => s.id)).toEqual(["model", "session", "mcp", "skills"]);
    expect(view.subtitle).toBe("Fix the flaky test");
    expect(view.footer).toBe("tentacle 1.4.0 · MacBook Pro");
  });

  test("a versionless daemon still names the computer", () => {
    expect(sessionInfoView(facts({ daemon: { model: "m" } })).footer).toBe("MacBook Pro");
  });

  test("offline: one banner, and every section it dims says so (F1)", () => {
    const view = sessionInfoView(
      facts({ link: "down", mcp: failed("offline"), skills: failed("offline") }),
    );
    expect(view.banner?.kind).toBe("offline");
    expect(view.banner?.text).toContain("Offline");
    expect(view.sections.find((s) => s.id === "mcp")?.phase).toBe("offline");
  });

  test("an already-open session keeps its facts while the link is down (dimmed, not blank)", () => {
    const view = sessionInfoView(
      facts({ link: "down", mcp: ready({ servers: [server({ name: "ghost" })] }) }),
    );
    const mcp = view.sections.find((s) => s.id === "mcp");
    expect(mcp?.phase).toBe("ready");
    expect(mcp?.dim).toBe(true);
  });

  test("the auto-accept switch is offered only when the session has one (Q3)", () => {
    expect(sessionInfoView(facts()).autoAccept).toBe(false);
    expect(sessionInfoView(facts({ autoAccept: true })).autoAccept).toBe(true);
  });

  test("one section failing never takes the others down (F2)", () => {
    const view = sessionInfoView(
      facts({ mcp: failed("unsupported"), skills: failed("error"), context: failed("not-open") }),
    );
    const by = (id: string) => view.sections.find((s) => s.id === id);
    expect(by("model")?.phase).toBe("ready");
    expect(by("session")?.phase).toBe("ready");
    expect(by("mcp")?.phase).toBe("unsupported");
    expect(by("skills")?.phase).toBe("error");
  });
});

describe("MCP/skill switches (docs/feat/session-capabilities.md S5, P1)", () => {
  const on = (over: Partial<CapabilitySwitches> = {}): CapabilitySwitches => ({
    phase: "on",
    state: { disabledMcp: [], disabledSkills: [] },
    changedBy: {},
    error: null,
    ...over,
  });
  const capSkill = (
    over: Partial<{ name: string; user: boolean; model: boolean; modelAfterReset: boolean }> = {},
  ) => ({
    name: "kubernetes",
    description: "Drive a cluster",
    scope: "user" as const,
    user: true,
    model: true,
    location: "/tmp/k/SKILL.md",
    ...over,
  });
  const withCaps = (caps: CapabilitySwitches, skills = [capSkill()]) =>
    facts({
      capabilities: caps,
      mcp: ready({
        servers: [
          server({ name: "k8s", tools: ["get"] }),
          server({ name: "a__b" }),
          server({ name: "broken", state: "failed", error: "spawn ENOENT" }),
        ],
      }),
      skills: ready({ slash: [], skills, problems: [], moreProblems: 0 }),
    });

  test("every server and skill row has a switch, on unless the session turned it off", () => {
    const f = withCaps(on({ state: { disabledMcp: ["a__b"], disabledSkills: [] } }));
    const mcp = section(f, "mcp");
    expect(mcp.rows.map((row) => [row.title, row.switch?.on, row.switch?.interactive])).toEqual([
      ["k8s", true, true],
      ["a__b", false, true],
      ["broken", true, true],
    ]);
    // The op carries the RAW name, the kind of the section.
    expect(mcp.rows[1]?.switch?.name).toBe("a__b");
    expect(mcp.rows[1]?.switch?.kind).toBe("mcp");
    expect(section(f, "skills").rows[0]?.switch).toMatchObject({ kind: "skill", on: true });
  });

  test("an off server says so and is dimmed; its error stays readable", () => {
    const f = withCaps(on({ state: { disabledMcp: ["k8s", "broken"], disabledSkills: [] } }));
    const rows = section(f, "mcp").rows;
    expect(rows[0]?.subtitle).toBe("Off · hidden from the model");
    expect(rows[0]?.dim).toBe(true);
    expect(rows[2]?.subtitle).toBe("Off · hidden from the model — spawn ENOENT");
    expect(rows[1]?.subtitle).toBeUndefined();
    expect(rows[1]?.dim).toBeUndefined();
  });

  test("an off skill: the user can still run /name; a model-only one is just hidden", () => {
    const f = withCaps(on({ state: { disabledMcp: [], disabledSkills: ["kubernetes", "veil"] } }), [
      capSkill(),
      capSkill({ name: "veil", user: false }),
    ]);
    const rows = section(f, "skills").rows;
    expect(rows[0]?.subtitle).toBe("Off · you can still run /kubernetes");
    expect(rows[0]?.dim).toBe(true);
    expect(rows[1]?.subtitle).toBe("Off · hidden from the model");
  });

  test("a skill the model can never be offered is a locked ghost switch, no words (Q5)", () => {
    const f = withCaps(on(), [
      capSkill({ model: false }),
      capSkill({ name: "later", model: false, modelAfterReset: true }),
    ]);
    const rows = section(f, "skills").rows;
    expect(rows[0]?.switch).toMatchObject({ on: false, interactive: false });
    expect(rows[0]?.dim).toBe(true);
    expect(rows[0]?.subtitle).toBe("Drive a cluster");
    expect(rows[0]?.value).toBeUndefined();
    // Offered after the next reset: the session's switch, not locked.
    expect(rows[1]?.switch).toMatchObject({ on: true, interactive: true });
  });

  test("another device's change reads 'changed on <device>', sanitized (Q4)", () => {
    const f = withCaps(
      on({
        state: { disabledMcp: ["k8s"], disabledSkills: [] },
        changedBy: { "mcp:k8s": "Mac‮book", "skill:kubernetes": "" },
      }),
    );
    expect(section(f, "mcp").rows[0]?.subtitle).toBe(
      "Off · hidden from the model · changed on Macbook",
    );
    expect(section(f, "skills").rows[0]?.subtitle).toBe("On · changed on another device");
  });

  test("an older daemon: ghost switches and an update footnote, on both sections (F7)", () => {
    const f = withCaps(on({ phase: "unsupported", state: undefined }));
    const mcp = section(f, "mcp");
    const skills = section(f, "skills");
    expect(mcp.rows.every((row) => row.switch?.interactive === false)).toBe(true);
    expect(skills.rows.every((row) => row.switch?.interactive === false)).toBe(true);
    expect(mcp.switchNote).toBe("The tentacle on MacBook Pro can't turn servers off — update it.");
    expect(skills.switchNote).toBe(
      "The tentacle on MacBook Pro can't turn skills off — update it.",
    );
  });

  test("not open: the daemon-wide servers are listed, their switches are not usable (F4)", () => {
    const f = withCaps(on({ phase: "not-open", state: undefined }));
    const mcp = section(f, "mcp");
    expect(mcp.rows.every((row) => row.switch?.interactive === false)).toBe(true);
    expect(mcp.switchNote).toBe("Open the session to turn servers on or off");
  });

  test("offline: the switches freeze on the last state, with no extra note (the banner says it)", () => {
    const f = withCaps(
      on({ phase: "offline", state: { disabledMcp: ["k8s"], disabledSkills: [] } }),
    );
    const mcp = section(f, "mcp");
    expect(mcp.rows[0]?.switch).toMatchObject({ on: false, interactive: false });
    expect(mcp.switchNote).toBeUndefined();
  });

  test("what Off does is said once: under the servers, or under the skills when none", () => {
    const f = withCaps(on());
    expect(section(f, "mcp").switchNote).toBe(
      "Off hides it from the model in this session, from the next reply.",
    );
    expect(section(f, "skills").switchNote).toBeUndefined();
    const noServers = { ...f, mcp: ready({ servers: [] }) };
    expect(section(noServers, "skills").switchNote).toBe(
      "Off hides it from the model in this session, from the next reply.",
    );
  });

  test("a refused set is shown under ITS section only", () => {
    const f = withCaps(on({ error: { kind: "skill", text: "too many\nnames" } }));
    expect(section(f, "skills").switchNote).toBe("Couldn't switch: too many names");
    expect(section(f, "mcp").switchNote).toBe(
      "Off hides it from the model in this session, from the next reply.",
    );
  });

  test("no switches offered by the port: today's rows, no switch, no note", () => {
    const f = { ...withCaps(on()), capabilities: undefined };
    expect(section(f, "mcp").rows.every((row) => row.switch === undefined)).toBe(true);
    expect(section(f, "mcp").switchNote).toBeUndefined();
  });
});

describe("switchPhase / capabilityChanges (pure)", () => {
  const empty = { disabledMcp: [], disabledSkills: [] };

  test("the phase: not attached, then offline, then the daemon's own report", () => {
    expect(switchPhase({ attached: false, link: "up", state: empty })).toBe("not-open");
    expect(switchPhase({ attached: true, link: "down", state: empty })).toBe("offline");
    expect(switchPhase({ attached: true, link: "up", state: undefined })).toBe("unsupported");
    expect(switchPhase({ attached: true, link: "up", state: empty })).toBe("on");
  });

  test("a snapshot (no by) is never news, and leaves the pending ops alone", () => {
    const pending = [{ kind: "mcp" as const, name: "k8s", enabled: false }];
    const next = { disabledMcp: ["k8s", "x"], disabledSkills: [] };
    expect(capabilityChanges(empty, next, undefined, pending)).toEqual({
      remote: [],
      own: [],
      pending,
    });
  });

  test("my own echo is consumed; everything else in the change is another device's", () => {
    const pending = [{ kind: "mcp" as const, name: "k8s", enabled: false }];
    const prev = { disabledMcp: [], disabledSkills: ["veil"] };
    const next = { disabledMcp: ["k8s"], disabledSkills: [] };
    expect(capabilityChanges(prev, next, "iPhone", pending)).toEqual({
      remote: [{ key: "skill:veil", by: "iPhone" }],
      own: ["mcp:k8s"],
      pending: [],
    });
  });

  test("a pending op for the OPPOSITE value is not an echo (the other device won)", () => {
    const pending = [{ kind: "skill" as const, name: "veil", enabled: false }];
    const next = { disabledMcp: [], disabledSkills: [] };
    const prev = { disabledMcp: [], disabledSkills: ["veil"] };
    const out = capabilityChanges(prev, next, "Mac", pending);
    expect(out.remote).toEqual([{ key: "skill:veil", by: "Mac" }]);
    expect(out.pending).toEqual(pending);
  });

  test("settledOp drops exactly one matching op", () => {
    const op = { kind: "mcp" as const, name: "k8s", enabled: false };
    expect(settledOp([op, op], op)).toEqual([op]);
    expect(settledOp([op], { ...op, enabled: true })).toEqual([op]);
  });
});

describe("the SCHEDULED WAKES section (cron-tool S6, mockup M7)", () => {
  const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
  const wake = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
    id: "sc-1",
    kind: "every",
    spec: "every 10m",
    prompt: "check CI on PR #412",
    nextAt: NOW + 10 * 60_000,
    fires: 4,
    createdAt: NOW - 3_600_000,
    expiresAt: new Date(2026, 10, 22, 14, 20).getTime(),
    ...over,
  });
  const feed = (
    rows: readonly ScheduleRow[] | undefined,
    error: string | null = null,
  ): InfoFacts["schedules"] => ({ rows, error });

  test("a session with no feed at all draws NO section (a port that offers none)", () => {
    const f = facts();
    expect(f.schedules).toBeUndefined();
    expect(sessionInfoView(f).sections.map((s) => s.id)).not.toContain("schedules");
  });

  test("ready: one row per wake, its prompt as the title and its spec/next/fires under it", () => {
    const found = section(facts({ now: NOW, schedules: feed([wake()]) }), "schedules");
    expect(found.phase).toBe("ready");
    expect(found.title).toBe("Scheduled wakes");
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.title).toBe("check CI on PR #412");
    expect(found.rows[0]?.subtitle).toBe("every 10m · next 12:10 · 4×");
    // A sendable delete: a RAW id (the title is sanitized) and its own label.
    expect(found.rows[0]?.delete?.id).toBe("sc-1");
    expect(found.rows[0]?.delete?.accessibilityLabel).toContain("check CI on PR #412");
  });

  test("a one-shot reads as its own day and time, never a fire count", () => {
    const found = section(
      facts({
        now: NOW,
        schedules: feed([wake({ kind: "at", spec: "at 17:00", nextAt: NOW + 3_600_000 })]),
      }),
      "schedules",
    );
    expect(found.rows[0]?.subtitle).toBe("today 13:00 · one-shot");
  });

  test("empty: a reported, empty table says so — with a hint, never a fake row", () => {
    const found = section(facts({ now: NOW, schedules: feed([]) }), "schedules");
    expect(found.phase).toBe("empty");
    expect(found.rows).toEqual([]);
    expect(found.empty?.title).toBe("No scheduled wakes");
    expect(found.empty?.footnote).toBeTruthy();
  });

  test("unsupported: an older daemon reports NO table (undefined ≠ [])", () => {
    const found = section(facts({ now: NOW, schedules: feed(undefined) }), "schedules");
    expect(found.phase).toBe("unsupported");
    expect(found.rows).toEqual([]);
    // The sheet's own words for an older daemon, naming the computer.
    expect(found.empty?.title).toContain("MacBook Pro");
  });

  test("not-open: an unattached session never shows a fresh session's wakes (F4)", () => {
    const found = section(
      facts({ phase: "failed", now: NOW, schedules: feed([wake()]) }),
      "schedules",
    );
    expect(found.phase).toBe("not-open");
    expect(found.rows).toEqual([]);
  });

  test("offline: the known rows STAY (dim), they just stop being followed; no delete is offered", () => {
    const found = section(
      facts({ link: "down", now: NOW, schedules: feed([wake()]) }),
      "schedules",
    );
    expect(found.phase).toBe("ready");
    expect(found.dim).toBe(true);
    expect(found.rows).toHaveLength(1);
    // A control that cannot send is worse than no control (the ghost-switch rule).
    expect(found.rows[0]?.delete).toBeUndefined();
  });

  test("a refused delete is a FOOTER, never a section failure: the rows stay", () => {
    const found = section(
      facts({ now: NOW, schedules: feed([wake()], "this daemon cannot delete a scheduled wake") }),
      "schedules",
    );
    expect(found.phase).toBe("ready");
    expect(found.footer).toBe("this daemon cannot delete a scheduled wake");
    expect(found.rows).toHaveLength(1);
  });

  test("every daemon string is sanitized before it is drawn", () => {
    const found = section(
      facts({
        now: NOW,
        schedules: feed([
          wake({ id: "sc\n1", prompt: "a\u001b[2J\u202eb", spec: "every\u009b31m10m" }),
        ]),
      }),
      "schedules",
    );
    const row = found.rows[0];
    for (const text of [row?.title ?? "", row?.subtitle ?? ""]) {
      expect(CONTROL.test(text)).toBe(false);
      expect(FORMAT.test(text)).toBe(false);
    }
    // The id is sent raw, but never longer than the wire allows (the client bounded it).
    expect(row?.delete?.id).toBe("sc\n1");
  });

  test("two wakes with the SAME prompt carry distinct row keys (S6 fix round 1)", () => {
    // Nothing in core stops two wakes sharing a prompt: `check CI` every 10m and a
    // one-shot `check CI` at 17:00. The TITLE is therefore no identity — a React
    // key, the expansion state or a Maestro testID built from it collides.
    const found = section(
      facts({
        now: NOW,
        schedules: feed([
          wake({ id: "sc-1", prompt: "check CI" }),
          wake({ id: "sc-2", kind: "at", spec: "at 17:00", prompt: "check CI" }),
        ]),
      }),
      "schedules",
    );
    expect(found.rows.map((row) => row.title)).toEqual(["check CI", "check CI"]);
    // The RAW id is the identity, and it survives a title collision.
    expect(found.rows.map((row) => row.key)).toEqual(["sc-1", "sc-2"]);
  });

  test("`rowIdentity` is what makes a keyed row distinct — the key WINS over the title", () => {
    // The ONE place `key` takes priority over `title` (S6 Review round 2's
    // MEDIUM): the sheet builds its React key, its expansion state and every
    // testID from `rowIdentity`, so a regression to `row.title` there would
    // re-collapse two same-prompt wakes with the whole suite green.
    expect(rowIdentity({ title: "check CI", key: "sc-2" })).toBe("sc-2");
    // A row with no key (every non-schedule row) still has an identity: its title.
    expect(rowIdentity({ title: "Project" })).toBe("Project");
    // And it survives the real section: two same-prompt rows stay distinct.
    const found = section(
      facts({
        now: NOW,
        schedules: feed([
          wake({ id: "sc-1", prompt: "check CI" }),
          wake({ id: "sc-2", kind: "at", spec: "at 17:00", prompt: "check CI" }),
        ]),
      }),
      "schedules",
    );
    expect(found.rows.map((row) => row.title)).toEqual(["check CI", "check CI"]);
    const identities = found.rows.map((row) => rowIdentity(row));
    expect(identities).toEqual(["sc-1", "sc-2"]);
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("a repeated (or unpaintable) id still yields UNIQUE, paint-safe keys", () => {
    // Two ids that sanitize to the same label are one identity to React, and an
    // id the phone must never paint (a newline) cannot ride into a testID raw.
    const found = section(
      facts({
        now: NOW,
        schedules: feed([
          wake({ id: "sc\n1", prompt: "a" }),
          wake({ id: "sc 1", prompt: "b" }),
          wake({ id: "\u0001", prompt: "c" }),
        ]),
      }),
      "schedules",
    );
    const keys = found.rows.map((row) => row.key ?? "");
    expect(keys).toEqual(["sc 1", "sc 1#2", "wake"]);
    for (const key of keys) {
      expect(CONTROL.test(key)).toBe(false);
      expect(FORMAT.test(key)).toBe(false);
    }
  });
});
