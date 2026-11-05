/**
 * The status bar's target badge (docs/feat/tui-target-badge.md). Pure.
 *
 * In a container/pod the bar names where the agent runs: `docker tentacle-ba89d072`,
 * `podman …`, `pod <name>`, `pod <name>/<container>` (the container only when
 * the pod has several). Every field is a LAPTOP fact (the engine host and the
 * name this laptop created or the user typed) — never text the pod supplied.
 */
export interface TargetBadge {
  readonly engine: "kubernetes" | "docker" | "podman";
  readonly name: string;
  /** k8s only, set when the pod has more than one container. */
  readonly container?: string;
}

/** `str` cut to `max` cells with a `…` in the MIDDLE (head and tail kept). */
function middleCut(str: string, max: number): string {
  const chars = [...str];
  if (chars.length <= max) {
    return str;
  }
  if (max <= 1) {
    return "…";
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join("")}…${tail > 0 ? chars.slice(chars.length - tail).join("") : ""}`;
}

/** The name keeps at least this many cells while the `/container` is kept whole. */
const MIN_NAME_CELLS = 5;

/**
 * The badge's text — the owner's rule (docs/feat/tui-target-badge.md, round 3):
 * the bar is ONE row, so the result never exceeds `limit`; the engine word is
 * always whole. Whole when it fits; else cut only the NAME in the middle with
 * `…`, the `/container` whole while the name keeps ≥ 5 cells
 * (`pod etcd…er-0/guard`); if that is not enough, `name/container` is cut
 * TOGETHER in the middle (`pod etcd-gu…ntainer`). (A `limit` under the engine
 * word + 2 cells cannot hold any name: the word and a `…` are returned.)
 */
export function targetText(target: TargetBadge, limit = Number.POSITIVE_INFINITY): string {
  const noun = target.engine === "kubernetes" ? "pod" : target.engine;
  const suffix = target.container ? `/${target.container}` : "";
  const full = `${noun} ${target.name}${suffix}`;
  if ([...full].length <= limit) {
    return full;
  }
  const head = `${noun} `;
  const nameRoom = limit - [...head].length - [...suffix].length;
  if (suffix === "" || nameRoom >= MIN_NAME_CELLS) {
    return `${head}${middleCut(target.name, Math.max(1, nameRoom))}${suffix}`;
  }
  return `${head}${middleCut(`${target.name}${suffix}`, Math.max(1, limit - [...head].length))}`;
}
