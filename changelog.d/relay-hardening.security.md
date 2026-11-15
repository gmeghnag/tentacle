- **The mobile relay is hardened against the flooding an internet-facing
  service actually gets.** Four availability holes are closed and its log stops
  being a lever. Bun now refuses an oversized frame *before* allocating it
  (`maxPayloadLength` 96 KiB, above the largest legitimate Noise frame) instead
  of after a 16 MiB string existed; a `/v1/daemon` or `/v1/accept` socket that
  has not said `hello`/`accept` is capped per address and closed after 10 s
  instead of living forever on pings; `ping` is allowed only after `ready` and
  rate-limited; and a new `--max-ids-per-ip` (32) bounds how many computers one
  address may register. Behind Caddy the per-IP limits were **one global
  bucket** keyed on 127.0.0.1 — a new `--trust-proxy` makes them per client by
  reading `X-Forwarded-For` only from a loopback peer and only the right-most
  untrusted hop, with an IPv6 client collapsed to its `/64`
  (`apps/relay/src/client-ip.ts`). The deploy artefacts follow: the unit runs
  `--trust-proxy` and drops the fleet-sized overrides, and the Caddy site block
  adds HSTS, drops the `Server` banner, 404s every non-relay path and sets the
  header the relay reads. Logs are capped at 20 lines per kind per 10 s with an
  honest `log-suppressed` summary, IPs are never logged, stream-token prefixes
  are dropped and Apple's `reason` is bounded. The runbook's Caddy steps are the
  podman ones this host actually runs. Doc:
  `docs/fix/relay-hardening.md`.
