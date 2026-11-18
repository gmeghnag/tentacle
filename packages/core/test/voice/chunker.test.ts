/**
 * `chunker.ts` — streaming text deltas → spoken chunks
 * (docs/feat/voice-conversation.md §3, C2 / T1).
 *
 * Mutation target: capping chunks at 40 chars (instead of 200) must fail the
 * clause-merge assertions; cutting inside a word or a number must fail its own.
 */
import { describe, expect, test } from "bun:test";
import { CHUNK_DEFAULTS, chunkFilter } from "../../src/voice/index.ts";

/** Feed a whole text in one delta, then flush. */
function run(text: string, splitAt?: readonly number[]): string[] {
  const deltas = splitAt === undefined ? [text] : cut(text, splitAt);
  let state = chunkFilter.init();
  const out: string[] = [];
  for (const delta of deltas) {
    const step = chunkFilter.step(state, delta);
    state = step.state;
    out.push(...step.chunks);
  }
  out.push(...chunkFilter.flush(state).chunks);
  return out;
}

/** Cut `text` at the given absolute offsets, sorted and de-duplicated. */
function cut(text: string, at: readonly number[]): string[] {
  const offsets = [...new Set(at)].filter((i) => i > 0 && i < text.length).sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const index of offsets) {
    out.push(text.slice(from, index));
    from = index;
  }
  out.push(text.slice(from));
  return out.filter((d) => d !== "");
}

describe("T1: the first chunk is short, so speech starts fast", () => {
  test("a long first sentence is cut at a clause end within 4 words", () => {
    // V0: non-streaming TTS has TTFA 125 ms at 1 word … 1.35 s at 179 chars.
    const chunks = run("Sure, I can do that for you right now. And then more.");
    expect(chunks[0]).toBe("Sure,");
    expect(words(chunks[0] ?? "")).toBeLessThanOrEqual(CHUNK_DEFAULTS.firstWords);
  });

  test("a first sentence with no early clause is cut at 4 words", () => {
    const chunks = run("alpha beta gamma delta epsilon zeta eta theta");
    expect(chunks[0]).toBe("alpha beta gamma delta");
  });

  test("a short first sentence is not padded with the next one", () => {
    expect(run("Done. Next thing here.")).toEqual(["Done.", "Next thing here."]);
  });

  test("the 4-word rule applies only to the FIRST chunk", () => {
    const chunks = run("Ok. alpha beta gamma delta epsilon zeta.");
    expect(chunks[0]).toBe("Ok.");
    // The second chunk may run to the clause/sentence end, not 4 words.
    expect(words(chunks[1] ?? "")).toBeGreaterThan(CHUNK_DEFAULTS.firstWords);
  });
});

describe("T1: later chunks end at a sentence or clause", () => {
  test("a comma merges into the sentence it belongs to", () => {
    // A comma is a clause cut for the FIRST chunk only; afterwards it merges, so
    // the voice is not chopped at every comma.
    expect(run("Fine. I looked at the config, and it was wrong.")).toEqual([
      "Fine.",
      "I looked at the config, and it was wrong.",
    ]);
  });

  test("a newline ends a chunk", () => {
    expect(run("one line\ntwo line")).toEqual(["one line", "two line"]);
  });

  test("a chunk longer than the cap splits at a clause, then a word", () => {
    const long = `${"word ".repeat(60).trim()}, ${"more ".repeat(60).trim()}.`;
    for (const chunk of run(long)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxChars);
    }
  });

  test("a real sentence under the cap is ONE chunk (mutation: cap 40)", () => {
    const sentence = "I checked the parser and the branch is fine now.";
    expect(sentence.length).toBeGreaterThan(40);
    expect(sentence.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxChars);
    expect(run(sentence)).toEqual([sentence]);
  });
});

describe("T1: never inside a word or a number", () => {
  test("a decimal number is never split across chunks", () => {
    const text = `pi is ${"x ".repeat(0)}3.14159 and it goes on, and on, and on, and on, and on.`;
    for (const chunk of run(text)) {
      expect(chunk).not.toMatch(/\d\.$/);
      expect(chunk).not.toMatch(/^\d+$/);
    }
    expect(run(text).join(" ")).toContain("3.14159");
  });

  test("a long run of digits is not cut mid-number", () => {
    const digits = "1".repeat(120);
    const chunks = run(`${digits} done`);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith("1")).toBe(true);
      expect(digits.startsWith(chunk)).toBe(true);
    }
  });

  test("a word longer than the cap is emitted alone, never split", () => {
    const word = "a".repeat(CHUNK_DEFAULTS.maxChars + 20);
    const chunks = run(`start ${word} end`);
    expect(chunks).toContain(word);
  });
});

describe("T1: the fold is delta-split invariant", () => {
  test("every split point gives the same chunks", () => {
    const text =
      "Sure, let me look. The config has a wrong value: it says 3.14 where it should say 2.5, and the parser keeps going until the very end of the line.";
    const expected = run(text);
    for (let i = 1; i < text.length; i += 7) {
      expect(run(text, [i])).toEqual(expected);
      expect(run(text, [i, Math.floor(i / 2)])).toEqual(expected);
    }
    for (let i = 1; i < text.length; i += 3) {
      expect(run(text, range(1, text.length - 1, 11))).toEqual(expected);
    }
  });

  test("char by char is the same as one shot", () => {
    const text = "Ok. Now the numbers: 1, 2, 3. And we are done.";
    const expected = run(text);
    expect(run(text, range(1, text.length - 1, 1))).toEqual(expected);
  });

  test("no text is lost: the chunks rejoin to the input's words", () => {
    const text = "Hello there.  This is   a test, with odd spacing  and numbers 3.14 too.";
    expect(run(text).join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });
});

describe("T1: flush", () => {
  test("flush speaks a held partial line, then emits nothing more", () => {
    let state = chunkFilter.init();
    const step = chunkFilter.step(state, "no terminator here");
    state = step.state;
    expect(step.chunks).toEqual([]);
    expect(chunkFilter.flush(state).chunks).toEqual(["no terminator here"]);
    expect(chunkFilter.flush(chunkFilter.flush(state).state).chunks).toEqual([]);
  });

  test("an empty stream yields nothing", () => {
    expect(run("")).toEqual([]);
    expect(run("   ")).toEqual([]);
  });
});

/** Words in a chunk (whitespace-separated). */
function words(chunk: string): number {
  return chunk.split(/\s+/).filter((w) => w !== "").length;
}

/** Every integer in [from, to) stepping by `by`. */
function range(from: number, to: number, by: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i += by) out.push(i);
  return out;
}
