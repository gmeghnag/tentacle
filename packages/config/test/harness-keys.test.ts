/** `harnesses` (docs/feat/subagent-harness-runners.md D3/D6): defaults, refusals. */
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const resolve = (fileConfig: object) =>
  resolveConfig({ fileConfig: FileConfigSchema.parse(fileConfig), env: {}, defaultCwd: "/w" });

describe("harnesses", () => {
  test("claude-code is there by default: on, `claude`, `opus`, 15 min, not configured", () => {
    expect(resolve({}).harnesses).toEqual({
      "claude-code": {
        adapter: "claude-code",
        enabled: true,
        command: "claude",
        model: "opus",
        idleMinutes: 15,
        configured: false,
      },
    });
  });

  test("a written entry overrides field by field and is marked configured", () => {
    expect(
      resolve({ harnesses: { "claude-code": { enabled: false, model: "sonnet" } } }).harnesses[
        "claude-code"
      ],
    ).toEqual({
      adapter: "claude-code",
      enabled: false,
      command: "claude",
      model: "sonnet",
      idleMinutes: 15,
      configured: true,
    });
  });

  test("an unknown instance, a flag-shaped model and an unknown field are refused", () => {
    for (const bad of [
      { harnesses: { codex: {} } },
      { harnesses: { "claude-code": { model: "--yolo" } } },
      { harnesses: { "claude-code": { maxBudgetUsd: 1 } } },
    ]) {
      expect(FileConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
});

// docs/feat/a2a-client.md C1 (slice a2c-3): a remote agent is a harness instance.
describe("harnesses: adapter a2a", () => {
  const CARD = "https://agents.acme.dev/.well-known/agent-card.json";

  test("an a2a entry resolves with its defaults (user, 30 min, on) beside claude-code", () => {
    const h = resolve({ harnesses: { "acme-reviewer": { adapter: "a2a", card: CARD } } }).harnesses;
    expect(h["acme-reviewer"]).toEqual({
      adapter: "a2a",
      enabled: true,
      card: CARD,
      inputFrom: "user",
      idleMinutes: 30,
      configured: true,
    });
    expect(h["claude-code"]?.adapter).toBe("claude-code");
  });

  test("every field written is kept", () => {
    const h = resolve({
      harnesses: {
        acme: {
          adapter: "a2a",
          card: "http://127.0.0.1:4001/.well-known/agent-card.json",
          tokenCommand: "op read op://dev/acme/token",
          description: "Reviews Go PRs",
          inputFrom: "both",
          idleMinutes: 5,
          enabled: false,
        },
      },
    }).harnesses.acme;
    expect(h).toMatchObject({
      tokenCommand: "op read op://dev/acme/token",
      description: "Reviews Go PRs",
      inputFrom: "both",
      idleMinutes: 5,
      enabled: false,
    });
  });

  test("a literal token has nowhere to go: refused", () => {
    expect(
      FileConfigSchema.safeParse({
        harnesses: { acme: { adapter: "a2a", card: CARD, token: "s3cret" } },
      }).success,
    ).toBe(false);
  });

  test("card: http only for loopback, no userinfo, a URL", () => {
    const ok = (card: string) =>
      FileConfigSchema.safeParse({ harnesses: { acme: { adapter: "a2a", card } } }).success;
    expect(ok(CARD)).toBe(true);
    expect(ok("http://localhost:8080/card")).toBe(true);
    expect(ok("http://[::1]:8080/card")).toBe(true);
    expect(ok("http://agents.acme.dev/card")).toBe(false);
    expect(ok("http://192.168.1.5/card")).toBe(false);
    expect(ok("https://user:pw@agents.acme.dev/card")).toBe(false);
    expect(ok("ftp://agents.acme.dev/card")).toBe(false);
    expect(ok("not a url")).toBe(false);
  });

  test("names: [a-z0-9][a-z0-9-]{0,31}; another name needs adapter a2a; claude-code stays Claude Code", () => {
    for (const bad of [
      { harnesses: { Acme: { adapter: "a2a", card: CARD } } },
      { harnesses: { "-acme": { adapter: "a2a", card: CARD } } },
      { harnesses: { ["a".repeat(33)]: { adapter: "a2a", card: CARD } } },
      { harnesses: { acme: { card: CARD } } },
      { harnesses: { "claude-code": { adapter: "a2a", card: CARD } } },
      { harnesses: { acme: { adapter: "a2a" } } },
    ]) {
      expect(FileConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
});
