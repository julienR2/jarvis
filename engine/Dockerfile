FROM node:25-slim

RUN apt-get update && apt-get install -y curl git python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@2.1.220

# Run as host user (UID/GID 1000) to avoid file permission issues
ARG UID=1000
ARG GID=1000
RUN groupmod -g ${GID} node && usermod -u ${UID} -g ${GID} node
# Pre-create the mount path with correct ownership so the anonymous
# volume for node_modules inherits node:1000 on first creation.
RUN mkdir -p /jarvis/engine/node_modules && chown -R node:node /jarvis
WORKDIR /jarvis/engine

USER node
