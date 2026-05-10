# Builds from a locally-imported Debian rootfs to avoid Docker Hub zstd layers.
# Run docker/setup.ps1 (Windows) or docker/setup.sh (Linux/macOS) first.
FROM geniesh-base:latest

# Install Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential \
    && rm -rf /var/lib/apt/lists/*

# Ollama CLI
RUN curl -fsSL https://ollama.com/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/geniesh

COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

COPY . .
RUN npm link

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
