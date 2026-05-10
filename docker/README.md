# geniesh — Docker Setup

Run geniesh (plus Ollama) in a single Docker compose stack — no manual Node.js or Ollama installation needed.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 24+ (Windows / macOS / Linux)
- ~50 GB free disk space (models + images ~10 GB, leaves room for repos)
- 20 GB RAM recommended (qwen3-coder ~5 GB, nomic-embed-text ~0.5 GB, system + Node ~2 GB)

## Quick start

```powershell
# Windows PowerShell
cd docker
.\setup.ps1
docker compose build geniesh
docker compose up -d
docker compose exec geniesh /bin/bash
```

```bash
# Linux / macOS
cd docker
chmod +x setup.sh && ./setup.sh
docker compose build geniesh
docker compose up -d
docker compose exec geniesh /bin/bash
```

On first boot the container automatically pulls `qwen3-coder` and `nomic-embed-text`. All source code is mounted live — edit outside, run inside.

## Architecture

Two containers defined in `docker/docker-compose.yml`:

| Container | Base image | Role | Memory limit |
|-----------|-----------|------|-------------|
| `geniesh-ollama` | `ollama/ollama:latest` | LLM inference server | 16 GB |
| `geniesh-worker` | `geniesh-base:latest` (locally-imported Debian rootfs) | geniesh CLI + tools | 8 GB |

The `geniesh-worker` image is built from a **locally-imported Debian rootfs** (downloaded via `setup.ps1`/`setup.sh` as a gzip/xz tarball) to avoid Docker Hub's zstd-compressed image layers, which some Windows Docker Desktop installations cannot extract.

- `ollama` runs the model server; `geniesh` connects via `OLLAMA_HOST=http://ollama:11434`.
- Models persist in a named volume (`ollama-data`) — no re-download on restart.
- Source code is volume-mounted from the host; `node_modules` is persisted in its own named volume so the build-layer `npm install` survives the mount.
- Use `docker compose logs -f geniesh` to watch model pulls.

## Useful commands

```bash
# Attach a shell to the running worker
docker compose exec geniesh /bin/bash

# Index a benchmark repo
docker compose exec geniesh geniesh index --dir /workspace/repos/flask

# Run the eval suite
docker compose exec geniesh geniesh eval --benchmark .reports/auto-flask-benchmark.json --dir /workspace/repos/flask

# Watch Ollama logs
docker compose logs -f ollama

# Tear everything down (volumes preserved)
docker compose down

# Full reset (wipes models and data)
docker compose down -v
```

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Builds geniesh worker image on top of local Debian rootfs |
| `docker-compose.yml` | Orchestrates ollama + geniesh services |
| `setup.ps1` | Downloads and imports Debian rootfs (Windows) |
| `setup.sh` | Downloads and imports Debian rootfs (Linux/macOS) |
| `start.sh` | One-command build & launch (Linux/macOS) |
| `pull-models.sh` | Pulls qwen3-coder + nomic-embed-text |

## Resource notes

- **20 GB RAM** is sufficient: qwen3-coder (7B, Q4) uses ~5 GB, nomic-embed-text ~0.5 GB, Node + system ~1-2 GB.
- **50 GB disk** comfortably holds both models, the geniesh codebase, and several cloned benchmark repos (~13 GB total).
- First `docker compose up` will download the Ollama image (~2 GB) and both models (~5 GB total).
