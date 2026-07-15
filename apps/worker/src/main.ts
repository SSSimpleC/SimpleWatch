import { z } from "zod";
import { RoomServiceClient } from "livekit-server-sdk";

import { processProbeJob, processSubtitleJob } from "./process-media.js";
import {
  processOutboxItem,
  reconcileRtcParticipants,
} from "./process-outbox.js";
import { SftpScanner } from "./sftp-scanner.js";

const configSchema = z.object({
  apiOrigin: z.url(),
  internalToken: z.string().min(32),
  workerId: z.string().min(1),
  uploadRoot: z.string().min(1),
  mediaRoot: z.string().min(1),
  inboxRoot: z.string().min(1),
  subtitleRoot: z.string().min(1),
  sftpIncomingRoot: z.string().min(1).optional(),
  ffprobePath: z.string().min(1).default("ffprobe"),
  ffmpegPath: z.string().min(1).default("ffmpeg"),
  livekitInternalUrl: z.url(),
  livekitApiKey: z.string().min(1),
  livekitApiSecret: z.string().min(1),
  mediamtxControlUrl: z.url(),
});
const probePayloadSchema = z.object({
  uploadId: z.string().optional(),
  filePath: z.string(),
  storageKey: z.string(),
  source: z.literal("sftp").optional(),
});
const subtitlePayloadSchema = z.object({
  storageKey: z.string(),
  contentBase64: z.string(),
});

const config = configSchema.parse({
  apiOrigin: process.env.API_ORIGIN,
  internalToken: process.env.INTERNAL_HOOK_TOKEN,
  workerId: process.env.WORKER_ID,
  uploadRoot: process.env.UPLOAD_ROOT,
  mediaRoot: process.env.MEDIA_ROOT,
  inboxRoot: process.env.INBOX_ROOT,
  subtitleRoot: process.env.SUBTITLE_ROOT,
  sftpIncomingRoot: process.env.SFTP_INCOMING_ROOT,
  ffprobePath: process.env.FFPROBE_PATH,
  ffmpegPath: process.env.FFMPEG_PATH,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL,
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
  mediamtxControlUrl: process.env.MEDIAMTX_CONTROL_URL,
});
const livekit = new RoomServiceClient(
  config.livekitInternalUrl,
  config.livekitApiKey,
  config.livekitApiSecret,
);
const sftpScanner = config.sftpIncomingRoot
  ? new SftpScanner(config.sftpIncomingRoot, config.inboxRoot)
  : null;
let nextSftpScanAt = 0;
let nextRtcReconciliationAt = 0;

while (true) {
  if (Date.now() >= nextRtcReconciliationAt) {
    nextRtcReconciliationAt = Date.now() + 15_000;
    try {
      const response = await callApi(
        "/api/v1/internal/rtc/reconciliation-snapshot",
        { method: "GET" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = (await response.json()) as {
        rooms: Array<{ roomId: string; activeMemberIds: string[] }>;
      };
      await reconcileRtcParticipants(snapshot.rooms, livekit);
    } catch (error) {
      console.error("RTC 对账暂不可用", error);
    }
  }
  if (sftpScanner && Date.now() >= nextSftpScanAt) {
    nextSftpScanAt = Date.now() + 60_000;
    sftpScanner.scan();
    for (const candidate of sftpScanner.pendingImports()) {
      try {
        const imported = await callApi("/api/v1/internal/imports/sftp", {
          method: "POST",
          body: JSON.stringify(candidate),
        });
        if (!imported.ok) {
          console.error(`SFTP 导入登记失败：HTTP ${imported.status}`);
        }
      } catch (error) {
        // 文件已经原子移动到 inbox/sftp，后续扫描会重新登记；网络抖动
        // 不能终止整个 Worker，否则普通上传任务也会停止处理。
        console.error("SFTP 导入登记服务暂不可用", error);
      }
    }
  }
  try {
    const outboxResponse = await callApi("/api/v1/internal/outbox/claim", {
      method: "POST",
      body: JSON.stringify({ workerId: config.workerId }),
    });
    if (outboxResponse.ok && outboxResponse.status !== 204) {
      const item = (await outboxResponse.json()) as {
        id: string;
        kind: string;
        payload: unknown;
        leaseToken: string;
      };
      try {
        await processOutboxItem(item, {
          livekit,
          mediamtxControlUrl: config.mediamtxControlUrl,
        });
        await submitOutboxResult(item.id, "complete", {
          leaseToken: item.leaseToken,
        });
      } catch (error) {
        await submitOutboxResult(item.id, "fail", {
          leaseToken: item.leaseToken,
          error: errorMessage(error),
        });
      }
      continue;
    }
    if (!outboxResponse.ok) {
      console.error(`Outbox 领取失败：HTTP ${outboxResponse.status}`);
    }
  } catch (error) {
    console.error("Outbox 服务暂不可用", error);
  }
  let response: Response;
  try {
    response = await callApi("/api/v1/internal/jobs/claim", {
      method: "POST",
      body: JSON.stringify({ workerId: config.workerId }),
    });
  } catch (error) {
    console.error("任务服务暂不可用", error);
    await delay(2000);
    continue;
  }
  if (response.status === 204) {
    await delay(2000);
    continue;
  }
  if (!response.ok) {
    console.error(`任务领取失败：HTTP ${response.status}`);
    await delay(2000);
    continue;
  }
  const job = (await response.json()) as {
    id: string;
    kind: string;
    leaseToken: string;
    payload: unknown;
  } | null;
  if (!job) {
    await delay(2000);
    continue;
  }
  const isSubtitle = job.kind === "subtitle";
  if (!isSubtitle && job.kind !== "probe") {
    throw new Error(`不支持的任务类型：${job.kind}`);
  }
  const result = isSubtitle
    ? processSubtitleJob(
        subtitlePayloadSchema.parse(job.payload),
        config.subtitleRoot,
      )
    : await processProbeJob(
        probePayloadSchema.parse(job.payload),
        {
          uploadRoot: config.uploadRoot,
          mediaRoot: config.mediaRoot,
          inboxRoot: config.inboxRoot,
          subtitleRoot: config.subtitleRoot,
        },
        config.ffprobePath,
        config.ffmpegPath,
      );
  const resultPath = isSubtitle ? "subtitle-result" : "result";
  const submitted = await callApi(
    `/api/v1/internal/jobs/${job.id}/${resultPath}`,
    {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, ...result }),
    },
  );
  if (!submitted.ok) throw new Error(`任务提交失败：HTTP ${submitted.status}`);
}

function callApi(path: string, init: RequestInit): Promise<Response> {
  return fetch(new URL(path, config.apiOrigin), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": config.internalToken,
      ...init.headers,
    },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function submitOutboxResult(
  id: string,
  action: "complete" | "fail",
  body: Record<string, string>,
): Promise<void> {
  const response = await callApi(`/api/v1/internal/outbox/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Outbox ${action} 提交失败：HTTP ${response.status}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
