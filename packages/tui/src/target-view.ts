/**
 * The status bar's target badge (docs/feat/tui-target-badge.md). Pure.
 *
 * In a container/pod the bar names where the agent runs: `docker tentacle-ba89d072`,
 * `podman …`, `pod <name>`, `pod <name>/<container>` (the container only when
 * the pod has several). Every field is a LAPTOP fact (the engine host and the
 * name this laptop created or the user typed) — never text the pod supplied.
 */
import { cellWidth, middleCells } from "./cells.ts";

export interface TargetBadge {
  readonly engine: "kubernetes" | "docker" | "podman";
  readonly name: string;
  /** k8s only, set when the pod has several containers. */
  readonly container?: string;
}

/** The name keeps at least this many cells while the `/container` is kept whole. */
const MIN_NAME_CELLS = 5;

/** The engine word, always whole: `pod` / `docker` / `podman`. */
export function badgeWord(target: TargetBadge): string {
  return target.engine === "kubernetes" ? "pod" : target.engine;
}

/** The smallest badge: the engine word and a `…` (`pod…`). Cells it takes. */
export function minBadgeCells(target: TargetBadge): number {
  return cellWidth(`${badgeWord(target)}…`);
}

/**
 * The badge's text — the owner's rule (docs/feat/tui-target-badge.md, rounds
 * 3–4): the bar is ONE row, so the result never exceeds `limit` CELLS (not code
 * points); the engine word is always whole. Whole when it fits; else cut only
 * the NAME in the middle with `…`, the `/container` whole while the name keeps
 * ≥ 5 cells (`pod etcd…er-0/guard`); if that is not enough, `name/container` is
 * cut TOGETHER in the middle (`pod etcd-gu…ntainer`); with no room for any name,
 * `pod…`. A `limit` under `minBadgeCells` cannot hold the word: the caller drops
 * the badge then (`statusLayout`).
 */
export function targetText(target: TargetBadge, limit = Number.POSITIVE_INFINITY): string {
  const noun = badgeWord(target);
  const suffix = target.container ? `/${target.container}` : "";
  const full = `${noun} ${target.name}${suffix}`;
  if (cellWidth(full) <= limit) {
    return full;
  }
  const head = `${noun} `;
  const room = limit - cellWidth(head);
  if (room < 2) {
    return `${noun}…`;
  }
  const nameRoom = room - cellWidth(suffix);
  if (suffix === "" || nameRoom >= MIN_NAME_CELLS) {
    return `${head}${middleCells(target.name, nameRoom)}${suffix}`;
  }
  return `${head}${middleCells(`${target.name}${suffix}`, room)}`;
}
