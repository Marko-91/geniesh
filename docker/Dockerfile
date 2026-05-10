FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=20

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    gnupg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# Ollama CLI (client only — server runs as separate container)
RUN curl -fsSL https://ollama.com/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /workspace/geniesh

# Copy package.json first (for Docker layer caching)
COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

# Copy rest of source (will be overridden by volume mount at runtime,
# but node_modules from `npm install` persists in its own layer)
COPY . .

# Install the CLI globally
RUN npm link

WORKDIR /workspace

# Start with a login shell so `geniesh` / `gensh` are on PATH
CMD ["/bin/bash", "-l"]
