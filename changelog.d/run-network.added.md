- **`tentacle run --network <name|none>`.** A docker/podman run now chooses its
  container's network at create (`--network` › `TENTACLE_NETWORK` › profile ›
  config `network` › the engine's default `bridge`); `--network none` is an
  air-gapped run — the daemon rides the exec's stdio and the model is RPC to the
  laptop, so nothing in the container needs egress. A malformed value, a network
  with `--engine kubernetes` (a pod's network is the cluster's) and a network the
  engine does not have are each ONE refusal before anything runs, and an unknown
  network no longer triggers a pointless image pull. `/move container` honours the
  same configured network (`TENTACLE_NETWORK` › profile › config) for the
  container it creates, instead of silently leaving it on `bridge`.
