import { describe, expect, it } from "vitest";

import { parseAppConfig } from "../src/index.js";

describe("parseAppConfig", () => {
  it("normalizes environment variables", () => {
    expect(
      parseAppConfig({
        DATABASE_PATH: "tmp/simplewatch.sqlite3",
        PORT: "3100",
        PUBLIC_ORIGIN: "https://watch.example.test",
        SESSION_SECRET: "a".repeat(32),
        PASSWORD_PEPPER: "p".repeat(32),
        MEDIA_ROOT: "tmp/media",
        UPLOAD_ROOT: "tmp/uploads",
        INBOX_ROOT: "tmp/inbox",
        SUBTITLE_ROOT: "tmp/subtitles",
        TRASH_ROOT: "tmp/trash",
        CONTENT_SIGNING_SECRET: "b".repeat(32),
        TUS_ENDPOINT: "https://watch.example.test/files/",
        INTERNAL_HOOK_TOKEN: "c".repeat(32),
        MEDIA_JWT_SECRET: "d".repeat(32),
        OBS_CREDENTIAL_ENCRYPTION_KEY: "f".repeat(32),
        MEDIA_ORIGIN: "https://media.example.test",
        LIVEKIT_API_KEY: "api-key",
        LIVEKIT_API_SECRET: "e".repeat(32),
        LIVEKIT_URL: "wss://rtc.example.test",
        MEDIAMTX_CONTROL_URL: "http://mediamtx:9997",
      }),
    ).toEqual({
      databasePath: "tmp/simplewatch.sqlite3",
      host: "127.0.0.1",
      nodeEnv: "development",
      port: 3100,
      publicOrigin: "https://watch.example.test",
      sessionSecret: "a".repeat(32),
      passwordPepper: "p".repeat(32),
      mediaRoot: "tmp/media",
      uploadRoot: "tmp/uploads",
      inboxRoot: "tmp/inbox",
      subtitleRoot: "tmp/subtitles",
      trashRoot: "tmp/trash",
      contentSigningSecret: "b".repeat(32),
      tusEndpoint: "https://watch.example.test/files/",
      internalHookToken: "c".repeat(32),
      mediaJwtSecret: "d".repeat(32),
      obsCredentialEncryptionKey: "f".repeat(32),
      mediaOrigin: "https://media.example.test",
      livekitApiKey: "api-key",
      livekitApiSecret: "e".repeat(32),
      livekitUrl: "wss://rtc.example.test",
      mediamtxControlUrl: "http://mediamtx:9997",
    });
  });
});
