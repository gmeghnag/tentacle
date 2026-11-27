/** `/model`'s pure rules (docs/feat/model-switch.md T5). */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, JsonRpcErrorCode } from "../../protocol/src/jsonrpc.ts";
import {
  MODEL_USAGE,
  modelListLines,
  modelSwitchFailedNotice,
  parseModelArg,
  switchedNotice,
  viewModel,
} from "../src/model-switch.ts";

const RESULT = {
  start: { model: "main-id", contextWindow: 111_000 },
  entries: [
    { name: "haiku", model: "haiku-id", contextWindow: 22_000 },
    { name: "qwen", model: "qwen-id", contextWindow: 32_000 },
  ],
  active: "haiku",
};

const coded = (code: number, message: string) => Object.assign(new Error(message), { code });

describe("parseModelArg", () => {
  test("nothing lists; a word selects; default is the start model", () => {
    expect(parseModelArg("/model")).toEqual({ list: true });
    expect(parseModelArg("  /model   ")).toEqual({ list: true });
    expect(parseModelArg("/model haiku")).toEqual({ name: "haiku" });
    expect(parseModelArg("/model   qwen-local ")).toEqual({ name: "qwen-local" });
    expect(parseModelArg("/model default")).toEqual({ name: null });
  });

  test("two words are the usage", () => {
    expect(parseModelArg("/model haiku now")).toEqual({ usage: MODEL_USAGE });
    expect(MODEL_USAGE).toContain("/model <name>");
    expect(MODEL_USAGE).toContain("/model default");
  });
});

describe("modelListLines", () => {
  const rows = (result: typeof RESULT | (Omit<typeof RESULT, "active"> & { active: null })) =>
    modelListLines(result).filter((line) => line.startsWith("- "));

  test("the start model then each entry; the active one is marked in TEXT", () => {
    expect(rows(RESULT)).toEqual([
      "- `default` — main-id (111k)",
      "- `haiku` — haiku-id (22k) ← active",
      "- `qwen` — qwen-id (32k)",
    ]);
  });

  test("no selection marks default", () => {
    expect(rows({ ...RESULT, active: null })[0]).toBe("- `default` — main-id (111k) ← active");
  });

  test("an entry named default is not selectable, so it is not a row", () => {
    const lines = rows({
      ...RESULT,
      entries: [{ name: "default", model: "other", contextWindow: 1000 }],
    });
    expect(lines).toEqual(["- `default` — main-id (111k)"]);
  });

  test("no entries says how to add one", () => {
    const text = modelListLines({ ...RESULT, entries: [], active: null as never }).join("\n");
    expect(text).toContain("`models.<name>`");
    expect(text).toContain("config.jsonc");
  });
});

describe("switchedNotice", () => {
  const next = { active: "haiku", model: "haiku-id", contextWindow: 22_000 };

  test("old → new, for this session", () => {
    expect(switchedNotice("main-id", next)).toBe(
      "Model: `main-id` → `haiku-id` (for this session)",
    );
    expect(switchedNotice("main-id", next, 22_000)).not.toContain("/compact");
    expect(switchedNotice("main-id", next, null)).not.toContain("/compact");
  });

  test("a context past the new window says to compact first", () => {
    expect(switchedNotice("main-id", next, 50_000)).toContain(
      "context ~50k exceeds haiku-id's window 22k: /compact first",
    );
  });
});

describe("modelSwitchFailedNotice", () => {
  test("a running turn or compaction says when to retry", () => {
    expect(modelSwitchFailedNotice(coded(DomainErrorCode.TurnInProgress, "x"))).toBe(
      "_Model not switched: a turn is running — switch the model after it ends (Esc stops it)_",
    );
    expect(modelSwitchFailedNotice(coded(DomainErrorCode.CompactInProgress, "x"))).toBe(
      "_Model not switched: a compaction is running — switch the model after it ends_",
    );
  });

  test("everything else shows the daemon's own words, on one line", () => {
    for (const code of [
      JsonRpcErrorCode.MethodNotFound,
      JsonRpcErrorCode.InvalidParams,
      JsonRpcErrorCode.InvalidRequest,
    ]) {
      expect(modelSwitchFailedNotice(coded(code, "no\nsuch thing"))).toBe(
        "_Model not switched: no such thing_",
      );
    }
    expect(modelSwitchFailedNotice("plain")).toBe("_Model not switched: plain_");
  });
});

describe("viewModel", () => {
  const startup = { label: "main-id", contextWindow: 111_000 };
  const session = {};
  const switched = { session, label: "haiku-id", contextWindow: 22_000 };

  test("the switched figures while the view is on that session", () => {
    expect(viewModel(startup, switched, session)).toEqual({
      label: "haiku-id",
      contextWindow: 22_000,
    });
  });

  test("another session, none, or no switch: the startup ones", () => {
    expect(viewModel(startup, switched, {})).toEqual(startup);
    expect(viewModel(startup, switched, null)).toEqual(startup);
    expect(viewModel(startup, null, session)).toEqual(startup);
  });
});
