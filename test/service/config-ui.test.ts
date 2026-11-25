import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTeamConfigEditorHtml } from "../../src/adapters/cli/render/config-editor-html.ts";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { generateConfigEditorPage } from "../../src/services/config-ui.ts";

const env = {
  ZENTAO_BASE_URL: "https://config-ui.invalid/zentao",
  ZENTAO_PASSWORD: "synthetic-config-password",
  BZT_WECOM_WEBHOOK:
    "https://robot.invalid/cgi-bin/webhook/send?key=synthetic-webhook-key",
};
const token = "synthetic-session-value";

function fakeZentao({
  failModules = false,
  truncateProducts = false,
  failUsers = false,
} = {}) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://config-ui.invalid");
    requests.push(url.pathname);
    if (url.pathname.endsWith("/tokens")) {
      expect(init?.method).toBe("POST");
      return Response.json({ token }, { status: 201 });
    }
    expect(init?.method).toBe("GET");
    if (url.pathname.endsWith("/v1/products")) {
      return Response.json({
        products: [
          {
            id: 42,
            name: "天宫平台",
            status: "normal",
            deleted: false,
            privateField: env.ZENTAO_BASE_URL,
          },
          { id: 43, name: "研发平台", status: "normal", deleted: false },
          { id: 44, name: "已删除产品", status: "normal", deleted: true },
        ],
        ...(truncateProducts ? { total: 999 } : {}),
      });
    }
    if (url.pathname.endsWith("/v1/products/42")) {
      return Response.json({
        id: 42,
        moduleOptionMenu: [
          { id: 0, name: "/" },
          { id: 1201, name: "/权限管理" },
          { id: 1202, name: "/权限管理/子模块" },
        ],
      });
    }
    if (url.pathname.endsWith("/v1/products/43")) {
      return failModules
        ? Response.json({ message: env.ZENTAO_PASSWORD }, { status: 403 })
        : Response.json({ id: 43, moduleOptionMenu: [] });
    }
    if (url.pathname.endsWith("/v2/users")) {
      if (failUsers) return Response.json({}, { status: 403 });
      const user = {
        id: 1,
        account: "zhangsan",
        realname: "张三",
        pinyin: "zhang san",
        dept: 2,
        role: "dev",
        deleted: false,
      };
      return Response.json({
        users: [
          {
            ...user,
            password: env.ZENTAO_PASSWORD,
            token,
            rawDictionary: { private: true },
          },
          {
            ...user,
            id: 2,
            account: "old",
            realname: "已删除人员",
            deleted: true,
          },
        ],
      });
    }
    throw new Error("假禅道收到未声明的请求。");
  });
  const client = createZentaoReadClient({
    baseUrl: env.ZENTAO_BASE_URL,
    account: "config_editor",
    password: env.ZENTAO_PASSWORD,
    clock: () => 1_800_000_000_000,
    logSink: vi.fn(),
  });
  return { client, requests };
}

describe("CR-001 配置页生成服务", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bzt-config-ui-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("写入子目录，投影只读目录并报告单个产品的模块读取失败", async () => {
    const { client, requests } = fakeZentao({ failModules: true });
    vi.stubEnv("ZENTAO_PASSWORD", env.ZENTAO_PASSWORD);
    const outPath = join(dir, "nested", "config.html");
    const render = vi.fn(renderTeamConfigEditorHtml);
    const result = await generateConfigEditorPage({
      client,
      env,
      outPath,
      render,
    });
    expect(result).toMatchObject({
      outPath,
      completeness: "partial",
      gaps: [{ source: "modules:43", reason: expect.any(String) }],
    });
    expect(render).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        modules: { 42: [{ id: 1201, name: "/权限管理" }] },
        users: [
          {
            account: "zhangsan",
            realname: "张三",
            pinyin: "zhang san",
            dept: 2,
          },
        ],
        completeness: "partial",
        gaps: result.gaps,
      }),
    );
    expect(requests).not.toContain("/zentao/api.php/v1/products/44");
    const html = await readFile(outPath, "utf8");
    for (const value of [
      ...Object.values(env),
      token,
      "synthetic-webhook-key",
      "rawDictionary",
      "已删除人员",
      "子模块",
    ]) {
      expect(html).not.toContain(value);
    }
    expect(html).toContain("权限管理");
  });

  it("区分已确认空清单、目录分页截断和读取失败", async () => {
    const { client } = fakeZentao({ truncateProducts: true, failUsers: true });
    const render = vi.fn(renderTeamConfigEditorHtml);
    const result = await generateConfigEditorPage({
      client,
      outPath: join(dir, "config.html"),
      render,
    });
    expect(result.completeness).toBe("partial");
    expect(result.gaps.map(({ source }) => source).sort()).toEqual([
      "products",
      "users",
    ]);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        modules: { 42: [{ id: 1201, name: "/权限管理" }], 43: [] },
      }),
    );
  });

  it("离线读取团队文件与快照，保留非编辑配置", async () => {
    const configPath = join(dir, "team.local.json");
    const outPath = join(dir, "config.html");
    const config = {
      calendar: { holidays: ["2026-12-25", "2027-01-01"] },
      rules: { R03: { enabled: true, after: 8 } },
    };
    await writeFile(configPath, JSON.stringify(config));
    const render = vi.fn(renderTeamConfigEditorHtml);
    const result = await generateConfigEditorPage({
      configPath,
      outPath,
      render,
      snapshot: {
        products: [{ id: 42, name: "天宫平台" }],
        modules: { 42: [] },
        users: [],
      },
    });
    expect(result).toEqual({ outPath, completeness: "complete", gaps: [] });
    expect(await readFile(outPath, "utf8")).toContain("2027-01-01");
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          calendar: expect.objectContaining(config.calendar),
          rules: expect.objectContaining(config.rules),
        }),
      }),
    );
  });

  it("仅提供配置时标记目录缺失，拒绝包含已知环境敏感值的配置", async () => {
    const render = vi.fn(renderTeamConfigEditorHtml);
    const outPath = join(dir, "config.html");
    const result = await generateConfigEditorPage({
      config: {},
      outPath,
      render,
    });
    expect(result.completeness).toBe("partial");
    expect(result.gaps.map(({ source }) => source)).toEqual([
      "products",
      "users",
    ]);
    render.mockClear();
    await expect(
      generateConfigEditorPage({
        config: { aliases: { 误填: env.ZENTAO_PASSWORD } },
        env,
        outPath: join(dir, "unsafe.html"),
        render,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(render).not.toHaveBeenCalled();
    await expect(
      readFile(join(dir, "unsafe.html"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
