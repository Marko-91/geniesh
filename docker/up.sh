#!/usr/bin/env bash
set -euo pipefail
docker compose up -d ollama
echo "Waiting for Ollama to be healthy..."
while [ "$(docker inspect --format='{{.State.Health.Status}}' geniesh-ollama 2>/dev/null)" != "healthy" ]; do
  sleep 2
done
echo "Ollama is ready!"
docker compose run --rm --service-ports geniesh
