# Stage 1: Build stage
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# ============================================
# Stage 2: Production stage
# ============================================
FROM node:20-alpine AS production

LABEL maintainer="Mintlayer Team"
LABEL description="Mojito API - batch/aggregation service + IPFS cache"
LABEL version="1.0.0"

# dumb-init for proper signal handling; curl for the healthcheck
RUN apk add --no-cache dumb-init curl

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 -G nodejs

WORKDIR /app

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./

USER nestjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/chain_tip || exit 1

ENV NODE_ENV=production \
    PORT=3000

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/main"]
