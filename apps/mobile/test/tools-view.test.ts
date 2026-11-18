/**
 * The Tools sheet's view-model (docs/feat/mobile-hub-tools.md D2): the segments,
 * the bands, the reuse of Session info's own words, the accordion, the search,
 * and the two figures the hub item reads.
 *
 * Two properties are load-bearing and easy to get wrong, so they are asserted
 * directly: the sheet NEVER disagrees with Session info about the same server
 * (the words and switches come from its builders), and the search covers the
 * FULL lists (Session info caps its skill rows at 100; this sheet may not).
 */
import { describe, expect, test } from "bun:test";
import type {
  McpServerStatus,
  SessionCapabilitiesWire,
  SessionSkillsResult,
  SkillListEntry,
} from "@tentacle/protocol";
import type { CapabilitySwitches } from "../src/session-info.ts";
import {
  type ToolsFacts,
  type ToolsUi,
  toolsRim,
  toolsSummary,
  toolsView,
} from "../src/tools-view.ts";

const NOTHING: SessionSkillsResult = { slash: [], skills: [], problems: [], moreProblems: 0 };

function skill(name: string, over: Partial<SkillListEntry> = {}): SkillListEntry {
  return {
    name,
    description: `${name} does things`,
    scope: "project",
    user: true,
    model: true,
    location: `/srv/app/.agents/skills/${name}/SKILL.md`,
    ...over,
  };
}

function server(name: string, over: Partial<McpServerStatus> = {}): McpServerStatus {
  return { name, state: "connected", tools: ["read_file"], moreTools: 0, ...over };
}

const CAPS: SessionCapabilitiesWire = { disabledMcp: [], disabledSkills: [] };

function facts(over: Partial<ToolsFacts> = {}): ToolsFacts {
  return {
    phase: "open",
    link: "up",
    computerName: "MacBook Pro",
    mcp: { state: "ready", value: { servers: [server("fs")] } },
    skills: { state: "ready", value: { ...NOTHING, skills: [skill("deploy")] } },
    capabilities: { phase: "on", state: CAPS, changedBy: {}, error: null },
    ...over,
  };
}

const ui = (over: Partial<ToolsUi> = {}): ToolsUi => ({
  segment: "mcp",
  query: "",
  open: new Set<string>(),
  ...over,
});

const band = (view: ReturnType<typeof toolsView>, key: string) =>
  view.bands.find((row) => row.key === key);

describe("the segments' phases come from Session info's own sections", () => {
  test("loading, ready, empty, error, unsupported, offline and not-open all read right", () => {
    const loading = toolsView(facts({ mcp: { state: "loading" } }), ui());
    expect(loading.segments[0]?.phase).toBe("loading");
    expect(loading.segments[0]?.count).toBeNull();

    const ready = toolsView(facts(), ui());
    expect(ready.segments[0]?.phase).toBe("ready");
    expect(ready.segments[0]?.count).toBe(1);
    expect(ready.segments[1]?.label).toBe("Skills");
    expect(ready.segments[1]?.count).toBe(1);

    const empty = toolsView(facts({ mcp: { state: "ready", value: { servers: [] } } }), ui());
    expect(empty.segments[0]?.phase).toBe("empty");
    expect(empty.segments[0]?.empty?.title).toBe("No MCP servers on MacBook Pro");
    expect(empty.segments[0]?.count).toBe(0);

    const failed = toolsView(facts({ mcp: { state: "error", kind: "error" } }), ui());
    expect(failed.segments[0]?.phase).toBe("error");
    expect(failed.segments[0]?.empty).toEqual({
      title: "Couldn't load MCP servers",
      footnote: "Tap to try again",
    });
    expect(failed.segments[0]?.retry).toBe(true);

    const old = toolsView(facts({ mcp: { state: "error", kind: "unsupported" } }), ui());
    expect(old.segments[0]?.empty?.title).toBe("Needs a newer tentacle on MacBook Pro");

    const down = toolsView(facts({ skills: { state: "error", kind: "offline" } }), ui());
    expect(down.segments[1]?.phase).toBe("offline");

    const closed = toolsView(
      facts({ skills: { state: "error", kind: "not-open" }, phase: "failed" }),
      ui({ segment: "skill" }),
    );
    expect(closed.segments[1]?.empty?.title).toBe("Open the session to see its skills");
  });
});

describe("the bands are keyed by capabilityKey, with sanitized titles", () => {
  test("a server's name and a skill's go through the sheet's sanitizer", () => {
    const view = toolsView(
      facts({
        mcp: { state: "ready", value: { servers: [server("fs\u202e")] } },
        skills: { state: "ready", value: { ...NOTHING, skills: [skill("deploy")] } },
      }),
      ui(),
    );
    // The key is the RAW name (the daemon's own); the title is the painted one.
    expect(view.bands[0]?.key).toBe("mcp:fs\u202e");
    expect(view.bands[0]?.title).toBe("fs");

    const skills = toolsView(
      facts({
        skills: {
          state: "ready",
          value: { ...NOTHING, skills: [skill("deploy", { description: "a\u202eb" })] },
        },
      }),
      ui({ segment: "skill" }),
    );
    expect(skills.bands[0]?.key).toBe("skill:deploy");
    expect(skills.bands[0]?.title).toBe("/deploy");
    expect(skills.bands[0]?.subtitle).toBe("ab");
  });

  test("a skill's band covers every skill, with no 100-row cap (Session info's cap)", () => {
    const many = Array.from({ length: 150 }, (_, i) => skill(`s${String(i + 1)}`));
    const view = toolsView(
      facts({ skills: { state: "ready", value: { ...NOTHING, skills: many } } }),
      ui({ segment: "skill" }),
    );
    expect(view.bands).toHaveLength(150);
    expect(band(view, "skill:s150")?.title).toBe("/s150");
  });
});

describe("the switches are Session info's own (one source, two projections)", () => {
  test("a server switched off dims its band and its tools", () => {
    const view = toolsView(
      facts({
        capabilities: {
          phase: "on",
          state: { disabledMcp: ["fs"], disabledSkills: [] },
          changedBy: {},
          error: null,
        },
      }),
      ui(),
    );
    expect(view.bands[0]?.switch?.on).toBe(false);
    expect(view.bands[0]?.switch?.interactive).toBe(true);
    expect(view.bands[0]?.dim).toBe(true);
    expect(view.bands[0]?.toolsDim).toBe(true);
    expect(view.bands[0]?.subtitle).toContain("Off · hidden from the model");
  });

  test("another device's flip is named in the subtitle (the Q4 machinery)", () => {
    const view = toolsView(
      facts({
        capabilities: {
          phase: "on",
          state: { disabledMcp: ["fs"], disabledSkills: [] },
          changedBy: { "mcp:fs": "Bens iPhone" },
          error: null,
        },
      }),
      ui(),
    );
    expect(view.bands[0]?.subtitle).toContain("changed on Bens iPhone");
  });

  test("a locked skill is a ghost switch, off, and is not counted by the hub", () => {
    const locked = skill("pinned", { model: false, modelAfterReset: false });
    const view = toolsView(
      facts({ skills: { state: "ready", value: { ...NOTHING, skills: [locked] } } }),
      ui({ segment: "skill" }),
    );
    expect(view.bands[0]?.switch?.on).toBe(false);
    expect(view.bands[0]?.switch?.interactive).toBe(false);
    expect(
      toolsSummary(facts({ skills: { state: "ready", value: { ...NOTHING, skills: [locked] } } })),
    ).toEqual({ known: true, total: 1, on: 1 });
  });

  test("a switch that cannot send is not interactive, with the reason underneath", () => {
    for (const phase of ["not-open", "unsupported", "offline"] as const) {
      const view = toolsView(
        facts({ capabilities: { phase, state: CAPS, changedBy: {}, error: null } }),
        ui(),
      );
      expect(view.bands[0]?.switch?.interactive).toBe(false);
    }
    const closed = toolsView(
      facts({ capabilities: { phase: "not-open", state: CAPS, changedBy: {}, error: null } }),
      ui(),
    );
    expect(closed.note).toBe("Open the session to turn servers on or off");

    const old = toolsView(
      facts({
        capabilities: { phase: "unsupported", state: undefined, changedBy: {}, error: null },
      }),
      ui(),
    );
    expect(old.note).toBe("The tentacle on MacBook Pro can't turn servers off — update it.");

    const up = toolsView(facts(), ui());
    expect(up.note).toBe("Off hides it from the model in this session, from the next reply.");
  });

  test("a refused set is said in its OWN segment only", () => {
    const refused = {
      phase: "on",
      state: CAPS,
      changedBy: {},
      error: { kind: "skill" as const, text: "not allowed" },
    } satisfies CapabilitySwitches;
    expect(toolsView(facts({ capabilities: refused }), ui()).note).not.toContain("Couldn't switch");
    expect(toolsView(facts({ capabilities: refused }), ui({ segment: "skill" })).note).toBe(
      "Couldn't switch: not allowed",
    );
  });

  test("a port with no switches at all draws no switch on a band", () => {
    const view = toolsView(facts({ capabilities: undefined }), ui());
    expect(view.bands[0]?.switch).toBeUndefined();
    expect(view.note).toBeUndefined();
  });

  test("the link down dims every band, even one still on", () => {
    expect(toolsView(facts({ link: "down" }), ui()).bands[0]?.dim).toBe(true);
  });
});

describe("the accordion", () => {
  test("collapsed by default, expanded iff its key is in `open`", () => {
    const closed = toolsView(facts(), ui());
    expect(closed.bands[0]?.expanded).toBe(false);
    expect(closed.bands[0]?.tools).toEqual({ names: ["read_file"], more: 0 });

    const opened = toolsView(facts(), ui({ open: new Set(["mcp:fs"]) }));
    expect(opened.bands[0]?.expanded).toBe(true);
  });

  test("a server with no tools has no accordion; a disconnected one neither", () => {
    const none = toolsView(
      facts({ mcp: { state: "ready", value: { servers: [server("fs", { tools: [] })] } } }),
      ui(),
    );
    expect(none.bands[0]?.tools).toBeNull();
    expect(none.bands[0]?.expanded).toBe(false);

    const broken = toolsView(
      facts({
        mcp: {
          state: "ready",
          value: { servers: [server("fs", { state: "failed", error: "boom" })] },
        },
      }),
      ui(),
    );
    expect(broken.bands[0]?.tools).toBeNull();
    expect(broken.bands[0]?.subtitle).toContain("boom");
  });

  test("tools the daemon only counted are carried as +N more", () => {
    const view = toolsView(
      facts({
        mcp: {
          state: "ready",
          value: { servers: [server("fs", { tools: ["read_file"], moreTools: 3 })] },
        },
      }),
      ui(),
    );
    expect(view.bands[0]?.tools).toEqual({ names: ["read_file"], more: 3 });
  });
});

describe("the search", () => {
  test("an empty query shows everything, with the counts unchanged", () => {
    const view = toolsView(facts(), ui({ query: "   " }));
    expect(view.bands).toHaveLength(1);
    expect(view.noMatches).toBe(false);
  });

  test("a tool name matches its server and force-expands it", () => {
    const view = toolsView(
      facts({
        mcp: {
          state: "ready",
          value: { servers: [server("fs", { tools: ["read_file", "write_file"] }), server("db")] },
        },
      }),
      ui({ query: "WRITE_FILE" }),
    );
    expect(view.bands.map((row) => row.key)).toEqual(["mcp:fs"]);
    expect(view.bands[0]?.expanded).toBe(true);
  });

  test("a server name matches case-insensitively, and a skill too", () => {
    const servers = toolsView(
      facts({ mcp: { state: "ready", value: { servers: [server("fs"), server("db")] } } }),
      ui({ query: "FS" }),
    );
    expect(servers.bands.map((row) => row.key)).toEqual(["mcp:fs"]);
    expect(servers.bands[0]?.expanded).toBe(false);

    const skills = toolsView(
      facts({
        skills: { state: "ready", value: { ...NOTHING, skills: [skill("deploy"), skill("test")] } },
      }),
      ui({ segment: "skill", query: "DEPL" }),
    );
    expect(skills.bands.map((row) => row.key)).toEqual(["skill:deploy"]);
  });

  test("the 150th skill is found (no 100-row cap on the search)", () => {
    const many = Array.from({ length: 150 }, (_, i) => skill(`s${String(i + 1)}`));
    const view = toolsView(
      facts({ skills: { state: "ready", value: { ...NOTHING, skills: many } } }),
      ui({ segment: "skill", query: "s150" }),
    );
    expect(view.bands.map((row) => row.key)).toEqual(["skill:s150"]);
  });

  test("no hits says so, and only on a loaded segment", () => {
    expect(toolsView(facts(), ui({ query: "zzz" })).noMatches).toBe(true);
    expect(toolsView(facts({ mcp: { state: "loading" } }), ui({ query: "zzz" })).noMatches).toBe(
      false,
    );
  });
});

describe("the hub's own figures", () => {
  test("known requires BOTH pulls: one still loading is unknown, never empty", () => {
    expect(toolsSummary(facts({ mcp: { state: "loading" } })).known).toBe(false);
    expect(toolsSummary(facts({ skills: { state: "error", kind: "offline" } })).known).toBe(false);
    expect(
      toolsSummary(
        facts({
          mcp: { state: "ready", value: { servers: [] } },
          skills: { state: "ready", value: NOTHING },
        }),
      ),
    ).toEqual({ known: true, total: 0, on: 0 });
  });

  test("total counts servers and toggleable skills; on counts what the model sees", () => {
    const both = facts({
      mcp: { state: "ready", value: { servers: [server("fs"), server("db")] } },
      skills: {
        state: "ready",
        value: {
          ...NOTHING,
          skills: [
            skill("deploy"),
            skill("test"),
            skill("pinned", { model: false, modelAfterReset: false }),
          ],
        },
      },
      capabilities: {
        phase: "on",
        state: { disabledMcp: ["db"], disabledSkills: ["test"] },
        changedBy: {},
        error: null,
      },
    });
    expect(toolsSummary(both)).toEqual({ known: true, total: 4, on: 2 });
  });

  test("the arc is the share switched OFF, and absent while everything is on", () => {
    expect(toolsRim({ known: true, total: 4, on: 4 })).toBeNull();
    expect(toolsRim({ known: true, total: 4, on: 3 })).toBe(0.25);
    expect(toolsRim({ known: true, total: 4, on: 0 })).toBe(1);
    // Nothing to switch is no arc either (that is the dimmed item's own news).
    expect(toolsRim({ known: true, total: 0, on: 0 })).toBeNull();
    expect(toolsRim({ known: false, total: 0, on: 0 })).toBeNull();
  });
});
