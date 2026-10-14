import { describe, expect, test } from "bun:test";
import { redactSecrets, redactText } from "../src/redact.ts";
import type { ResultTransformContext } from "../src/result-pipeline.ts";

const ctx = {} as ResultTransformContext;

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
