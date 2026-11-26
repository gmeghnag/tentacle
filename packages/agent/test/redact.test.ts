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
