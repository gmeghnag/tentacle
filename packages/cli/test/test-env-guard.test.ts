import { describe, expect, test } from "bun:test";
import { NONEXISTENT, applyTestEnvGuard } from "../../../scripts/test-env-guard.ts";

const SHELL = {
  TENTACLE_POD_IMAGE: "img",
  TENTACLE_ENGINE: "docker",
  TENTACLE_PROFILE: "p",
  TENTACLE_K8S_TOKEN: "t",
  KUBECONFIG: "/real/kubeconfig",
  DOCKER_HOST: "tcp://real:2375",
  DOCKER_CONTEXT: "prod",
  CONTAINER_HOST: "ssh://real",
  HOME: "/Users/real",
};

describe("applyTestEnvGuard", () => {
  test("blanks the env that can reach real infrastructure", () => {
    const env: Record<string, string | undefined> = { ...SHELL };
    applyTestEnvGuard(env, "/scratch");
    expect(env.TENTACLE_POD_IMAGE).toBeUndefined();
    expect(env.TENTACLE_ENGINE).toBeUndefined();
    expect(env.TENTACLE_PROFILE).toBeUndefined();
    expect(env.TENTACLE_K8S_TOKEN).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.KUBECONFIG).toStartWith(NONEXISTENT);
    expect(env.DOCKER_HOST).toContain(NONEXISTENT);
    expect(env.CONTAINER_HOST).toContain(NONEXISTENT);
    expect(env.HOME).toBe("/scratch");
  });

  test("live-k8s opt-in keeps its server/token, never the image or engine", () => {
    const env: Record<string, string | undefined> = {
      ...SHELL,
      TENTACLE_K8S_SERVER: "https://k:6443",
    };
    applyTestEnvGuard(env, "/scratch");
    expect(env.TENTACLE_K8S_SERVER).toBe("https://k:6443");
    expect(env.TENTACLE_K8S_TOKEN).toBe("t");
    expect(env.TENTACLE_POD_IMAGE).toBeUndefined();
    expect(env.TENTACLE_ENGINE).toBeUndefined();
  });

  test("live-docker opt-in keeps the docker client env and HOME", () => {
    const env: Record<string, string | undefined> = {
      ...SHELL,
      TENTACLE_DOCKER_TESTS: "1",
      TENTACLE_DOCKER_IMAGE: "busybox",
    };
    applyTestEnvGuard(env, "/scratch");
    expect(env.TENTACLE_DOCKER_IMAGE).toBe("busybox");
    expect(env.DOCKER_HOST).toBe("tcp://real:2375");
    expect(env.HOME).toBe("/Users/real");
    expect(env.TENTACLE_POD_IMAGE).toBeUndefined();
  });

  test("slow opt-in is kept", () => {
    const env: Record<string, string | undefined> = { ...SHELL, TENTACLE_SLOW_TESTS: "1" };
    applyTestEnvGuard(env, "/scratch");
    expect(env.TENTACLE_SLOW_TESTS).toBe("1");
  });
});

describe("the preload is active in this process", () => {
  test("no shell endpoint reaches the tests", () => {
    if (process.env.TENTACLE_DOCKER_TESTS === "1" || process.env.TENTACLE_K8S_SERVER) return;
    expect(process.env.TENTACLE_POD_IMAGE).toBeUndefined();
    expect(process.env.TENTACLE_ENGINE).toBeUndefined();
    expect(process.env.KUBECONFIG).toStartWith(NONEXISTENT);
    expect(process.env.HOME).toContain("tentacle-test-home-");
  });
});
