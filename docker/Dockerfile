FROM node:20-bookworm-slim AS base

# System deps (git for cloning benchmark repos, build-essential for native modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Ollama CLI (client only — server runs as separate container)
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://ollama.com/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/geniesh

# Copy package manifests first (Docker layer caching)
COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

# Copy rest of source
COPY . .

# Install the CLI globally
RUN npm link

WORKDIR /workspace

CMD ["/bin/bash", "-l"]
