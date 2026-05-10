# FROM scratch + ADD tarball = zero Docker Hub pulls, zero zstd layers.
# Docker's ADD uses Go's built-in tar/gzip — no containerd layer extraction.
# Run docker/setup.ps1 first to download alpine-minirootfs.tar.gz.
FROM scratch
ADD alpine-minirootfs.tar.gz /

# Install Node.js 20, system deps, Ollama CLI
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    curl \
    bash \
    build-base

# Ollama CLI (zstd needed — Ollama ships its binary as .tar.zst)
RUN apk add --no-cache zstd && curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /workspace/geniesh

COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

COPY . .
RUN npm link

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
