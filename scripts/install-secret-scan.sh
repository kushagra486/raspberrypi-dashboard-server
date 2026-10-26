#!/usr/bin/env bash
# Install a pinned, checksum-verified gitleaks and enable this repo's git hooks.
# Linux (Pi: arm64) and macOS. On Windows: `winget install gitleaks`, then
# `git config core.hooksPath .githooks`.
set -euo pipefail

VERSION=8.30.1
BIN_DIR="${BIN_DIR:-/usr/local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;; Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;; x86_64|amd64) arch=x64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

if command -v gitleaks >/dev/null 2>&1 && [ "$(gitleaks version)" = "$VERSION" ]; then
  echo "gitleaks $VERSION already installed"
else
  tarball="gitleaks_${VERSION}_${os}_${arch}.tar.gz"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  curl -fsSL "$base/gitleaks_${VERSION}_checksums.txt" -o "$tmp/checksums.txt"
  ( cd "$tmp" && grep " $tarball\$" checksums.txt | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; } )
  tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
  if [ -w "$BIN_DIR" ]; then install -m 755 "$tmp/gitleaks" "$BIN_DIR/gitleaks"
  else sudo install -m 755 "$tmp/gitleaks" "$BIN_DIR/gitleaks"; fi
  echo "installed gitleaks $(gitleaks version) to $BIN_DIR"
fi

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git -C "$repo" config core.hooksPath .githooks
echo "git hooks enabled for $repo (pre-commit + pre-push secret scan)"
