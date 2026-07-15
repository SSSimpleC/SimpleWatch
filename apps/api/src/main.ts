import { parseAppConfig } from "@simplewatch/config";

import { buildApp } from "./app.js";

const config = parseAppConfig(process.env);
const { app } = await buildApp({
  databasePath: config.databasePath,
  publicOrigin: config.publicOrigin,
  friendInviteToken: config.friendInviteToken,
  mediaRoot: config.mediaRoot,
  uploadRoot: config.uploadRoot,
  inboxRoot: config.inboxRoot,
  subtitleRoot: config.subtitleRoot,
  tusEndpoint: config.tusEndpoint,
  contentSigningSecret: config.contentSigningSecret,
  internalHookToken: config.internalHookToken,
  mediaJwtSecret: config.mediaJwtSecret,
  mediaOrigin: config.mediaOrigin,
  livekitApiKey: config.livekitApiKey,
  livekitApiSecret: config.livekitApiSecret,
  livekitUrl: config.livekitUrl,
  mediamtxControlUrl: config.mediamtxControlUrl,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
