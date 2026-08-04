import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CloudStorageSummary,
  EdgeAgentSummary,
  EdgeCacheReplica,
  EdgeCatalogItem,
  EdgeCatalogPage,
  EdgeCatalogRefreshResponse,
  EdgeTransfer,
  ProgramQueue,
} from "@simplewatch/contracts";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { adminQueryKeys } from "../../admin-data.js";
import { api, ApiError, type MediaItem } from "../../api.js";
import { useSession } from "../../store.js";

export type AdminView =
  | "screening"
  | "home-library"
  | "cloud-library"
  | "transfers"
  | "system";

interface EdgeAdminSummary {
  agents: EdgeAgentSummary[];
  storage: CloudStorageSummary;
}

type ProgramItem = ProgramQueue["items"][number];
type CatalogSourceFilter = "all" | "present" | "missing";

interface PendingCatalogScan {
  readonly baselineLastCompleteScanAt: string | null;
  readonly state: "submitting" | "queued" | "leased";
}

const catalogPathCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export const adminViews: ReadonlyArray<{
  id: AdminView;
  index: string;
  label: string;
  caption: string;
}> = [
  { id: "screening", index: "01", label: "放映", caption: "ROOM" },
  {
    id: "home-library",
    index: "02",
    label: "家庭片库",
    caption: "SOURCE",
  },
  {
    id: "cloud-library",
    index: "03",
    label: "云端片库",
    caption: "CACHE",
  },
  { id: "transfers", index: "04", label: "传输", caption: "RELAY" },
  { id: "system", index: "05", label: "系统", caption: "STATUS" },
] as const;

export function adminViewFromSearch(search: string): AdminView {
  const candidate = new URLSearchParams(search).get("view");
  return adminViews.some((view) => view.id === candidate)
    ? (candidate as AdminView)
    : "screening";
}

export function reorderProgramItemIds(
  items: readonly Pick<ProgramItem, "id">[],
  itemId: string,
  direction: -1 | 1,
): string[] | null {
  const itemIds = items.map((item) => item.id);
  const from = itemIds.indexOf(itemId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= itemIds.length) return null;
  [itemIds[from], itemIds[to]] = [itemIds[to]!, itemIds[from]!];
  return itemIds;
}

export function filterCatalogItems(
  items: readonly EdgeCatalogItem[],
  search: string,
  sourceState: CatalogSourceFilter,
  cloudState: "all" | EdgeCatalogItem["cloudState"],
): EdgeCatalogItem[] {
  const needle = search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (sourceState === "all" || item.sourceState === sourceState) &&
      (cloudState === "all" || item.cloudState === cloudState) &&
      (needle.length === 0 ||
        item.displayName.toLocaleLowerCase().includes(needle) ||
        item.relativePath.toLocaleLowerCase().includes(needle)),
  );
}

export function mergeCatalogPages(
  pages: readonly Pick<EdgeCatalogPage, "items">[],
): EdgeCatalogItem[] {
  const byVersion = new Map<string, EdgeCatalogItem>();
  for (const page of pages) {
    for (const item of page.items) byVersion.set(item.versionId, item);
  }
  return [...byVersion.values()].sort(
    (left, right) =>
      catalogPathCollator.compare(left.relativePath, right.relativePath) ||
      left.versionId.localeCompare(right.versionId),
  );
}

export function buildCatalogScanRequest(
  accountRole: "host" | "viewer" | undefined,
  csrfToken: string | null,
  agent: Pick<EdgeAgentSummary, "id" | "state">,
  pending: boolean,
): { readonly path: string; readonly init: RequestInit } | null {
  if (
    accountRole !== "host" ||
    !csrfToken ||
    pending ||
    agent.state === "revoked"
  ) {
    return null;
  }
  return {
    path: `/api/v1/admin/edge/agents/${encodeURIComponent(agent.id)}/catalog/refresh`,
    init: {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: "{}",
    },
  };
}

export function ProgramQueuePanel() {
  const queryClient = useQueryClient();
  const adminCsrf = useSession((state) => state.adminCsrf);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const queue = useQuery({
    queryKey: adminQueryKeys.program,
    queryFn: () => api<ProgramQueue | null>("/api/v1/admin/program"),
  });
  const program = queue.data;

  async function applyQueueMutation(
    action: string,
    request: () => Promise<ProgramQueue>,
    successCopy: string,
  ) {
    if (!adminCsrf || pendingAction) return;
    setPendingAction(action);
    setMessage("");
    try {
      const next = await request();
      queryClient.setQueryData(adminQueryKeys.program, next);
      setMessage(successCopy);
    } catch (error) {
      setMessage(mutationErrorCopy(error));
      if (
        error instanceof ApiError &&
        error.code === "PROGRAM_REVISION_CONFLICT"
      ) {
        await queryClient.invalidateQueries({
          queryKey: adminQueryKeys.program,
        });
      }
    } finally {
      setPendingAction(null);
    }
  }

  function moveItem(itemId: string, direction: -1 | 1) {
    if (!program || !adminCsrf) return;
    const itemIds = reorderProgramItemIds(program.items, itemId, direction);
    if (!itemIds) return;
    void applyQueueMutation(
      `move:${itemId}`,
      () =>
        api<ProgramQueue>(`/api/v1/admin/program/${program.id}/order`, {
          method: "PUT",
          headers: { "x-csrf-token": adminCsrf },
          body: JSON.stringify({
            expectedRevision: program.revision,
            itemIds,
          }),
        }),
      "节目顺序已更新",
    );
  }

  function removeItem(item: ProgramItem) {
    if (!program || !adminCsrf) return;
    if (!confirm(`从节目单移除《${item.displayName}》？不会删除家庭原片。`)) {
      return;
    }
    void applyQueueMutation(
      `remove:${item.id}`,
      () =>
        api<ProgramQueue>(
          `/api/v1/admin/program/${program.id}/items/${item.id}`,
          {
            method: "DELETE",
            headers: { "x-csrf-token": adminCsrf },
            body: JSON.stringify({ expectedRevision: program.revision }),
          },
        ),
      "节目已移除；家庭原片保持不变",
    );
  }

  function togglePin(item: ProgramItem) {
    if (!program || !adminCsrf) return;
    void applyQueueMutation(
      `pin:${item.id}`,
      () =>
        api<ProgramQueue>(
          `/api/v1/admin/program/${program.id}/items/${item.id}/pin`,
          {
            method: "PATCH",
            headers: { "x-csrf-token": adminCsrf },
            body: JSON.stringify({
              expectedRevision: program.revision,
              pinned: !item.pinned,
            }),
          },
        ),
      item.pinned ? "已取消缓存置顶" : "已置顶，云端缓存不会自动回收",
    );
  }

  return (
    <section
      className="panel program-ledger"
      aria-labelledby="program-title"
      aria-busy={Boolean(pendingAction)}
    >
      <div className="panel-title">
        <span>PROGRAM</span>
        <h2 id="program-title">节目单</h2>
        {program && <b>REV {program.revision}</b>}
      </div>
      <QueryNotice
        loading={queue.isLoading}
        error={queue.error}
        empty={!program || program.items.length === 0}
        emptyCopy="节目单为空。前往家庭片库，筛选并加入需要放映的完整影片。"
      />
      {program && program.items.length > 0 && (
        <ol className="program-strip">
          {program.items.map((item, index) => (
            <li
              key={item.id}
              className={item.id === program.currentItemId ? "current" : ""}
            >
              <span>{String(item.position + 1).padStart(2, "0")}</span>
              <div className="program-item-copy">
                <strong title={item.displayName}>{item.displayName}</strong>
                <small>
                  {preparationLabel(item.preparationState)} ·{" "}
                  {playbackLabel(item.playbackState)}
                  {item.pinned ? " · 已置顶" : ""}
                </small>
                {item.watchCoverage && (
                  <div className="program-coverage">
                    <progress
                      max={100}
                      value={item.watchCoverage.coveredRatio * 100}
                      aria-label={`${item.displayName} 已观看 ${Math.round(item.watchCoverage.coveredRatio * 100)}%`}
                    />
                    <small>
                      已观看 {Math.round(item.watchCoverage.coveredRatio * 100)}
                      %
                    </small>
                  </div>
                )}
              </div>
              <div
                className="program-item-actions"
                aria-label={`${item.displayName} 编排操作`}
              >
                <button
                  type="button"
                  className="compact-button"
                  disabled={Boolean(pendingAction) || index === 0}
                  onClick={() => moveItem(item.id, -1)}
                  aria-label={`上移 ${item.displayName}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="compact-button"
                  disabled={
                    Boolean(pendingAction) || index === program.items.length - 1
                  }
                  onClick={() => moveItem(item.id, 1)}
                  aria-label={`下移 ${item.displayName}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="compact-button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => togglePin(item)}
                  aria-pressed={item.pinned}
                >
                  {item.pinned ? "取消置顶" : "缓存置顶"}
                </button>
                <button
                  type="button"
                  className="compact-button danger"
                  disabled={
                    Boolean(pendingAction) || item.playbackState === "current"
                  }
                  onClick={() => removeItem(item)}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <MutationNotice message={message} />
    </section>
  );
}

export function AdminEdgeView({
  view,
}: {
  view: Exclude<AdminView, "screening">;
}) {
  if (view === "home-library") return <HomeLibraryView />;
  if (view === "cloud-library") return <CloudLibraryView />;
  if (view === "transfers") return <TransfersView />;
  return <SystemView />;
}

function HomeLibraryView() {
  const queryClient = useQueryClient();
  const adminCsrf = useSession((state) => state.adminCsrf);
  const accountRole = useSession((state) => state.account?.role);
  const agents = useEdgeAgents();
  const [searchDraft, setSearchDraft] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const catalog = useInfiniteQuery({
    queryKey: [...adminQueryKeys.edgeCatalog, { search: catalogSearch }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "100" });
      if (catalogSearch) query.set("search", catalogSearch);
      if (pageParam) query.set("cursor", pageParam);
      return api<EdgeCatalogPage>(`/api/v1/admin/edge/catalog?${query}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const queue = useQuery({
    queryKey: adminQueryKeys.program,
    queryFn: () => api<ProgramQueue | null>("/api/v1/admin/program"),
  });
  const [sourceState, setSourceState] =
    useState<CatalogSourceFilter>("present");
  const [cloudState, setCloudState] = useState<
    "all" | EdgeCatalogItem["cloudState"]
  >("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingScans, setPendingScans] = useState<
    Record<string, PendingCatalogScan>
  >({});
  const [scanMessages, setScanMessages] = useState<Record<string, string>>({});
  const catalogItems = useMemo(
    () => mergeCatalogPages(catalog.data?.pages ?? []),
    [catalog.data?.pages],
  );
  const filtered = useMemo(
    () => filterCatalogItems(catalogItems, "", sourceState, cloudState),
    [catalogItems, cloudState, sourceState],
  );
  const queuedVersions = new Set(
    queue.data?.items.flatMap((item) =>
      item.catalogVersionId ? [item.catalogVersionId] : [],
    ),
  );
  const selectable = filtered.filter(
    (item) =>
      item.sourceState === "present" && !queuedVersions.has(item.versionId),
  );
  const allVisibleSelected =
    selectable.length > 0 &&
    selectable.every((item) => selected.includes(item.versionId));

  useEffect(() => {
    const queued = new Set(
      queue.data?.items.flatMap((item) =>
        item.catalogVersionId ? [item.catalogVersionId] : [],
      ),
    );
    const valid = new Set(
      catalogItems
        .filter(
          (item) =>
            item.sourceState === "present" && !queued.has(item.versionId),
        )
        .map((item) => item.versionId),
    );
    setSelected((previous) => previous.filter((id) => valid.has(id)));
  }, [catalogItems, queue.data?.items]);

  useEffect(() => {
    if (!agents.data) return;
    const completed = agents.data.filter((agent) => {
      const pending = pendingScans[agent.id];
      return (
        pending !== undefined &&
        agent.lastCompleteScanAt !== null &&
        agent.lastCompleteScanAt !== pending.baselineLastCompleteScanAt
      );
    });
    if (completed.length === 0) return;
    setPendingScans((previous) => {
      const next = { ...previous };
      for (const agent of completed) delete next[agent.id];
      return next;
    });
    setScanMessages((previous) => {
      const next = { ...previous };
      for (const agent of completed) {
        next[agent.id] = "目录刷新已完成，影片索引已更新。";
      }
      return next;
    });
  }, [agents.data, pendingScans]);

  async function requestCatalogScan(agent: EdgeAgentSummary) {
    const command = buildCatalogScanRequest(
      accountRole,
      adminCsrf,
      agent,
      Boolean(pendingScans[agent.id]),
    );
    if (!command) {
      if (agent.state === "revoked") {
        setScanMessages((previous) => ({
          ...previous,
          [agent.id]: "Agent 凭据已撤销，无法刷新目录。",
        }));
      }
      return;
    }
    setPendingScans((previous) => ({
      ...previous,
      [agent.id]: {
        baselineLastCompleteScanAt: agent.lastCompleteScanAt,
        state: "submitting",
      },
    }));
    setScanMessages((previous) => ({ ...previous, [agent.id]: "" }));
    try {
      const result = await api<EdgeCatalogRefreshResponse>(
        command.path,
        command.init,
      );
      setPendingScans((previous) => ({
        ...previous,
        [agent.id]: {
          baselineLastCompleteScanAt: agent.lastCompleteScanAt,
          state: result.task.state,
        },
      }));
      setScanMessages((previous) => ({
        ...previous,
        [agent.id]: catalogScanResultCopy(agent, result.task),
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeSummary }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeCatalog }),
      ]);
    } catch (error) {
      setPendingScans((previous) => {
        const next = { ...previous };
        delete next[agent.id];
        return next;
      });
      setScanMessages((previous) => ({
        ...previous,
        [agent.id]: mutationErrorCopy(error),
      }));
    }
  }

  async function addSelectedToProgram() {
    if (!adminCsrf || selected.length === 0 || adding) return;
    setAdding(true);
    setMessage("");
    try {
      const next = await api<ProgramQueue>("/api/v1/admin/program/items", {
        method: "POST",
        headers: { "x-csrf-token": adminCsrf },
        body: JSON.stringify({
          expectedRevision: queue.data?.revision ?? 0,
          catalogVersionIds: selected,
        }),
      });
      queryClient.setQueryData(adminQueryKeys.program, next);
      setMessage(`已将 ${selected.length} 条影片加入节目单`);
      setSelected([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeCatalog }),
        queryClient.invalidateQueries({
          queryKey: adminQueryKeys.edgeTransfers,
        }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeSummary }),
      ]);
    } catch (error) {
      setMessage(mutationErrorCopy(error));
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.program });
    } finally {
      setAdding(false);
    }
  }

  function toggleVisibleSelection() {
    const visible = selectable.map((item) => item.versionId);
    setSelected((previous) =>
      allVisibleSelected
        ? previous.filter((id) => !visible.includes(id))
        : [...new Set([...previous, ...visible])],
    );
  }

  function applyCatalogSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelected([]);
    const nextSearch = searchDraft.trim();
    if (nextSearch === catalogSearch) {
      void catalog.refetch();
      return;
    }
    setCatalogSearch(nextSearch);
  }

  return (
    <section className="admin-workspace" aria-labelledby="home-library-title">
      <WorkspaceHeading
        eyebrow="SOURCE LEDGER / COMPLETE FILES"
        title="家庭片库"
        copy="Library 目录只存放完整影片；新文件或发生变化的文件仍须连续两次扫描 size 与 mtime 一致后才更新索引，以防人工复制尚未稳定。"
      />
      <div className="edge-layout">
        <section className="panel edge-source-status">
          <div className="panel-title">
            <span>AGENT</span>
            <h2>家庭服务器</h2>
          </div>
          <QueryNotice
            loading={agents.isLoading}
            error={agents.error}
            empty={!agents.data?.length}
            emptyCopy="尚未登记 Edge Agent。完成服务器端注册后，目录才会在这里出现。"
          />
          {agents.data?.map((agent) => {
            const pending = pendingScans[agent.id];
            const hintId = `agent-scan-${agent.id}`;
            return (
              <AgentLine
                key={agent.id}
                agent={agent}
                action={
                  <div className="agent-scan-action">
                    <button
                      type="button"
                      className="compact-button"
                      disabled={
                        Boolean(pending) ||
                        agent.state === "revoked" ||
                        accountRole !== "host" ||
                        !adminCsrf
                      }
                      aria-busy={pending?.state === "submitting"}
                      aria-describedby={hintId}
                      onClick={() => void requestCatalogScan(agent)}
                    >
                      {catalogScanButtonLabel(pending)}
                    </button>
                    <p id={hintId}>
                      {scanMessages[agent.id] || catalogScanHint(agent)}
                    </p>
                  </div>
                }
              />
            );
          })}
        </section>
        <section className="panel edge-catalog-panel">
          <div className="panel-title">
            <span>INDEX</span>
            <h2 id="home-library-title">完整影片索引</h2>
            {catalog.data && <b>{catalogItems.length} LOADED</b>}
          </div>
          <form
            className="catalog-toolbar"
            role="search"
            aria-label="筛选家庭片库"
            onSubmit={applyCatalogSearch}
          >
            <label>
              <span>搜索</span>
              <input
                type="search"
                value={searchDraft}
                placeholder="片名或相对路径"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <label>
              <span>家庭源</span>
              <select
                value={sourceState}
                onChange={(event) =>
                  setSourceState(event.target.value as CatalogSourceFilter)
                }
              >
                <option value="all">全部</option>
                <option value="present">当前存在</option>
                <option value="missing">源已缺失</option>
              </select>
            </label>
            <label>
              <span>云端状态</span>
              <select
                value={cloudState}
                onChange={(event) =>
                  setCloudState(
                    event.target.value as "all" | EdgeCatalogItem["cloudState"],
                  )
                }
              >
                <option value="all">全部</option>
                <option value="not-requested">仅家庭</option>
                <option value="queued">待传输</option>
                <option value="validating">核验中</option>
                <option value="uploading">上传中</option>
                <option value="processing">处理中</option>
                <option value="ready">云端就绪</option>
                <option value="blocked">空间阻塞</option>
                <option value="failed">失败</option>
                <option value="evicted">缓存已清</option>
              </select>
            </label>
            <button
              type="submit"
              className="compact-button catalog-search-button"
            >
              查询服务器
            </button>
          </form>
          <div className="catalog-selection-bar">
            <label>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={selectable.length === 0}
                onChange={toggleVisibleSelection}
              />
              选择当前已加载结果
            </label>
            <span>
              {filtered.length} 条可见 / {selected.length} 条已选
            </span>
            <button
              type="button"
              disabled={selected.length === 0 || adding}
              onClick={() => void addSelectedToProgram()}
            >
              {adding ? "正在编排…" : `加入节目单（${selected.length}）`}
            </button>
          </div>
          <MutationNotice message={message} />
          <QueryNotice
            loading={catalog.isLoading}
            error={catalog.error}
            empty={catalogItems.length === 0}
            emptyCopy={
              catalogSearch
                ? "服务器目录中没有匹配该关键词的影片。"
                : "尚未收到一次完整目录扫描。"
            }
          />
          {catalogItems.length > 0 && filtered.length === 0 && (
            <p className="query-notice empty">没有符合当前筛选条件的影片。</p>
          )}
          {filtered.length > 0 && (
            <div className="edge-file-list selectable-file-list" role="list">
              {filtered.map((item) => {
                const alreadyQueued = queuedVersions.has(item.versionId);
                const disabled =
                  item.sourceState !== "present" || alreadyQueued;
                return (
                  <article key={item.versionId} role="listitem">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.displayName}`}
                      checked={selected.includes(item.versionId)}
                      disabled={disabled}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...new Set([...previous, item.versionId])]
                            : previous.filter((id) => id !== item.versionId),
                        )
                      }
                    />
                    <div>
                      <h3>{item.displayName}</h3>
                      <code>{item.relativePath}</code>
                      {alreadyQueued && <em>已在节目单</em>}
                    </div>
                    <span>{formatBytes(item.bytes)}</span>
                    <small data-state={item.cloudState}>
                      {cloudStateLabel(item.cloudState)}
                    </small>
                  </article>
                );
              })}
            </div>
          )}
          {catalog.hasNextPage && (
            <button
              type="button"
              className="load-more-button"
              disabled={catalog.isFetchingNextPage}
              onClick={() => void catalog.fetchNextPage()}
            >
              {catalog.isFetchingNextPage ? "正在载入…" : "加载更多影片"}
            </button>
          )}
        </section>
      </div>
    </section>
  );
}

function CloudLibraryView() {
  const queryClient = useQueryClient();
  const adminCsrf = useSession((state) => state.adminCsrf);
  const storage = useStorage();
  const [pendingReplica, setPendingReplica] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const cache = useQuery({
    queryKey: adminQueryKeys.edgeCache,
    queryFn: () => api<EdgeCacheReplica[]>("/api/v1/admin/edge/cache"),
  });
  const media = useQuery({
    queryKey: adminQueryKeys.media,
    queryFn: () => api<MediaItem[]>("/api/v1/media"),
  });
  const cachedMediaIds = new Set(
    cache.data?.flatMap((replica) =>
      replica.mediaId ? [replica.mediaId] : [],
    ),
  );

  async function mutateReplica(
    replica: EdgeCacheReplica,
    path: string,
    method: "PATCH" | "POST",
    body: Record<string, unknown>,
    successCopy: string,
  ) {
    if (!adminCsrf || pendingReplica) return;
    setPendingReplica(replica.id);
    setMessage("");
    try {
      await api(path, {
        method,
        headers: { "x-csrf-token": adminCsrf },
        body: JSON.stringify({
          expectedGeneration: replica.generation,
          expectedRowVersion: replica.rowVersion,
          ...body,
        }),
      });
      setMessage(successCopy);
    } catch (error) {
      setMessage(mutationErrorCopy(error));
    } finally {
      setPendingReplica(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeCache }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeSummary }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.program }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.media }),
      ]);
    }
  }

  function toggleReplicaPin(replica: EdgeCacheReplica) {
    void mutateReplica(
      replica,
      `/api/v1/admin/edge/cache/${replica.id}`,
      "PATCH",
      { pinned: !replica.pinned },
      replica.pinned ? "已取消缓存置顶" : "缓存已置顶，不会自动回收",
    );
  }

  function evictReplica(replica: EdgeCacheReplica) {
    if (
      !confirm(
        `安全回收《${replica.displayName}》的云端缓存？系统会先核验家庭原片，再隔离并删除云端副本；家庭原片不受影响。`,
      )
    ) {
      return;
    }
    void mutateReplica(
      replica,
      `/api/v1/admin/edge/cache/${replica.id}/evict`,
      "POST",
      {},
      "已提交安全回收；来源校验和隔离删除将在后台完成",
    );
  }

  return (
    <section className="admin-workspace" aria-labelledby="cloud-library-title">
      <WorkspaceHeading
        eyebrow="CLOUD VAULT / 12 GIB FLOOR"
        title="云端片库"
        copy="常驻影片与家庭片库缓存分账显示。安全回收只针对可回收缓存，并在删除前核验家庭来源。"
      />
      <StorageLedger
        storage={storage.data}
        loading={storage.isLoading}
        error={storage.error}
      />
      <section className="panel cloud-media-ledger">
        <div className="panel-title">
          <span>VAULT</span>
          <h2>可放映影片</h2>
          {media.data && <b>{media.data.length} REELS</b>}
        </div>
        <QueryNotice
          loading={media.isLoading}
          error={media.error}
          empty={!media.data?.length}
          emptyCopy="云端片库为空。浏览器、SFTP 或家庭传输完成后，影片会出现在这里。"
        />
        {media.data && media.data.length > 0 && (
          <div className="edge-file-list cloud-media-list" role="list">
            {media.data.map((item) => (
              <article key={item.id} role="listitem">
                <div>
                  <h3>{item.displayName}</h3>
                  <code>
                    {cachedMediaIds.has(item.id) ? "家庭片库缓存" : "常驻入库"}
                  </code>
                </div>
                <span>{formatBytes(item.bytes)}</span>
                <small data-state={item.state}>
                  {mediaStateLabel(item.state)}
                </small>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel cloud-replicas">
        <div className="panel-title">
          <span>CACHE</span>
          <h2 id="cloud-library-title">家庭片库副本</h2>
          {cache.data && <b>{cache.data.length} REPLICAS</b>}
        </div>
        <MutationNotice message={message} />
        <QueryNotice
          loading={cache.isLoading}
          error={cache.error}
          empty={!cache.data?.length}
          emptyCopy="云端尚无家庭片库缓存。普通浏览器或 SFTP 入库的影片不会被 Edge 自动清理。"
        />
        {cache.data && cache.data.length > 0 && (
          <div className="replica-grid">
            {cache.data.map((replica) => {
              const canEvict = replica.state === "eligible" && !replica.pinned;
              return (
                <article
                  key={replica.id}
                  aria-busy={pendingReplica === replica.id}
                >
                  <span className="reel-number">
                    {replica.pinned ? "PIN" : "REEL"}
                  </span>
                  <h3 title={replica.displayName}>{replica.displayName}</h3>
                  <p>
                    {formatBytes(replica.bytes)} ·{" "}
                    {replica.protectedReason ??
                      replicaStateLabel(replica.state)}
                  </p>
                  <small>
                    GEN {replica.generation} / ROW {replica.rowVersion}
                  </small>
                  <small>
                    来源核验：{formatDate(replica.sourceVerifiedAt)}
                  </small>
                  <div className="replica-actions">
                    <button
                      type="button"
                      className="compact-button"
                      disabled={
                        Boolean(pendingReplica) || replica.state === "evicted"
                      }
                      onClick={() => toggleReplicaPin(replica)}
                      aria-pressed={replica.pinned}
                    >
                      {replica.pinned ? "取消置顶" : "缓存置顶"}
                    </button>
                    <button
                      type="button"
                      className="compact-button danger"
                      disabled={Boolean(pendingReplica) || !canEvict}
                      onClick={() => evictReplica(replica)}
                      title={
                        canEvict
                          ? "核验家庭源后回收云端缓存"
                          : "仅可回收且未置顶的缓存可操作"
                      }
                    >
                      安全回收
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function TransfersView() {
  const queryClient = useQueryClient();
  const adminCsrf = useSession((state) => state.adminCsrf);
  const [pendingTransfer, setPendingTransfer] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const transfers = useQuery({
    queryKey: adminQueryKeys.edgeTransfers,
    queryFn: () => api<EdgeTransfer[]>("/api/v1/admin/edge/transfers"),
    refetchInterval: 15_000,
  });

  async function mutateTransfer(
    transfer: EdgeTransfer,
    action: "cancel" | "retry",
  ) {
    if (!adminCsrf || pendingTransfer) return;
    if (
      action === "cancel" &&
      !confirm(
        `取消《${transfer.displayName}》的本次传输？家庭原片不会被删除。`,
      )
    ) {
      return;
    }
    setPendingTransfer(transfer.id);
    setMessage("");
    try {
      await api(`/api/v1/admin/edge/transfers/${transfer.id}/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": adminCsrf },
      });
      setMessage(action === "cancel" ? "已提交取消请求" : "已重新加入传输队列");
    } catch (error) {
      setMessage(mutationErrorCopy(error));
    } finally {
      setPendingTransfer(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: adminQueryKeys.edgeTransfers,
        }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeCatalog }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.program }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.edgeSummary }),
      ]);
    }
  }

  return (
    <section className="admin-workspace" aria-labelledby="transfers-title">
      <WorkspaceHeading
        eyebrow="OUTBOUND RELAY / ONE AT A TIME"
        title="传输"
        copy="家庭服务器主动连接云端。状态来自任务账本；失败任务可按来源与容量条件重新排队。"
      />
      <section className="panel transfer-ledger">
        <div className="panel-title">
          <span>QUEUE</span>
          <h2 id="transfers-title">传输流水</h2>
          {transfers.data && <b>{transfers.data.length} JOBS</b>}
        </div>
        <MutationNotice message={message} />
        <QueryNotice
          loading={transfers.isLoading}
          error={transfers.error}
          empty={!transfers.data?.length}
          emptyCopy="当前没有传输任务。节目单需要的影片会在这里显示校验、上传与处理进度。"
        />
        {transfers.data && transfers.data.length > 0 && (
          <div className="transfer-list" role="list">
            {transfers.data.map((transfer) => {
              const percent =
                transfer.declaredBytes > 0
                  ? Math.min(
                      100,
                      (transfer.transferredBytes / transfer.declaredBytes) *
                        100,
                    )
                  : 0;
              const cancellable = new Set<EdgeTransfer["state"]>([
                "queued",
                "leased",
                "validating",
                "uploading",
              ]).has(transfer.state);
              const retryable = new Set<EdgeTransfer["state"]>([
                "blocked_storage",
                "source_missing",
                "source_changed",
                "permission_denied",
                "failed",
              ]).has(transfer.state);
              return (
                <article
                  key={transfer.id}
                  role="listitem"
                  aria-busy={pendingTransfer === transfer.id}
                >
                  <div className="transfer-title">
                    <strong>{transfer.displayName}</strong>
                    <span>{transferStateLabel(transfer.state)}</span>
                  </div>
                  <progress
                    max={100}
                    value={percent}
                    aria-label={`${transfer.displayName} 传输进度`}
                  />
                  <div className="transfer-metrics">
                    <span>{percent.toFixed(1)}%</span>
                    <span>
                      {transfer.speedBytesPerSecond
                        ? `${formatBytes(transfer.speedBytesPerSecond)}/s`
                        : "—"}
                    </span>
                    <span>
                      {transfer.etaSeconds === null
                        ? "—"
                        : `约 ${formatEta(transfer.etaSeconds)}`}
                    </span>
                    <span>
                      尝试 {transfer.attempts} / {transfer.maxAttempts}
                    </span>
                  </div>
                  {transfer.errorMessage && (
                    <p role="alert">{transfer.errorMessage}</p>
                  )}
                  {(cancellable || retryable) && (
                    <div className="transfer-actions">
                      {cancellable && (
                        <button
                          type="button"
                          className="compact-button danger"
                          disabled={Boolean(pendingTransfer)}
                          onClick={() =>
                            void mutateTransfer(transfer, "cancel")
                          }
                        >
                          取消传输
                        </button>
                      )}
                      {retryable && (
                        <button
                          type="button"
                          className="compact-button"
                          disabled={Boolean(pendingTransfer)}
                          onClick={() => void mutateTransfer(transfer, "retry")}
                        >
                          重新排队
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function SystemView() {
  const agents = useEdgeAgents();
  const storage = useStorage();
  return (
    <section className="admin-workspace" aria-labelledby="system-title">
      <WorkspaceHeading
        eyebrow="PROJECTION BOOTH / TRUTH ONLY"
        title="系统"
        copy="汇总家庭 Agent 心跳与云端容量。离线状态不会被伪装成已连接，容量不足也不会绕过安全底线。"
      />
      <div className="edge-layout">
        <section className="panel">
          <div className="panel-title">
            <span>EDGE</span>
            <h2 id="system-title">Agent 状态</h2>
          </div>
          <QueryNotice
            loading={agents.isLoading}
            error={agents.error}
            empty={!agents.data?.length}
            emptyCopy="尚无 Agent 状态。"
          />
          {agents.data?.map((agent) => (
            <AgentLine key={agent.id} agent={agent} />
          ))}
        </section>
        <StorageLedger
          storage={storage.data}
          loading={storage.isLoading}
          error={storage.error}
          compact
        />
      </div>
    </section>
  );
}

function useEdgeAgents() {
  return useQuery({
    queryKey: adminQueryKeys.edgeSummary,
    queryFn: () => api<EdgeAdminSummary>("/api/v1/admin/edge/summary"),
    select: (summary) => summary.agents,
    refetchInterval: 30_000,
  });
}

function useStorage() {
  return useQuery({
    queryKey: adminQueryKeys.edgeSummary,
    queryFn: () => api<EdgeAdminSummary>("/api/v1/admin/edge/summary"),
    select: (summary) => summary.storage,
    refetchInterval: 30_000,
  });
}

function WorkspaceHeading({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <header className="workspace-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{copy}</p>
    </header>
  );
}

function QueryNotice({
  loading,
  error,
  empty,
  emptyCopy,
}: {
  loading: boolean;
  error: Error | null;
  empty: boolean;
  emptyCopy: string;
}) {
  if (loading)
    return (
      <p className="query-notice loading" aria-live="polite">
        正在读取服务器记录…
      </p>
    );
  if (error)
    return (
      <p className="query-notice error" role="alert">
        读取失败：{error.message}
      </p>
    );
  if (empty) return <p className="query-notice empty">{emptyCopy}</p>;
  return null;
}

function MutationNotice({ message }: { message: string }) {
  return message ? (
    <output className="mutation-notice" aria-live="polite">
      {message}
    </output>
  ) : null;
}

function AgentLine({
  agent,
  action,
}: {
  agent: EdgeAgentSummary;
  action?: ReactNode;
}) {
  return (
    <article className="agent-line">
      <span className={`agent-lamp state-${agent.state}`} aria-hidden="true" />
      <div>
        <h3>{agent.displayName}</h3>
        <p>
          {agent.state === "online"
            ? "线路在线"
            : agent.state === "revoked"
              ? "凭据已撤销"
              : "线路离线"}
        </p>
      </div>
      <dl>
        <div>
          <dt>最近心跳</dt>
          <dd>{formatDate(agent.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>完整扫描</dt>
          <dd>{formatDate(agent.lastCompleteScanAt)}</dd>
        </div>
        <div>
          <dt>影片</dt>
          <dd>{agent.catalogItemCount}</dd>
        </div>
        <div>
          <dt>凭据到期</dt>
          <dd>{formatCredentialExpiry(agent)}</dd>
        </div>
      </dl>
      {agent.credentialExpiringSoon && (
        <p className="credential-warning" role="status">
          Edge Agent 凭据将在 14 天内到期，请尽快安排轮换。
        </p>
      )}
      {action}
    </article>
  );
}

function catalogScanButtonLabel(pending: PendingCatalogScan | undefined) {
  if (!pending) return "立即刷新目录";
  if (pending.state === "submitting") return "正在提交…";
  if (pending.state === "leased") return "正在扫描目录";
  return "等待扫描完成";
}

function catalogScanHint(agent: EdgeAgentSummary) {
  if (agent.state === "revoked") {
    return "凭据已撤销；需先完成 Agent 凭据轮换。";
  }
  if (agent.state === "offline" || agent.state === "stale") {
    return "Agent 当前离线；仍可先排队，恢复在线后会自动领取。";
  }
  return "任务由家庭 Agent 主动领取，不需要开放家庭服务器入站端口。";
}

function catalogScanResultCopy(
  agent: EdgeAgentSummary,
  result: EdgeCatalogRefreshResponse["task"],
) {
  if (result.deduplicated) {
    return agent.state === "online"
      ? "已有目录刷新任务正在排队或执行，无需重复提交。"
      : "已有目录刷新任务在队列中；Agent 恢复在线后会自动领取。";
  }
  if (result.state === "leased") {
    return "Agent 已领取目录刷新任务；完成后索引会自动更新。";
  }
  if (agent.state === "offline" || agent.state === "stale") {
    return "目录刷新已排队；Agent 当前离线，恢复在线后会自动领取。";
  }
  return "目录刷新已排队；Agent 将主动领取，完成后列表会自动更新。";
}

function StorageLedger({
  storage,
  loading,
  error,
  compact = false,
}: {
  storage: CloudStorageSummary | undefined;
  loading: boolean;
  error: Error | null;
  compact?: boolean;
}) {
  return (
    <section className={`panel storage-ledger ${compact ? "compact" : ""}`}>
      <div className="panel-title">
        <span>DISK</span>
        <h2>云端容量账本</h2>
      </div>
      <QueryNotice
        loading={loading}
        error={error}
        empty={!storage}
        emptyCopy="暂无容量数据。"
      />
      {storage && (
        <>
          <div
            className="storage-scale"
            aria-label={`可用 ${formatBytes(storage.freeBytes)}，安全底线 ${formatBytes(storage.safetyFloorBytes)}`}
          >
            <i
              style={{
                width: `${Math.min(100, (storage.freeBytes / Math.max(1, storage.capacityBytes)) * 100)}%`,
              }}
            />
            <b
              style={{
                left: `${Math.min(100, (storage.safetyFloorBytes / Math.max(1, storage.capacityBytes)) * 100)}%`,
              }}
            />
          </div>
          <dl>
            <div>
              <dt>可用</dt>
              <dd>{formatBytes(storage.freeBytes)}</dd>
            </div>
            <div>
              <dt>安全底线</dt>
              <dd>{formatBytes(storage.safetyFloorBytes)}</dd>
            </div>
            <div>
              <dt>家庭缓存</dt>
              <dd>{formatBytes(storage.edgeCacheBytes)}</dd>
            </div>
            <div>
              <dt>传输预留</dt>
              <dd>{formatBytes(storage.reservedBytes)}</dd>
            </div>
            <div>
              <dt>常驻片库</dt>
              <dd>{formatBytes(storage.permanentMediaBytes)}</dd>
            </div>
            <div>
              <dt>处理中</dt>
              <dd>{formatBytes(storage.inFlightBytes)}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}

function mutationErrorCopy(error: unknown) {
  if (error instanceof ApiError) {
    if (
      error.code === "PROGRAM_REVISION_CONFLICT" ||
      error.code === "EDGE_CACHE_CAS_CONFLICT"
    ) {
      return `${error.message}；已刷新服务器最新状态，请重试`;
    }
    return error.message;
  }
  return "操作失败，请稍后重试";
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}
function formatEta(seconds: number) {
  return seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
}
function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "尚无";
}
function formatCredentialExpiry(agent: EdgeAgentSummary) {
  if (agent.state === "revoked") return "已撤销";
  if (!agent.credentialExpiresAt) return "未设置到期日";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(agent.credentialExpiresAt));
}
function preparationLabel(value: ProgramItem["preparationState"]) {
  return (
    {
      pending: "待准备",
      queued: "已排队",
      validating: "核验来源",
      uploading: "上传中",
      processing: "处理中",
      ready: "已就绪",
      blocked: "空间阻塞",
      failed: "准备失败",
      evicted: "缓存已清",
    } as const
  )[value];
}
function playbackLabel(value: ProgramItem["playbackState"]) {
  return (
    {
      upcoming: "待放映",
      current: "正在放映",
      completed: "已看完",
      incomplete: "未看完",
      removed: "已移除",
    } as const
  )[value];
}
function cloudStateLabel(value: EdgeCatalogItem["cloudState"]) {
  return (
    {
      "not-requested": "仅家庭",
      queued: "待传输",
      validating: "核验中",
      uploading: "上传中",
      processing: "处理中",
      ready: "云端就绪",
      blocked: "空间阻塞",
      failed: "失败",
      evicted: "缓存已清",
    } as const
  )[value];
}
function replicaStateLabel(value: EdgeCacheReplica["state"]) {
  return (
    {
      ready: "已就绪",
      protected: "受节目保护",
      eligible: "可回收",
      verifying_source: "正在核验家庭来源",
      evicting: "正在回收",
      evicted: "已回收",
      recovery_blocked: "恢复受阻",
    } as const
  )[value];
}
function transferStateLabel(value: EdgeTransfer["state"]) {
  return (
    {
      queued: "等待家庭服务器",
      leased: "任务已领取",
      validating: "核验完整性",
      uploading: "上传中",
      received: "云端已接收",
      processing: "检片处理中",
      ready: "云端就绪",
      blocked_storage: "空间不足",
      source_missing: "家庭源已缺失",
      source_changed: "家庭源已变化",
      permission_denied: "无法读取源",
      cancel_requested: "等待取消",
      cancelled: "已取消",
      incompatible: "影片不兼容",
      failed: "传输失败",
      evicted: "缓存已清",
    } as const
  )[value];
}
function mediaStateLabel(value: MediaItem["state"]) {
  return (
    {
      scanning: "检片中",
      compatible: "兼容",
      published: "可放映",
      incompatible: "不兼容",
      failed: "处理失败",
    } as const
  )[value];
}
