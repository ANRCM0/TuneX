# syntax=docker/dockerfile:1
#
# RelayX web (Next.js standalone). Mirrors the shipped image layout: the app lives in
# /app, runs as the unprivileged `node` user and listens on 3000.
#
# Build from the REPOSITORY ROOT so the workspace packages resolve:
#   docker build -f apps/web/Dockerfile -t relayx-web .

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @relayx/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @relayx/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nodejs
WORKDIR /app
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/public ./apps/web/public
USER nodejs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
