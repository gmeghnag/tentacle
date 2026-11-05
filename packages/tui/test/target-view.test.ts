import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { targetText } from "../src/target-view.ts";

describe("targetText with a limit (round 2, MEDIUM 3): cut the NAME in the middle, keep the engine word and /container", () => {
  const t = {
    engine: "kubernetes",
    name: "etcd-sharded-cluster-master-0",
    container: "etcd",
  } as const;

  test("fits: untouched", () => {
    expect(targetText(t, 60)).toBe("pod etcd-sharded-cluster-master-0/etcd");
  });

  test("does not fit: `pod etcd-shar…master-0/etcd`, exactly the limit", () => {
    const got = targetText(t, 27);
    expect(got).toBe("pod etcd-shar…master-0/etcd");
    expect([...got].length).toBe(27);
  });

  test("docker keeps its engine word; a tiny limit leaves `…` for the name", () => {
    expect(targetText({ engine: "docker", name: "tentacle-ba89d072" }, 19)).toBe(
      "docker tentac…9d072",
    );
    expect(targetText({ engine: "podman", name: "abcdefgh" }, 8)).toBe("podman…");
  });

  test("round 4 (LOW 3): the owner's `≥ 5` boundary — 5 name cells keep the container whole, 4 do not", () => {
    const t = { engine: "kubernetes", name: "abcdefghijklmnop", container: "abc" } as const;
    // "pod " (4) + name (5) + "/abc" (4) = 13: the name is cut alone.
    const five = targetText(t, 13);
    expect(five).toBe("pod ab…op/abc");
    // 12: the name would have 4 cells: name/container are cut TOGETHER.
    const four = targetText(t, 12);
    expect([...four].length).toBeLessThanOrEqual(12);
    expect(four.endsWith("/abc")).toBe(false);
    expect(four.startsWith("pod abc")).toBe(true);
  });

  test("round 4: wide characters are measured in cells, never code points", () => {
    const got = targetText(
      { engine: "kubernetes", name: "ポッド名前テスト-ポッド名前テスト", container: "コンテナ" },
      19,
    );
    expect(stringWidth(got)).toBeLessThanOrEqual(19);
    expect(got.startsWith("pod ")).toBe(true);
    for (const limit of [8, 12, 20, 30]) {
      const g = targetText({ engine: "docker", name: "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀" }, limit);
      expect(stringWidth(g)).toBeLessThanOrEqual(Math.max(limit, 7));
    }
  });
});

describe("targetText round 3 (owner rule): the engine word whole; cut the name, then name/container together; never past the limit", () => {
  const pod = "etcd-guard-sharedocp419-f84rv-master-0";

  test("owner example: `pod etcd…er-0/guard` — the container whole while the name keeps ≥ 5 cells", () => {
    const got = targetText({ engine: "kubernetes", name: pod, container: "guard" }, 19);
    expect(got).toBe("pod etcd…er-0/guard");
  });

  test("owner example: a 44-char container — name/container cut TOGETHER in the middle", () => {
    const container = `${"x".repeat(37)}ntainer`;
    expect(container).toHaveLength(44);
    const got = targetText({ engine: "kubernetes", name: pod, container }, 19);
    expect([...got].length).toBeLessThanOrEqual(19);
    expect(got.startsWith("pod etcd-gu…")).toBe(true);
    expect(got.endsWith("ntainer")).toBe(true);
  });

  test("a 63-char container (the k8s maximum): still within the limit, engine word whole", () => {
    const container = "c".repeat(63);
    for (const limit of [12, 19, 30, 40, 60]) {
      const got = targetText({ engine: "kubernetes", name: "pod-1", container }, limit);
      expect([...got].length).toBeLessThanOrEqual(limit);
      expect(got.startsWith("pod ")).toBe(true);
    }
  });

  test("property: for every name/container length and limit ≥ word+2, the result fits and keeps its engine word", () => {
    const engines = ["kubernetes", "docker", "podman"] as const;
    for (const engine of engines) {
      const word = engine === "kubernetes" ? "pod" : engine;
      for (const nameLen of [1, 5, 12, 40, 63]) {
        for (const containerLen of [0, 1, 5, 20, 44, 63]) {
          for (let limit = word.length + 2; limit <= 90; limit += 1) {
            const got = targetText(
              {
                engine,
                name: "n".repeat(nameLen),
                ...(containerLen > 0 && engine === "kubernetes"
                  ? { container: "c".repeat(containerLen) }
                  : {}),
              },
              limit,
            );
            expect({ got, ok: [...got].length <= limit }).toEqual({
              got,
              ok: true,
            });
            expect(got.startsWith(word)).toBe(true);
          }
        }
      }
    }
  });
});

describe("targetText: the badge's text (laptop-side facts only)", () => {
  test("docker / podman: engine + container name", () => {
    expect(targetText({ engine: "docker", name: "tentacle-ba89d072" })).toBe(
      "docker tentacle-ba89d072",
    );
    expect(targetText({ engine: "podman", name: "tentacle-x" })).toBe("podman tentacle-x");
  });

  test("kubernetes reads `pod <name>`; `/container` only when one is given", () => {
    expect(targetText({ engine: "kubernetes", name: "dev-1" })).toBe("pod dev-1");
    expect(targetText({ engine: "kubernetes", name: "dev-1", container: "app" })).toBe(
      "pod dev-1/app",
    );
  });
});
