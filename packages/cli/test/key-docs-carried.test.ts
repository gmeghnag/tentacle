import { describe, expect, test } from "bun:test";
import { KEY_DOCS, type KeyDoc, keyDoc } from "@tentacle/config";
import { CARRIED } from "../src/carried-settings.ts";
import { ARGS } from "../src/flags.ts";

/** The base entries only: a `profiles.*.x` mirror repeats its base's facts. */
const baseEntries = (): [string, KeyDoc][] =>
  Object.entries(KEY_DOCS).filter(([path]) => !path.startsWith("profiles."));

/** Every flag any command of `ARGS` accepts, without its leading `--`. */
function allFlagNames(): Set<string> {
  const names = new Set<string>();
  // `ARGS` is `as const`, so each command's spec has its own narrow type: read
  // the three flag groups structurally rather than through the union.
  for (const spec of Object.values(ARGS) as readonly {
    readonly values?: Readonly<Record<string, { readonly short?: string }>>;
    readonly bools?: Readonly<Record<string, { readonly short?: string }>>;
    readonly optional?: Readonly<Record<string, unknown>>;
  }[]) {
    for (const group of [spec.values, spec.bools, spec.optional]) {
      for (const name of Object.keys(group ?? {})) {
        names.add(name);
      }
      for (const def of Object.values(group ?? {}) as readonly { readonly short?: string }[]) {
        if (def.short !== undefined) {
          names.add(def.short);
        }
      }
    }
  }
  return names;
}

describe("T5: every documented CLI flag exists", () => {
  test("each `flag` names a real flag of a real command", () => {
    const names = allFlagNames();
    const missing = baseEntries()
      .filter(([, doc]) => doc.flag !== undefined)
      .map(([path, doc]) => {
        const flag = (doc.flag ?? "").replace(/^--?/, "").replace(/[= ].*$/, "");
        return names.has(flag) ? undefined : `${path}: ${doc.flag} is not a flag of any command`;
      })
      .filter((entry): entry is string => entry !== undefined);
    expect(missing).toEqual([]);
  });

  test("the flags that override a config key are the documented ones", () => {
    const documented = baseEntries()
      .filter(([, doc]) => doc.flag !== undefined)
      .map(([, doc]) => doc.flag)
      .sort();
    // `--model`, `--profile` (profile selection), `--engine`, `--rm`. Anything
    // else would be a flag the registry claims and the CLI does not apply.
    expect(documented).toEqual(["--engine", "--model", "--rm"]);
    expect(keyDoc("engine")?.flag).toBe("--engine");
    expect(keyDoc("rm")?.flag).toBe("--rm");
  });
});

describe("T6: CARRIED and the registry's carried set agree", () => {
  const carriedRows = (): [string, "pinned" | "workspace"][] =>
    Object.values(CARRIED).map((row) => [
      row.configKey,
      row.class === "P" ? "pinned" : "workspace",
    ]);

  test("the registry's carried keys equal CARRIED's, both directions", () => {
    const registry = new Map(
      baseEntries()
        .filter(([, doc]) => doc.carried !== "no")
        .map(([path, doc]) => [path, doc.carried] as const),
    );
    const rows = new Map(carriedRows());
    const missing = [...rows.keys()].filter((key) => !registry.has(key));
    const extra = [...registry.keys()].filter((key) => !rows.has(key));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect([...registry.keys()].sort()).toEqual([...rows.keys()].sort());
  });

  test("each key's carried CLASS matches its CARRIED row (P = pinned, W = workspace)", () => {
    const mismatched = carriedRows()
      .filter(([key, cls]) => keyDoc(key)?.carried !== cls)
      .map(([key, cls]) => `${key}: registry ${String(keyDoc(key)?.carried)}, CARRIED ${cls}`);
    expect(mismatched).toEqual([]);
  });

  test("a not-carried key is one CARRIED does not list — the laptop's own", () => {
    for (const path of [
      "tools.writableDirs",
      "tui.theme",
      "autoWake",
      "packages",
      "engine",
      "rm",
    ]) {
      expect(keyDoc(path)?.carried).toBe("no");
      expect(Object.values(CARRIED).some((row) => row.configKey === path)).toBe(false);
    }
  });

  test("CARRIED is not empty, so the comparison above is not vacuous", () => {
    expect(Object.keys(CARRIED).length).toBe(21);
    expect(carriedRows().filter(([, cls]) => cls === "pinned").length).toBeGreaterThan(0);
    expect(carriedRows().filter(([, cls]) => cls === "workspace").length).toBeGreaterThan(0);
  });
});
