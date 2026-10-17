import { describe, expect, test } from "bun:test";
import { isSensitiveEnvKey, scrubSensitiveEnv } from "../src/env.ts";

describe("isSensitiveEnvKey", () => {
  test("flags keys that look like secrets", () => {
    for (const key of [
      "TENTACLE_MODEL_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "TENTACLE_REMOTE_TOKEN",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "SOME_PRIVATE_KEY",
      "GOOGLE_CREDENTIALS",
      "TENTACLE_POD_TLS_KEY",
      "TENTACLE_POD_TLS_CERT",
      "TENTACLE_POD_TLS_CA",
    ]) {
      expect(isSensitiveEnvKey(key)).toBe(true);
    }
  });

  test("leaves ordinary vars alone", () => {
    for (const key of [
      "PATH",
      "HOME",
      "LANG",
      "TERM",
      "PWD",
      "SHELL",
      "TENTACLE_POD_TLS_INSECURE",
    ]) {
      expect(isSensitiveEnvKey(key)).toBe(false);
    }
  });
});

describe("scrubSensitiveEnv", () => {
  test("drops secret keys and undefined values, keeps the rest", () => {
    const scrubbed = scrubSensitiveEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      TENTACLE_MODEL_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_x",
      TENTACLE_POD_TLS_CA: "ca-pem",
      TENTACLE_POD_TLS_INSECURE: "1",
      EMPTY: undefined,
    });
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/home/u", TENTACLE_POD_TLS_INSECURE: "1" });
    expect(scrubbed).not.toHaveProperty("TENTACLE_MODEL_API_KEY");
    expect(scrubbed).not.toHaveProperty("GITHUB_TOKEN");
    expect(scrubbed).not.toHaveProperty("TENTACLE_POD_TLS_CA");
  });
});
