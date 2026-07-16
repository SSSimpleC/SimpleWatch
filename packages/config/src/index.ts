import { z } from "zod";

export const appConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  databasePath: z.string().min(1),
  publicOrigin: z.url(),
  sessionSecret: z.string().min(32),
  passwordPepper: z.string().min(32),
  mediaRoot: z.string().min(1),
  uploadRoot: z.string().min(1),
  inboxRoot: z.string().min(1),
  subtitleRoot: z.string().min(1),
  trashRoot: z.string().min(1),
  contentSigningSecret: z.string().min(32),
  tusEndpoint: z.url(),
  internalHookToken: z.string().min(32),
  mediaJwtSecret: z.string().min(32),
  obsCredentialEncryptionKey: z.string().min(32),
  mediaOrigin: z.url(),
  livekitApiKey: z.string().min(1),
  livekitApiSecret: z.string().min(32),
  livekitUrl: z.url(),
  mediamtxControlUrl: z.url(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export function parseAppConfig(environment: NodeJS.ProcessEnv): AppConfig {
  return appConfigSchema.parse({
    nodeEnv: environment.NODE_ENV,
    host: environment.HOST,
    port: environment.PORT,
    databasePath: environment.DATABASE_PATH,
    publicOrigin: environment.PUBLIC_ORIGIN,
    sessionSecret: environment.SESSION_SECRET,
    passwordPepper: environment.PASSWORD_PEPPER,
    mediaRoot: environment.MEDIA_ROOT,
    uploadRoot: environment.UPLOAD_ROOT,
    inboxRoot: environment.INBOX_ROOT,
    subtitleRoot: environment.SUBTITLE_ROOT,
    trashRoot: environment.TRASH_ROOT,
    contentSigningSecret: environment.CONTENT_SIGNING_SECRET,
    tusEndpoint: environment.TUS_ENDPOINT,
    internalHookToken: environment.INTERNAL_HOOK_TOKEN,
    mediaJwtSecret: environment.MEDIA_JWT_SECRET,
    obsCredentialEncryptionKey: environment.OBS_CREDENTIAL_ENCRYPTION_KEY,
    mediaOrigin: environment.MEDIA_ORIGIN,
    livekitApiKey: environment.LIVEKIT_API_KEY,
    livekitApiSecret: environment.LIVEKIT_API_SECRET,
    livekitUrl: environment.LIVEKIT_URL,
    mediamtxControlUrl: environment.MEDIAMTX_CONTROL_URL,
  });
}
