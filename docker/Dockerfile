FROM alpine:3.20

RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    curl \
    bash \
    build-base \
    zstd \
    && curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /workspace/geniesh

COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

COPY . .
RUN npm link

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
