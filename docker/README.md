# geniesh — Docker Setup

Run geniesh (plus Ollama) in a single Docker compose stack.

## Quick start

```powershell
cd docker
docker compose build geniesh
docker compose up -d
docker compose exec geniesh /bin/bash
```

On first boot the container pulls `qwen3-coder` and `nomic-embed-text` automatically.

## Architecture

| Container | Base | Role | Memory |
|-----------|------|------|--------|
| `geniesh-ollama` | `ollama/ollama` | LLM server | 16 GB |
| `geniesh-worker` | `alpine:3.20` | geniesh CLI | 8 GB |

## Commands

```bash
docker compose exec geniesh /bin/bash     # shell
docker compose exec geniesh geniesh chat   # start chatting
docker compose logs -f ollama              # watch model pulls
docker compose down                        # stop
docker compose down -v                     # full reset
```

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Alpine + Node.js + Ollama CLI |
| `docker-compose.yml` | Ollama + geniesh services |
