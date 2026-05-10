#!/usr/bin/env bash
# Downloads and imports a Debian rootfs as a local Docker image.
# This bypasses Docker Hub's zstd-compressed layers entirely.
set -euo pipefail

ROOTFS_URL="https://github.com/debuerreotype/docker-debian-artifacts/raw/dist-amd64/bookworm/rootfs.tar.xz"
IMAGE_NAME="geniesh-base:latest"
TARBALL="/tmp/debian-rootfs.tar.xz"

echo "=== Downloading Debian rootfs (xz compressed, ~30 MB) ==="
curl -fsSL -o "$TARBALL" "$ROOTFS_URL"

echo "=== Importing as Docker image '$IMAGE_NAME' ==="
docker import "$TARBALL" "$IMAGE_NAME"

rm -f "$TARBALL"

echo "=== Image ready ==="
docker images "$IMAGE_NAME"
echo ""
echo "Now run: docker compose build geniesh && docker compose up -d"
