FROM node:25-slim

RUN apt-get update && apt-get install -y curl git python3 make g++ && rm -rf /var/lib/apt/lists/*

# Chromium for puppeteer-based skills. Installed from Debian rather than
# letting puppeteer fetch its own: on aarch64 hosts Chrome-for-Testing
# publishes no linux-arm64 build, so puppeteer's download resolves to a
# binary that does not exist.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Run as host user (UID/GID 1000) to avoid file permission issues
ARG UID=1000
ARG GID=1000
RUN groupmod -g ${GID} node && usermod -u ${UID} -g ${GID} node
# Pre-create the mount path with correct ownership so the anonymous
# volume for node_modules inherits node:1000 on first creation.
RUN mkdir -p /jarvis/engine/node_modules && chown -R node:node /jarvis
WORKDIR /jarvis/engine

# The Claude CLI is a pinned dependency in engine/package.json, not a global
# install baked into this image. The engine runs `npm install` on every start,
# so bumping that pin and restarting the engine is the whole upgrade — no image
# rebuild, and nothing here that needs Docker. This PATH entry is what makes the
# installed `claude` the one spawn() finds.
ENV PATH=/jarvis/engine/node_modules/.bin:$PATH

USER node
