#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Step 1: Import Debian rootfs (avoids zstd layers) ==="
./setup.sh

echo ""
echo "=== Step 2: Build geniesh image ==="
docker compose build geniesh

echo ""
echo "=== Step 3: Start services ==="
docker compose up -d ollama
echo "  Waiting for Ollama to become healthy..."
sleep 10
docker compose up -d geniesh

echo ""
echo "=== Containers running ==="
docker compose ps

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Attach:  docker compose exec geniesh /bin/bash    ║"
echo "║   Logs:    docker compose logs -f geniesh           ║"
echo "║   Stop:    docker compose down                      ║"
echo "╚══════════════════════════════════════════════════════╝"
