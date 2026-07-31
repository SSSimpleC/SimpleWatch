import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { EdgeAdminEvent } from "@simplewatch/contracts";
import { useEffect, useRef } from "react";

import { useSession } from "./store.js";

const adminRootKey = ["admin"] as const;

export const adminQueryKeys = {
  root: adminRootKey,
  activeRoom: [...adminRootKey, "active-room"] as const,
  media: [...adminRootKey, "media"] as const,
  program: [...adminRootKey, "program"] as const,
  edgeSummary: [...adminRootKey, "edge", "summary"] as const,
  edgeCatalog: [...adminRootKey, "edge", "catalog"] as const,
  edgeTransfers: [...adminRootKey, "edge", "transfers"] as const,
  edgeCache: [...adminRootKey, "edge", "cache"] as const,
};

export function isAdminQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === adminRootKey[0];
}

export function purgeAdminQueries(queryClient: QueryClient): void {
  const cancellation = queryClient.cancelQueries({
    queryKey: adminRootKey,
    exact: false,
  });
  queryClient.removeQueries({ queryKey: adminRootKey, exact: false });
  void cancellation.finally(() =>
    queryClient.removeQueries({ queryKey: adminRootKey, exact: false }),
  );
}

/**
 * 正常 SSE 事件只刷新实际受影响的管理账本。断线时由页面以 root key
 * 做一次兜底全量刷新，避免常态事件让所有面板同步抖动。
 */
export function adminQueryKeysForEvent(
  type: EdgeAdminEvent["type"],
): readonly QueryKey[] {
  switch (type) {
    case "edge.agent.changed":
      return [adminQueryKeys.edgeSummary];
    case "edge.catalog.changed":
      return [adminQueryKeys.edgeCatalog, adminQueryKeys.edgeSummary];
    case "edge.transfer.changed":
      return [
        adminQueryKeys.edgeTransfers,
        adminQueryKeys.edgeCatalog,
        adminQueryKeys.program,
        adminQueryKeys.edgeSummary,
      ];
    case "edge.cache.changed":
      return [
        adminQueryKeys.edgeCache,
        adminQueryKeys.program,
        adminQueryKeys.media,
        adminQueryKeys.edgeSummary,
      ];
    case "program.queue.changed":
      return [adminQueryKeys.program];
    case "storage.changed":
      return [adminQueryKeys.edgeSummary];
  }
}

export function hasHostControls(
  accountRole: "host" | "viewer" | undefined,
  memberId: string | null,
  hostMemberId: string | undefined,
): boolean {
  return (
    accountRole === "host" &&
    Boolean(memberId) &&
    Boolean(hostMemberId) &&
    memberId === hostMemberId
  );
}

/**
 * 管理数据只允许跟随当前 Host 身份存活。账户退出、换号，或同一浏览器
 * 切换到 Viewer 后立即中止请求并清空缓存，避免 Edge 元数据留在内存中。
 */
export function AdminDataBoundary() {
  const queryClient = useQueryClient();
  const account = useSession((state) => state.account);
  const previousIdentity = useRef<string | null>(null);

  useEffect(() => {
    const nextIdentity = account ? `${account.id}:${account.role}` : null;
    const identityChanged = previousIdentity.current !== nextIdentity;
    if (account?.role !== "host" || identityChanged) {
      purgeAdminQueries(queryClient);
    }
    previousIdentity.current = nextIdentity;
  }, [account, queryClient]);

  return null;
}
