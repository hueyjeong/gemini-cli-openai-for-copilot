# syntax=docker/dockerfile:1.4
# Dockerfile for Gemini CLI OpenAI Worker
# Production-ready build with security optimizations
# BuildKit enabled for parallel layer building and cache optimization

FROM node:20-slim

# Install security updates and required packages including redsocks for transparent proxy
# Use mount cache to speed up repeated builds
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends wget curl gosu redsocks iptables ca-certificates && \
    update-ca-certificates && \
    rm -rf /tmp/*

# Create a non-root user for security and directories in single layer
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs worker && \
    mkdir -p /home/worker/.config/.wrangler/logs && \
    chown -R worker:nodejs /home/worker

# Set working directory inside the container
WORKDIR /app

# Install wrangler and tsx globally with npm cache mount
RUN --mount=type=cache,target=/root/.npm \
    npm install -g wrangler@4.23.0 tsx

# Copy package files first to leverage Docker cache
COPY package*.json yarn.lock* ./

# Install project dependencies with yarn cache mount
ARG NODE_ENV=development
RUN --mount=type=cache,target=/root/.yarn \
    yarn install --frozen-lockfile 2>/dev/null || yarn install

# Copy entrypoint script early (small file, rarely changes)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copy the rest of your application code
COPY --chown=worker:nodejs . .

# Create app directories with proper ownership in single layer
RUN mkdir -p .mf && chown -R worker:nodejs /app

# Expose the port the server will run on
EXPOSE 8787

# Health check - fast startup detection
# start-period: 10s grace, interval: 3s rapid check, timeout: 3s
HEALTHCHECK --interval=3s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

# Use entrypoint script to configure proxy
ENTRYPOINT ["/docker-entrypoint.sh"]

# Default: run with wrangler (Cloudflare Workers mode)
# Set RUN_MODE=node to use Node.js server with proxy support
CMD ["wrangler", "dev", "--host", "0.0.0.0", "--port", "8787", "--local", "--persist-to", ".mf"]
