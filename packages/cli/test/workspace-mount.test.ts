import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaseFs,
  DEFAULT_HIDE,
  HIDE_CAP,
  HIDE_FILE_MAX_BYTES,
  type HideFileFs,
  type HideFs,
  WORKSPACE_LABELS,
  type WorkspaceInput,
  type WorkspaceMount,
  apiKeyFileOf,
  apiKeyFileUnknown,
  attachCwdWarning,
  caseAliasedFiles,
  engineFacts,
  hiddenSummary,
  hideList,
  hidesPath,
  isYes,
  loadHideFile,
  mountGate,
  parseHideFile,
  planWorkspace,
  resolveHideFile,
  workspaceEngineOptions,
  workspaceLabels,
  workspaceMounts,
  workspaceProbeCommand,
  workspaceProbeProblem,
} from "../src/workspace-mount.ts";

const base: WorkspaceInput = {
  engine: "docker",
  endpointLocal: true,
  endpointLabel: "unix:///var/run/docker.sock",
  noMount: false,
  cwd: "/Users/me/repo",
  realCwd: "/Users/me/repo",
  home: "/Users/me",
  configDir: "/Users/me/.config/tentacle",
  sshDir: "/Users/me/.ssh",
  hide: [{ label: "~/.ssh", path: "/Users/me/.ssh", file: false }],
  binDir: "/usr/local/bin",
  entries: ["README.md", "src"],
};

const plan = (over: Partial<WorkspaceInput> = {}) => planWorkspace({ ...base, ...over });

const mountOf = (over: Partial<WorkspaceInput> = {}): WorkspaceMount => {
  const p = plan(over);
  if (p.kind !== "mount") {
    throw new Error(`expected a mount, got ${p.kind}`);
  }
  return p.mount;
};

/** The masked container paths. */
const paths = (m: WorkspaceMount): string[] => m.masks.map((mask) => mask.path);

const refusal = (over: Partial<WorkspaceInput>): string => {
  const p = plan(over);
  if (p.kind !== "refuse") {
    throw new Error(`expected a refusal, got ${p.kind}`);
  }
  return p.message;
};

describe("planWorkspace: when to mount", () => {
  test("a project dir on a local engine → mount source=realpath at target=logical cwd", () => {
    const p = plan({ cwd: "/tmp/x/repo", realCwd: "/private/tmp/x/repo" });
    expect(p).toEqual({
      kind: "mount",
      mount: {
        source: "/private/tmp/x/repo",
        target: "/tmp/x/repo",
        masks: [],
        probeEntry: "README.md",
      },
    });
  });

  test("kubernetes never mounts (no warning: k8s has no laptop files)", () => {
    expect(plan({ engine: "kubernetes" })).toEqual({ kind: "none" });
  });

  test("--no-mount → none", () => {
    expect(plan({ noMount: true })).toEqual({ kind: "none" });
  });

  test("a remote engine → NO mount + a clear warning (M3), never a silent empty mount", () => {
    const p = plan({ endpointLocal: false, endpointLabel: "ssh://me@box" });
    expect(p.kind).toBe("none");
    expect(p.kind === "none" ? p.warning : "").toContain(
      "remote engine ssh://me@box: the laptop folder /Users/me/repo is NOT mounted",
    );
  });

  test("an empty folder has no probe entry", () => {
    expect(mountOf({ entries: [] }).probeEntry).toBeUndefined();
  });
});

describe("planWorkspace: dangerous sources → confirmation (M5), never silently", () => {
  for (const [label, over, kind] of [
    ["$HOME", { cwd: "/Users/me", realCwd: "/Users/me" }, "your home directory"],
    ["an ancestor of $HOME", { cwd: "/Users", realCwd: "/Users" }, "an ancestor of your home"],
    [
      "a dir on the hide list (~/.aws)",
      {
        cwd: "/Users/me/.aws",
        realCwd: "/Users/me/.aws",
        hide: [{ label: "~/.aws", path: "/Users/me/.aws", file: false }],
      },
      "~/.aws, on your hide list",
    ],
    ["/etc", { cwd: "/etc", realCwd: "/private/etc" }, "a system directory"],
    ["/var", { cwd: "/var", realCwd: "/var" }, "a system directory"],
    ["/opt", { cwd: "/opt", realCwd: "/opt" }, "a system directory"],
  ] as const) {
    test(`${label} → danger "${kind}"`, () => {
      const p = plan(over);
      expect(p.kind).toBe("mount");
      expect(p.kind === "mount" ? p.danger : undefined).toContain(kind);
    });
  }

  test("a project under a system dir is not itself dangerous (/opt/app, /tmp/x)", () => {
    expect(plan({ cwd: "/opt/app", realCwd: "/opt/app" })).not.toHaveProperty("danger");
    expect(plan({ cwd: "/tmp/x", realCwd: "/private/tmp/x" })).not.toHaveProperty("danger");
  });

  test("a symlinked cwd is judged by its realpath (a link to $HOME is $HOME)", () => {
    const p = plan({ cwd: "/work/link", realCwd: "/Users/me" });
    expect(p.kind === "mount" ? p.danger : undefined).toContain("your home directory");
  });
});

describe("planWorkspace: refusals (D-1: no confirmation can override)", () => {
  test("a SOURCE of /, /usr, /usr/local, /usr/local/bin is refused, explaining the binary clash", () => {
    for (const src of ["/", "/usr", "/usr/local", "/usr/local/bin"]) {
      // Even reached through a symlinked cwd, and with --bin-dir moved away.
      const message = refusal({ cwd: "/work/link", realCwd: src, binDir: "/opt/tbin" });
      expect(message).toContain(`Refusing to mount ${src}`);
      expect(message).toContain("tentacle installs its binary");
    }
  });

  test("a TARGET that contains the injection dir is refused (--bin-dir clash)", () => {
    const custom = refusal({ cwd: "/tmp/w", realCwd: "/tmp/w", binDir: "/tmp/w/bin" });
    expect(custom).toContain("--bin-dir");
  });

  for (const [label, src, why] of [
    ["the config dir", "/Users/me/.config/tentacle", "tentacle's config directory"],
    ["inside the config dir", "/Users/me/.config/tentacle/sessions", "tentacle's config directory"],
    ["~/.ssh", "/Users/me/.ssh", "your SSH directory"],
    ["inside ~/.ssh", "/Users/me/.ssh/keys", "your SSH directory"],
  ] as const) {
    test(`a cwd that IS / is INSIDE a secret dir (${label}) is refused`, () => {
      const message = refusal({ cwd: src, realCwd: src });
      expect(message).toContain(`Refusing to mount ${src}: it is ${why}`);
      expect(message).toContain("cannot hide the mount root");
    });
  }

  test("a symlink to the config dir is judged by its realpath — still refused", () => {
    expect(refusal({ cwd: "/work/cfg-link", realCwd: "/Users/me/.config/tentacle" })).toContain(
      "tentacle's config directory",
    );
  });

  test("~/.ssh is refused even when the user removed it from the hide list", () => {
    expect(refusal({ cwd: "/Users/me/.ssh", realCwd: "/Users/me/.ssh", hide: [] })).toContain(
      "your SSH directory",
    );
  });

  test("a sibling with a common prefix is not inside (/Users/me/.sshx is mountable)", () => {
    expect(plan({ cwd: "/Users/me/.sshx", realCwd: "/Users/me/.sshx" }).kind).toBe("mount");
  });

  test("a relative or NUL path is refused", () => {
    expect(plan({ cwd: "repo", realCwd: "repo" }).kind).toBe("refuse");
    expect(plan({ realCwd: "/Users/me/re\0po" }).kind).toBe("refuse");
  });
});

describe("planWorkspace: masks (M5b, D-2)", () => {
  const homeHide = [
    { label: "~/.ssh", path: "/Users/me/.ssh", file: false },
    { label: "~/.docker/config.json", path: "/Users/me/.docker/config.json", file: true },
    { label: "~/.netrc", path: "/Users/me/.netrc", file: true },
  ];

  test("every hide entry inside the source + the config dir, in list order (config last)", () => {
    const m = mountOf({
      cwd: "/Users/me",
      realCwd: "/Users/me",
      hide: homeHide,
      entries: [".netrc", ".ssh", "code"],
    });
    expect(m.masks).toEqual([
      { path: "/Users/me/.ssh", file: false, label: "~/.ssh" },
      { path: "/Users/me/.docker/config.json", file: true, label: "~/.docker/config.json" },
      { path: "/Users/me/.netrc", file: true, label: "~/.netrc" },
      { path: "/Users/me/.config/tentacle", file: false, label: "tentacle's config" },
    ]);
    // The probe entry is never a masked one.
    expect(m.probeEntry).toBe("code");
  });

  test("the config dir is masked even with an EMPTY hide list (not configurable)", () => {
    expect(paths(mountOf({ cwd: "/Users/me", realCwd: "/Users/me", hide: [] }))).toEqual([
      "/Users/me/.config/tentacle",
    ]);
  });

  test("a mask is placed under the LOGICAL target even when the source is a realpath", () => {
    const m = mountOf({
      cwd: "/home/me",
      realCwd: "/data/me",
      hide: [{ label: "~/.ssh", path: "/data/me/.ssh", file: false }],
    });
    expect(paths(m)).toEqual(["/home/me/.ssh"]);
  });

  test("a symlinked hide entry is masked where it REALLY lives (symlinks cannot bypass)", () => {
    const m = mountOf({
      hide: [{ label: "~/.ssh", path: "/Users/me/repo/dotfiles/ssh", file: false }],
    });
    expect(paths(m)).toEqual(["/Users/me/repo/dotfiles/ssh"]);
  });

  test("a custom config dir (TENTACLE_CONFIG_DIR) inside the source is masked", () => {
    expect(paths(mountOf({ configDir: "/Users/me/repo/.tentacle-cfg" }))).toEqual([
      "/Users/me/repo/.tentacle-cfg",
    ]);
  });

  test("the apiKeyCommand key file (resolved by the caller into the list) is masked as a FILE", () => {
    const m = mountOf({
      hide: [{ label: "the API key file", path: "/Users/me/repo/.key", file: true }],
    });
    expect(m.masks).toEqual([
      { path: "/Users/me/repo/.key", file: true, label: "the API key file" },
    ]);
  });

  test("paths outside the source are not masked (nothing to hide)", () => {
    expect(mountOf().masks).toEqual([]);
  });

  test("a sibling with a common prefix is NOT inside (/Users/me/repo-x vs /Users/me/repo)", () => {
    expect(
      mountOf({ hide: [{ label: "x", path: "/Users/me/repo-x/.ssh", file: false }] }).masks,
    ).toEqual([]);
  });
});

describe("hideList / apiKeyFileOf (D-2)", () => {
  test("the default list; hide REPLACES it; hideExtra ADDS; duplicates collapse", () => {
    expect(DEFAULT_HIDE).toEqual([
      "~/.ssh",
      "~/.aws",
      "~/.kube",
      "~/.config/gcloud",
      "~/.docker/config.json",
      "~/.netrc",
    ]);
    expect(hideList(undefined, undefined).map((h) => h.path)).toEqual([...DEFAULT_HIDE]);
    expect(hideList({ hide: ["~/.aws"] }, undefined).map((h) => h.path)).toEqual(["~/.aws"]);
    expect(hideList({ hideExtra: ["~/.pgpass", "~/.ssh"] }, undefined).map((h) => h.path)).toEqual([
      ...DEFAULT_HIDE,
      "~/.pgpass",
    ]);
    expect(hideList({ hide: [], hideExtra: ["/s/x"] }, undefined)).toEqual([
      { label: "/s/x", path: "/s/x" },
    ]);
  });

  test("the API key file is ALWAYS in the list, even with hide: []", () => {
    expect(hideList({ hide: [] }, "cat ~/.cache/anthropic-key")).toEqual([
      { label: "the API key file", path: "~/.cache/anthropic-key", always: true },
    ]);
  });

  test("apiKeyFileOf: `cat [--] <path>` (quoted or not); anything else is not a file", () => {
    expect(apiKeyFileOf("cat ~/.cache/k")).toBe("~/.cache/k");
    expect(apiKeyFileOf("  cat   /etc/k  ")).toBe("/etc/k");
    expect(apiKeyFileOf("cat -- '/a b/k'")).toBe("/a b/k");
    expect(apiKeyFileOf('cat "/a b/k"')).toBe("/a b/k");
    expect(apiKeyFileOf("cat keyfile")).toBe("keyfile");
    for (const other of ["pass show api", "cat a b", "cat ~/k | tr -d x", "op read x", "cat"]) {
      expect(apiKeyFileOf(other)).toBeUndefined();
    }
  });
});

describe("mountGate (M5): ask before Ink, refuse without a TTY", () => {
  const dangerous = plan({ cwd: "/Users/me", realCwd: "/Users/me" });
  const etc = plan({ cwd: "/etc", realCwd: "/etc" });

  test("a safe mount proceeds without asking", () => {
    expect(mountGate(plan(), { interactive: false, confirmed: false })).toEqual({
      action: "proceed",
    });
  });

  test("interactive → the exact prompt (with masks: the hidden-dirs line)", () => {
    expect(mountGate(dangerous, { interactive: true, confirmed: false })).toEqual({
      action: "ask",
      prompt:
        "⚠ You are about to mount /Users/me (your home directory) into the container.\n" +
        "The agent will be able to read everything in it except ~/.ssh and tentacle's config, which stay hidden.\n" +
        "Hidden from the container: 0 paths from .tentacle/hide, 2 defaults\n" +
        "Continue? [y/N] ",
    });
  });

  test("the prompt LISTS what stays hidden (D-2)", () => {
    const home = plan({
      cwd: "/Users/me",
      realCwd: "/Users/me",
      hide: [
        { label: "~/.ssh", path: "/Users/me/.ssh", file: false },
        { label: "~/.netrc", path: "/Users/me/.netrc", file: true },
        { label: "the API key file", path: "/Users/me/.cache/k", file: true },
      ],
    });
    const gate = mountGate(home, { interactive: true, confirmed: false });
    expect(gate.action === "ask" ? gate.prompt : "").toContain(
      "The agent will be able to read everything in it except ~/.ssh, ~/.netrc, the API key file and tentacle's config, which stay hidden.\n",
    );
  });

  test("interactive, no mask applies → the owner's original second line", () => {
    const gate = mountGate(etc, { interactive: true, confirmed: false });
    expect(gate.action === "ask" ? gate.prompt : "").toContain(
      "The agent will be able to read everything in it: SSH keys, tokens, configs.\n",
    );
  });

  test("non-interactive → refused with the exact message", () => {
    expect(mountGate(dangerous, { interactive: false, confirmed: false })).toEqual({
      action: "refuse",
      message:
        "Refusing to mount /Users/me (your home directory) without confirmation.\n" +
        "Run from your project directory, or pass --confirm-mount to proceed.",
    });
  });

  test("--confirm-mount proceeds (interactive or not)", () => {
    for (const interactive of [true, false]) {
      expect(mountGate(dangerous, { interactive, confirmed: true })).toEqual({
        action: "proceed",
      });
    }
  });

  test("isYes: default No — only y/yes", () => {
    expect(["y", "Y", "yes", " YES \n"].map(isYes)).toEqual([true, true, true, true]);
    expect(["", "\n", "n", "no", "yy", "ok"].map(isYes)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("workspaceEngineOptions (M2, M4)", () => {
  const laptop = { kind: "docker" as const, platform: "linux", uid: 1000, gid: 1000 };
  const rootful = { rootless: false, selinux: false, desktop: false };

  test("laptop uid:gid ONLY on rootful Docker on Linux", () => {
    expect(workspaceEngineOptions(rootful, laptop)).toEqual({ user: "1000:1000" });
    expect(workspaceEngineOptions({ ...rootful, rootless: true }, laptop)).toEqual({});
    expect(workspaceEngineOptions({ ...rootful, desktop: true }, laptop)).toEqual({});
    expect(workspaceEngineOptions(rootful, { ...laptop, platform: "darwin" })).toEqual({});
    expect(workspaceEngineOptions(rootful, { ...laptop, kind: "podman" })).toEqual({});
    // Root on the laptop: nothing to map.
    expect(workspaceEngineOptions(rootful, { ...laptop, uid: 0, gid: 0 })).toEqual({});
  });

  test("SELinux → label=disable (never :z relabelling)", () => {
    expect(
      workspaceEngineOptions({ ...rootful, selinux: true }, { ...laptop, kind: "podman" }),
    ).toEqual({
      securityOpt: ["label=disable"],
    });
  });

  test("engineFacts parses /info (unknown → rootful, no SELinux, not Desktop)", () => {
    expect(
      engineFacts({
        OperatingSystem: "Docker Desktop",
        SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=selinux"],
      }),
    ).toEqual({ rootless: true, selinux: true, desktop: true });
    expect(engineFacts({ OperatingSystem: "Ubuntu 24.04", SecurityOptions: null })).toEqual({
      rootless: false,
      selinux: false,
      desktop: false,
    });
  });
});

describe("workspaceMounts / labels: what the container gets", () => {
  test("one structured bind (rw); a masked DIR → empty ro tmpfs; a masked FILE → ro bind of /dev/null", () => {
    const m = mountOf({
      cwd: "/Users/me",
      realCwd: "/Users/me",
      hide: [
        { label: "~/.ssh", path: "/Users/me/.ssh", file: false },
        { label: "~/.netrc", path: "/Users/me/.netrc", file: true },
      ],
    });
    expect(workspaceMounts(m)).toEqual([
      { Type: "bind", Source: "/Users/me", Target: "/Users/me", ReadOnly: false },
      { Type: "tmpfs", Target: "/Users/me/.ssh", ReadOnly: true },
      { Type: "bind", Source: "/dev/null", Target: "/Users/me/.netrc", ReadOnly: true },
      { Type: "tmpfs", Target: "/Users/me/.config/tentacle", ReadOnly: true },
    ]);
  });

  test("labels: workspace, source, masked (JSON), user — empty strings without a mount", () => {
    const m = mountOf({
      cwd: "/w/a,b:c",
      realCwd: "/w/a,b:c",
      hide: [{ label: "~/.ssh", path: "/w/a,b:c/.ssh", file: false }],
    });
    expect(workspaceLabels(m, "1000:1000")).toEqual({
      [WORKSPACE_LABELS.workspace]: "/w/a,b:c",
      [WORKSPACE_LABELS.source]: "/w/a,b:c",
      [WORKSPACE_LABELS.masked]: '["/w/a,b:c/.ssh"]',
      [WORKSPACE_LABELS.user]: "1000:1000",
    });
    expect(workspaceLabels(undefined, undefined)).toEqual({
      "tentacle.workspace": "",
      "tentacle.workspace-source": "",
      "tentacle.workspace-masked": "",
      "tentacle.workspace-user": "",
    });
  });
});

describe("post-start probe (M5b)", () => {
  const m = mountOf({
    cwd: "/Users/me",
    realCwd: "/Users/me",
    entries: ["code"],
    hide: [
      { label: "~/.ssh", path: "/Users/me/.ssh", file: false },
      { label: "~/.netrc", path: "/Users/me/.netrc", file: true },
    ],
  });

  test("paths are positional args (d:/f: = dir/file mask), never interpolated into the script", () => {
    const cmd = workspaceProbeCommand(m);
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(cmd.slice(3)).toEqual([
      "tentacle-workspace-probe",
      "/Users/me",
      "code",
      "d:/Users/me/.ssh",
      "f:/Users/me/.netrc",
      "d:/Users/me/.config/tentacle",
    ]);
    expect(cmd[2]).not.toContain("/Users/me");
  });

  test("the probe script checks a file mask is an EMPTY non-directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-probe-"));
    try {
      await mkdir(join(dir, "d"));
      await writeFile(join(dir, "empty"), "");
      await writeFile(join(dir, "full"), "secret");
      const script = workspaceProbeCommand(m)[2] as string;
      const run = (...masks: string[]) =>
        Bun.spawnSync(["sh", "-c", script, "p", dir, "", ...masks]).exitCode;
      expect(run(`d:${dir}/d`, `f:${dir}/empty`, "f:/dev/null")).toBe(0);
      expect(run(`f:${dir}/full`)).toBe(7);
      expect(run(`f:${dir}/d`)).toBe(7);
      expect(run(`f:${dir}/missing`)).toBe(6);
      await writeFile(join(dir, "d", "x"), "");
      expect(run(`d:${dir}/d`)).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exit 0 → no problem; a visible mask → a secret would be visible", () => {
    expect(workspaceProbeProblem({ exitCode: 0, stdout: "ok\n", stderr: "" }, m)).toBeNull();
    const masked = workspaceProbeProblem(
      { exitCode: 7, stdout: "mask /Users/me/.ssh is not empty\n", stderr: "" },
      m,
    );
    expect(masked).toContain("mask /Users/me/.ssh is not empty");
    expect(masked).toContain("a secret would be visible");
  });

  test("an empty / unshared mount is actionable (file sharing, --no-mount)", () => {
    const empty = workspaceProbeProblem(
      { exitCode: 5, stdout: "workspace /Users/me looks empty (code is missing)\n", stderr: "" },
      m,
    );
    expect(empty).toContain("File sharing");
    expect(empty).toContain("--no-mount");
  });
});

describe("attachCwdWarning (M7)", () => {
  test("a different cwd → the warning; the same, or no workspace → none", () => {
    expect(attachCwdWarning("/Users/me/repo", "/Users/me/other")).toBe(
      "This container mounts /Users/me/repo; you are in /Users/me/other.",
    );
    expect(attachCwdWarning("/Users/me/repo", "/Users/me/repo")).toBeNull();
    expect(attachCwdWarning(undefined, "/Users/me/repo")).toBeNull();
  });
});

// ---- `.tentacle/hide` (owner 2026-10-27): per-project, gitignore-style, ADD-only ----

/** A tree: "file", a nested dir, or a symlink `[realpath, isDir]`. Rooted at `/p`. */
type Tree = { [name: string]: "file" | Tree | readonly [string, boolean] };

function fakeFs(tree: Tree): HideFs {
  const node = (path: string): Tree | undefined => {
    let cur: Tree = tree;
    for (const part of path.split("/").filter((p) => p !== "" && p !== "p")) {
      const next = cur[part];
      if (next === undefined || next === "file" || Array.isArray(next)) {
        return undefined;
      }
      cur = next as Tree;
    }
    return cur;
  };
  return {
    list: (dir) =>
      Object.entries(node(dir) ?? {}).map(([name, v]) => ({
        name,
        dir: v !== "file" && !Array.isArray(v),
        link: Array.isArray(v),
      })),
    link: (path) => {
      const parent = node(path.slice(0, path.lastIndexOf("/")));
      const v = parent?.[path.slice(path.lastIndexOf("/") + 1)];
      return Array.isArray(v) ? { real: v[0] as string, dir: v[1] as boolean } : undefined;
    },
  };
}

const rulesOf = (text: string) => parseHideFile(text).rules;
const hid = (text: string, rel: string, isDir = false): boolean =>
  hidesPath(rulesOf(text), rel, isDir);

describe(".tentacle/hide: parse", () => {
  test("comments, blank lines and trailing spaces are dropped; \\# and \\! are literal", () => {
    const { rules, warnings } = parseHideFile("# a comment\n\n  \n*.pem   \n\\#hash\n\\!bang\n");
    expect(rules).toHaveLength(3);
    expect(warnings).toEqual([]);
    expect(hidesPath(rules, "#hash", false)).toBe(true);
    expect(hidesPath(rules, "!bang", false)).toBe(true);
    expect(hidesPath(rules, "x/a.pem", false)).toBe(true);
  });

  test("CRLF files parse the same", () => {
    expect(hid("*.pem\r\n", "a.pem")).toBe(true);
  });

  test("a pattern that escapes the folder (..) is ignored WITH a warning", () => {
    const { rules, warnings } = parseHideFile("../x\na/../b\nok\n");
    expect(rules).toHaveLength(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('".tentacle/hide": "../x" ignored');
  });
});

describe(".tentacle/hide: match (gitignore semantics)", () => {
  test("a bare name / glob matches at any depth, and only whole names", () => {
    expect(hid("*.pem", "a.pem")).toBe(true);
    expect(hid("*.pem", "x/y/a.pem")).toBe(true);
    expect(hid("*.pem", "a.pemx")).toBe(false);
    expect(hid("a?c", "abc")).toBe(true);
    expect(hid("a?c", "a/c")).toBe(false);
  });

  test("a trailing / matches directories only", () => {
    expect(hid("build/", "build", true)).toBe(true);
    expect(hid("build/", "src/build", true)).toBe(true);
    expect(hid("build/", "build", false)).toBe(false);
  });

  test("a leading / or an inner / anchors to the folder root", () => {
    expect(hid("/top", "top")).toBe(true);
    expect(hid("/top", "x/top")).toBe(false);
    expect(hid("docs/*.md", "docs/a.md")).toBe(true);
    expect(hid("docs/*.md", "docs/x/a.md")).toBe(false);
    expect(hid("docs/*.md", "a/docs/a.md")).toBe(false);
  });

  test("** crosses directories: **/x, x/**, a/**/b", () => {
    expect(hid("**/secret", "secret")).toBe(true);
    expect(hid("**/secret", "a/b/secret")).toBe(true);
    expect(hid("a/**", "a/b")).toBe(true);
    expect(hid("a/**", "a/b/c")).toBe(true);
    expect(hid("a/**", "a")).toBe(false);
    expect(hid("a/**/b", "a/b")).toBe(true);
    expect(hid("a/**/b", "a/x/y/b")).toBe(true);
    expect(hid("a/**/b", "ab")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(hid("a.b+c(d)", "a.b+c(d)")).toBe(true);
    expect(hid("a.b", "axb")).toBe(false);
  });

  test("! re-includes a path an EARLIER line hid; the last matching line wins", () => {
    expect(hid("*.pem\n!public.pem", "public.pem")).toBe(false);
    expect(hid("*.pem\n!public.pem", "k.pem")).toBe(true);
    expect(hid("!x\nx", "x")).toBe(true);
  });
});

describe(".tentacle/hide: resolve (injectable walk)", () => {
  const tree: Tree = {
    ".env": "file",
    keys: { "x.pem": "file" },
    secrets: { a: "file", b: "file" },
    src: { "a.ts": "file", "k.pem": "file" },
  };
  const resolve = (text: string, t: Tree = tree) => resolveHideFile(text, "/p", fakeFs(t));

  test("files vs dirs: a matched dir is ONE dir mask and is not descended into", () => {
    const r = resolve("secrets/\n*.pem\n.env");
    expect(r.problem).toBeUndefined();
    expect(r.paths).toEqual([
      { label: ".tentacle/hide", path: "/p/.env", file: true, fromFile: true },
      { label: ".tentacle/hide", path: "/p/keys/x.pem", file: true, fromFile: true },
      { label: ".tentacle/hide", path: "/p/secrets", file: false, fromFile: true },
      { label: ".tentacle/hide", path: "/p/src/k.pem", file: true, fromFile: true },
    ]);
  });

  test("! un-hides within the file: *.pem then !src/k.pem", () => {
    const r = resolve("*.pem\n!src/k.pem");
    expect(r.paths.map((p) => p.path)).toEqual(["/p/keys/x.pem"]);
  });

  test("a pattern matching nothing hides nothing (only EXISTING paths are masked)", () => {
    expect(resolve("nothing-here\n*.nope").paths).toEqual([]);
  });

  test("an empty / comment-only file hides nothing", () => {
    expect(resolve("# nothing\n\n").paths).toEqual([]);
  });

  test("cap: exactly HIDE_CAP resolved paths is fine, one more STOPS (never a partial set)", () => {
    const many = (n: number): Tree =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}.pem`, "file" as const]));
    expect(HIDE_CAP).toBe(200);
    const ok = resolve("*.pem", many(HIDE_CAP));
    expect(ok.problem).toBeUndefined();
    expect(ok.paths).toHaveLength(HIDE_CAP);
    const over = resolve("*.pem", many(HIDE_CAP + 1));
    expect(over.paths).toEqual([]);
    expect(over.problem).toContain("more than 200 paths");
    expect(over.problem).toContain("narrow the patterns");
  });

  test("a runaway scan stops with a problem instead of masking a partial set", () => {
    const r = resolveHideFile("*.pem", "/p", fakeFs(tree), { scanCap: 3 });
    expect(r.paths).toEqual([]);
    expect(r.problem).toContain("too many entries");
  });

  test("a symlink escaping the folder is ignored with a warning; one inside masks its REAL path", () => {
    const t: Tree = {
      out: ["/etc", true],
      real: { f: "file" },
      inl: ["/p/real", true],
    };
    const r = resolve("out\ninl", t);
    expect(r.paths).toEqual([
      { label: ".tentacle/hide", path: "/p/real", file: false, fromFile: true },
    ]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("/p/out");
    expect(r.warnings[0]).toContain("outside the mounted folder");
  });

  test("a symlink to the mount root itself is also outside (never masks the whole source)", () => {
    const r = resolve("up", { up: ["/p", true] });
    expect(r.paths).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  test("a dir/ pattern does not match a symlink to a dir (gitignore)", () => {
    const r = resolve("inl/", { real: {}, inl: ["/p/real", true] });
    expect(r.paths).toEqual([]);
  });
});

describe(".tentacle/hide: plan integration", () => {
  const fileEntry = (path: string, file = true) => ({
    label: ".tentacle/hide",
    path,
    file,
    fromFile: true,
  });
  const def = (label: string, path: string, file = false) => ({ label, path, file });

  test("it ADDS masks; the file's entries are flagged and counted apart from the defaults", () => {
    const m = mountOf({
      hide: [def("~/.aws", "/Users/me/repo/.aws"), fileEntry("/Users/me/repo/k.pem")],
    });
    expect(m.masks).toEqual([
      { path: "/Users/me/repo/.aws", file: false, label: "~/.aws" },
      { path: "/Users/me/repo/k.pem", file: true, label: ".tentacle/hide", fromFile: true },
    ]);
    expect(hiddenSummary(m)).toBe(
      "Hidden from the container: 1 paths from .tentacle/hide, 1 defaults",
    );
  });

  test("a file entry equal to a default / the config dir counts as a default (dedupe keeps the always-hidden one)", () => {
    const m = mountOf({
      hide: [
        def("~/.aws", "/Users/me/repo/.aws"),
        fileEntry("/Users/me/repo/.aws", false),
        fileEntry("/Users/me/repo/cfg", false),
      ],
      configDir: "/Users/me/repo/cfg",
    });
    expect(m.masks.map((x) => [x.path, x.fromFile ?? false])).toEqual([
      ["/Users/me/repo/.aws", false],
      ["/Users/me/repo/cfg", false],
    ]);
    expect(hiddenSummary(m)).toBe(
      "Hidden from the container: 0 paths from .tentacle/hide, 2 defaults",
    );
  });

  test("! in the file can NEVER un-hide a default, the config dir or the key file", () => {
    // The file resolves to nothing for these (its `!` only edits its own set)...
    const resolved = resolveHideFile(".aws\n!.aws\n!cfg\n!.key", "/p", fakeFs({}));
    expect(resolved.paths).toEqual([]);
    // ...so the planner still masks all three.
    const m = mountOf({
      hide: [
        def("~/.aws", "/Users/me/repo/.aws"),
        def("the API key file", "/Users/me/repo/.key", true),
        ...resolved.paths,
      ],
      configDir: "/Users/me/repo/cfg",
    });
    expect(paths(m)).toEqual(["/Users/me/repo/.aws", "/Users/me/repo/.key", "/Users/me/repo/cfg"]);
  });

  test("the status line: no masks → none; N and M counted", () => {
    expect(hiddenSummary(mountOf())).toBeUndefined();
    const m = mountOf({
      hide: [fileEntry("/Users/me/repo/a"), fileEntry("/Users/me/repo/b")],
      configDir: "/Users/me/repo/cfg",
    });
    expect(hiddenSummary(m)).toBe(
      "Hidden from the container: 2 paths from .tentacle/hide, 1 defaults",
    );
  });

  test("a hide-file problem (cap) REFUSES before anything is created", () => {
    const message = refusal({
      hideProblem: ".tentacle/hide matches more than 200 paths — narrow the patterns",
    });
    expect(message).toContain("more than 200 paths");
  });

  test("hide-file warnings travel with the mount plan", () => {
    const p = plan({ hideWarnings: ['".tentacle/hide": "../x" ignored'] });
    expect(p.kind === "mount" ? p.warnings : undefined).toEqual([
      '".tentacle/hide": "../x" ignored',
    ]);
    expect(plan()).not.toHaveProperty("warnings");
  });

  test("the prompt carries the summary line; file paths are not listed one by one", () => {
    const home = plan({
      cwd: "/Users/me",
      realCwd: "/Users/me",
      hide: [fileEntry("/Users/me/a"), fileEntry("/Users/me/b")],
    });
    const gate = mountGate(home, { interactive: true, confirmed: false });
    const prompt = gate.action === "ask" ? gate.prompt : "";
    expect(prompt).toContain(
      "Hidden from the container: 2 paths from .tentacle/hide, 1 defaults\n",
    );
    expect(prompt).toContain("except tentacle's config, which stay hidden");
    expect(prompt).not.toContain("/Users/me/a");
  });
});

// ---- fix round 2 (Review round 2, owner 2026-10-27) ------------------------

describe("R2-1: the apiKeyCommand key file — derived, or said to be NOT hidden", () => {
  test("$HOME / ${HOME} (unquoted or double-quoted) → ~; single quotes stay literal", () => {
    expect(apiKeyFileOf('cat "$HOME/.anthropic-key"')).toBe("~/.anthropic-key");
    expect(apiKeyFileOf("cat $HOME/.k")).toBe("~/.k");
    expect(apiKeyFileOf("cat ${HOME}/.k")).toBe("~/.k");
    expect(apiKeyFileOf('cat -- "${HOME}/a b/k"')).toBe("~/a b/k");
    expect(apiKeyFileOf("cat '$HOME/k'")).toBe("$HOME/k");
  });

  test("any other expansion, glob or escape is not a file we can name", () => {
    for (const other of [
      'cat "$KEYDIR/k"',
      'cat "$HOMEX/k"',
      "cat $HOME",
      'cat "/a/$x"',
      'cat "/a/\\$x"',
      'cat "`pwd`/k"',
      'cat "$(pwd)/k"',
      "cat /k/*",
      "cat /k/?",
      "cat /k/[ab]",
      "cat /a\\ b",
      "cat ~user/k",
      'cat "~/k"',
    ]) {
      expect([other, apiKeyFileOf(other)]).toEqual([other, undefined]);
    }
  });

  test("apiKeyFileUnknown: only a set command whose file cannot be named", () => {
    expect(apiKeyFileUnknown(undefined)).toBe(false);
    expect(apiKeyFileUnknown("cat ~/.k")).toBe(false);
    expect(apiKeyFileUnknown('cat "$HOME/.k"')).toBe(false);
    expect(apiKeyFileUnknown("cat ~/.k | tr -d '\\n'")).toBe(true);
    expect(apiKeyFileUnknown("pass show anthropic")).toBe(true);
  });

  test("an unknown key file → an explicit warning on the mount plan (never silent)", () => {
    const p = plan({ keyFileUnknown: true });
    expect(p.kind === "mount" ? p.warnings : undefined).toEqual([
      "apiKeyCommand: the API key file could not be determined from the command, so it is NOT hidden from the container — use `cat <path>`, or add the file to mount.hideExtra",
    ]);
    // No mount → nothing to warn about.
    expect(plan({ keyFileUnknown: true, noMount: true })).toEqual({ kind: "none" });
  });
});

describe("R2-3: FILE masks on a case-insensitive filesystem", () => {
  /** dev:ino by path; a missing path is `undefined`. Records every lookup. */
  const caseFs = (ids: Record<string, string>): CaseFs & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      id: (path) => {
        calls.push(path);
        return ids[path];
      },
    };
  };

  test("the swapped-case spelling reaches the SAME inode → aliased", () => {
    expect(caseAliasedFiles(["/p/Key"], caseFs({ "/p/Key": "1:7", "/p/kEY": "1:7" }))).toEqual([
      "/p/Key",
    ]);
  });

  test("case-sensitive (variant missing, or a different file) → safe", () => {
    expect(caseAliasedFiles(["/p/Key"], caseFs({ "/p/Key": "1:7" }))).toEqual([]);
    expect(caseAliasedFiles(["/p/Key"], caseFs({ "/p/Key": "1:7", "/p/kEY": "1:8" }))).toEqual([]);
  });

  test("an ASCII name with no letters cannot be reached by case → safe, not even probed", () => {
    const fs = caseFs({ "/p/.123": "1:7" });
    expect(caseAliasedFiles(["/p/.123"], fs)).toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  test("one probe per directory: a known case-insensitive dir flags its next file unprobed", () => {
    const fs = caseFs({ "/p/a": "1:1", "/p/A": "1:1", "/p/b": "1:2" });
    expect(caseAliasedFiles(["/p/a", "/p/b"], fs)).toEqual(["/p/a", "/p/b"]);
    expect(fs.calls.filter((c) => c === "/p/b" || c === "/p/B")).toEqual([]);
  });

  test("non-ASCII: a normalization (NFD) or case variant on the same inode → aliased", () => {
    const nfc = "/p/é";
    expect(caseAliasedFiles([nfc], caseFs({ [nfc]: "1:7", "/p/é": "1:7" }))).toEqual([nfc]);
    expect(caseAliasedFiles([nfc], caseFs({ [nfc]: "1:7", "/p/É": "1:7" }))).toEqual([nfc]);
  });

  test("non-ASCII: variants exist and none reaches the file → safe", () => {
    const nfc = "/p/é";
    expect(caseAliasedFiles([nfc], caseFs({ [nfc]: "1:7" }))).toEqual([]);
  });

  test("non-ASCII with no variant to probe (e.g. CJK) → conservatively aliased", () => {
    expect(caseAliasedFiles(["/p/鍵"], caseFs({ "/p/鍵": "1:7" }))).toEqual(["/p/鍵"]);
  });

  test("a file that cannot be stat'ed cannot be verified → aliased", () => {
    expect(caseAliasedFiles(["/p/Key"], caseFs({}))).toEqual(["/p/Key"]);
  });

  const key = { label: "the API key file", path: "/Users/me/repo/Key", file: true, always: true };
  const netrc = { label: "~/.netrc", path: "/Users/me/repo/.netrc", file: true };

  test("an ALWAYS-hidden file (the key file) aliased → refused, never overridable", () => {
    const message = refusal({ hide: [key], caseAliased: [key.path] });
    expect(message).toContain("Refusing to mount /Users/me/repo");
    expect(message).toContain("case-insensitive");
    expect(message).toContain("/Users/me/repo/Key (the API key file)");
    expect(message).toContain("Hide the folder that contains it");
    expect(message).toContain("move the file");
    expect(message).not.toContain("--confirm-mount");
  });

  test("a user-added file aliased → the gate refuses (TTY or not) unless --confirm-mount", () => {
    const p = plan({ hide: [netrc], caseAliased: [netrc.path] });
    expect(p.kind === "mount" ? p.caseExposed : undefined).toEqual([
      { path: netrc.path, label: "~/.netrc" },
    ]);
    for (const interactive of [true, false]) {
      const gate = mountGate(p, { interactive, confirmed: false });
      expect(gate.action).toBe("refuse");
      const message = gate.action === "refuse" ? gate.message : "";
      expect(message).toContain("/Users/me/repo/.netrc (~/.netrc)");
      expect(message).toContain("--confirm-mount");
    }
  });

  test("--confirm-mount proceeds and WARNS naming the still-readable files", () => {
    const p = plan({ hide: [netrc], caseAliased: [netrc.path] });
    expect(mountGate(p, { interactive: false, confirmed: true })).toEqual({
      action: "proceed",
      warnings: [
        "--confirm-mount: these hidden files stay READABLE in the container under another spelling of their name (case-insensitive filesystem): /Users/me/repo/.netrc (~/.netrc)",
      ],
    });
  });

  test("a case problem is refused BEFORE the danger prompt is asked", () => {
    const p = plan({
      cwd: "/Users/me",
      realCwd: "/Users/me",
      hide: [{ label: "~/.netrc", path: "/Users/me/.netrc", file: true }],
      caseAliased: ["/Users/me/.netrc"],
    });
    expect(mountGate(p, { interactive: true, confirmed: false }).action).toBe("refuse");
  });

  test("a file inside a hidden DIR is covered by the dir mask: dropped, so no case problem", () => {
    const m = mountOf({
      hide: [
        { label: "secrets", path: "/Users/me/repo/sec", file: false },
        { ...key, path: "/Users/me/repo/sec/Key" },
      ],
      caseAliased: ["/Users/me/repo/sec/Key"],
    });
    expect(paths(m)).toEqual(["/Users/me/repo/sec"]);
  });

  test("an aliased file OUTSIDE the mount is not masked → no problem", () => {
    const p = plan({ hide: [{ ...key, path: "/Users/me/Key" }], caseAliased: ["/Users/me/Key"] });
    expect(p.kind).toBe("mount");
    expect(mountGate(p, { interactive: false, confirmed: false })).toEqual({ action: "proceed" });
  });

  test("dir masks are never a case problem; a remote engine never plans one", () => {
    const dir = { label: "~/.aws", path: "/Users/me/repo/.aws", file: false };
    expect(plan({ hide: [dir], caseAliased: [dir.path] }).kind).toBe("mount");
    expect(plan({ endpointLocal: false, hide: [key], caseAliased: [key.path] }).kind).toBe("none");
  });

  test("hideList marks the key file always-hidden (and nothing else)", () => {
    expect(hideList({ hide: ["~/.netrc"] }, "cat ~/.k")).toEqual([
      { label: "~/.netrc", path: "~/.netrc" },
      { label: "the API key file", path: "~/.k", always: true },
    ]);
  });
});

describe("R2-2 / R2-4: reading .tentacle/hide (loud on anything but absent)", () => {
  type Node = { kind: "file" | "link" | "other"; size?: number; real?: string; text?: string };
  const hideFs = (nodes: Record<string, Node | Error>): HideFileFs & { reads: string[] } => {
    const reads: string[] = [];
    const get = (path: string): Node | undefined => {
      const n = nodes[path];
      if (n instanceof Error) {
        throw n;
      }
      return n;
    };
    return {
      reads,
      lstat: (path) => {
        const n = get(path);
        return n ? { kind: n.kind, size: n.size ?? (n.text ?? "").length } : undefined;
      },
      realpath: (path) => {
        const n = get(path);
        if (!n) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return n.real ?? path;
      },
      read: (path) => {
        reads.push(path);
        return get(path)?.text ?? "";
      },
    };
  };
  const file = "/p/.tentacle/hide";
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

  test("absent (ENOENT) → nothing, no problem", () => {
    expect(loadHideFile("/p", hideFs({}))).toEqual({});
  });

  test("a regular file → its text", () => {
    expect(loadHideFile("/p", hideFs({ [file]: { kind: "file", text: "secrets/\n" } }))).toEqual({
      text: "secrets/\n",
    });
  });

  test("unreadable (EACCES on stat or on read) → problem, never 'absent'", () => {
    const readFails: HideFileFs = {
      ...hideFs({ [file]: { kind: "file", text: "x" } }),
      read: () => {
        throw eacces;
      },
    };
    for (const fs of [hideFs({ [file]: eacces }), readFails]) {
      const r = loadHideFile("/p", fs);
      expect(r.text).toBeUndefined();
      expect(r.problem).toContain(".tentacle/hide could not be read");
      expect(r.problem).toContain("EACCES");
    }
  });

  test("a FIFO / socket / device → problem, and it is never opened", () => {
    const fs = hideFs({ [file]: { kind: "other" } });
    expect(loadHideFile("/p", fs).problem).toContain("not a regular file");
    expect(fs.reads).toEqual([]);
  });

  test("over the size cap → problem, never read; exactly the cap is fine", () => {
    const fs = hideFs({ [file]: { kind: "file", size: HIDE_FILE_MAX_BYTES + 1 } });
    expect(loadHideFile("/p", fs).problem).toContain("too large");
    expect(fs.reads).toEqual([]);
    expect(
      loadHideFile("/p", hideFs({ [file]: { kind: "file", size: HIDE_FILE_MAX_BYTES } })).problem,
    ).toBeUndefined();
  });

  test("a symlink to a regular file INSIDE the folder → that file's text", () => {
    const fs = hideFs({
      [file]: { kind: "link", real: "/p/conf/hide" },
      "/p/conf/hide": { kind: "file", text: "a\n" },
    });
    expect(loadHideFile("/p", fs)).toEqual({ text: "a\n" });
    expect(fs.reads).toEqual(["/p/conf/hide"]);
  });

  test("a symlink (or a linked .tentacle) OUTSIDE the folder → problem, never read", () => {
    for (const fs of [
      hideFs({ [file]: { kind: "link", real: "/etc/passwd" }, "/etc/passwd": { kind: "file" } }),
      hideFs({ [file]: { kind: "file", real: "/elsewhere/hide" } }),
    ]) {
      expect(loadHideFile("/p", fs).problem).toContain("outside the mounted folder");
      expect(fs.reads).toEqual([]);
    }
  });

  test("a symlink to a FIFO inside the folder → problem, never opened", () => {
    const fs = hideFs({ [file]: { kind: "link", real: "/p/f" }, "/p/f": { kind: "other" } });
    expect(loadHideFile("/p", fs).problem).toContain("not a regular file");
    expect(fs.reads).toEqual([]);
  });

  test("an unreadable SUBDIR during the walk → a warning naming it (patterns below not applied)", () => {
    const fs: HideFs = {
      list: (dir) =>
        dir === "/p"
          ? [
              { name: "locked", dir: true, link: false },
              { name: "a.pem", dir: false, link: false },
            ]
          : undefined,
      link: () => undefined,
    };
    const r = resolveHideFile("*.pem", "/p", fs);
    expect(r.paths.map((p) => p.path)).toEqual(["/p/a.pem"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("/p/locked");
    expect(r.warnings[0]).toContain("could not be read");
  });
});
