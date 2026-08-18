# Build stage. node:24-alpine is the ACTIVE LTS line (Krypton) as of 2026-08-18 —
# 26 exists but is a current release, not LTS, which is why dependabot.yml ignores
# major bumps of this image while still taking digest and minor refreshes.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
ENV NODE_ENV=production

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
