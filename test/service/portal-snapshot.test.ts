import { expect, it, vi } from "vitest";
import { createPortalSnapshots } from "../../src/services/portal-snapshots.ts";
import { portalLinkProjector } from "../../src/services/portal-links.ts";

it("读本地快照、并发单飞、手动同步及故障保留旧快照", async () => {
  const values = new Map<string, string>();
  let now = 1000;
  const repo = {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => {
      values.set(key, value);
    },
    pruneExpired: () => 0,
    trimPrefix: () => {},
  };
  const read = vi.fn(async () => ({
    ok: true,
    completeness: "complete",
    data: [1],
  }));
  const create = () =>
    createPortalSnapshots(
      repo,
      () => now,
      async () => [],
    );
  const cache = create();
  const first = cache.read("RD", "get_my_work", {}, "default", read);
  const duplicate = cache.read("RD", "get_my_work", {}, "default", read);
  expect(await first).toEqual(await duplicate);
  expect(read).toHaveBeenCalledTimes(1);
  now += 60_000;
  const restored = create();
  expect(
    await restored.read("RD", "get_my_work", {}, "default", read),
  ).toMatchObject({
    snapshot: { savedAt: 1000, fromCache: true },
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    await restored.read("RD", "get_my_work", {}, "sync", async () => {
      throw Error("Offline");
    }),
  ).toMatchObject({
    data: [1],
    snapshot: { savedAt: 1000, retained: true },
  });
  await restored.read("RD", "get_my_work", {}, "sync", read);
  expect(read).toHaveBeenCalledTimes(2);
  await restored.read("QA", "get_my_work", {}, "default", read);
  expect(read).toHaveBeenCalledTimes(3);
});

it("活动探测限流，报告变化但不会刷新快照", async () => {
  const values = new Map<string, string>();
  let now = 1000;
  const probe = vi.fn(async () => [1]);
  const cache = createPortalSnapshots(
    {
      get: (key) => values.get(key),
      set: (key, value) => {
        values.set(key, value);
      },
      trimPrefix: () => {},
      pruneExpired: () => 0,
    },
    () => now,
    probe,
  );
  expect(await cache.check("RD")).toMatchObject({ changed: false });
  expect(await cache.check("QA")).toMatchObject({ changed: false });
  expect(probe).toHaveBeenCalledTimes(1);
  now += 300_000;
  probe.mockResolvedValueOnce([2]);
  const status = await cache.check("RD");
  expect(status).toMatchObject({ changed: true });
  await cache.check("RD", status.revision);
  expect(await cache.check("RD")).toMatchObject({ changed: false });
  expect(await cache.check("QA")).toMatchObject({ changed: true });
});

it("查询参数路由保留对象类型、编号和禅道安装子路径", () => {
  const convert = portalLinkProjector("http://local.test/zentao/", "GET");
  const input = {
    data: [
      { url: "http://local.test/zentao/story-view-42.html" },
      { url: "http://local.test/zentao/task-view-8.html" },
      { url: "http://local.test/zentao/requirement-view-19.html" },
      { url: "http://else.test/zentao/task-view-8.html" },
    ],
  };
  expect(convert(input)).toEqual({
    data: [
      { url: "http://local.test/zentao/index.php?m=story&f=view&storyID=42" },
      { url: "http://local.test/zentao/index.php?m=task&f=view&taskID=8" },
      {
        url: "http://local.test/zentao/index.php?m=requirement&f=view&storyID=19",
      },
      input.data[3],
    ],
  });
  expect(
    portalLinkProjector("http://local.test/zentao/", "PATH_INFO")(input),
  ).toEqual(input);
});
