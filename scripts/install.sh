#!/bin/sh
# tentacle installer
#
#   curl -fsSL tentacle.so/install | sh
#
# Downloads the tentacle binary for this machine from the GitHub release,
# checks it against the release's SHA256SUMS and installs it without sudo.
# Then it runs `tentacle update` for the same version, which fetches the Linux
# binaries that `tentacle run` / `tentacle attach` inject into pods.
#
# Environment (all optional):
#   TENTACLE_VERSION         release tag to install, e.g. v0.1.0 (default: latest;
#                            0.1.0 is the oldest version this installer accepts)
#   TENTACLE_INSTALL_DIR     where the binary goes (default: ~/.local/bin)
#   TENTACLE_NO_POD_BINARIES set to 1 to skip the Linux pod binaries (~2 x 90 MB);
#                            `tentacle update` fetches them later
#   TENTACLE_CONFIG_DIR      tentacle's config dir (same rule as tentacle itself:
#                            $TENTACLE_CONFIG_DIR, else $XDG_CONFIG_HOME/tentacle,
#                            else ~/.config/tentacle); pod binaries go in its bin/
#   TENTACLE_DOWNLOAD_BASE   serve the CLI assets from another URL (a mirror, or a
#                            test server). A non-https URL disables the https-only
#                            check: use one only if you trust the network path.
#                            The pod binaries always come from GitHub (via update).
#
# Usage with options:
#   curl -fsSL tentacle.so/install | TENTACLE_VERSION=v0.1.0 sh

# Everything runs inside main(), called on the last line: if the download is cut
# short, sh never sees the call and nothing half-runs.

set -eu

REPO="gmeghnag/tentacle"

say() { printf '%s\n' "$*"; }
err() { printf 'tentacle install: error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
  # HTTPS only (redirects included) unless a non-https mirror was set explicitly.
  case "$1" in
    https://*) curl_tls="--proto =https --tlsv1.2" wget_tls="--https-only" ;;
    *) curl_tls="" wget_tls="" ;;
  esac
  if has curl; then
    # shellcheck disable=SC2086 # the TLS flags are meant to split
    curl -fsSL --retry 3 $curl_tls -o "$2" "$1"
  elif has wget; then
    # shellcheck disable=SC2086
    wget -q $wget_tls -O "$2" "$1"
  else
    err "need curl or wget"
  fi
}

sha256_of() { # file -> hex digest
  if has sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    err "need sha256sum or shasum to verify the download"
  fi
}

verify() { # file asset-name
  want=$(awk -v n="$2" '$2 == n || $2 == "*"n { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || err "$2 is not listed in the release's SHA256SUMS"
  got=$(sha256_of "$1")
  [ "$got" = "$want" ] || err "checksum mismatch for $2 (expected $want, got $got)"
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) err "unsupported CPU architecture: $arch" ;;
  esac
  case "$os" in
    Darwin)
      # An x64 shell under Rosetta on Apple Silicon: install the native build.
      if [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        arch=arm64
      fi
      os=darwin
      ;;
    Linux)
      # The binaries are glibc-linked; musl systems (Alpine, ...) cannot run them.
      if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
        err "this system uses musl libc (e.g. Alpine); tentacle needs glibc"
      fi
      os=linux
      ;;
    *) err "unsupported OS: $os (tentacle runs on macOS and Linux)" ;;
  esac
  target="bun-$os-$arch"
}

check_version() { # vX.Y.Z[-pre] -> refuse anything older than 0.1.0
  v=${1#v}
  case "$v" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) err "TENTACLE_VERSION must look like v0.1.0 (got $1)" ;;
  esac
  case "$v" in
    0.0.* | 0.1.0-*) err "versions before 0.1.0 cannot be installed (got $1)" ;;
  esac
}

main() {
  [ -n "${HOME:-}" ] || err "HOME is not set"
  detect_target

  version="${TENTACLE_VERSION:-latest}"
  if [ "$version" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    case "$version" in v*) ;; *) version="v$version" ;; esac
    check_version "$version"
    base="https://github.com/$REPO/releases/download/$version"
  fi
  base="${TENTACLE_DOWNLOAD_BASE:-$base}"

  install_dir="${TENTACLE_INSTALL_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir"

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t tentacle)
  # The new binary is staged NEXT TO its destination, so the final mv is an
  # atomic rename on one filesystem: an interrupted install never leaves a
  # truncated tentacle, and a running tentacle keeps its old inode.
  staged="$install_dir/.tentacle.install.$$"
  trap 'rm -rf "$tmp" "$staged"' EXIT
  trap 'exit 130' INT TERM

  say "Installing tentacle ($version, $target)"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS" ||
    err "no release found at $base (check TENTACLE_VERSION; until a release is published, set one explicitly)"

  # 1) The CLI for this machine.
  download "$base/tentacle-$target" "$staged" || err "download failed: $base/tentacle-$target"
  verify "$staged" "tentacle-$target"
  chmod 755 "$staged"
  installed=$("$staged" --version 2>/dev/null) || err "the downloaded tentacle does not run on this machine"
  case "$installed" in
    "tentacle "*) ;;
    *) err "the downloaded binary is not tentacle (it printed: $installed)" ;;
  esac
  installed_version=${installed#tentacle }
  if [ "$version" != latest ] && [ "v$installed_version" != "$version" ]; then
    err "asked for $version but the release contains tentacle $installed_version"
  fi
  check_version "v$installed_version"
  mv -f "$staged" "$install_dir/tentacle"
  say "  ✓ $install_dir/tentacle ($installed)"

  # 2) The Linux binaries tentacle injects into pods (run / attach): the same
  # code path as a later `tentacle update` (checksums, version marker, atomic).
  if [ "${TENTACLE_NO_POD_BINARIES:-0}" != 1 ]; then
    "$install_dir/tentacle" update --version "v$installed_version" ||
      err "tentacle is installed, but fetching the pod binaries failed; retry with: tentacle update"
  else
    say "  - pod binaries skipped (run 'tentacle update' to fetch them)"
  fi

  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add it with:"
      case "$(basename "${SHELL:-sh}")" in
        fish) say "  fish_add_path $install_dir" ;;
        zsh) say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc" ;;
        *) say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.bashrc" ;;
      esac
      ;;
  esac

  say ""
  say "Run 'tentacle' to start. The first run creates its config.jsonc;"
  say "point it at your model there."
}

main "$@"
