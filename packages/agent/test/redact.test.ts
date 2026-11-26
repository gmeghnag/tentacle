import { describe, expect, test } from "bun:test";
import { DEFAULT_REDACT_RULES, findSecrets, redactSecrets, redactText } from "../src/redact.ts";
import type { ResultTransformContext } from "../src/result-pipeline.ts";

const ctx = {} as ResultTransformContext;

// docs/feat/session-apps-publish.md D5: the publish ask names what looks secret
// (rule + line), never the value. Assembled from parts so this file holds no
// secret-looking literal.
describe("findSecrets", () => {
  const VALUES: Record<string, string> = {
    "private-key": `-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----`,
    jwt: `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4`,
    "github-token": `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`,
    "slack-token": `xoxb-${"1234567890-abcdefghij"}`,
    "aws-access-key": `AKIA${"ABCDEFGHIJKLMNOP"}`,
    "google-api-key": `AIza${"SyA1234567890abcdefghijklmnopqrstuv"}`,
    "openai-key": `sk-${"abcdefghijklmnopqrstuvwxyz0123"}`,
    bearer: `Bearer ${"abcdef0123456789xyz"}`,
    "url-credentials": `https://alice:${"hunter2pass"}@example.com/`,
    assignment: `password = "${"correcthorse"}"`,
  };

  test("every default rule has a case here", () => {
    expect(Object.keys(VALUES).sort()).toEqual(DEFAULT_REDACT_RULES.map((r) => r.name).sort());
  });

  for (const [rule, value] of Object.entries(VALUES)) {
    test(`${rule}: found with its 1-based line, the value nowhere in the result`, () => {
      const found = findSecrets(`<html>\n<body>\n<p>${value}</p>\n</body>`);
      expect(found).toContainEqual({ rule, line: 3 });
      const dumped = JSON.stringify(found);
      for (const word of value.split(/[\s"':@/]+/).filter((w) => w.length > 8)) {
        expect(dumped).not.toContain(word);
      }
      for (const finding of found) expect(Object.keys(finding).sort()).toEqual(["line", "rule"]);
    });
  }

  test("clean text finds nothing", () => {
    expect(findSecrets("<html><body><h1>Hello</h1></body></html>\n")).toEqual([]);
    expect(findSecrets("")).toEqual([]);
  });

  test("capped at 20, the first ones in reading order", () => {
    const text = Array.from({ length: 50 }, (_, i) => `row ${i} ${VALUES["aws-access-key"]}`);
    const found = findSecrets(text.join("\n"));
    expect(found).toHaveLength(20);
    expect(found.map((f) => f.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("the cap keeps reading order across rules, and a second scan agrees", () => {
    const text = `${VALUES["slack-token"]}\n${VALUES["github-token"]}\n${VALUES["slack-token"]}`;
    const found = findSecrets(text, DEFAULT_REDACT_RULES, 2);
    expect(found.map((f) => f.line)).toEqual([1, 2]);
    expect(findSecrets(text, DEFAULT_REDACT_RULES, 2)).toEqual(found);
  });
});

// Fix round 1: the scan runs synchronously, before anyone is asked, on a page
// the model wrote (≤ 10 MiB). No input may make it super-linear.
describe("findSecrets on a crafted page", () => {
  // Sizes at which the backtracking patterns take 5 s or more.
  const CRAFTED: [name: string, unit: string, kib: number][] = [
    ["scheme run (url-credentials)", "a.", 256],
    ["token header run (jwt)", "eyJ-", 256],
    ["unterminated key headers (private-key)", `-----BEGIN ${"PRIVATE"} KEY-----\n`, 1024],
  ];

  for (const [name, unit, kib] of CRAFTED) {
    test(`${name}: ${kib} KiB in well under a second`, () => {
      const text = unit.repeat(Math.ceil((kib * 1024) / unit.length));
      const began = performance.now();
      expect(findSecrets(text)).toEqual([]);
      expect(performance.now() - began).toBeLessThan(1000);
    });
  }

  // `findSecrets` and output redaction share one rule table (D5): a rule scanned
  // its own way must still find exactly what its pattern replaces.
  test("every rule's scan finds exactly what its pattern matches", () => {
    const pieces = [
      ...["a", "Z", "7", "_", "-", ".", ":", "/", "@", " ", "\n", '"', "=", "é"],
      ...["://", "eyJ", "abcdefgh", "-----", "BEGIN ", "END ", "PRIVATE KEY", "RSA "],
      `-----BEGIN ${"PRIVATE"} KEY-----`,
      `-----END ${"PRIVATE"} KEY-----`,
      "eyJabcdefgh.abcdefgh.abcdefgh",
      ".abcdefgh",
      "https://",
      "user:pass@",
    ];
    // A seeded generator: a failure reproduces.
    let seed = 12345;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const matched = new Map<string, number>();
    for (let round = 0; round < 20_000; round++) {
      const length = 1 + next(24);
      let text = "";
      for (let i = 0; i < length; i++) text += pieces[next(pieces.length)] ?? "";
      for (const rule of DEFAULT_REDACT_RULES) {
        if (!rule.starts) continue;
        const expected = [...text.matchAll(rule.pattern)].map((m) => m.index);
        expect({ rule: rule.name, text, at: [...rule.starts(text)] }).toEqual({
          rule: rule.name,
          text,
          at: expected,
        });
        matched.set(rule.name, (matched.get(rule.name) ?? 0) + expected.length);
      }
    }
    // Not vacuous: each own scan met real matches.
    expect([...matched.keys()].sort()).toEqual(["jwt", "private-key", "url-credentials"]);
    for (const count of matched.values()) expect(count).toBeGreaterThan(100);
  });
});

describe("redactText", () => {
  test("masks an OpenAI-style key", () => {
    const out = redactText("export KEY=sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).toContain("[REDACTED]");
  });

  test("masks a bearer token but keeps the word Bearer", () => {
    const out = redactText("Authorization: Bearer abcdef0123456789xyz");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abcdef0123456789xyz");
  });

  test("masks a private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(redactText(pem)).toBe("[REDACTED: private key]");
  });

  test("masks a JWT and URL credentials", () => {
    expect(redactText("tok eyJABCDEFGH.IJKLMNOPQR.STUVWXYZ12")).toContain("[REDACTED: jwt]");
    expect(redactText("clone https://user:p4ssw0rd@github.com/x")).toContain(
      "https://[REDACTED]@github.com/x",
    );
  });

  test("masks assignments of sensitive keys", () => {
    const out = redactText('{"api_key": "verysecretvalue123"}');
    expect(out).not.toContain("verysecretvalue123");
    expect(out).toContain("[REDACTED]");
  });

  test("leaves ordinary text untouched", () => {
    const text = "just some normal output with numbers 12345";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactSecrets transform", () => {
  test("redacts a result's content and preserves identity when nothing matches", async () => {
    const clean = { content: "all good" };
    expect(await redactSecrets()(clean, ctx)).toBe(clean);

    const dirty = await redactSecrets()(
      { content: "token=ghp_0123456789abcdefghijklmnopqrstuvwxyz", isError: false },
      ctx,
    );
    expect(dirty.content).toContain("[REDACTED]");
    expect(dirty.content).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });
});
