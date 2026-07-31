ARG NODE_IMAGE=docker.m.daocloud.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE}

ARG EDGE_AGENT_RELEASE_TAG
ARG EDGE_AGENT_ARTIFACT_SHA256
LABEL org.opencontainers.image.version="${EDGE_AGENT_RELEASE_TAG}" \
      io.simplewatch.edge-agent.artifact-sha256="${EDGE_AGENT_ARTIFACT_SHA256}"

ENV NODE_ENV=production
WORKDIR /opt/simplewatch-edge-agent

COPY --chown=node:node dist/edge-agent/main.mjs ./main.mjs

USER node
CMD ["node", "main.mjs"]
