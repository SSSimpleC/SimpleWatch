ARG NODE_IMAGE=docker.m.daocloud.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG RUNTIME_IMAGE
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR=mirrors.aliyun.com
USER root
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate
WORKDIR /opt/simplewatch
COPY . .
RUN pnpm install --frozen-lockfile --prod=false \
    && pnpm build:production \
    && pnpm --filter @simplewatch/api deploy --prod --legacy /opt/runtime \
    && rm -r /opt/runtime/node_modules/@simplewatch \
    && rm -r /opt/runtime/node_modules/.pnpm/node_modules/@simplewatch \
    && find /opt/runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@simplewatch+*' -exec rm -r '{}' + \
    && test ! -e /opt/runtime/node_modules/tsx

# Keep the existing validated Node/OS/FFmpeg runtime. Replace the ENTIRE
# application dependency tree so patched packages cannot merge with stale ones.
# RUNTIME_IMAGE must be the currently running App/Worker image, verified by ID.
FROM ${RUNTIME_IMAGE}
ARG SOURCE_SHA256
ARG GIT_SHA
ARG RELEASE_KIND=local-predeploy
LABEL org.opencontainers.image.revision=${GIT_SHA} \
    simplewatch.source-sha256=${SOURCE_SHA256} \
    simplewatch.release-kind=${RELEASE_KIND}
USER root
WORKDIR /opt/simplewatch
RUN rm -r /opt/simplewatch/node_modules /opt/simplewatch/dist /opt/simplewatch/migrations
COPY --from=builder --chown=node:node /opt/runtime/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/simplewatch/dist/server ./dist
COPY --from=builder --chown=node:node /opt/simplewatch/dist/web ./dist/web
COPY --from=builder --chown=node:node /opt/simplewatch/migrations ./migrations
USER node
CMD ["node", "dist/api.mjs"]
