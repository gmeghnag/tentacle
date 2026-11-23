import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../packages/protocol/src/index.ts";

/**
 * A hand-written protocol version in a test is harmful in exactly one case: it
 * EQUALS the live `PROTOCOL_VERSION` (docs/fix/protocol-bump-pin.md). Then it is
 * green on every branch and red right after the next bump, at the merge, in
 * files the bump's author never opened — the 23/11 `24` case. Every other
 * literal is a deliberate fake (`protocolVersion: 1`, a `22` older daemon, `-1`
 * as invalid input) that never moves; a fake that differs and is compared with a
 * real peer is red today, so the gate already catches it.
 */
const ROOT = join(import.meta.dir, "..", "..");

/**
 * Files allowed to spell the version out, by exact repo-relative path.
 * `version.test.ts` holds THE pin (the bump rewrites it: `applyPin`), and
 * `protocol-bump.test.ts` holds a fake `version.ts`/pin fixture that is never
 * compared with the real number. The guard file itself is NOT listed: its own
 * fixtures are `${PROTOCOL_VERSION}` templates, so its source holds no literal.
 */
const ALLOWED = new Map([
  ["packages/protocol/test/version.test.ts", "THE pin: bun run protocol:bump rewrites it"],
  ["scripts/test/protocol-bump.test.ts", "fixtures of a fake version.ts and a fake pin"],
]);

/** One hit: the 1-based line of the match start and its text, normalized. */
interface VersionLiteral {
  readonly line: number;
  readonly match: string;
}

/**
 * The two shapes that count, both anchored on the version CONTEXT, so an
 * unrelated `expect(count).toBe(<n>)` is not a hit:
 * 1. a key form — `protocolVersion: <n>`, `protocol: <n>`,
 *    `x-protocol-version: "<n>"` (quoted or not);
 * 2. an assertion on a version expression — `expect(x.protocolVersion).toBe(<n>)`.
 * `\s*` spans newlines: Biome wraps a long assertion as `.toBe(\n 24,\n)`, which
 * is how one of the 23/11 literals was written. A `toBeGreaterThanOrEqual(<n>)`
 * floor is by design (AGENTS §7) and is not matched — `toBe` must be followed by
 * `(`.
 */
function findVersionLiterals(text: string, version: number): VersionLiteral[] {
  const patterns = [
    new RegExp(
      `"?\\b(?:protocolVersion|protocol|PROTOCOL_VERSION|x-protocol-version)"?\\s*:\\s*"?${version}\\b`,
      "g",
    ),
    new RegExp(
      `\\b(?:protocolVersion|PROTOCOL_VERSION)\\s*\\)\\s*\\.to(?:Be|Equal|StrictEqual)\\(\\s*${version}\\b`,
      "g",
    ),
  ];
  const found: { index: number; match: string }[] = [];
  for (const pattern of patterns) {
    for (const hit of text.matchAll(pattern)) {
      found.push({ index: hit.index, match: hit[0] });
    }
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, match }) => ({
      line: text.slice(0, index).split("\n").length,
      match: match.replace(/\s+/g, " "),
    }));
}

/** Every test file the scan covers, repo-relative and sorted. */
function testFiles(root: string): string[] {
  const glob = new Bun.Glob("{packages,apps}/*/test/**/*.{ts,tsx}");
  const scripts = new Bun.Glob("scripts/test/**/*.ts");
  const all = [...glob.scanSync({ cwd: root }), ...scripts.scanSync({ cwd: root })].filter(
    (path) => !path.includes("node_modules/"),
  );
  return all.sort();
}

/** The offending literals across the tree, formatted for the failure message. */
function scanVersionLiterals(root: string, version: number): string[] {
  return testFiles(root).flatMap((path) =>
    ALLOWED.has(path)
      ? []
      : findVersionLiterals(readFileSync(join(root, path), "utf8"), version).map(
          (hit) => `${path}:${hit.line}  ${hit.match}`,
        ),
  );
}

describe("no test hand-writes the live protocol version", () => {
  test("every test that names the version imports PROTOCOL_VERSION (repo guard)", () => {
    expect(scanVersionLiterals(ROOT, PROTOCOL_VERSION)).toEqual([]);
  });

  test("the scan is not silently empty (non-vacuity)", () => {
    const files = testFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("packages/daemon/test/relay-link.test.ts");
    expect(files).toContain("scripts/test/protocol-bump.test.ts");
    // The allowlist is exact-path, so a rename shows up as a hit, not a silent pass.
    for (const path of ALLOWED.keys()) {
      expect(files).toContain(path);
    }
  });

  test("the historic literals are caught (mutation, built from the live number)", () => {
    const V = PROTOCOL_VERSION;
    const red = [
      `const init = { protocolVersion: ${V}, methods: [] };`,
      `expect(init.protocolVersion).toBe(${V});`,
      `expect(\n  request.result.protocolVersion).toBe(\n        ${V},\n      );`,
      `const meta = { protocol: ${V}, tentacle: "x" };`,
      `const frame = { "protocolVersion": ${V} };`,
      `expect(client.protocolVersion).toEqual(${V});`,
      `const headers = { "x-protocol-version": "${V}" };`,
    ];
    for (const text of red) {
      expect(findVersionLiterals(text, V).length).toBeGreaterThan(0);
    }
    // The line number is the match start, so the failure names the line to edit.
    expect(findVersionLiterals(`a\nb\nconst x = { protocolVersion: ${V} };\n`, V)).toEqual([
      { line: 3, match: `protocolVersion: ${V}` },
    ]);
  });

  test("a legitimate fake or a floor is not a hit (no false positives)", () => {
    const V = PROTOCOL_VERSION;
    const clean = [
      "const init = { protocolVersion: 1, methods: [] };",
      `const init = { protocolVersion: ${V + 1}, methods: [] };`,
      `const init = { protocolVersion: ${V}0, methods: [] };`,
      `expect(init.protocolVersion).toBeGreaterThanOrEqual(${V});`,
      `expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(${V});`,
      `expect(count).toBe(${V});`,
      "const init = { protocolVersion: PROTOCOL_VERSION };",
      'const caps = { protocolVersion: "2025-06-18" };',
    ];
    for (const text of clean) {
      expect(findVersionLiterals(text, V)).toEqual([]);
    }
  });
});
