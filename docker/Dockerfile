# Uses a locally-imported Alpine rootfs to avoid Docker Hub's zstd layers.
# Run docker/setup.ps1 first to create geniesh-base:latest.
FROM geniesh-base:latest

# Install Node.js 20, system deps, Ollama CLI
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    curl \
    bash \
    build-base

# Ollama CLI
RUN curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /workspace/geniesh

COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

COPY . .
RUN npm link

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
