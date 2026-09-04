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
# optimization) use prebuilt glibc binaries. Digest-pinned for reproducibility
# + supply-chain integrity; bump the tag AND digest together (see docs/docker.md
# "Hardening"). Digest is the multi-arch index for `node:22-bookworm-slim`
# (22.23.2, 2026-08-25). Dependabot's `docker` ecosystem (.github/dependabot.yml)
# proposes digest bumps; keep BOTH stages on the same digest.
# ─────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS builder

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
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS runner

ENV NODE_ENV="production" \
    NEXT_TELEMETRY_DISABLED="1" \
    PORT="3000" \
    HOSTNAME="0.0.0.0"
WORKDIR /app

# Non-root runtime user.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Strip the package-manager CLIs the base image bundles (npm + its vendored
# node_modules, npx, corepack, yarn). The runtime is `node server.js` only and
# never invokes them, yet npm's bundled dependencies (tar, pacote, minimatch/
# brace-expansion, ip-address, sigstore, picomatch, …) are what the Trivy image
# scan kept flagging — a whole class of "fixable HIGH/CRITICAL" findings that
# are unreachable in production and that no app-side dependency bump can clear.
# Removing them keeps `.trivyignore` empty of npm-CLI mutes and shrinks the
# runtime attack surface (nothing in the image can install packages).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# `.next/standalone` already contains server.js + the minimal traced
# node_modules; `.next/static` and `public` are served by it. `docs/` and
# `help/` are the in-app viewers' source roots (DOCS_ROOT/HELP_ROOT default
# to <cwd>/docs and <cwd>/help) — copy them so both viewers work out of
# the box.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/docs ./docs
COPY --from=builder --chown=nextjs:nodejs /app/help ./help

USER nextjs
EXPOSE 3000

# Wire the readiness endpoint to the container health status. /api/health/ready
# runs `select 1` and returns 503 when the DB is unreachable, so this reports
# the container healthy only when it can actually serve — not the instant the
# process starts (Compose `service_healthy`, Swarm, and `docker run` all read
# this). Node 22 ships a global `fetch`; Docker's `--timeout` bounds the probe,
# and `--start-period` keeps boot-time failures from counting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Next.js standalone server reads PORT / HOSTNAME from the env above.
CMD ["node", "server.js"]
