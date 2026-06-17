# syntax=docker/dockerfile:1
#
# Production image for devresponsekit.
#
# Multi-stage build that produces a thin, non-root runtime image from
# Next.js' standalone output (`output: "standalone"` in next.config.mjs):
# the final image is `node server.js` plus only the traced runtime deps —
# not the full repo or dev dependencies.
#
# Build:   docker build -t devresponsekit .
# Run:     see docs/docker.md (env vars + run/deploy + migrations)
#
# NOTE: database migrations are NOT run by this image's CMD. They are a
# separate one-off step run BEFORE traffic is routed — see docs/docker.md.

# ─────────────────────────────────────────────────────────────────────
# Stage 1 — builder: install all deps and produce the standalone bundle.
# Debian "slim" (not Alpine) so native modules like `sharp` (Next image
# optimization) use prebuilt glibc binaries. Pin to a digest in production
# for full reproducibility (see docs/docker.md "Hardening").
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI="true" \
    NEXT_TELEMETRY_DISABLED="1"
WORKDIR /app

# corepack ships with Node and pins pnpm to the `packageManager` field.
RUN corepack enable

# Install against the committed lockfile first so this layer caches until
# dependencies actually change. `.npmrc` carries node-linker=hoisted.
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build the standalone server. `next build` sets
# NEXT_PHASE=phase-production-build, so src/lib/env.ts substitutes
# placeholders — NO real secrets are needed or baked in at build time.
# Sentry source-map upload stays off unless SENTRY_AUTH_TOKEN is provided.
COPY . .
RUN pnpm build

# ─────────────────────────────────────────────────────────────────────
# Stage 2 — runner: copy only the standalone server + static assets and
# run as an unprivileged user.
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV="production" \
    NEXT_TELEMETRY_DISABLED="1" \
    PORT="3000" \
    HOSTNAME="0.0.0.0"
WORKDIR /app

# Non-root runtime user.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# `.next/standalone` already contains server.js + the minimal traced
# node_modules; `.next/static` and `public` are served by it. `docs/` is
# the in-app documentation viewer's source root (DOCS_ROOT defaults to
# <cwd>/docs) — copy it so the /docs viewer works out of the box.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/docs ./docs

USER nextjs
EXPOSE 3000

# The Next.js standalone server reads PORT / HOSTNAME from the env above.
CMD ["node", "server.js"]
