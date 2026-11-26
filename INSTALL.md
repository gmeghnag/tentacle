# Install

On macOS or Linux (x64 and arm64):

```sh
curl -fsSL tentacle.so/install | sh
```

It installs the CLI in `~/.local/bin` (no sudo), checks it against the
release's `SHA256SUMS`, then runs `tentacle update` to fetch the pod binaries.
On macOS it also installs the voice-dictation helper `tentacle-voice` next to it.
Options, as environment variables: `TENTACLE_VERSION=v0.1.0` (pin a release;
0.1.0 is the oldest), `TENTACLE_INSTALL_DIR`, and `TENTACLE_NO_POD_BINARIES=1`
(skip the pod binaries). The script is
[`scripts/install.sh`](scripts/install.sh); read it before piping it to `sh`.

## Getting started

The first run creates `~/.config/tentacle/` with a commented `config.jsonc` and
a `PROMPT.md`. Point it at your model:

```jsonc
// ~/.config/tentacle/config.jsonc
{
  "model": {
    "baseURL": "http://localhost:8080/v1",
    "model": "my-model",
    "apiKey": "your-api-key"
  }
}
```

Next: [the ways to run it](docs/guide/running.md) and [configuration](docs/guide/configuration.md).
