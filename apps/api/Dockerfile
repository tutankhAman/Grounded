# Grounded API — Bun + Elysia (production)
# Pinned to Bun 1.4: bun.lock uses lockfileVersion 2, which older Bun
# releases cannot parse (lowers the image only in lockstep with the lockfile).
FROM oven/bun:1.4-slim

WORKDIR /app

# Workspace manifests first for a cached dependency layer
COPY package.json bun.lock tsconfig.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
# --ignore-scripts: skips the root `prepare` hook (lefthook needs git, which
# slim images lack). No runtime dependency relies on postinstall — native
# modules (@napi-rs/canvas, unpdf) ship prebuilt binaries in-package.
RUN bun install --frozen-lockfile --ignore-scripts

# App sources (dotenv ../../../.env resolves to /app/.env — absent in
# containers, so all config comes from container env, which is intended)
COPY packages/db ./packages/db
COPY apps/api ./apps/api

ENV NODE_ENV=production PORT=3000 UPLOAD_DIR=/app/uploads
RUN mkdir -p /app/uploads

EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
