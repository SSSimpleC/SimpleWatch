import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { buildApp } from "../../apps/api/src/app.ts";

// A temporary localhost stack, not a production server or replacement media route.
const repository = resolve(import.meta.dirname, "../..");
const origin = "https://127.0.0.1:18443";
const apiPort = 13943;
const caddy =
  process.env.PLAYER_CADDY_BIN ??
  resolve(repository, ".cache/caddy-2.11.4/caddy");
if (
  !execFileSync(caddy, ["version"], { encoding: "utf8" }).startsWith("v2.11.4 ")
) {
  throw new Error("Player gate requires pinned Caddy 2.11.4");
}
const localRoot = resolve(repository, ".local/player-e2e");
await mkdir(localRoot, { recursive: true });
const runRoot = await mkdtemp(join(localRoot, "run-"));
const mediaRoot = join(runRoot, "media");
const fixture = resolve(repository, "test-data/generated/sync-60s.mp4");
const mediaId = "d8b0483b-b1d2-49d4-8f3b-f16341734bd4";
const storageKey =
  "player_fixture_0123456789abcdef0123456789abcdef0123456789abcdef";
const target = join(mediaRoot, storageKey, "content.mp4");
await mkdir(join(mediaRoot, storageKey), { recursive: true });
await copyFile(fixture, target);
const bytes = (await stat(target)).size;
const sha256 = createHash("sha256")
  .update(await readFile(target))
  .digest("hex");
const internalToken = "local-player-gate-internal-token-not-production";
const app = await buildApp({
  databasePath: join(runRoot, "player.sqlite3"),
  migrationsPath: resolve(repository, "migrations"),
  publicOrigin: origin,
  webRoot: resolve(repository, "dist/web"),
  mediaRoot,
  uploadRoot: join(runRoot, "uploads"),
  inboxRoot: join(runRoot, "inbox"),
  subtitleRoot: join(runRoot, "subtitles"),
  trashRoot: join(runRoot, "trash"),
  internalHookToken: internalToken,
  contentSigningSecret: "local-player-gate-signing-secret-not-production",
  authFailureDelay: () => Promise.resolve(),
});
await app.authService.provisionAccounts([
  {
    username: "Host",
    role: "host",
    password: "player-host-test-password-24-characters",
  },
  {
    username: "Simple",
    role: "viewer",
    password: "player-viewer-test-password-24-characters",
  },
]);
app.database
  .prepare(
    `INSERT INTO media(
  id,storage_key,display_name,state,bytes,sha256,mime,duration_ms,created_at,
  video_codec,playback_support,video_width,video_height,video_fps,video_pixel_format,probe_json
) VALUES (?,?,'sync-player-fixture.mp4','published',?,?,'video/mp4',60000,?,
  'h264','broad',640,360,30,'yuv420p',?)`,
  )
  .run(
    mediaId,
    storageKey,
    bytes,
    sha256,
    Date.now(),
    JSON.stringify({ finalPath: target }),
  );

const cert = join(runRoot, "localhost.crt");
const key = join(runRoot, "localhost.key");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
const config = join(runRoot, "Caddyfile");
await writeFile(
  config,
  `{
  auto_https off
  admin off
}
${origin} {
  bind 127.0.0.1
  tls ${JSON.stringify(cert)} ${JSON.stringify(key)}
  header {
    -Server
    X-Content-Type-Options nosniff
    Cache-Control no-store
  }
  route {
    @media path /media-files/*
    @media_bad_method {
      path /media-files/*
      not method GET HEAD
    }
    @multiple_ranges {
      path /media-files/*
      header Range "*,*"
    }
    respond @media_bad_method 405
    respond @multiple_ranges 416
    handle @media {
      forward_auth 127.0.0.1:${apiPort} {
        uri /api/v1/internal/media/authorize
        header_up X-Internal-Token ${internalToken}
        header_up X-Forwarded-Method {orig_method}
        header_up X-Forwarded-Uri {orig_uri}
      }
      uri strip_prefix /media-files
      root * ${JSON.stringify(mediaRoot)}
      file_server
    }
    handle {
      reverse_proxy 127.0.0.1:${apiPort}
    }
  }
}
`,
);
const processEnv = {
  ...process.env,
  XDG_DATA_HOME: join(runRoot, "caddy-data"),
  XDG_CONFIG_HOME: join(runRoot, "caddy-config"),
};
execFileSync(
  caddy,
  ["validate", "--config", config, "--adapter", "caddyfile"],
  { env: processEnv, stdio: "pipe" },
);
await app.app.listen({ host: "127.0.0.1", port: apiPort });
const edge = spawn(
  caddy,
  ["run", "--config", config, "--adapter", "caddyfile"],
  { env: processEnv, stdio: ["ignore", "inherit", "inherit"] },
);
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  edge.kill("SIGTERM");
  await app.app.close();
  process.exit(code);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
edge.once("error", (error) => {
  console.error(error);
  void stop(1);
});
edge.once("exit", (code) => {
  if (!stopping) void stop(code ?? 1);
});
console.log(
  `Player gate isolated stack: ${origin}; fixture=${mediaId}; evidence=${runRoot}`,
);
