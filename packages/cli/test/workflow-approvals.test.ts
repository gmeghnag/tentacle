import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_APPROVALS_FILE, workflowApprovals } from "../src/workflow-approvals.ts";

// docs/feat/agent-workflows.md D2 / owner decision 2: a hash approval is
// remembered per project + path + hash, across sessions, on the laptop.

const fresh = (): string => mkdtempSync(join(tmpdir(), "wf-approvals-"));
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("workflow approvals store", () => {
  test("an added hash is approved for that project + path only, across store instances", async () => {
    const dir = fresh();
    const a = workflowApprovals(dir, "/repo/one", () => 5);
    expect(await a.has("workflows/task.yaml", H1)).toBe(false);
    await a.add("workflows/task.yaml", H1);
    // A new session (a new store over the same file) still knows it.
    const again = workflowApprovals(dir, "/repo/one");
    expect(await again.has("workflows/task.yaml", H1)).toBe(true);
    // One edited byte (another hash), another path, another project: not approved.
    expect(await again.has("workflows/task.yaml", H2)).toBe(false);
    expect(await again.has("workflows/other.yaml", H1)).toBe(false);
    expect(await workflowApprovals(dir, "/repo/two").has("workflows/task.yaml", H1)).toBe(false);
  });

  test("a malformed file approves nothing (fail closed) and is replaced on add", async () => {
    const dir = fresh();
    const file = join(dir, WORKFLOW_APPROVALS_FILE);
    writeFileSync(file, "{not json");
    const store = workflowApprovals(dir, "/repo/one");
    expect(await store.has("workflows/task.yaml", H1)).toBe(false);
    await store.add("workflows/task.yaml", H1);
    expect(await store.has("workflows/task.yaml", H1)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toHaveLength(1);
  });

  test("adding the same approval twice keeps one record", async () => {
    const dir = fresh();
    const store = workflowApprovals(dir, "/repo/one");
    await store.add("workflows/task.yaml", H1);
    await store.add("workflows/task.yaml", H1);
    const file = join(dir, WORKFLOW_APPROVALS_FILE);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toHaveLength(1);
  });
});
