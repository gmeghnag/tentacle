import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOTE_DIR,
  PIN_PATH,
  VERSION_PATH,
  applyBump,
  applyPin,
  foldNote,
  parseNotes,
  readBumps,
  readNoteDir,
  readVersion,
  runProtocolBump,
} from "../protocol-bump.ts";
import { ReleaseError } from "../release-plan.ts";

/** The shape of the real file: a reason block, then the number. */
const VERSION = `/** Wire protocol version. */
// 23: image refs on messages (docs/feat/attachments-core.md).
// 24: \`StopReasonSchema\` gained \`max_token_budget\`
// (docs/feat/subagent-token-budget.md).
export const PROTOCOL_VERSION = 24 as const;
`;

/** The shape of the real pin: ONE assertion line inside a test body. */
const PIN = `describe("the wire version", () => {
  test("PROTOCOL_VERSION is the number this build speaks", () => {
    // THE pin. A bump edits this line and \`version.ts\`; nothing else.
    expect(PROTOCOL_VERSION).toBe(24);
  });
});
`;

const note = (slug: string, text: string) => ({ path: `${NOTE_DIR}/${slug}.md`, slug, text });

describe("parseNotes", () => {
  test("one note per file, sorted by slug (numbers are assigned in this order)", () => {
    const out = parseNotes([note("zeta", "the zeta break\n"), note("alpha", "the alpha break\n")]);
    expect(out.map((n) => n.slug)).toEqual(["alpha", "zeta"]);
    expect(out[0]?.text).toBe("the alpha break");
  });

  test("a note's prose is flattened: the reason is one comment block, not markup", () => {
    const out = parseNotes([note("task-x", "\nline one.\nline two.\n\n")]);
    expect(out[0]?.text).toBe("line one. line two.");
  });

  test("refuses a name that is not <slug>.md", () => {
    for (const path of [`${NOTE_DIR}/Task_x.md`, `${NOTE_DIR}/task-x.added.md`, `${NOTE_DIR}/x`]) {
      expect(() => parseNotes([{ path, text: "- a thing\n" }])).toThrow(/named <slug>\.md/);
      expect(() => parseNotes([{ path, text: "- a thing\n" }])).toThrow(ReleaseError);
    }
  });

  test("refuses a subdirectory by name (a `*.md` glob would silently skip it)", () => {
    expect(() => parseNotes([{ path: `${NOTE_DIR}/sub`, text: "", directory: true }])).toThrow(
      /no subdirectories/,
    );
    expect(() => parseNotes([{ path: `${NOTE_DIR}/sub/nested.md`, text: "a\n" }])).toThrow(
      /no subdirectories/,
    );
  });

  test("refuses an empty note: a break with no reason is what this replaced", () => {
    expect(() => parseNotes([note("task-x", "\n \n")])).toThrow(/note is empty/);
  });

  test("the scan lists every entry, so nothing is recorded and never applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "tentacle-notes-"));
    try {
      const root = dir;
      mkdirSync(join(root, NOTE_DIR, "sub"), { recursive: true });
      for (const rel of ["ok.md", "lost-task", ".DS_Store"]) {
        writeFileSync(join(root, NOTE_DIR, rel), "a reason\n");
      }
      expect(readNoteDir(root).map((f) => f.path)).toEqual([
        `${NOTE_DIR}/.DS_Store`,
        `${NOTE_DIR}/lost-task`,
        `${NOTE_DIR}/ok.md`,
        `${NOTE_DIR}/sub`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyBump", () => {
  test("folds each note as the next number, in slug order, and sets the number", () => {
    const out = applyBump(VERSION, [
      note("zeta", "the zeta break"),
      note("alpha", "the alpha break"),
    ]);
    expect(readVersion(out)).toBe(26);
    const bumps = readBumps(out);
    expect(bumps.slice(-2)).toEqual([
      { number: 25, text: "the alpha break" },
      { number: 26, text: "the zeta break" },
    ]);
    // The earlier reasons survive untouched: the block is append-only.
    expect(bumps.slice(0, 2)).toEqual([
      { number: 23, text: "image refs on messages (docs/feat/attachments-core.md)." },
      {
        number: 24,
        text: "`StopReasonSchema` gained `max_token_budget` (docs/feat/subagent-token-budget.md).",
      },
    ]);
    // The number line is the last thing in the file, exactly once.
    expect(out.match(/^export const PROTOCOL_VERSION =/gm)?.length).toBe(1);
    expect(out.trimEnd().endsWith("export const PROTOCOL_VERSION = 26 as const;")).toBe(true);
  });

  test("no notes: the file is returned byte-identical", () => {
    expect(applyBump(VERSION, [])).toBe(VERSION);
  });

  test("a long reason wraps into `// ` continuation lines, not one wide line", () => {
    const long = `${"word ".repeat(40)}end`;
    const out = applyBump(VERSION, [note("task-long", long)]);
    const block = out.split("\n").filter((l) => l.startsWith("// 25: ") || l.startsWith("// word"));
    expect(block.length).toBeGreaterThan(1);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(96);
    }
    expect(readBumps(out).at(-1)).toEqual({ number: 25, text: long });
  });

  test("a note already folded is skipped, so a crash between write and delete converges", () => {
    const once = applyBump(VERSION, [note("task-x", "the x break")]);
    const twice = applyBump(once, [note("task-x", "the x break")]);
    expect(twice).toBe(once);
    expect(readVersion(twice)).toBe(25);
  });

  test("a crash re-run with TWO notes folded skips both, not just the newest", () => {
    // The crash window is between the single write and the deletions, so a
    // multi-note fold leaves EVERY note on disk. Skipping only the newest folds
    // the others again: the numbers stay consecutive, nothing goes red, and one
    // break silently burns two version numbers (review round 1, HIGH).
    const pending = [note("alpha", "break A"), note("zeta", "break B")];
    const once = applyBump(VERSION, pending);
    const twice = applyBump(once, pending);
    expect(twice).toBe(once);
    expect(readVersion(twice)).toBe(26);
    expect(readBumps(twice).slice(-2)).toEqual([
      { number: 25, text: "break A" },
      { number: 26, text: "break B" },
    ]);
  });

  test("a wrapped reason never starts a continuation line that reads back as a block", () => {
    // `// 7: y` as a CONTINUATION reads back as block 7 (review round 1, MEDIUM):
    // the next bump then refuses ("the number is 25 but the newest reason
    // comment is 7") after the bad block is already written.
    const text = `${"x ".repeat(40).trim()} 7: y`;
    const out = applyBump(VERSION, [note("task-x", text)]);
    expect(out.split("\n").filter((l) => /^\/\/ \d+: /.test(l)).length).toBe(
      VERSION.split("\n").filter((l) => /^\/\/ \d+: /.test(l)).length + 1,
    );
    expect(readBumps(out).at(-1)).toEqual({ number: 25, text });
    expect(readVersion(out)).toBe(25);
    // And the block is still foldable onto: a mis-read block makes this refuse.
    const next = applyBump(out, [note("task-y", "the y break")]);
    expect(readVersion(next)).toBe(26);
  });

  test("refuses a hand-bumped number whose newest reason comment disagrees", () => {
    // Mutation target: accept this silently and the reason block lies about the number.
    const handBumped = VERSION.replace("= 24 as const", "= 25 as const");
    expect(() => applyBump(handBumped, [note("task-x", "the x break")])).toThrow(
      /number is 25 but the newest reason comment is 24/,
    );
  });

  test("refuses a reason block that is not consecutive (edited out of order)", () => {
    const gapped = VERSION.replace("// 23:", "// 22:");
    expect(() => applyBump(gapped, [note("task-x", "the x break")])).toThrow(
      /must number consecutively; got 22 then 24/,
    );
    const doubled = VERSION.replace("// 23:", "// 24:");
    expect(() => applyBump(doubled, [note("task-x", "the x break")])).toThrow(
      /must number consecutively; got 24 then 24/,
    );
  });

  test("refuses a file with no PROTOCOL_VERSION line, or more than one", () => {
    expect(() => readVersion("// nothing here\n")).toThrow(/exactly one/);
    expect(() => readVersion(`${VERSION}export const PROTOCOL_VERSION = 25 as const;\n`)).toThrow(
      /exactly one/,
    );
  });
});

describe("applyPin (the one hand-maintained number in the tests)", () => {
  test("rewrites the number, keeping the line's indentation and everything else", () => {
    const out = applyPin(PIN, 24, 25);
    expect(out).toBe(PIN.replace("toBe(24)", "toBe(25)"));
    expect(out.split("\n").length).toBe(PIN.split("\n").length);
  });

  test("a pin already at `to` is returned byte-identical (a crash re-run is a no-op)", () => {
    // The convergence case: pin → version.ts, so a crash in between leaves
    // from=24, to=25 and pin=25 — the pin must not be touched again.
    const at25 = PIN.replace("toBe(24)", "toBe(25)");
    expect(applyPin(at25, 24, 25)).toBe(at25);
    // A no-note run: from == to, nothing to do.
    expect(applyPin(at25, 25, 25)).toBe(at25);
  });

  test("a pin that is neither `from` nor `to` is refused, never overwritten", () => {
    // The pin's own job: catching a hand-edit of version.ts. Overwriting it
    // silently would erase the evidence instead of reporting it.
    expect(() => applyPin(PIN.replace("toBe(24)", "toBe(26)"), 24, 25)).toThrow(
      /pins 26 but version\.ts was 24 — the pin was hand-edited; fix it to 24 and re-run/,
    );
  });

  test("a missing, moved or duplicated pin line is refused by name", () => {
    expect(() => applyPin("// no pin here\n", 24, 25)).toThrow(/expected exactly one .*found 0/);
    const doubled = `${PIN}    expect(PROTOCOL_VERSION).toBe(24);\n`;
    expect(() => applyPin(doubled, 24, 25)).toThrow(/\(found 2\)/);
    expect(() => applyPin(doubled, 24, 25)).toThrow(ReleaseError);
  });
});

describe("foldNote", () => {
  test("the first line carries `// <n>: ` and each continuation only `// `", () => {
    const lines = foldNote(25, "a b c", 11);
    expect(lines).toEqual(["// 25: a b", "// c"]);
  });
});

describe("runProtocolBump (the orchestrator's one merge command)", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "tentacle-bump-"));
    mkdirSync(join(root, "packages/protocol/src"), { recursive: true });
    mkdirSync(join(root, "packages/protocol/test"), { recursive: true });
    mkdirSync(join(root, NOTE_DIR), { recursive: true });
    writeFileSync(join(root, VERSION_PATH), VERSION);
    writeFileSync(join(root, PIN_PATH), PIN);
    return root;
  };

  const pinOf = (root: string) =>
    /expect\(PROTOCOL_VERSION\)\.toBe\((\d+)\);/
      .exec(readFileSync(join(root, PIN_PATH), "utf8"))
      ?.at(1);

  test("two notes: version.ts folded, both notes deleted, schema refreshed once", async () => {
    const root = fixture();
    const out: string[] = [];
    let exports = 0;
    try {
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      writeFileSync(join(root, `${NOTE_DIR}/zeta.md`), "the zeta break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => {
          exports += 1;
          return true;
        },
        write: (t) => out.push(t),
      });
      expect(code).toBe(0);
      const text = readFileSync(join(root, VERSION_PATH), "utf8");
      expect(readVersion(text)).toBe(26);
      expect(
        readBumps(text)
          .slice(-2)
          .map((b) => b.number),
      ).toEqual([25, 26]);
      expect(readNoteDir(root)).toEqual([]);
      expect(exports).toBe(1);
      expect(out.join("")).toContain("PROTOCOL_VERSION is now 26");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one note: the pin line moves with version.ts (the 23/11 merge bug)", async () => {
    // Red today: the bump writes version.ts and leaves the pin at 24, so the
    // merged tree is red in `version.test.ts` and the number was edited by hand.
    const root = fixture();
    try {
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: () => {},
      });
      expect(code).toBe(0);
      expect(pinOf(root)).toBe("25");
      expect(readVersion(readFileSync(join(root, VERSION_PATH), "utf8"))).toBe(25);
      // The rest of the pin file is untouched: only the number moves.
      expect(readFileSync(join(root, PIN_PATH), "utf8")).toBe(PIN.replace("toBe(24)", "toBe(25)"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no notes is NOT an error: it is the post-merge schema refresh", async () => {
    const root = fixture();
    let exports = 0;
    try {
      const code = await runProtocolBump({
        root,
        exportSchema: async () => {
          exports += 1;
          return true;
        },
        write: () => {},
      });
      expect(code).toBe(0);
      expect(exports).toBe(1);
      expect(readFileSync(join(root, VERSION_PATH), "utf8")).toBe(VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed note: exit 1, version.ts untouched, nothing deleted, no export", async () => {
    const root = fixture();
    let exports = 0;
    const out: string[] = [];
    try {
      writeFileSync(join(root, `${NOTE_DIR}/ok.md`), "a reason\n");
      writeFileSync(join(root, `${NOTE_DIR}/Task_x.md`), "a reason\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => {
          exports += 1;
          return true;
        },
        write: (t) => out.push(t),
      });
      expect(code).toBe(1);
      expect(readFileSync(join(root, VERSION_PATH), "utf8")).toBe(VERSION);
      expect(readNoteDir(root).length).toBe(2);
      expect(exports).toBe(0);
      expect(out.join("")).toContain("named <slug>.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the note is deleted only AFTER both writes, pin first (crash window, M7/R4)", async () => {
    // The unrecoverable loss this blocks: delete first, write second, crash ⇒ the
    // reason is gone and the number was never bumped — nothing left to re-run.
    // The ORDER matters too: pin → version.ts converges on a re-run at any crash
    // point; version.ts → pin does not (see the reverse-order case below).
    const root = fixture();
    const writes: string[] = [];
    let notePresentAtWrite: boolean | string = "the write was never called";
    try {
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: () => {},
        writeFile: (path, text) => {
          writes.push(path.slice(root.length + 1));
          notePresentAtWrite = readNoteDir(root)
            .map((f) => f.path)
            .join(",");
          writeFileSync(path, text);
        },
      });
      expect(code).toBe(0);
      expect(writes).toEqual([PIN_PATH, VERSION_PATH]);
      expect(notePresentAtWrite).toBe(`${NOTE_DIR}/alpha.md`);
      expect(readNoteDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pin file that does not exist: exit 1, version.ts untouched, note kept", async () => {
    // applyPin never sees a text, so this is the shell's own refusal: the read
    // throws before anything is written, the same "nothing half-done" contract.
    const root = fixture();
    const out: string[] = [];
    let exports = 0;
    try {
      rmSync(join(root, PIN_PATH));
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => {
          exports += 1;
          return true;
        },
        write: (t) => out.push(t),
      });
      expect(code).toBe(1);
      expect(readFileSync(join(root, VERSION_PATH), "utf8")).toBe(VERSION);
      expect(readNoteDir(root).map((f) => f.path)).toEqual([`${NOTE_DIR}/alpha.md`]);
      expect(exports).toBe(0);
      expect(out.join("")).toContain(PIN_PATH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the pin is not rewritten when it did not change (no notes: both untouched)", async () => {
    const root = fixture();
    const writes: string[] = [];
    try {
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: () => {},
        writeFile: (path, text) => {
          writes.push(path.slice(root.length + 1));
          writeFileSync(path, text);
        },
      });
      expect(code).toBe(0);
      expect(writes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing or malformed pin: exit 1, version.ts untouched, note kept, no export", async () => {
    // A bump that writes version.ts and skips the pin is the 23/11 bug. Refusing
    // before the first write keeps "the pin would be red anyway" from landing.
    for (const pinText of [
      "",
      "// no pin here\n",
      `${PIN}    expect(PROTOCOL_VERSION).toBe(24);\n`,
    ]) {
      const root = fixture();
      const out: string[] = [];
      let exports = 0;
      try {
        writeFileSync(join(root, PIN_PATH), pinText);
        writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
        const code = await runProtocolBump({
          root,
          exportSchema: async () => {
            exports += 1;
            return true;
          },
          write: (t) => out.push(t),
        });
        expect(code).toBe(1);
        expect(readFileSync(join(root, VERSION_PATH), "utf8")).toBe(VERSION);
        expect(readFileSync(join(root, PIN_PATH), "utf8")).toBe(pinText);
        expect(readNoteDir(root).map((f) => f.path)).toEqual([`${NOTE_DIR}/alpha.md`]);
        expect(exports).toBe(0);
        expect(out.join("")).toContain("expected exactly one");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("a hand-edited pin: refused with the value to fix it to, never overwritten", async () => {
    const root = fixture();
    const out: string[] = [];
    try {
      writeFileSync(join(root, PIN_PATH), PIN.replace("toBe(24)", "toBe(26)"));
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: (t) => out.push(t),
      });
      expect(code).toBe(1);
      expect(out.join("")).toContain("the pin was hand-edited; fix it to 24 and re-run");
      expect(readFileSync(join(root, PIN_PATH), "utf8")).toBe(PIN.replace("toBe(24)", "toBe(26)"));
      expect(readFileSync(join(root, VERSION_PATH), "utf8")).toBe(VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a crash between the two writes converges on a re-run (why the pin goes first)", async () => {
    // Crash after the pin, before version.ts: from=24, to=25, pin=25. The pin
    // equals `to`, so the re-run leaves it and writes version.ts. The reverse
    // order (version.ts first) would strand: from=to=25, pin=24 ⇒ refused forever.
    const root = fixture();
    const out: string[] = [];
    try {
      writeFileSync(join(root, PIN_PATH), PIN.replace("toBe(24)", "toBe(25)"));
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: (t) => out.push(t),
      });
      expect(code).toBe(0);
      expect(readVersion(readFileSync(join(root, VERSION_PATH), "utf8"))).toBe(25);
      expect(pinOf(root)).toBe("25");
      expect(readNoteDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the reverse-order state is refused, not silently overwritten", async () => {
    // What a version.ts-first crash would leave: version.ts at 25, pin at 24 and
    // the note still on disk (so the re-run's `from` is already `to`).
    const root = fixture();
    const out: string[] = [];
    try {
      writeFileSync(
        join(root, VERSION_PATH),
        applyBump(VERSION, [note("alpha", "the alpha break")]),
      );
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: (t) => out.push(t),
      });
      expect(code).toBe(1);
      expect(out.join("")).toContain("pins 24 but version.ts was 25");
      expect(readNoteDir(root).map((f) => f.path)).toEqual([`${NOTE_DIR}/alpha.md`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a crash re-run (notes folded, not yet deleted) folds nothing and deletes them", async () => {
    // End-to-end form of the HIGH: the crash window leaves BOTH notes on disk
    // with version.ts already at 26. A re-run must converge on 26, not 28.
    const root = fixture();
    const out: string[] = [];
    try {
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "break A\n");
      writeFileSync(join(root, `${NOTE_DIR}/zeta.md`), "break B\n");
      // Simulate the crash: both writes landed (pin first), the deletions did not.
      writeFileSync(join(root, VERSION_PATH), applyBump(VERSION, parseNotes(readNoteDir(root))));
      writeFileSync(join(root, PIN_PATH), PIN.replace("toBe(24)", "toBe(26)"));
      const code = await runProtocolBump({
        root,
        exportSchema: async () => true,
        write: (t) => out.push(t),
      });
      expect(code).toBe(0);
      expect(readVersion(readFileSync(join(root, VERSION_PATH), "utf8"))).toBe(26);
      expect(readNoteDir(root)).toEqual([]);
      expect(out.join("")).toContain("no new protocol.d/ notes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed schema export is a refusal, not a silent stale schema", async () => {
    const root = fixture();
    const out: string[] = [];
    try {
      writeFileSync(join(root, `${NOTE_DIR}/alpha.md`), "the alpha break\n");
      const code = await runProtocolBump({
        root,
        exportSchema: async () => false,
        write: (t) => out.push(t),
      });
      expect(code).toBe(1);
      expect(out.join("")).toContain("schema:export failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
