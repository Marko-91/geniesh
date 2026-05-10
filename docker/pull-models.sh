#!/usr/bin/env bash
# Pull all required Ollama models for geniesh + opencode
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

MODELS=(
  "qwen3-coder"
  "nomic-embed-text"
)

echo "=== Pulling Ollama models ==="
for model in "${MODELS[@]}"; do
  echo "  Pulling $model ..."
  ollama pull "$model"
done
echo "=== All models ready ==="

# Show disk usage
echo ""
echo "=== Ollama model storage ==="
du -sh ~/.ollama/models/ 2>/dev/null || echo "(no models directory yet)"
