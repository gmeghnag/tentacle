/**
 * Kept workloads (docker-runtime slice E, docs/feat/engine-ps-rm.md): the
 * labels a kept `run` writes, the laptop-side index entry that says where it
 * lives, and every decision `tentacle ps` / `rm` / `attach <name>` make on them.
 * Pure — no IO, no React: `kept-index.ts` stores entries, `kept-cmd.ts` dials.
 *
 * Trust (AGENTS §7 "a pod is not trusted"): WHERE to dial comes from the index
 * (written by this laptop), never from a label; labels only VERIFY ownership
 * (managed marker + `tentacle.kept=true`) before `rm` deletes anything. Text
 * that came from a file or a workload is sanitised before it is printed.
 */
import type { EngineKind } from "./engine-host.ts";
import { untrustedText } from "./untrusted-text.ts";
import { WORKSPACE_LABELS } from "./workspace-mount.ts";

/** Set ONLY by a kept `run`: `ps` lists and `rm` removes nothing without it. */
export const KEPT_LABEL = "tentacle.kept";
/** Display metadata: docker/podman labels, k8s annotations (free text). */
export const KEPT_KEYS = {
  engine: "tentacle.engine",
  model: "tentacle.model",
  created: "tentacle.created",
} as const;
/** The owner markers: docker/podman (`@tentacle/docker` `OWNER_LABEL`) and k8s (`buildPodManifest`). */
export const DOCKER_OWNER_LABEL = "tentacle.managed";
export const K8S_OWNER_LABEL = "app.kubernetes.io/managed-by";

/** The on-disk index entry's version (AGENTS §7: an unknown one is refused, left untouched). */
export const KEPT_SCHEMA_VERSION = 1;

/** One kept workload, as `run` recorded it on the laptop. Locators only — no credentials. */
export interface KeptEntry {
  readonly schemaVersion: typeof KEPT_SCHEMA_VERSION;
  readonly name: string;
  readonly engine: EngineKind;
  /** docker/podman: the endpoint URL used (`unix:///…`, `ssh://u@h:p`, `tcp://h:p`). */
  readonly endpoint?: string;
  /** docker/podman: the explicit `--context`; k8s: the kube context used. */
  readonly context?: string;
  /** k8s: the `TENTACLE_K8S_SERVER` override used instead of a kubeconfig context. */
  readonly server?: string;
  /** k8s: the namespace. */
  readonly namespace?: string;
  /** docker/podman: `--insecure-docker-tcp` was needed to reach it. */
  readonly insecureTcp?: boolean;
  /** `--bin-dir` given at `run` (re-used by `attach <name>`). */
  readonly binDir?: string;
  /** The laptop folder mounted (slice D), absent without a mount. */
  readonly mount?: string;
  /** The model the session started with. */
  readonly model: string;
  /** RFC 3339 UTC, laptop clock. */
  readonly created: string;
}

/** Labels + annotations a kept `run` writes (k8s label values cannot hold a model id with `/`). */
export function keptMetadata(input: {
  readonly engine: EngineKind;
  readonly model: string;
  readonly created: string;
}): {
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
} {
  return {
    labels: { [KEPT_LABEL]: "true" },
    annotations: {
      [KEPT_KEYS.engine]: input.engine,
      [KEPT_KEYS.model]: input.model,
      [KEPT_KEYS.created]: input.created,
    },
  };
}

/** Does the engine say this workload is tentacle's AND kept? Anything else is never removed. */
export function isKeptWorkload(
  engine: EngineKind,
  labels: Readonly<Record<string, string>> | null | undefined,
): boolean {
  const owned =
    engine === "kubernetes"
      ? labels?.[K8S_OWNER_LABEL] === "tentacle"
      : labels?.[DOCKER_OWNER_LABEL] === "true";
  return owned && labels?.[KEPT_LABEL] === "true";
}

/** A parsed index file, or why it was refused (never half-loaded). */
export type ParsedEntry =
  | { readonly ok: true; readonly entry: KeptEntry }
  | { readonly ok: false; readonly problem: string };

const ENGINES: readonly string[] = ["kubernetes", "docker", "podman"];
const str = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Strict parse of one index file's text. */
export function parseKeptEntry(text: string): ParsedEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, problem: "not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== KEPT_SCHEMA_VERSION) {
    return {
      ok: false,
      problem: `schemaVersion ${JSON.stringify(r.schemaVersion)} is not ${KEPT_SCHEMA_VERSION} (written by another tentacle version — upgrade tentacle)`,
    };
  }
  if (!str(r.name) || !str(r.engine) || !ENGINES.includes(r.engine) || !str(r.model)) {
    return { ok: false, problem: "missing name, engine or model" };
  }
  if (!str(r.created) || Number.isNaN(Date.parse(r.created))) {
    return { ok: false, problem: "missing or invalid created" };
  }
  const engine = r.engine as EngineKind;
  if (engine === "kubernetes" ? !str(r.namespace) : !str(r.endpoint) && !str(r.context)) {
    return { ok: false, problem: "missing its location" };
  }
  const opt = (key: string): Record<string, string> =>
    str(r[key]) ? { [key]: r[key] as string } : {};
  return {
    ok: true,
    entry: {
      schemaVersion: KEPT_SCHEMA_VERSION,
      name: r.name,
      engine,
      ...opt("endpoint"),
      ...opt("context"),
      ...opt("server"),
      ...opt("namespace"),
      ...(r.insecureTcp === true ? { insecureTcp: true } : {}),
      ...opt("binDir"),
      ...opt("mount"),
      model: r.model,
      created: r.created,
    },
  };
}

/** WHERE: `local` | `ssh://host` | `tcp://host:port` | `context/namespace`. */
export function whereOf(entry: KeptEntry): string {
  if (entry.engine === "kubernetes") {
    const cluster = entry.context ?? (entry.server ? hostOf(entry.server) : "?");
    return `${cluster}/${entry.namespace ?? "?"}`;
  }
  const endpoint = entry.endpoint ?? "";
  if (endpoint.startsWith("unix://")) {
    return entry.context !== undefined ? `local (context ${entry.context})` : "local";
  }
  if (endpoint.startsWith("ssh://")) {
    return `ssh://${hostOf(endpoint)}`;
  }
  return endpoint !== "" ? endpoint : `context ${entry.context ?? "?"}`;
}

/** `ssh://user@box:22` → `box`; `https://api.c:6443` → `api.c`. */
function hostOf(url: string): string {
  const rest = url.replace(/^[a-z]+:\/\//i, "");
  const noUser = rest.slice(rest.lastIndexOf("@") + 1);
  return noUser.replace(/[:/].*$/, "");
}

/** AGE: `now`, `Nm`, `Nh`, `Nd`; a future or unparsable time → `?`. */
export function formatAge(nowMs: number, created: string): string {
  const ms = nowMs - Date.parse(created);
  if (Number.isNaN(ms) || ms < 0) {
    return "?";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** MOUNT: `~/…` under home, the path otherwise, `—` without one. */
export function formatMount(path: string | undefined, home: string): string {
  if (path === undefined || path === "") {
    return "—";
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What the engine said about one entry. */
export type KeptStatus =
  /** The engine's own state (`running`, `exited`, `pending`…). */
  | {
      readonly kind: "state";
      readonly state: string;
      readonly labels: Readonly<Record<string, string>>;
    }
  /** 404: removed outside tentacle. `rm <name>` drops the entry. */
  | { readonly kind: "gone" }
  /** The name now belongs to a workload without tentacle's managed + kept labels. */
  | { readonly kind: "foreign" }
  | { readonly kind: "unreachable"; readonly reason: string };

export interface KeptRow {
  readonly entry: KeptEntry;
  readonly status: KeptStatus;
}

export function statusText(status: KeptStatus): string {
  switch (status.kind) {
    case "state":
      return untrustedText(status.state) || "unknown";
    case "gone":
      return "gone";
    case "foreign":
      return "not-tentacle";
    case "unreachable":
      return "unreachable";
  }
}

/** Newest first (oldest at the bottom); ties by name. */
export function sortKept<T extends { readonly entry: KeptEntry }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (Date.parse(b.entry.created) || 0) - (Date.parse(a.entry.created) || 0) ||
      (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
  );
}

const HEADER = ["NAME", "ENGINE", "WHERE", "MOUNT", "MODEL", "AGE", "STATUS"] as const;

/** The table (header + one line per row, already sorted by the caller). */
export function renderTable(rows: readonly KeptRow[], nowMs: number, home: string): string[] {
  const cells = rows.map((row) => [
    untrustedText(row.entry.name),
    row.entry.engine,
    untrustedText(whereOf(row.entry)),
    untrustedText(formatMount(row.entry.mount, home)),
    untrustedText(row.entry.model),
    formatAge(nowMs, row.entry.created),
    statusText(row.status),
  ]);
  const all = [[...HEADER], ...cells];
  const widths = HEADER.map((_, i) => Math.max(...all.map((line) => (line[i] ?? "").length)));
  return all.map((line) =>
    line
      .map((cell, i) => (i === line.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2)))
      .join("")
      .trimEnd(),
  );
}

export function summaryLine(count: number): string {
  return `${count} kept · resume: tentacle attach <name> · remove: tentacle rm <name>`;
}

export const EMPTY_LINE = "No kept containers or pods.";

/** `ps -v`: one block per workload. */
export function renderVerbose(rows: readonly KeptRow[], nowMs: number, home: string): string[] {
  const out: string[] = [];
  for (const { entry, status } of rows) {
    const labels = status.kind === "state" ? status.labels : undefined;
    let hidden = "—";
    const masked = labels?.[WORKSPACE_LABELS.masked];
    if (masked) {
      try {
        const list = JSON.parse(masked) as unknown;
        if (Array.isArray(list) && list.length > 0) {
          hidden = list.map((p) => untrustedText(formatMount(String(p), home))).join(", ");
        }
      } catch {
        hidden = "? (unreadable label)";
      }
    }
    const location =
      entry.engine === "kubernetes"
        ? `${entry.context !== undefined ? `context ${entry.context}` : `server ${entry.server ?? "?"}`}, namespace ${entry.namespace ?? "?"}`
        : `${entry.endpoint ?? "?"}${entry.context !== undefined ? ` (context ${entry.context})` : ""}`;
    out.push(
      untrustedText(entry.name),
      `  engine    ${entry.engine}`,
      `  where     ${untrustedText(location)}`,
      `  mount     ${untrustedText(formatMount(entry.mount, home))}`,
      `  hidden    ${hidden}`,
      `  model     ${untrustedText(entry.model)} (the session's model at start)`,
      `  created   ${untrustedText(entry.created)} (${formatAge(nowMs, entry.created)} ago)`,
      `  status    ${statusText(status)}${status.kind === "unreachable" ? ` — ${untrustedText(status.reason)}` : ""}`,
      "",
    );
  }
  return out;
}

export type Resolved<T> =
  | { readonly kind: "one"; readonly match: T }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly T[] };

/** `rm <name>` / `attach <name>`: exactly one entry, or say why not. */
export function resolveByName<T extends { readonly entry: KeptEntry }>(
  name: string,
  items: readonly T[],
  engine?: EngineKind,
): Resolved<T> {
  const hits = items.filter(
    (item) => item.entry.name === name && (engine === undefined || item.entry.engine === engine),
  );
  if (hits.length === 0) {
    return { kind: "none" };
  }
  const [first] = hits;
  return hits.length === 1 && first !== undefined
    ? { kind: "one", match: first }
    : { kind: "ambiguous", candidates: hits };
}

/** The ambiguity error: every candidate, and how to narrow. */
export function ambiguousMessage(name: string, entries: readonly KeptEntry[]): string {
  return [
    `"${untrustedText(name)}" names ${entries.length} kept workloads:`,
    ...entries.map((e) => `  ${e.engine} · ${untrustedText(whereOf(e))}`),
    "Narrow it with --engine <kubernetes|docker|podman>.",
  ].join("\n");
}

/** `rm`'s confirmation for a running workload (a session may be attached). */
export function removeConfirmation(entry: KeptEntry): string {
  return `${untrustedText(entry.name)} (${entry.engine}, ${untrustedText(whereOf(entry))}) is running — a session may be attached. Remove it? [y/N] `;
}

/** `Removed tentacle-1b2c3d (docker, ~/code/tentacle).` — the mount, else WHERE. */
export function removedLine(entry: KeptEntry, home: string): string {
  const detail = entry.mount !== undefined ? formatMount(entry.mount, home) : whereOf(entry);
  return `Removed ${untrustedText(entry.name)} (${entry.engine}, ${untrustedText(detail)}).`;
}
