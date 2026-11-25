/**
 * The laptop's workflow approval store (docs/feat/agent-workflows.md D2, owner
 * decision 2): `<configDir>/workflow-approvals.json`, one record per
 * project + path + hash, kept across sessions. A hash approval is a lasting
 * grant, so it lives here — on the laptop, never in a pod (AGENTS §7) — and an
 * edited byte (a new hash) is simply not in it: asked again.
 *
 * Fail closed: an unreadable or malformed file approves nothing (every run is
 * asked), and is replaced on the next `add` (temp + rename, never half-written).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectKey } from "@tentacle/agent";

export const WORKFLOW_APPROVALS_FILE = "workflow-approvals.json";
/** Oldest records drop past this (a store that only grows is a leak). */
export const WORKFLOW_APPROVALS_MAX = 1000;

interface ApprovalRecord {
  readonly project: string;
  readonly path: string;
  readonly hash: string;
  readonly approvedAt: number;
}

function isRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.project === "string" &&
    typeof r.path === "string" &&
    typeof r.hash === "string" &&
    typeof r.approvedAt === "number"
  );
}

function read(file: string): ApprovalRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const list = (parsed as { approvals?: unknown } | null)?.approvals;
    return Array.isArray(list) ? list.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The store for one project (`cwd`), as `WorkflowDriverDeps.approvals` takes it. */
export function workflowApprovals(
  configDir: string,
  cwd: string,
  now: () => number = Date.now,
): {
  has(path: string, hash: string): Promise<boolean>;
  add(path: string, hash: string): Promise<void>;
} {
  const file = join(configDir, WORKFLOW_APPROVALS_FILE);
  const project = projectKey(cwd);
  const same = (r: ApprovalRecord, path: string, hash: string): boolean =>
    r.project === project && r.path === path && r.hash === hash;
  return {
    has: async (path, hash) => read(file).some((r) => same(r, path, hash)),
    add: async (path, hash) => {
      const kept = read(file).filter((r) => !same(r, path, hash));
      kept.push({ project, path, hash, approvedAt: now() });
      const approvals = kept.slice(-WORKFLOW_APPROVALS_MAX);
      writeAtomic(file, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`);
    },
  };
}
