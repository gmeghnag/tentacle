/**
 * The pure core of `search`, driven on BOTH engines (docs/feat/explore-search.md,
 * Tests T-S1, T-S2, T-S6-pure, T-S8).
 *
 * The real-run half executes the FALLBACK command for real through `/bin/sh`
 * with a scrubbed `PATH` (no `rg`), and compares its render against the
 * recorded rg transcript (`test/fixtures/search-rg.txt`) — so the suite needs
 * no ripgrep and adds no opt-in skip (AGENTS §6).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPattern } from "../src/search-dialect.ts";
import {
  MAX_BYTES,
  MAX_LINE,
  RAW_CAP,
  buildSearchPlan,
  classifyGitignore,
  parseSearchOutput,
  renderSearchResult,
  shq,
  validateSearchInput,
} from "../src/search.ts";
import { makeSearchFixture, scrubbedPath } from "./search-fixture.ts";

/** The fixture root — a NON-repo temp dir, so no parent `.gitignore` applies. */
const ROOT = mkdtempSync(join(tmpdir(), "search-pure-"));
const FX = join(ROOT, "fx");
const BIN = scrubbedPath(join(ROOT, "bin"));
makeSearchFixture(FX, { expressibleGitignoreOnly: true, withoutBinary: true });

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function runFallback(command: string, cwd = FX) {
  const proc = Bun.spawnSync(["/bin/sh", "-c", command], { cwd, env: { PATH: BIN } });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    stdout: decoder.decode(new Uint8Array(proc.stdout)),
    stderr: decoder.decode(new Uint8Array(proc.stderr)),
    exitCode: proc.exitCode ?? 124,
  };
}

/** One search, end to end, on the FALLBACK — validated, planned, run, parsed, rendered. */
function searchGrep(
  raw: Record<string, unknown>,
  gitignore = classifyGitignore(readFileSync(join(FX, ".gitignore"), "utf8")),
  cwd = FX,
) {
  const validated = validateSearchInput(raw);
  if (!validated.ok) {
    return { refused: validated.refusal.message };
  }
  const built = buildSearchPlan(validated.input, "grep", { gitignore, binaryFilter: false });
  if (!built.ok) {
    return { refused: built.refusal.message };
  }
  const result = runFallback(built.plan.command, cwd);
  const filesWithMatches =
    validated.input.output_mode === "files" && validated.input.pattern !== undefined;
  const parsed = parseSearchOutput(
    result.stdout,
    result.stderr,
    validated.input.output_mode,
    filesWithMatches,
  );
  const rendered = renderSearchResult(parsed, {
    input: validated.input,
    engine: "grep",
    notes: built.plan.notes,
    ...(built.plan.ignoreNote !== undefined ? { ignoreNote: built.plan.ignoreNote } : {}),
  });
  return { ...rendered, parsed, command: built.plan.command, notes: built.plan.notes };
}

/** The recorded rg transcript, as raw stdout/stderr per query name. */
function recording(): ReadonlyMap<string, { stdout: string; stderr: string }> {
  const text = readFileSync(join(import.meta.dir, "fixtures/search-rg.txt"), "utf8");
  const sections = new Map<string, { stdout: string; stderr: string }>();
  let name: string | undefined;
  let stdout: string[] = [];
  let stderr: string[] = [];
  const flush = (): void => {
    if (name !== undefined) {
      sections.set(name, { stdout: stdout.join("\n"), stderr: stderr.join("\n") });
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("### ")) {
      flush();
      name = line.slice(4);
      stdout = [];
      stderr = [];
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[stderr] ")) {
      stderr.push(line.slice(9));
      continue;
    }
    if (line !== "") {
      stdout.push(line);
    }
  }
  flush();
  return sections;
}

/** Render the RECORDED engine output for the same input, to compare shapes. */
function searchRecorded(name: string, raw: Record<string, unknown>) {
  const section = recording().get(name);
  if (section === undefined) {
    throw new Error(`no recording for ${name}`);
  }
  const validated = validateSearchInput(raw);
  if (!validated.ok) {
    throw new Error("refused");
  }
  const filesWithMatches =
    validated.input.output_mode === "files" && validated.input.pattern !== undefined;
  const parsed = parseSearchOutput(
    section.stdout,
    section.stderr,
    validated.input.output_mode,
    filesWithMatches,
  );
  return renderSearchResult(parsed, { input: validated.input, engine: "rg" }).content;
}

/** The engine annotation is the ONE licensed difference inside the body. */
const withoutEngine = (text: string): string => text.replace(/ {2}\(engine=\w+\)(?=\n|$)/g, "");

describe("T-S1: the fallback and the recorded rg run render the same SHAPE", () => {
  // Every row here is one the design makes agree: same hit lines, same order,
  // same markers. The rows it deliberately makes DIFFER are asserted apart
  // (a refuse, the `engine=` annotation, the dialect rewrite note).
  const rows: { name: string; raw: Record<string, unknown>; notes?: string }[] = [
    { name: "needle", raw: { pattern: "needle" } },
    { name: "regex", raw: { pattern: "needle.*Two" } },
    { name: "digits", raw: { pattern: "\\d+" }, notes: "pattern rewritten for grep: \\d → [0-9]" },
    {
      name: "words",
      raw: { pattern: "\\w+" },
      notes: "pattern rewritten for grep: \\w → [[:alnum:]_]",
    },
    { name: "no-match", raw: { pattern: "zzz" } },
    { name: "files-with-matches", raw: { pattern: "needle", output_mode: "files" } },
    { name: "glob-ts", raw: { glob: "*.ts", output_mode: "files" } },
    { name: "path-file", raw: { pattern: "needle", path: "-dash.ts" } },
    { name: "path-space", raw: { pattern: "needle", path: "a b" } },
    { name: "path-quote", raw: { pattern: "needle", path: "it's" } },
    { name: "path-bracket", raw: { pattern: "needle", path: "app/[id].ts" } },
    { name: "path-hidden", raw: { pattern: "needle", path: ".hidx" } },
    { name: "path-named-prune", raw: { pattern: "needle", path: "node_modules" } },
    { name: "count-cut", raw: { pattern: "needle", max_results: 3 } },
  ];
  for (const row of rows) {
    test(`"${row.name}" renders identically on both engines`, () => {
      const mine = searchGrep(row.raw);
      if ("refused" in mine) {
        throw new Error(`fallback refused: ${mine.refused}`);
      }
      const theirs = searchRecorded(row.name, row.raw);
      // Two licensed differences: the `engine=` annotation, and the rewrite
      // note a translated pattern owes (the rg path needed no rewrite).
      const notesOf = (text: string): string[] =>
        text.split("\n").filter((line) => line.startsWith("[note: "));
      const body = (text: string): string =>
        withoutEngine(text)
          .split("\n")
          .filter((line) => !line.startsWith("[note: "))
          .join("\n");
      expect(body(mine.content)).toBe(body(theirs));
      expect(notesOf(theirs)).toEqual([]);
      // The header names the engine on purpose, on both paths.
      expect(mine.content).toContain("(engine=grep)");
      expect(theirs).toContain("(engine=rg)");
      // A translated pattern says so; the rg path needed no rewrite.
      if (row.notes !== undefined) {
        expect(mine.content).toContain(`[note: ${row.notes}]`);
        expect(mine.notes).toEqual([row.notes]);
      }
    });
  }

  test("vacuity guard: the scrubbed PATH really has no rg", () => {
    const proc = Bun.spawnSync(["/bin/sh", "-c", "command -v rg"], { env: { PATH: BIN } });
    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(proc.stdout)).trim()).toBe("");
  });
});

describe("T-S2: hostile PATTERNS never reach the shell", () => {
  // Each pattern exists LITERALLY in a file; a hit for it proves the quoting
  // held, and no `pwned` file proves no substitution happened.
  const hostile = [
    "it's",
    'say "hi"',
    "$(echo PWNED)",
    "`id`",
    "a;b|$(id)",
    "-n",
    "--version",
    "back\\slash",
  ];
  for (const pattern of hostile) {
    test(`${JSON.stringify(pattern)} matches its own line literally`, () => {
      // Inside the fixture, so the workspace confinement accepts the path.
      const name = `hp-${Math.random().toString(36).slice(2, 8)}`;
      const dir = join(FX, name);
      mkdirSync(dir, { recursive: true });
      Bun.write(join(dir, "hit.txt"), `${pattern}\n`);
      const result = searchGrep({ pattern, path: name, fixed_strings: true });
      if ("refused" in result) {
        throw new Error(`refused: ${result.refused}`);
      }
      // A leading `-` lands in flag position only if the quoting is broken.
      expect(result.content).toContain("hit.txt:1:");
      expect(result.isError).toBe(false);
    });
  }

  test("no hostile pattern creates a file, and nothing is expanded", () => {
    const name = `pwn-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(FX, name);
    mkdirSync(dir, { recursive: true });
    Bun.write(join(dir, "a.txt"), "$HOME\n$(touch pwned)\n");
    searchGrep({ pattern: "$(touch pwned)", path: name, fixed_strings: true });
    searchGrep({ pattern: "$HOME", path: name, fixed_strings: true });
    const created = Bun.spawnSync(["/bin/sh", "-c", `ls -a ${shq(dir)}`]);
    const listing = new TextDecoder().decode(new Uint8Array(created.stdout));
    expect(listing).not.toContain("pwned");
    expect(listing).toContain("a.txt");
  });
});

describe("T-S2: hostile PATHS are confined, prefixed and escaped", () => {
  test("a leading-dash path is usable (the `./` prefix is what makes it so)", () => {
    const result = searchGrep({ pattern: "needle", path: "-dash.ts" });
    if ("refused" in result) {
      throw new Error(`refused: ${result.refused}`);
    }
    expect(result.content).toContain("./-dash.ts:1:needle dash");
    expect(result.content).toContain('[search "needle" in ./-dash.ts]');
    // `find -dash.ts` is an error on all three engines; the command never says that.
    expect(result.command).toContain("find -H './-dash.ts'");
  });

  test("a bracket path is not self-pruned by the `-path` guard (it is escaped)", () => {
    const result = searchGrep({ pattern: "needle", path: ".hidx" });
    if ("refused" in result) {
      throw new Error("refused");
    }
    expect(result.content).toContain("./.hidx/f.ts:1:needle");
  });

  test("a HIDDEN metachar root is searched, not self-pruned (the `-path` escape)", () => {
    // Measured on busybox/alpine/debian/BSD: with the operand unescaped, a root
    // whose basename matches the hidden prune (`-name '.*'`) prunes ITSELF and
    // returns nothing. A non-hidden `app/[id]` root is unaffected either way.
    const result = searchGrep({ pattern: "needle", path: ".hid[x]" });
    if ("refused" in result) {
      throw new Error("refused");
    }
    expect(result.content).toContain("./.hid[x]/g.ts:1:needle");
  });

  test("a space and a quote in the path survive", () => {
    for (const path of ["a b", "it's"]) {
      const result = searchGrep({ pattern: "needle", path });
      if ("refused" in result) {
        throw new Error("refused");
      }
      expect(result.content).toContain(
        path === "a b" ? "./a b/sp ace.ts:1:needle" : "./it's/q.txt:1:needle",
      );
    }
  });

  test("an absolute path and a climbing `..` are REFUSED, never rewritten", () => {
    for (const path of ["/etc", "../x", "a/../../y", "/Users/x/.ssh"]) {
      const result = validateSearchInput({ pattern: "x", path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.message).toMatch(/inside the workspace|climbs out/);
      }
    }
  });

  test("a literal `~` is not a home directory: it stays inside the workspace", () => {
    // The path is single-quoted, so the shell never expands `~`.
    const result = validateSearchInput({ pattern: "x", path: "~/.ssh" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.path).toBe("./~/.ssh");
    }
  });

  test("a NUL / newline / CR in pattern, path or glob is refused (F8, M1)", () => {
    for (const raw of [
      { pattern: "a\nb" },
      { pattern: "a\rb" },
      { pattern: "a\u0000b" },
      { pattern: "x", path: "a\nb" },
      { pattern: "x", glob: "a\nb" },
    ]) {
      const result = validateSearchInput(raw);
      expect(result.ok).toBe(false);
    }
  });

  test("a missing path is status 3, an error, and says so (F3)", () => {
    const result = searchGrep({ pattern: "needle", path: "nope" });
    if ("refused" in result) {
      throw new Error("refused");
    }
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path not found: ./nope");
    expect(result.content).not.toContain("no matches");
  });

  test("a named prune is exempt: asking for `node_modules` searches it", () => {
    const result = searchGrep({ pattern: "needle", path: "node_modules" });
    if ("refused" in result) {
      throw new Error("refused");
    }
    expect(result.content).toContain("./node_modules/m.ts:1:needle");
  });
});

describe("T-S8: the dialect classifier is a table", () => {
  const table: { pattern: string; kind: "ere" | "translated" | "refused"; text?: string }[] = [
    { pattern: "\\d+", kind: "translated", text: "[0-9]+" },
    { pattern: "\\D", kind: "translated", text: "[^0-9]" },
    { pattern: "\\w+", kind: "translated", text: "[[:alnum:]_]+" },
    { pattern: "\\W", kind: "translated", text: "[^[:alnum:]_]" },
    { pattern: "\\s", kind: "translated", text: "[[:space:]]" },
    { pattern: "\\S", kind: "translated", text: "[^[:space:]]" },
    { pattern: "[[:word:]]+", kind: "translated", text: "[[:alnum:]]+" },
    // NOT refused: measured working on BSD, busybox, GNU and rg.
    { pattern: "\\bfoo\\b", kind: "ere" },
    { pattern: "needle.*Two", kind: "ere" },
    { pattern: "\\$1", kind: "ere" },
    // Refused, each for a DIFFERENT measured reason.
    { pattern: "(?i)abc", kind: "refused" },
    { pattern: "(?:ab)", kind: "refused" },
    { pattern: "\\p{L}", kind: "refused" },
    { pattern: "a{2}", kind: "refused" },
    { pattern: "a{2,3}", kind: "refused" },
    { pattern: "\\x41", kind: "refused" },
    { pattern: "a.*?b", kind: "refused" },
    { pattern: "a+?", kind: "refused" },
    { pattern: "[\\d]", kind: "refused" },
  ];
  for (const row of table) {
    test(`${JSON.stringify(row.pattern)} is ${row.kind}`, () => {
      const classification = classifyPattern(row.pattern, false);
      expect(classification.kind).toBe(row.kind);
      if (classification.kind === "translated" && row.text !== undefined) {
        expect(classification.text).toBe(row.text);
      }
      if (classification.kind === "refused") {
        // Actionable: it names a way forward, not just "no".
        expect(classification.reason).toMatch(/fixed_strings|POSIX class/);
      }
    });
  }

  test("fixed_strings skips the table entirely (`-F` is literal everywhere)", () => {
    expect(classifyPattern("\\d+(?i)", true).kind).toBe("ere");
  });

  test("an escaped paren is not group syntax", () => {
    expect(classifyPattern("\\(?", false).kind).toBe("ere");
  });

  test("a translated pattern really matches what rg matches (the `\\d` fix)", () => {
    const result = searchGrep({ pattern: "\\d+" });
    if ("refused" in result) {
      throw new Error("refused");
    }
    // rg found `src/a.ts` lines 1 and 2; BSD grep's un-translated `\d+` would
    // match every line holding a `d`, GNU/busybox nothing.
    expect(result.content).toContain("./src/a.ts:2:const x = 2;");
    expect(result.content).not.toContain("src/debug.log");
  });

  test("a refused pattern is a refusal with the engine named, never `no matches`", () => {
    const result = searchGrep({ pattern: "(?i)needle" });
    if (!("refused" in result)) {
      throw new Error("expected a refusal");
    }
    expect(result.refused).toContain("POSIX-grep engine");
    expect(result.refused).not.toContain("no matches");
  });
});

describe("T-S6 (pure): the bounds", () => {
  function render(parsed: ReturnType<typeof parseSearchOutput>, raw: Record<string, unknown>) {
    const validated = validateSearchInput(raw);
    if (!validated.ok) {
      throw new Error("refused");
    }
    return renderSearchResult(parsed, { input: validated.input, engine: "grep" }).content;
  }

  function parsedOf(hits: { path: string; line: number; text: string }[]) {
    return parseSearchOutput(
      hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n"),
      "TENTACLE_RC=0",
      "content",
      false,
    );
  }

  test("max_results keeps N lines, says so, and digests the files it cut", () => {
    const hits = Array.from({ length: 500 }, (_, index) => ({
      path: `./d${Math.floor(index / 10)}/f.ts`,
      line: index + 1,
      text: "x",
    }));
    const content = render(parsedOf(hits), { pattern: "x", max_results: 3 });
    const lines = content.split("\n");
    expect(lines.filter((line) => line.includes(":x")).length).toBe(3);
    expect(content).toContain("[search truncated: first 3 matches — narrow the pattern or path]");
    expect(content).toMatch(/\[more matches in: .+ \d+/);
  });

  test("one 40000-char line is capped at MAX_LINE with an ellipsis", () => {
    const content = render(parsedOf([{ path: "./a.ts", line: 1, text: "y".repeat(40000) }]), {
      pattern: "y",
    });
    const hit = content.split("\n").find((line) => line.startsWith("./a.ts:1:"));
    expect(hit).toBeDefined();
    const text = (hit ?? "").slice("./a.ts:1:".length);
    expect(text.length).toBe(MAX_LINE);
    expect(text.endsWith("…")).toBe(true);
  });

  test("the byte bound keeps WHOLE lines and emits the byte marker", () => {
    const hits = Array.from({ length: 200 }, (_, index) => ({
      path: "./a.ts",
      line: index + 1,
      text: "z".repeat(200),
    }));
    const content = render(parsedOf(hits), { pattern: "z" });
    expect(content).toContain(
      `[search truncated: ${MAX_BYTES} bytes — narrow the pattern or path]`,
    );
    const body = Buffer.byteLength(content, "utf8");
    // Every hit line is whole (no half line, no cut character).
    for (const line of content.split("\n").filter((line) => line.startsWith("./a.ts:"))) {
      expect(line.endsWith("z")).toBe(true);
    }
    expect(body).toBeLessThan(MAX_BYTES + 2000);
  });

  test("a raw stream at the CAP gets the INCOMPLETE marker, not `first N` (M3)", () => {
    const line = `./a.ts:1:${"q".repeat(100)}`;
    const filler = `${line}\n`.repeat(RAW_CAP / (line.length + 1) + 1);
    const content = render(parseSearchOutput(filler, "TENTACLE_RC=0", "content", false), {
      pattern: "q",
    });
    expect(content).toContain(
      "[search truncated at 256 KiB — results are INCOMPLETE, not the first N]",
    );
    // The COUNT marker ("first N matches") is a different, honest marker; it
    // must not be printed for a cut byte stream.
    expect(content).not.toContain("matches — narrow");
  });

  test("a raw stream under the CAP gets `first N`, a DIFFERENT marker", () => {
    const content = render(parsedOf([{ path: "./a.ts", line: 1, text: "q" }]), {
      pattern: "q",
      max_results: 1,
    });
    expect(content).not.toContain("INCOMPLETE");
  });

  test("no hits renders the explicit sentence, not an empty body", () => {
    const content = render(parseSearchOutput("", "TENTACLE_RC=1", "content", false), {
      pattern: "zzz",
    });
    expect(content).toContain("no matches");
  });

  test("a binary match becomes one note, not a hit line (F6)", () => {
    const parsed = parseSearchOutput(
      "binary file ./bin.dat matches\n./a.ts:1:ok",
      "TENTACLE_RC=0",
      "content",
      false,
    );
    const content = render(parsed, { pattern: "needle" });
    expect(content).toContain("[binary files matched (1) — not shown]");
    expect(content).not.toContain("bin.dat");
  });

  test("a NUL-bearing line is dropped, never rendered", () => {
    const parsed = parseSearchOutput(
      "./bin.dat:1:a\u0000needle",
      "TENTACLE_RC=0",
      "content",
      false,
    );
    expect(parsed.hits).toEqual([]);
    expect(parsed.binaryMatches).toBe(1);
  });

  test("a tab survives, other C0 characters do not (M7b, F9)", () => {
    const parsed = parseSearchOutput(
      "./a.ts:1:\tif (x) {\u0007",
      "TENTACLE_RC=0",
      "content",
      false,
    );
    expect(parsed.hits[0]?.text).toBe("\tif (x) {");
  });
});

describe("the parser reads the engines' own words", () => {
  const cases: { stderr: string; expect: Partial<ReturnType<typeof parseSearchOutput>> }[] = [
    { stderr: "TENTACLE_RC=0\n", expect: { status: 0 } },
    { stderr: "TENTACLE_RC=1\n", expect: { status: 1 } },
    { stderr: "TENTACLE_MISSING\n", expect: { missingPath: true } },
    { stderr: "grep: bad regex 'foo(': Unmatched\nTENTACLE_RC=1", expect: { status: 1 } },
    { stderr: "grep: parentheses not balanced\n", expect: {} },
    { stderr: "grep: brackets ([ ]) not balanced\n", expect: {} },
    { stderr: "rg: regex parse error:\n", expect: {} },
    { stderr: "grep: warning: ? at start of expression\n", expect: {} },
  ];
  for (const row of cases) {
    test(`stderr ${JSON.stringify(row.stderr)}`, () => {
      const parsed = parseSearchOutput("", row.stderr, "content", false);
      if (row.expect.status !== undefined) {
        expect(parsed.status).toBe(row.expect.status);
      }
      if (row.expect.missingPath) {
        expect(parsed.missingPath).toBe(true);
      }
      if (
        row.stderr.includes("bad regex") ||
        row.stderr.includes("not balanced") ||
        row.stderr.includes("regex parse") ||
        row.stderr.includes("warning:")
      ) {
        expect(parsed.parseError).toBeDefined();
        const rendered = renderSearchResult(parsed, {
          input: {
            path: ".",
            output_mode: "content",
            fixed_strings: false,
            ignore_case: false,
            max_results: 100,
            pattern: "x",
          },
          engine: "grep",
        });
        expect(rendered.isError).toBe(true);
        expect(rendered.content).toContain("fixed_strings: true");
      }
    });
  }

  test("the SIGPIPE chatter is noise, not a parse error", () => {
    const parsed = parseSearchOutput(
      "./a.ts:1:x",
      "find: 'grep' terminated by signal 13\nTENTACLE_RC=0",
      "content",
      false,
    );
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.status).toBe(0);
  });
});

describe("classifyGitignore", () => {
  test("top-level literal names prune, everything else is counted (Design 3b)", () => {
    const classified = classifyGitignore(
      [
        "node_modules/",
        "dist",
        "coverage",
        "*.log",
        "pkg/a/",
        "!.env.example",
        "# a comment",
        "",
      ].join("\n"),
    );
    expect(classified.prunes).toEqual(["node_modules", "dist", "coverage"]);
    expect(classified.unexpressible).toEqual(["*.log", "pkg/a/", "!.env.example"]);
  });

  test("the note is printed on the FALLBACK only, and says `may differ` (M2)", () => {
    const gitignore = classifyGitignore("*.log\npkg/a/\n");
    const input = validateSearchInput({ pattern: "needle" });
    if (!input.ok) {
      throw new Error("refused");
    }
    const fallback = buildSearchPlan(input.input, "grep", { gitignore, binaryFilter: false });
    const rg = buildSearchPlan(input.input, "rg", { gitignore, binaryFilter: true });
    if (!fallback.ok || !rg.ok) {
      throw new Error("no plan");
    }
    expect(fallback.plan.ignoreNote).toContain("2 .gitignore rules (*.log, pkg/a/)");
    expect(fallback.plan.ignoreNote).toContain("may differ");
    expect(rg.plan.ignoreNote).toBeUndefined();
  });
});

describe("the plan's shape", () => {
  test("both commands carry the pre-check, the status line and the raw cap (H3, M3)", () => {
    const input = validateSearchInput({ pattern: "needle" });
    if (!input.ok) {
      throw new Error("refused");
    }
    for (const engine of ["rg", "grep"] as const) {
      const plan = buildSearchPlan(input.input, engine, { binaryFilter: false });
      if (!plan.ok) {
        throw new Error("no plan");
      }
      expect(plan.plan.command).toContain("[ ! -f '.' ] && [ ! -d '.' ] && [ ! -L '.' ]");
      expect(plan.plan.command).toContain("TENTACLE_MISSING");
      expect(plan.plan.command).toContain("exit 3");
      expect(plan.plan.command).toContain(`printf 'TENTACLE_RC=%s\\n' "$?" >&2`);
      expect(plan.plan.command).toContain(`| head -c ${RAW_CAP}`);
      // The pattern is never in flag position: it always follows `-e`.
      expect(plan.plan.command).toContain("-e 'needle'");
    }
  });

  test("the fixture is where the test left it (guard against an empty tree)", () => {
    expect(statSync(join(FX, "src/a.ts")).size).toBeGreaterThan(0);
    copyFileSync(join(FX, "src/a.ts"), join(ROOT, "copy.ts"));
  });
});
