# ==============================================================================
# Stage 1: Builder (Install all dependencies & compile TypeScript -> dist/)
# ==============================================================================
FROM node:22.23-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Layer cache: copy lockfiles and workspace build permissions first
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code and compile
COPY . .
RUN pnpm build

# ==============================================================================
# Stage 2: Prod-Deps (Install strictly runtime dependencies)
# ==============================================================================
FROM node:22.23-alpine AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Equivalent of npm ci --omit=dev
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ==============================================================================
# Stage 3: Runner (Minimal production runtime)
# ==============================================================================
FROM node:22.23-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Create required application directories and assign ownership to non-root user
RUN mkdir -p uploads output logs && chown -R node:node /app

# Copy production node_modules from prod-deps stage
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules

# Copy compiled JavaScript from builder stage
COPY --chown=node:node --from=builder /app/dist ./dist

# Copy metadata and static web assets
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public

# Drop root privileges
USER node

# Persist dynamic user uploads and generated job artifacts across container recreations
VOLUME ["/app/uploads", "/app/output"]

EXPOSE 3000

# Native Node.js fetch healthcheck with 2s internal abort timeout (before Docker's 3s hard cutoff)
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(2000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Direct node execution for clean SIGTERM handling and graceful shutdown
CMD ["node", "dist/index.js"]
