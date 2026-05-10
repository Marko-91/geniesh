#!/usr/bin/env bash
# Ensures the Alpine base image is available locally before building.
set -euo pipefail

IMAGE="alpine:3.20"

echo "=== Pulling $IMAGE (classic engine) ==="
docker pull --platform=linux/amd64 "$IMAGE" || docker pull "$IMAGE"

echo "=== Ready ==="
docker images "$IMAGE"
echo ""
echo "Now run: docker compose build geniesh && docker compose up -d"
