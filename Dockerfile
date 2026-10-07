# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# Debian-based image (glibc) instead of Alpine (musl)
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim AS debian-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Setup pnpm and turbo on the debian base
FROM --platform=linux/amd64 debian-base as base
ENV CI=true
RUN npm install pnpm@11.5.1 turbo --global
RUN pnpm config set store-dir ~/.pnpm-store

# Prune projects
FROM --platform=linux/amd64 base AS pruner
ARG PROJECT=app

WORKDIR /app
COPY . .
RUN turbo prune --scope=${PROJECT} --docker

# Build the project
FROM --platform=linux/amd64 base AS builder
ARG PROJECT=app

WORKDIR /app

# Copy lockfile and package.json's of isolated subworkspace
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /app/out/json/ .

# First install the dependencies (as they change less often)
RUN --mount=type=cache,id=pnpm,target=~/.pnpm-store pnpm install --frozen-lockfile

# Copy source code of isolated subworkspace
COPY --from=pruner /app/out/full/ .

RUN turbo build --filter=${PROJECT}
# Remove dev dependencies and hoist production dependencies to top level for proper module resolution
RUN --mount=type=cache,id=pnpm,target=~/.pnpm-store pnpm install --frozen-lockfile --prod --shamefully-hoist
# Remove source files only from workspace packages, not from node_modules
RUN rm -rf ./packages/*/src ./apps/*/src

# Final image
FROM --platform=linux/amd64 debian-base AS runner
ARG PROJECT=app
ENV PROJECT=${PROJECT}

# Clean up build dependencies in the final image
RUN apt-get purge -y make g++ git \
 && apt-get autoremove -y && apt-get clean

WORKDIR /app
COPY --from=builder /app .

# Create matrix storage directory
RUN mkdir -p apps/${PROJECT}/matrix-storage

ENV NODE_ENV=production
EXPOSE 3000

CMD sh -c "node --experimental-require-module apps/${PROJECT}/dist/main"

# docker build -t api:latest --build-arg PROJECT=api .
# docker build -t ghcr.io/ixofoundation/qiforge:v0.0.2 --build-arg PROJECT=guru .
