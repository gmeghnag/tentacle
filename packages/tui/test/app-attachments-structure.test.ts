/**
 * docs/feat/app-decomposition.md S6 — the STRUCTURAL contract of the move, in the
 * S0b style: a source-level property that a rendering assertion cannot see.
 *
 * The plan's S6 payload is "`useAttachments.ts` + App.tsx 835–858, 1881–2106",
 * and the Fable H1/M1 constraints narrow it to:
 *   - the DECISIONS and their EXECUTOR leave `App.tsx` (no `decideAttachment`,
 *     `routeDecision`, `attachmentCandidateText`, `parseAttachCommand`,
 *     `withChips`, `uploadProgress`, `looksLikeCommand`, `NO_IMAGE_SEAM` there);
 *   - the unmount effect does NOT move: it is effect 1 of 22 (the original 20 +
 *     session-hop's 2), in today's order,
 *     and it still aborts the upload and bumps the generation the hook reads;
 *   - the frozen identifiers survive, so no use-site had to change;
 *   - exactly ONE `useAttachments` call — two would be two executors over one draft.
 *
 * Every assertion here is red under the mutation named beside it (the slice's
 * mutation table), so none of them is decoration.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

/**
 * The body of App's `index`-th `useEffect` (0-based), from its opening line to the
 * first `}, [...])`/`}, [])` that closes it — enough to assert what it does, not
 * to parse JSX.
 */
const effectBody = (src: string, index: number): string | null => {
  const starts = [...src.matchAll(/^ {2}useEffect\(/gm)].map((m) => m.index ?? 0);
  const start = starts[index];
  if (start === undefined) {
    return null;
  }
  const end = src.indexOf("}, [", start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
};

/**
 * The member names a module's named imports bring in, per `from` specifier.
 * `import { a, type B } from "x.ts"` → `[a, B]`, kept with the module it came from.
 */
const importSpecs = (src: string, from: string): string[] => {
  const specs: string[] = [];
  for (const m of src.matchAll(/import \{([^{}]*)\} from "(\.\/[^"]*)";/g)) {
    if (m[2] !== from) {
      continue;
    }
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().replace(/^type /, "");
      if (name !== "") {
        specs.push(name);
      }
    }
  }
  return specs;
};

describe("S6: the attach decisions and their executor leave App.tsx", () => {
  // M4: a decision body re-inlined in App.tsx (the executor is back in the
  // component) — the exact drift this slice exists to prevent. Checked as an
  // IMPORT plus a CALL, so a comment naming one (`looksLikeCommand already said
  // so`, which rightly stays) is not mistaken for a use.
  test("no attach decision lives in App.tsx any more; they are useAttachments.ts's", () => {
    const app = readSrc("App.tsx");
    const moved = [
      "decideAttachment",
      "routeDecision",
      "attachmentCandidateText",
      "parseAttachCommand",
      "withChips",
      "uploadProgress",
      "looksLikeCommand",
      "draftRefs",
    ];
    const imported = [
      ...importSpecs(app, "./attach-candidates.ts"),
      ...importSpecs(app, "./attach-draft.ts"),
      ...importSpecs(app, "./attach-files.ts"),
    ];
    for (const gone of moved) {
      expect({ symbol: gone, imported: imported.includes(gone) }).toEqual({
        symbol: gone,
        imported: false,
      });
      expect({ symbol: gone, calls: countOf(app, `${gone}(`) }).toEqual({ symbol: gone, calls: 0 });
    }
    const hook = readSrc("useAttachments.ts");
    for (const there of ["decideAttachment", "routeDecision", "attachmentCandidateText"]) {
      expect(hook).toContain(there);
    }
  });

  // M6: the hook called twice — two serialization chains, two executors over one
  // draft, so the "one decision at a time" guarantee is gone.
  test("one useAttachments call, and every identifier its call sites use still exists", () => {
    const app = readSrc("App.tsx");
    expect(countOf(app, "useAttachments({")).toBe(1);
    expect(app).toMatch(/import \{ useAttachments \} from "\.\/useAttachments\.ts";/);
    // The frozen identifiers (Fable M1): destructured under the SAME names, which
    // is what keeps every use-site below unchanged.
    expect(app).toMatch(
      /const \{ attachMode, restoreChips, routeAttach, attachCommand, convertToChips, sendWithImages \}/,
    );
  });

  // Review round 1, finding 1: the one-decision-at-a-time chain was COPIED, not
  // moved — App kept a zero-reader `attachChainRef` beside the hook's. A second
  // chain with the same name type-checks and lints clean, so a later slice that
  // joins it runs its paste CONCURRENTLY with the hook's, and `existing` misses
  // the first paste's chips — the exact bug the chain exists to prevent.
  test("the serialization chain lives in the hook ONLY, never duplicated in App.tsx", () => {
    const app = readSrc("App.tsx");
    expect({ where: "App.tsx", chains: countOf(app, "attachChainRef") }).toEqual({
      where: "App.tsx",
      chains: 0,
    });
    const hook = readSrc("useAttachments.ts");
    expect(countOf(hook, "const attachChainRef = useRef<Promise<void>>(Promise.resolve());")).toBe(
      1,
    );
    // Non-vacuity: it is the chain the decisions actually JOIN, not a dead ref of
    // its own (M2: drop the chaining → the layer test's serialization case fails).
    expect(countOf(hook, "attachChainRef.current = attachChainRef.current.then(")).toBe(3);
    // …and the refs App legitimately keeps as port fields stay exactly one each.
    expect(countOf(app, "const attachGenRef = useRef(0);")).toBe(1);
    expect(countOf(app, "const attachRef = useRef<AttachDraft>(EMPTY_DRAFT);")).toBe(1);
  });

  // H2 (2): a dep array naming the whole port makes `useExhaustiveDependencies`
  // blind to the fields, and the hook's callbacks lose their identity rules.
  test("the hook's dependency arrays name FIELDS, never the port object", () => {
    const hook = readSrc("useAttachments.ts");
    // Every `],` that closes a dep array in this file: none may be `[host]`.
    for (const bad of ["[host]", "[..., host]", "host,\n  ]"]) {
      expect({ dep: bad, uses: countOf(hook, bad) }).toEqual({ dep: bad, uses: 0 });
    }
    // Non-vacuity: the hook really does declare dep arrays naming its fields.
    expect(hook).toContain(
      "[attachGenRef, restoreInput, runRef, sessionRef, setAttach, uploadCtrlRef]",
    );
  });
});

describe("S6: the unmount effect stays in App, at its index, doing its job", () => {
  // M5: the effect's body gutted (the generation bump dropped) — a decision that
  // lands after an unmount then sets state on a dead component.
  test("the attachments' unmount effect is STILL effect 1 of 22 and still aborts + bumps", () => {
    const app = readSrc("App.tsx");
    expect(countOf(app, "\n  useEffect(")).toBe(22);
    const first = effectBody(app, 0);
    expect(first).not.toBeNull();
    const body = first ?? "";
    expect(body).toContain("attachGenRef.current += 1");
    expect(body).toContain("uploadCtrlRef.current?.abort()");
    // …and it is the ATTACHMENTS' own effect, not some other one that drifted first.
    expect(body).toContain("attachGenRef");
    expect(effectBody(app, 1)).not.toBeNull();
    expect(effectBody(app, 22)).toBeNull();
  });
});
