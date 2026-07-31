import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { MediaService } from "../services/media-service.js";

if (process.env.ALLOW_EXPIRED_UPLOAD_CLEANUP !== "cancel-expired-uploads") {
  throw new Error("必须显式确认过期上传清理");
}

interface ExpiredUploadRow {
  readonly id: string;
  readonly owner_admin_id: string;
}

interface UploadStateRow {
  readonly state: string;
}

const terminalStates = new Set([
  "cancelled",
  "failed",
  "incompatible",
  "published",
]);
const uploadIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orphanMinimumAgeMs = 7 * 24 * 60 * 60 * 1000;
const now = Date.now();
const config = parseAppConfig(process.env);
const database = openDatabase({ databasePath: config.databasePath });

try {
  const mediaService = new MediaService(database, {
    mediaRoot: config.mediaRoot,
    uploadRoot: config.uploadRoot,
    inboxRoot: config.inboxRoot,
    subtitleRoot: config.subtitleRoot,
    trashRoot: config.trashRoot,
    tusEndpoint: config.tusEndpoint,
    contentSigningSecret: config.contentSigningSecret,
    now: () => now,
  });
  const expired = database
    .prepare(
      `SELECT id, owner_admin_id
       FROM uploads
       WHERE state IN ('authorized', 'uploading') AND expires_at <= ?
         AND edge_job_id IS NULL
       ORDER BY created_at, id`,
    )
    .all(now) as ExpiredUploadRow[];
  for (const upload of expired) {
    mediaService.cancelUpload(upload.owner_admin_id, upload.id);
  }

  let removedMetadata = 0;
  for (const name of readdirSync(config.uploadRoot)) {
    if (!name.endsWith(".info")) continue;
    const uploadId = name.slice(0, -".info".length);
    if (!uploadIdPattern.test(uploadId)) continue;
    const metadataPath = join(config.uploadRoot, name);
    const dataPath = join(config.uploadRoot, uploadId);
    if (existsSync(dataPath)) continue;
    const metadata = statSync(metadataPath);
    if (!metadata.isFile() || now - metadata.mtimeMs < orphanMinimumAgeMs)
      continue;
    const upload = database
      .prepare("SELECT state FROM uploads WHERE id = ?")
      .get(uploadId) as UploadStateRow | undefined;
    if (upload && !terminalStates.has(upload.state)) continue;
    unlinkSync(metadataPath);
    removedMetadata += 1;
  }

  process.stdout.write(
    `${JSON.stringify({ cancelledExpiredUploads: expired.length, removedOrphanMetadata: removedMetadata })}\n`,
  );
} finally {
  database.close();
}
