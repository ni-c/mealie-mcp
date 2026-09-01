# Build stage. node:24-alpine is the ACTIVE LTS line (Krypton) as of 2026-08-18 —
# 26 exists but is a current release, not LTS, which is why dependabot.yml ignores
# major bumps of this image while still taking digest and minor refreshes.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /app
ENV NODE_ENV=production

# CVE-2026-14456: the pinned base image carries OpenSSL 3.5.7-r0, and Alpine's
# fixed 3.5.8-r0 has not been rebuilt into node:24-alpine yet. Upgrading these
# two packages by name rather than running a blanket `apk upgrade` keeps the
# rest of the image exactly as the digest pins it. Drop this once the base
# image ships the fix.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime.
COPY package.json package-lock.json ./

# npm itself is not needed — the entrypoint is bare `node` — and its own
# dependency tree is what container scanners report as vulnerable in this base
# image. Removing it does not shrink the image (the base layer stays), but it
# does take those files out of the final filesystem, which is what gets scanned.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/mealie-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
USER node

# stdio transport only — no port, no healthcheck. The server starts without
# credentials (tools are listable, so registries and inspectors can introspect
# it); every call then fails with setup instructions instead of reaching the API.
ENTRYPOINT ["node", "dist/index.js"]
