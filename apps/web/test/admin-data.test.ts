import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  adminQueryKeys,
  adminQueryKeysForEvent,
  hasHostControls,
  isAdminQueryKey,
  purgeAdminQueries,
} from "../src/admin-data.js";
import {
  adminViewFromSearch,
  buildCatalogScanRequest,
  filterCatalogItems,
  mergeCatalogPages,
  reorderProgramItemIds,
} from "../src/pages/admin/AdminEdgeViews.js";

describe("admin data isolation", () => {
  it("grants host controls only to an authenticated Host holding the host seat", () => {
    const hostMemberId = "019f6555-77a3-753c-bbfd-7c27c1d70f52";
    expect(hasHostControls("host", hostMemberId, hostMemberId)).toBe(true);
    expect(hasHostControls("viewer", hostMemberId, hostMemberId)).toBe(false);
    expect(hasHostControls(undefined, hostMemberId, hostMemberId)).toBe(false);
    expect(
      hasHostControls(
        "host",
        "019f6555-77a3-753c-bbfd-7c27c1d70f53",
        hostMemberId,
      ),
    ).toBe(false);
  });

  it("purges all admin, edge and program queries without removing room data", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(adminQueryKeys.edgeCatalog, {
      secret: "relative/path",
    });
    queryClient.setQueryData(adminQueryKeys.program, { id: "program" });
    queryClient.setQueryData(["room-media", "media-id"], { id: "media-id" });

    purgeAdminQueries(queryClient);

    expect(
      queryClient.getQueryData(adminQueryKeys.edgeCatalog),
    ).toBeUndefined();
    expect(queryClient.getQueryData(adminQueryKeys.program)).toBeUndefined();
    expect(queryClient.getQueryData(["room-media", "media-id"])).toEqual({
      id: "media-id",
    });
    expect(isAdminQueryKey(adminQueryKeys.edgeTransfers)).toBe(true);
    expect(isAdminQueryKey(["room-media", "media-id"])).toBe(false);
  });

  it("maps SSE events to precise ledgers and never reaches viewer room data", () => {
    expect(adminQueryKeysForEvent("program.queue.changed")).toEqual([
      adminQueryKeys.program,
    ]);
    expect(adminQueryKeysForEvent("edge.catalog.changed")).toEqual([
      adminQueryKeys.edgeCatalog,
      adminQueryKeys.edgeSummary,
    ]);
    const transferKeys = adminQueryKeysForEvent("edge.transfer.changed");
    expect(transferKeys).toContain(adminQueryKeys.edgeTransfers);
    expect(transferKeys).toContain(adminQueryKeys.program);
    expect(transferKeys.some((key) => key[0] !== "admin")).toBe(false);
  });
});

describe("admin shell navigation", () => {
  it("accepts only known sections and safely falls back to screening", () => {
    expect(adminViewFromSearch("?view=home-library")).toBe("home-library");
    expect(adminViewFromSearch("?view=transfers")).toBe("transfers");
    expect(adminViewFromSearch("?view=viewer-secrets")).toBe("screening");
    expect(adminViewFromSearch("")).toBe("screening");
  });
});

describe("edge admin interaction helpers", () => {
  it("reorders exactly one adjacent program item and guards both boundaries", () => {
    const items = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(reorderProgramItemIds(items, "two", -1)).toEqual([
      "two",
      "one",
      "three",
    ]);
    expect(reorderProgramItemIds(items, "two", 1)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(reorderProgramItemIds(items, "one", -1)).toBeNull();
    expect(reorderProgramItemIds(items, "three", 1)).toBeNull();
  });

  it("filters the complete Library catalog by name, source and cloud state", () => {
    const base = {
      bytes: 1024,
      mtimeMs: 1,
      sha256: null,
    } as const;
    const items = [
      {
        ...base,
        id: "019f6555-77a3-753c-bbfd-7c27c1d70f50",
        versionId: "019f6555-77a3-753c-bbfd-7c27c1d70f51",
        relativePath: "Drama/First.mkv",
        displayName: "第一集",
        sourceState: "present" as const,
        cloudState: "ready" as const,
      },
      {
        ...base,
        id: "019f6555-77a3-753c-bbfd-7c27c1d70f52",
        versionId: "019f6555-77a3-753c-bbfd-7c27c1d70f53",
        relativePath: "Drama/Second.mkv",
        displayName: "第二集",
        sourceState: "missing" as const,
        cloudState: "not-requested" as const,
      },
    ];
    expect(filterCatalogItems(items, "first", "present", "ready")).toEqual([
      items[0],
    ]);
    expect(filterCatalogItems(items, "第二", "all", "not-requested")).toEqual([
      items[1],
    ]);
    expect(
      mergeCatalogPages([
        { items },
        {
          items: [{ ...items[0]!, cloudState: "uploading" }],
        },
      ]),
    ).toEqual([{ ...items[0]!, cloudState: "uploading" }, items[1]]);
  });

  it("sorts merged catalog paths naturally instead of lexical 1, 10, 2 order", () => {
    const template = {
      id: "019f6555-77a3-753c-bbfd-7c27c1d70f60",
      versionId: "019f6555-77a3-753c-bbfd-7c27c1d70f61",
      displayName: "剧集",
      bytes: 1024,
      mtimeMs: 1,
      sourceState: "present" as const,
      cloudState: "not-requested" as const,
      sha256: null,
    };
    const items = [
      { ...template, relativePath: "Series/Episode 10.mkv" },
      {
        ...template,
        id: "019f6555-77a3-753c-bbfd-7c27c1d70f62",
        versionId: "019f6555-77a3-753c-bbfd-7c27c1d70f63",
        relativePath: "Series/Episode 2.mkv",
      },
      {
        ...template,
        id: "019f6555-77a3-753c-bbfd-7c27c1d70f64",
        versionId: "019f6555-77a3-753c-bbfd-7c27c1d70f65",
        relativePath: "Series/Episode 1.mkv",
      },
    ];

    expect(
      mergeCatalogPages([{ items }]).map((item) => item.relativePath),
    ).toEqual([
      "Series/Episode 1.mkv",
      "Series/Episode 2.mkv",
      "Series/Episode 10.mkv",
    ]);
  });

  it("never builds a catalog scan request for a Viewer or revoked Agent", () => {
    const onlineAgent = {
      id: "019f6555-77a3-753c-bbfd-7c27c1d70f70",
      state: "online" as const,
    };
    expect(
      buildCatalogScanRequest("viewer", "viewer-csrf", onlineAgent, false),
    ).toBeNull();
    expect(
      buildCatalogScanRequest("host", null, onlineAgent, false),
    ).toBeNull();
    expect(
      buildCatalogScanRequest("host", "host-csrf", onlineAgent, true),
    ).toBeNull();
    expect(
      buildCatalogScanRequest(
        "host",
        "host-csrf",
        { ...onlineAgent, state: "revoked" },
        false,
      ),
    ).toBeNull();
    expect(
      buildCatalogScanRequest("host", "host-csrf", onlineAgent, false),
    ).toEqual({
      path: `/api/v1/admin/edge/agents/${onlineAgent.id}/catalog/refresh`,
      init: {
        method: "POST",
        headers: { "x-csrf-token": "host-csrf" },
        body: "{}",
      },
    });
  });
});
