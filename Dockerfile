ARG NODE_IMAGE=node:24.18.0-bookworm-slim
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR=deb.debian.org

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
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm build:web

FROM ${NODE_IMAGE}
ARG APT_MIRROR=deb.debian.org

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate
WORKDIR /opt/simplewatch
COPY --from=builder --chown=node:node /opt/simplewatch /opt/simplewatch

USER node
CMD ["pnpm", "--filter", "@simplewatch/api", "exec", "tsx", "src/main.ts"]
