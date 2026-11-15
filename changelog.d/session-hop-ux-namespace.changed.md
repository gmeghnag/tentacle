- **A hop names its Kubernetes namespace, and one rule decides the default.**
  `kubernetes:<namespace>/<pod>[/<container>]` in `/move attach` (one segment =
  the pod, two = `<ns>/<pod>`, three = `<ns>/<pod>/<container>` — the old
  `pod/container` reading is GONE), and the same namespace as a structured
  `workload.namespace` on the `move_session` tool. One function, `kubeNamespace`,
  now decides it for `run`, `attach` and every hop: explicit >
  `TENTACLE_POD_NAMESPACE` > (a server override ? `default` : the kubeconfig
  context's, else `default`) — the hop used to ignore the env entirely, which is
  why a live test attached to `namespace default`. A proposal's namespace is
  resolved at the turn's end, so what the prompt shows is what is dialled; the
  prompt and the failure line carry the provenance (`namespace ns1 (from context;
  context c, ~/.kube/config)`); a k8s 404 says `/move attach
  kubernetes:<namespace>/<pod>` instead of a `--namespace` flag a hop does not
  have; and every label prints `kubernetes:<ns>/<pod>[/<container>]` from ONE
  function.
