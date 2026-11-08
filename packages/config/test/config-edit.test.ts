import { describe, expect, test } from "bun:test";
import {
  type EditOp,
  applyEdit,
  formattingOf,
  parseConfigText,
  planConfigEdit,
  readPath,
  sameValue,
  validateFileConfig,
} from "../src/config-edit.ts";

/** A commented file with an odd indent (4 spaces) and a hand-kept key order. */
const FIXTURE = `{
    // my notes, top
    "model": {
        // endpoint
        "model": "qwen3",   // a trailing note
        "baseURL": "http://localhost:8080/v1"
    },
    "subagents": {
        "enabled": true
    },
    // and after
    "maxIterations": 8
}
`;

const set = (value: unknown): EditOp => ({ kind: "set", value });
const del: EditOp = { kind: "delete" };

/** The one region two texts differ in; the shared prefix/suffix are equal bytes. */
function changedRegion(before: string, after: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

/** Plan a set, asserting it succeeded (no `!` assertion, AGENTS §9 style). */
function planned(text: string, segments: readonly string[], op: EditOp): string {
  const result = planConfigEdit({ text, segments, op });
  if (!result.ok) {
    throw new Error(`expected a plan, got: ${result.error} ${(result.details ?? []).join("; ")}`);
  }
  return result.text;
}

describe("T10: the edit changes only the touched node, byte for byte", () => {
  test("a set inserts the node and leaves every other byte alone", () => {
    const out = planned(FIXTURE, ["subagents", "maxParallel"], set(3));
    expect(out).toBe(
      FIXTURE.replace(
        '        "enabled": true\n',
        '        "enabled": true,\n        "maxParallel": 3\n',
      ),
    );
    expect(out).toContain("// a trailing note");
    expect(out).toContain("// my notes, top");
    // The shared prefix is every byte before the insertion point: unchanged.
    const region = changedRegion(FIXTURE, out);
    expect(region.prefix).toBe(FIXTURE.indexOf('"enabled": true') + '"enabled": true'.length);
  });

  test("a set of an existing leaf changes only its literal", () => {
    const out = planned(FIXTURE, ["model", "model"], set("qwen3-coder"));
    expect(out).toBe(FIXTURE.replace('"model": "qwen3",', '"model": "qwen3-coder",'));
    // The change starts inside the old literal, not at the key: only the text moves.
    expect(changedRegion(FIXTURE, out).prefix).toBe(FIXTURE.indexOf('"qwen3"') + 6);
  });

  test("a set then an unset is the original text again (round trip)", () => {
    const added = planned(FIXTURE, ["subagents", "maxParallel"], set(3));
    const removed = planned(added, ["subagents", "maxParallel"], del);
    expect(removed).toBe(FIXTURE);
  });

  test("a new top-level key goes after the last existing one, before the closing brace", () => {
    const out = planned(FIXTURE, ["autoWake"], set(false));
    expect(out).toBe(
      FIXTURE.replace('"maxIterations": 8\n}', '"maxIterations": 8,\n    "autoWake": false\n}'),
    );
  });

  test("a tab-indented file keeps tabs in the inserted node", () => {
    // A jsonc-parser default (2 spaces) would mix tabs and spaces here.
    const tabs = '{\n\t"model": {\n\t\t"model": "a"\n\t}\n}\n';
    const out = planned(tabs, ["maxIterations"], set(20));
    expect(out).toBe('{\n\t"model": {\n\t\t"model": "a"\n\t},\n\t"maxIterations": 20\n}\n');
  });

  test("a CRLF file is edited with CRLF", () => {
    const crlf = '{\r\n  // note\r\n  "maxIterations": 8\r\n}\r\n';
    const out = planned(crlf, ["autoWake"], set(true));
    expect(out).toContain('\r\n  "autoWake": true\r\n');
    expect(out.includes("\n") && !out.includes("\r\n")).toBe(false);
  });

  test("a map entry and a deep profile are created from one leaf", () => {
    const mcp = planned("{}\n", ["mcpServers", "fs", "command"], set("mcp-fs"));
    expect(mcp).toBe(
      '{\n  "mcpServers": {\n    "fs": {\n      "command": "mcp-fs"\n    }\n  }\n}\n',
    );
    const profile = planned("{}\n", ["profiles", "work", "model", "model"], set("x"));
    expect(profile).toContain('"profiles": {');
    expect(profile).toContain('"model": "x"');
  });

  test("a whole section can be set as one JSON value (an object)", () => {
    const out = planned(FIXTURE, ["tools"], set({ execution: "parallel" }));
    expect(out).toContain('"tools": {\n        "execution": "parallel"\n    }');
    expect(out).toContain("// and after");
  });

  test("null is a value (a profile's mcpServers entry is nulled, not deleted)", () => {
    const base =
      '{\n  "profiles": {\n    "work": {\n      "mcpServers": {\n        "fs": {\n          "command": "mcp-fs"\n        }\n      }\n    }\n  }\n}\n';
    const out = planned(base, ["profiles", "work", "mcpServers", "fs"], set(null));
    expect(out).toContain('"fs": null');
  });

  test("unsetting a section's only leaf leaves an empty object (documented)", () => {
    // `modify` deletes the node, never an emptied parent: a `{}` is left, which is
    // valid and harmless (`subagents`' fields are all optional). Pruning it would
    // touch a SECOND node and break T10's "only the touched node changes"
    // property (recorded as debt in the doc).
    const out = planned(FIXTURE, ["subagents", "enabled"], del);
    // One line removed; the emptied `subagents` object stays.
    expect(out).toBe(FIXTURE.replace('        "enabled": true\n', ""));
    expect(out).toContain('"subagents": {\n    },');
    const reparsed = parseConfigText(out);
    expect(reparsed.ok && reparsed.value).toEqual({
      model: { model: "qwen3", baseURL: "http://localhost:8080/v1" },
      subagents: {},
      maxIterations: 8,
    });
  });

  test("an unset that would leave an INVALID empty entry is refused, not written", () => {
    // `mcpServers.fs.command` is required by the stdio branch (`schema.ts:66`), so
    // removing it leaves `{"fs":{}}`, which the WHOLE-file validate refuses — the
    // same rule that protects a cross-field invariant protects this.
    const base = '{\n  "mcpServers": {\n    "fs": {\n      "command": "mcp-fs"\n    }\n  }\n}\n';
    const result = planConfigEdit({
      text: base,
      segments: ["mcpServers", "fs", "command"],
      op: del,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.join(" ")).toContain("mcpServers.fs.command");
  });

  test("LOW-5: unsetting the only key of an object with a trailing comma works", () => {
    // jsonc-parser's `modify` leaves an ORPHAN comma behind (`{ "tui": { , } }`),
    // which does not parse, so the edit was refused with a message that blamed
    // the schema. The repair drops that comma (and only it).
    const text = '{\n  "tui": {\n    "theme": "dark",\n  },\n}\n';
    const out = planned(text, ["tui", "theme"], del);
    // Valid JSONC again, holding `{ tui: {} }` — and nothing outside the node
    // moved (the `,` that made the reference invalid is gone, the outer trailing
    // comma of the FILE is kept as it was).
    const reparsed = parseConfigText(out);
    expect(reparsed.ok && reparsed.value).toEqual({ tui: {} });
    expect(out.startsWith('{\n  "tui": {')).toBe(true);
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).not.toContain("{,");
    // The non-trailing-comma file is unchanged behaviour.
    expect(planned('{\n  "tui": {\n    "theme": "dark",\n  }\n}\n', ["tui", "theme"], del)).toBe(
      '{\n  "tui": {\n  }\n}\n',
    );
    // A trailing comma before a SIBLING is a legit trailing comma: kept, and the
    // unset of either member still works.
    const siblings = '{\n  "subagents": {\n    "enabled": true,\n    "maxParallel": 3,\n  },\n}\n';
    const one = planned(siblings, ["subagents", "enabled"], del);
    expect(one).toBe('{\n  "subagents": {\n    "maxParallel": 3,\n  },\n}\n');
    const last = planned(siblings, ["subagents", "maxParallel"], del);
    expect(last).toBe('{\n  "subagents": {\n    "enabled": true,\n  },\n}\n');
    expect(parseConfigText(last).ok).toBe(true);
    // …and removing the second one THEN the first (the emptied-object case again).
    expect(parseConfigText(planned(one, ["subagents", "maxParallel"], del)).ok).toBe(true);
  });

  test("LOW-6: a file with no trailing newline does not gain one", () => {
    // One extra byte outside the touched node is against T10's property.
    const out = planned('{"maxIterations": 5}', ["autoWake"], set(true));
    expect(out).toBe('{\n  "maxIterations": 5,\n  "autoWake": true\n}');
    expect(out.endsWith("\n")).toBe(false);
    // The same for a new key in an unindented multi-line file.
    const multi = '{\n"maxIterations": 5\n}';
    expect(planned(multi, ["autoWake"], set(true)).endsWith("\n")).toBe(false);
  });

  test("a new (empty) file IS written with a trailing newline", () => {
    // The one case the newline is ours: there was no text to copy a style from.
    expect(planned("", ["autoWake"], set(true))).toBe('{\n  "autoWake": true\n}\n');
    expect(planned("  \n", ["autoWake"], set(true)).endsWith("\n")).toBe(true);
  });

  test("MEDIUM-4: a schema message names the path and the expected values, never the value", () => {
    // A value pasted into the wrong slot: zod's `received '…'` tail echoed it.
    for (const [value, path] of [
      [{ tools: { execution: "sk-LEAKECHO" } }, "tools.execution"],
      [{ model: { provider: "sk-LEAKECHO" } }, "model.provider"],
      [{ engine: "sk-LEAKECHO" }, "engine"],
      [{ tui: { theme: "sk-LEAKECHO" } }, "tui.theme"],
    ] as const) {
      const result = validateFileConfig(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const text = `${result.error} ${(result.details ?? []).join(" ")}`;
      expect(text).not.toContain("sk-LEAKECHO");
      expect(text).toContain(path);
    }
    // The expected set survives (that is the point of the message).
    const enumIssue = validateFileConfig({ tools: { execution: "sk-LEAKECHO" } });
    expect(enumIssue.ok).toBe(false);
    if (enumIssue.ok) return;
    const detail = (enumIssue.details ?? []).join(" ");
    expect(detail).toContain("sequential");
    expect(detail).toContain("read-only");
    expect(detail).toContain("parallel");
  });

  test("the formatting is read from the file (spaces, tabs, CRLF)", () => {
    expect(formattingOf('{\n    "a": 1\n}\n')).toEqual({
      insertSpaces: true,
      tabSize: 4,
      eol: "\n",
    });
    expect(formattingOf('{\n\t"a": 1\n}\n')).toEqual({
      insertSpaces: false,
      tabSize: 1,
      eol: "\n",
    });
    expect(formattingOf('{\r\n  "a": 1\r\n}\r\n')).toEqual({
      insertSpaces: true,
      tabSize: 2,
      eol: "\r\n",
    });
    // A one-line file has no indent to copy: two spaces.
    expect(formattingOf("{}")).toEqual({ insertSpaces: true, tabSize: 2, eol: "\n" });
  });
});

describe("T8: refused before anything could be written", () => {
  test("a type error is refused with EVERY schema issue, and no text", () => {
    // Mutation: validate AFTER the edit / skip the validate → the bad value is written.
    const result = planConfigEdit({
      text: FIXTURE,
      segments: ["subagents", "maxParallel"],
      op: set("abc"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Every issue, each naming its path (`load.ts:85` prints only the first).
    expect(result.error).toContain("1 issue");
    expect(result.details?.join(" ")).toContain("subagents.maxParallel");
  });

  test("a cross-field violation is caught on the WHOLE result", () => {
    // `schema.ts:250-257`: agentTaskDescription and …File are one setting.
    const withOne = planned(FIXTURE, ["subagents", "agentTaskDescription"], set("do this"));
    const result = planConfigEdit({
      text: withOne,
      segments: ["subagents", "agentTaskDescriptionFile"],
      op: set("desc.md"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The `superRefine` message lands on the `subagents` path, not on a leaf.
    expect(result.details?.join(" ")).toContain("not both");
  });

  test("a nested key whose parent is not an object is refused", () => {
    const result = planConfigEdit({
      text: '{\n  "maxIterations": 8\n}\n',
      segments: ["maxIterations", "x"],
      op: set(1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("maxIterations is not a JSON object");
  });

  test("every parse error is reported, not only the first", () => {
    const broken = '{\n  "a": ,\n  "b": ,\n}\n';
    const result = planConfigEdit({ text: broken, segments: ["autoWake"], op: set(true) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not valid JSONC");
    expect(result.details?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("a non-object document is refused, not thrown", () => {
    // jsonc-parser's `modify` throws "Can not add index to parent of type
    // number" here; the refusal must be ours, before any edit is computed.
    for (const text of ["5\n", "[]\n", '"x"\n', "null\n"]) {
      const result = planConfigEdit({ text, segments: ["autoWake"], op: set(true) });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("not a JSON object");
    }
  });

  test("an unset of something that is not set is refused", () => {
    const result = planConfigEdit({ text: FIXTURE, segments: ["autoWake"], op: del });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("autoWake is not set");
    const deep = planConfigEdit({ text: FIXTURE, segments: ["model", "apiKey"], op: del });
    expect(deep.ok).toBe(false);
  });

  test("an empty document cannot be unset from (jsonc-parser throws there)", () => {
    const result = planConfigEdit({ text: "", segments: ["autoWake"], op: del });
    expect(result.ok).toBe(false);
  });
});

describe("the plan's own building blocks", () => {
  test("parse: a missing value is an empty object; trailing commas are fine", () => {
    const empty = parseConfigText("");
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value).toEqual({});
    const trailing = parseConfigText('{\n  "maxIterations": 8,\n}\n');
    expect(trailing.ok).toBe(true);
  });

  test("validate: all issues, with their paths", () => {
    const result = validateFileConfig({ maxIterations: 0, model: { provider: "x" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.some((line) => line.startsWith("model.provider"))).toBe(true);
    expect(result.details?.some((line) => line.startsWith("maxIterations"))).toBe(true);
  });

  test("applyEdit never mutates its input", () => {
    const before = { model: { model: "a" } };
    const applied = applyEdit(before, ["model", "model"], set("b"));
    expect(before).toEqual({ model: { model: "a" } });
    expect(applied.ok && applied.value).toEqual({ model: { model: "b" } });
  });

  test("readPath: found/absent, and an object is a value", () => {
    const doc = { a: { b: [1, 2] } };
    expect(readPath(doc, ["a", "b"])).toEqual({ found: true, value: [1, 2] });
    expect(readPath(doc, ["a", "c"])).toEqual({ found: false });
    expect(readPath(doc, ["a", "b", "0"])).toEqual({ found: false });
  });

  test("sameValue ignores key order but not a value", () => {
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  test("the text plan and the validated value agree (the load-bearing check)", () => {
    const result = planConfigEdit({
      text: FIXTURE,
      segments: ["tools"],
      op: set({ execution: "parallel" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reparsed = parseConfigText(result.text);
    expect(reparsed.ok && sameValue(reparsed.value, result.value)).toBe(true);
    expect(result.config.tools?.execution).toBe("parallel");
  });
});
