FROM alpine:3.20

RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    curl \
    bash \
    build-base \
    dos2unix

WORKDIR /workspace/geniesh

COPY package.json package-lock.json ./
COPY packages/kernel/package.json ./packages/kernel/package.json
RUN mkdir -p packages/kernel && npm install

COPY . .
RUN dos2unix src/cli.js packages/kernel/src/*.js && npm link

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
