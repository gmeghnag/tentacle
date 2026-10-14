/**
 * `@agent-harness/exec` — execution environments.
 *
 * Ships the host implementation; a container implementation (F2) will live here
 * too, behind the same `ExecutionEnvironment` contract.
 */
export * from "./host-execution.ts";
export * from "./background.ts";
