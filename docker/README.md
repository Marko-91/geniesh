# geniesh — Docker

## Quick start

```bash
cd docker

# One-time build
docker compose build geniesh

# Start (build skipped if already built)
bash up.sh          # Linux/macOS
.\up.ps1            # Windows PowerShell
```

## Commands inside the container

```bash
geniesh index --dir <repo>
geniesh chat
geniesh eval --benchmark <file> --dir <repo>
```

## Services

| Container | Image | Role |
|-----------|-------|------|
| `geniesh-ollama` | `ollama/ollama` | LLM server (port 11434) |
| `geniesh-worker` | custom | geniesh CLI |

## Manual usage

```bash
# Start just Ollama in background, then open geniesh shell
docker compose up -d ollama
docker compose run --rm --service-ports geniesh

# Or start everything in background
docker compose up -d
docker compose exec geniesh /bin/bash
```

## Management

```bash
docker compose logs -f ollama    # watch model pulls
docker compose down              # stop
docker compose down -v           # full reset (wipes models)
```
