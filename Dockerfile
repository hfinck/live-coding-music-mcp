# Stage 1: Build
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS builder

WORKDIR /app

# Copy only package files first (better layer caching)
COPY package*.json ./

# Install all dependencies (needed for build)
RUN npm ci --ignore-scripts

# Copy source and build.
# `npm run build` also regenerates README.md via scripts/generate-tool-docs.ts,
# which is a dev-time docs task and is not part of the image, so compile directly.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Prune dev dependencies to reduce size
RUN npm prune --production && \
    rm -rf ~/.npm /tmp/*

# Stage 2: Runtime (smaller image)
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runtime

# Install Chromium and cleanup in single layer
RUN apk add --no-cache chromium && \
    rm -rf /var/cache/apk/*

# Chromium configuration
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

WORKDIR /app

# Copy only production dependencies and built code
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Create patterns directory
RUN mkdir -p patterns

# Create default config for headless mode in container
RUN echo '{"headless":true}' > config.json

# Hosted deployments talk MCP over Streamable HTTP (dist/http.js); local clients
# spawn the stdio entrypoint (dist/index.js) directly.
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/http.js"]