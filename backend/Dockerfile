FROM node:25-slim

RUN apt-get update && apt-get install -y curl git python3 make g++ && rm -rf /var/lib/apt/lists/*

# Note: Claude Code CLI lives in the session-manager container now; the backend
# only talks to it over HTTP and does not spawn claude itself.

# Run as host user (UID/GID 1000) to avoid file permission issues
ARG UID=1000
ARG GID=1000
RUN groupmod -g ${GID} node && usermod -u ${UID} -g ${GID} node
# Pre-create the mount path with correct ownership so the anonymous
# volume for node_modules inherits node:1000 on first creation.
RUN mkdir -p /jarvis/backend/node_modules && chown -R node:node /jarvis
WORKDIR /jarvis/backend

USER node
