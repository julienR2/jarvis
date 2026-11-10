FROM node:25-slim

# ffmpeg turns whatever is uploaded (webm, m4a, ogg…) into the 16 kHz PCM the
# model reads; curl and bzip2 fetch the model on first start.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src

# The model lives in a named volume, created from this directory and so owned
# by node: downloaded once, kept across rebuilds.
RUN mkdir -p /models && chown node:node /models
ENV MODEL_DIR=/models
USER node

# Node runs the TypeScript directly (type stripping) — no build step.
CMD ["node", "src/index.ts"]
