#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_revision=$(git -C "$repository_root" rev-parse HEAD)
image_version=${IMAGE_VERSION:-}

if [ -z "$image_version" ]; then
  if [ -n "$(git -C "$repository_root" status --porcelain)" ]; then
    echo "IMAGE_VERSION is required when building from a modified worktree" >&2
    exit 1
  fi
  image_version=$source_revision
fi

case "$image_version" in
  latest|stable|production)
    echo "IMAGE_VERSION must be an immutable version, not '$image_version'" >&2
    exit 1
    ;;
esac

docker build \
  --platform linux/amd64 \
  --progress plain \
  --build-arg "IMAGE_VERSION=$image_version" \
  --build-arg "SOURCE_REVISION=$source_revision" \
  --file "$repository_root/apps/api/Dockerfile" \
  --tag "factorylens-web:$image_version" \
  "$repository_root"

docker build \
  --platform linux/amd64 \
  --progress plain \
  --build-arg "IMAGE_VERSION=$image_version" \
  --build-arg "SOURCE_REVISION=$source_revision" \
  --file "$repository_root/apps/worker/Dockerfile" \
  --tag "factorylens-worker:$image_version" \
  "$repository_root"

echo "Built factorylens-web:$image_version and factorylens-worker:$image_version"
