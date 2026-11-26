# Apps

The agent can turn a page it built into a **session app**: a public web page at
its own address under `apps.tentacle.so`, up while the session is open. Off by
default.

## How it works

- The agent first shows you the page (`present`), then asks to publish it
  (`app_publish`). **You approve every publish and every update**, never with
  "always", and the approval shows any secret-looking text found in the page.
- The page is served at `<id>.apps.tentacle.so` with the network off (it cannot
  call anything), behind a first-visit warning with a Report link, within size,
  rate and count limits.
- It stays up while the session is open (a lease the `serve` renews) and goes
  away when the session ends; `app_unpublish` or `/apps` take it down earlier.
- `/apps` in the TUI (and Session info on the phone) lists the session's apps
  with their state and stops one.

## Configure

| Key | Default | Meaning |
| --- | --- | --- |
| `apps.enabled` | `false` | Offer the agent `app_publish` / `app_unpublish`. |
| `apps.domain` | `apps.tentacle.so` | The apps host to publish to. |

```jsonc
{ "apps": { "enabled": true } }
```

## Container previews (private)

Separate from public apps: with `previews.enabled` (off by default) on a
`serve`, the agent can ask to show a running Docker or Podman container's web
port, published on loopback, **only to your paired devices**. You approve each
one; there is no public URL and nothing is kept. The phone viewer comes in a
later release.

| Key | Default | Meaning |
| --- | --- | --- |
| `previews.enabled` | `false` | Offer the agent `container_preview` on `serve`. |

## Run your own apps host

The apps host is open source (`apps/apps-host`): it keeps one single-file page
per app, with a kill switch and takedowns. Deploy it on a separate domain and
set `apps.domain`. Runbook: [`docs/ops/apps-host-deploy.md`](../ops/apps-host-deploy.md).
Design: [`docs/feat/session-apps.md`](../feat/session-apps.md).
