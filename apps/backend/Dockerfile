# Backend image (build context: repository root).
#
#   docker build -f apps/backend/Dockerfile -t tunex-backend .
#   docker run -p 3000:3000 -v tunex_data:/data tunex-backend
#
# The runtime executes the TypeScript sources through `tsx` (the same entry the
# repository uses), so dev dependencies stay installed: `tsx`, the Prisma CLI and
# the generator. The database is SQLite under /data; `DB_PUSH_ON_START=0` skips
# the schema push when an operator manages migrations out of band.

FROM node:24-slim

ARG PNPM_VERSION=11.7.0
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

# Install first so the layer cache survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/license-server/package.json apps/license-server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/relayx.db

RUN mkdir -p /data && chmod +x apps/backend/docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["bash", "apps/backend/docker-entrypoint.sh"]
