#!/usr/bin/env bash
# Put odurgut/rasat into ./rasat (gitignored). CI does the same via actions/checkout.
# Laptop: if this repo sits next to a rasat clone, link it. Otherwise clone the tag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/rasat"
REPO="${RASAT_REPO:-https://github.com/odurgut/rasat.git}"
TAG="${RASAT_TAG:-}"

latest_tag() {
  git ls-remote --tags --refs "$REPO" |
    awk '{print $2}' |
    sed 's|refs/tags/||' |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    sort -V |
    tail -1
}

if [[ -z "$TAG" ]]; then
  TAG="$(latest_tag)"
fi
if [[ -z "$TAG" ]]; then
  echo "could not resolve a vMAJOR.MINOR.PATCH tag on $REPO" >&2
  exit 1
fi

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  if [[ ! -f "$DEST/web/package.json" ]]; then
    echo "CI must check out odurgut/rasat@$TAG into ./rasat" >&2
    exit 1
  fi
  echo "using $DEST (tag $TAG)"
  exit 0
fi

if [[ -f "$DEST/web/package.json" ]]; then
  echo "using $DEST"
  exit 0
fi

SIBLING="$(cd "$ROOT/.." && pwd)/rasat"
if [[ -f "$SIBLING/web/package.json" ]]; then
  ln -s "$SIBLING" "$DEST"
  echo "linked $DEST -> $SIBLING (local only; CI clones the tag)"
  exit 0
fi

git clone --depth 1 --branch "$TAG" "$REPO" "$DEST"
echo "cloned $REPO@$TAG -> $DEST"
