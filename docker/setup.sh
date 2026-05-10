#!/usr/bin/env bash
# Downloads Alpine minirootfs directly from Alpine's CDN (gzip, not zstd)
# and imports it as a local Docker image.
set -euo pipefail

ROOTFS_URL="https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz"
IMAGE_NAME="geniesh-base:latest"
TARBALL="/tmp/alpine-rootfs.tar.gz"

echo "=== Cleaning old images ==="
docker rmi "$IMAGE_NAME" -f 2>/dev/null || true

echo "=== Downloading Alpine minirootfs (~3 MB, gzip) ==="
curl -fsSL -o "$TARBALL" "$ROOTFS_URL"

echo "=== Importing as Docker image '$IMAGE_NAME' ==="
docker import "$TARBALL" "$IMAGE_NAME"

rm -f "$TARBALL"

echo "=== Image ready ==="
docker images "$IMAGE_NAME"
echo ""
echo "Now run: docker compose build geniesh --no-cache && docker compose up -d"
