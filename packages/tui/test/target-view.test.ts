import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import {
  badgePrefix,
  minBadgeCells,
  shortBadgePrefix,
  targetParts,
  targetText,
} from "../src/target-view.ts";

describe("final pass (6): the `<engine>:<name>` format — no space, the prefix and the name apart", () => {
  test("prefixes: `kubernetes:` whole, `k8s:` short; docker/podman are short already", () => {
    expect(badgePrefix({ engine: "kubernetes", name: "p" })).toBe("kubernetes:");
    expect(shortBadgePrefix({ engine: "kubernetes", name: "p" })).toBe("k8s:");
    expect(badgePrefix({ engine: "docker", name: "p" })).toBe("docker:");
    expect(shortBadgePrefix({ engine: "podman", name: "p" })).toBe("podman:");
  });

  test("the two parts: prefix (colon included) and name (`/container` is the name's)", () => {
    expect(targetParts({ engine: "kubernetes", name: "dev-1", container: "app" })).toEqual({
      prefix: "kubernetes:",
      name: "dev-1/app",
    });
    expect(targetParts({ engine: "docker", name: "tentacle-x" })).toEqual({
      prefix: "docker:",
      name: "tentacle-x",
    });
  });

  test("whole badge too long → `k8s:` is used, and when that fits whole no name is cut", () => {
    const t = { engine: "kubernetes", name: "dev-1", container: "app" } as const;
    // `kubernetes:dev-1/app` = 20 cells, `k8s:dev-1/app` = 13.
    expect(targetText(t, 20)).toBe("kubernetes:dev-1/app");
    expect(targetText(t, 19)).toBe("k8s:dev-1/app");
    expect(targetText(t, 13)).toBe("k8s:dev-1/app");
    expect(targetText(t, 12)).not.toBe("k8s:dev-1/app");
  });

  test("the smallest badge is `k8s:…` (5), `docker:…` (8)", () => {
    expect(minBadgeCells({ engine: "kubernetes", name: "p" })).toBe(5);
    expect(minBadgeCells({ engine: "docker", name: "p" })).toBe(8);
    expect(targetText({ engine: "kubernetes", name: "pod-name", container: "c" }, 5)).toBe("k8s:…");
  });
});

describe("targetText with a limit: cut the NAME in the middle, keep the prefix and /container", () => {
  const t = {
    engine: "kubernetes",
    name: "etcd-sharded-cluster-master-0",
    container: "etcd",
  } as const;

  test("fits: untouched, with `kubernetes:`", () => {
    expect(targetText(t, 60)).toBe("kubernetes:etcd-sharded-cluster-master-0/etcd");
  });

  test("does not fit: `k8s:etcd-shar…master-0/etcd`, exactly the limit", () => {
    const got = targetText(t, 27);
    expect(got).toBe("k8s:etcd-shar…master-0/etcd");
    expect([...got].length).toBe(27);
  });

  test("docker keeps its prefix; a tiny limit leaves `…` for the name", () => {
    expect(targetText({ engine: "docker", name: "tentacle-ba89d072" }, 19)).toBe(
      "docker:tentac…9d072",
    );
    expect(targetText({ engine: "podman", name: "abcdefgh" }, 8)).toBe("podman:…");
  });

  test("the `≥ 5` boundary — 5 name cells keep the container whole, 4 do not", () => {
    const t = { engine: "kubernetes", name: "abcdefghijklmnop", container: "abc" } as const;
    // "k8s:" (4) + name (5) + "/abc" (4) = 13: the name is cut alone.
    const five = targetText(t, 13);
    expect(five).toBe("k8s:ab…op/abc");
    // 12: the name would have 4 cells: name/container are cut TOGETHER.
    const four = targetText(t, 12);
    expect([...four].length).toBeLessThanOrEqual(12);
    expect(four.endsWith("/abc")).toBe(false);
    expect(four.startsWith("k8s:abc")).toBe(true);
  });

  test("wide characters are measured in cells, never code points", () => {
    const got = targetText(
      { engine: "kubernetes", name: "ポッド名前テスト-ポッド名前テスト", container: "コンテナ" },
      19,
    );
    expect(stringWidth(got)).toBeLessThanOrEqual(19);
    expect(got.startsWith("k8s:")).toBe(true);
    for (const limit of [9, 12, 20, 30]) {
      const g = targetText({ engine: "docker", name: "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀" }, limit);
      expect(stringWidth(g)).toBeLessThanOrEqual(Math.max(limit, 8));
    }
  });
});

describe("owner rule: the prefix whole; cut the name, then name/container together; never past the limit", () => {
  const pod = "etcd-guard-sharedocp419-f84rv-master-0";

  test("owner frame at 40 columns: `k8s:etcd…er-0/guard` — the container whole while the name keeps ≥ 5 cells", () => {
    const got = targetText({ engine: "kubernetes", name: pod, container: "guard" }, 19);
    expect(got).toBe("k8s:etcd…er-0/guard");
  });

  test("owner frame at 80 columns: the whole `kubernetes:` badge", () => {
    const got = targetText({ engine: "kubernetes", name: pod, container: "guard" }, 60);
    expect(got).toBe("kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard");
  });

  test("a 44-char container — name/container cut TOGETHER in the middle", () => {
    const container = `${"x".repeat(37)}ntainer`;
    expect(container).toHaveLength(44);
    const got = targetText({ engine: "kubernetes", name: pod, container }, 19);
    expect([...got].length).toBeLessThanOrEqual(19);
    expect(got.startsWith("k8s:etcd-gu…")).toBe(true);
    expect(got.endsWith("ntainer")).toBe(true);
  });

  test("a 63-char container (the k8s maximum): within the limit, prefix whole", () => {
    const container = "c".repeat(63);
    for (const limit of [12, 19, 30, 40, 60]) {
      const got = targetText({ engine: "kubernetes", name: "pod-1", container }, limit);
      expect([...got].length).toBeLessThanOrEqual(limit);
      expect(got.startsWith("k8s:")).toBe(true);
    }
  });

  test("property: for every name/container length and limit ≥ min badge, the result fits and keeps its (short) prefix", () => {
    const engines = ["kubernetes", "docker", "podman"] as const;
    for (const engine of engines) {
      for (const nameLen of [1, 5, 12, 40, 63]) {
        for (const containerLen of [0, 1, 5, 20, 44, 63]) {
          const t = {
            engine,
            name: "n".repeat(nameLen),
            ...(containerLen > 0 && engine === "kubernetes"
              ? { container: "c".repeat(containerLen) }
              : {}),
          } as const;
          for (let limit = minBadgeCells(t); limit <= 100; limit += 1) {
            const got = targetText(t, limit);
            expect({ got, ok: [...got].length <= limit }).toEqual({ got, ok: true });
            expect(got.startsWith(badgePrefix(t)) || got.startsWith(shortBadgePrefix(t))).toBe(
              true,
            );
          }
        }
      }
    }
  });
});

describe("targetText: the badge's text (laptop-side facts only)", () => {
  test("docker / podman: `engine:name`", () => {
    expect(targetText({ engine: "docker", name: "tentacle-ba89d072" })).toBe(
      "docker:tentacle-ba89d072",
    );
    expect(targetText({ engine: "podman", name: "tentacle-x" })).toBe("podman:tentacle-x");
  });

  test("kubernetes reads `kubernetes:<pod>/<container>`", () => {
    expect(targetText({ engine: "kubernetes", name: "dev-1", container: "app" })).toBe(
      "kubernetes:dev-1/app",
    );
  });
});
