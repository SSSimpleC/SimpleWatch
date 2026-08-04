ARG NODE_IMAGE=docker.m.daocloud.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR=deb.debian.org

USER root

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate
WORKDIR /opt/simplewatch
COPY . .
RUN pnpm install --frozen-lockfile --prod=false \
    && pnpm build:production

# `pnpm deploy` materializes only API production dependencies. The Worker
# dependency set is asserted by build-server.mjs to be a subset of this set.
# Workspace TypeScript packages are bundled, so their source copies are removed
# before the runtime node_modules tree is transferred to the final image.
RUN pnpm --filter @simplewatch/api deploy --prod --legacy /opt/runtime \
    && rm -r /opt/runtime/node_modules/@simplewatch \
    && rm -r /opt/runtime/node_modules/.pnpm/node_modules/@simplewatch \
    && find /opt/runtime/node_modules/.pnpm \
      -mindepth 1 -maxdepth 1 -type d -name '@simplewatch+*' \
      -exec rm -r '{}' + \
    && test ! -e /opt/runtime/node_modules/tsx

FROM ${NODE_IMAGE}
ARG APT_MIRROR=deb.debian.org

USER root

ENV NODE_ENV=production

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/simplewatch
COPY --from=builder --chown=node:node /opt/runtime/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/simplewatch/dist/server ./dist
COPY --from=builder --chown=node:node /opt/simplewatch/dist/web ./dist/web
COPY --from=builder --chown=node:node /opt/simplewatch/migrations ./migrations

USER node
CMD ["node", "dist/api.mjs"]
