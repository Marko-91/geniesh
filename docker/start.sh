#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Building geniesh Docker image ==="
docker compose build geniesh

echo ""
echo "=== Starting services ==="
docker compose up -d ollama
echo "  Waiting for Ollama to become healthy..."
sleep 10
docker compose up -d geniesh

echo ""
echo "=== Pulling models (background) ==="
docker compose exec geniesh sh -c "
  nohup sh -c '
    ollama pull qwen3-coder 2>&1
    ollama pull nomic-embed-text 2>&1
    echo \"Models ready!\"
  ' > /tmp/pull-models.log 2>&1 &
"

echo ""
echo "=== Containers running ==="
docker compose ps

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Attach:  docker compose exec geniesh /bin/bash    ║"
echo "║   Logs:    docker compose logs -f geniesh           ║"
echo "║   Stop:    docker compose down                      ║"
echo "╚══════════════════════════════════════════════════════╝"
