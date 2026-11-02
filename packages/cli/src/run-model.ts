/**
 * Which LOCAL model `attach <name>` talks to (docs/fix/detach-live.md round 10,
 * owner A): the run's — the profile it was launched with and the model `ps`
 * shows — unless this command names one itself (`--profile`,
 * `TENTACLE_PROFILE`, `TENTACLE_MODEL`). Pure. Only WHICH laptop model: the
 * endpoint and key stay the laptop's config (AGENTS §7), the pod gets nothing.
 */

export type RunModelPlan =
  /** Keep the config this command loaded. */
  | { readonly kind: "as-is" }
  /** Load the config under `profile` (absent: none), then use `model`. */
  | { readonly kind: "run"; readonly profile?: string; readonly model: string };

export function runModelPlan(
  run: { readonly model: string; readonly profile?: string },
  loaded: { readonly model: string; readonly profile?: string },
  explicit: { readonly profile: boolean; readonly model: boolean },
): RunModelPlan {
  if (explicit.profile || explicit.model) {
    return { kind: "as-is" };
  }
  if (run.profile === loaded.profile && run.model === loaded.model) {
    return { kind: "as-is" };
  }
  return {
    kind: "run",
    ...(run.profile !== undefined ? { profile: run.profile } : {}),
    model: run.model,
  };
}
