/**
 * The status bar's target badge (docs/feat/tui-target-badge.md). Pure.
 *
 * In a container/pod the bar names where the agent runs, as `<engine>:<name>`
 * with no space: `docker:tentacle-ba89d072`, `podman:…`, and Kubernetes ALWAYS
 * with its container, `kubernetes:<pod>/<container>` (also for a one-container
 * pod). The prefix (`kubernetes:` / `k8s:` / `docker:` / `podman:`, colon
 * included) is painted grey, the name in the accent colour — `TargetParts`
 * keeps them apart. Every field is a LAPTOP fact (the engine host and the name
 * this laptop created or the user typed) — never text the pod supplied.
 */
import { cellWidth, middleCells } from "./cells.ts";

export interface TargetBadge {
  readonly engine: "kubernetes" | "docker" | "podman";
  readonly name: string;
  /** k8s only: the container in use (always set there when it could be resolved). */
  readonly container?: string;
}

/** The badge in two paints: `prefix` (grey, colon included) and `name` (accent). */
export interface TargetParts {
  readonly prefix: string;
  readonly name: string;
}

/** The name keeps at least this many cells while the `/container` is kept whole. */
const MIN_NAME_CELLS = 5;

/** The prefix when the badge fits whole: `kubernetes:` / `docker:` / `podman:`. */
export function badgePrefix(target: TargetBadge): string {
  return `${target.engine}:`;
}

/** The prefix when the whole badge would be cut: `k8s:` for Kubernetes; the others are short already. */
export function shortBadgePrefix(target: TargetBadge): string {
  return target.engine === "kubernetes" ? "k8s:" : badgePrefix(target);
}

/** `<name>` or `<name>/<container>`. */
function wholeName(target: TargetBadge): string {
  return target.container ? `${target.name}/${target.container}` : target.name;
}

/** The smallest badge: the (short) prefix and a `…` (`k8s:…`). Cells it takes. */
export function minBadgeCells(target: TargetBadge): number {
  return cellWidth(`${shortBadgePrefix(target)}…`);
}

/**
 * The badge's two parts — the owner's rule (docs/feat/tui-target-badge.md,
 * rounds 3–5): the bar is ONE row, so the result never exceeds `limit` CELLS
 * (not code points). Whole, with `kubernetes:`, when it fits; else `k8s:` (the
 * prefix is always whole); then, if still too long, cut only the NAME in the
 * middle with `…`, the `/container` whole while the name keeps ≥ 5 cells
 * (`k8s:etcd…er-0/guard`); if that is not enough, `name/container` is cut
 * TOGETHER in the middle; with no room for any name, `k8s:…`. A `limit` under
 * `minBadgeCells` cannot hold the prefix: the caller drops the badge then
 * (`statusLayout`).
 */
export function targetParts(target: TargetBadge, limit = Number.POSITIVE_INFINITY): TargetParts {
  const whole = wholeName(target);
  const long = badgePrefix(target);
  if (cellWidth(long) + cellWidth(whole) <= limit) {
    return { prefix: long, name: whole };
  }
  const prefix = shortBadgePrefix(target);
  const room = limit - cellWidth(prefix);
  if (room >= cellWidth(whole)) {
    return { prefix, name: whole };
  }
  if (room < 2) {
    return { prefix, name: "…" };
  }
  const suffix = target.container ? `/${target.container}` : "";
  const nameRoom = room - cellWidth(suffix);
  if (suffix === "" || nameRoom >= MIN_NAME_CELLS) {
    return { prefix, name: `${middleCells(target.name, nameRoom)}${suffix}` };
  }
  return { prefix, name: middleCells(whole, room) };
}

/** The badge as one plain string (`kubernetes:pod/c`), the two parts joined. */
export function targetText(target: TargetBadge, limit = Number.POSITIVE_INFINITY): string {
  const { prefix, name } = targetParts(target, limit);
  return `${prefix}${name}`;
}
