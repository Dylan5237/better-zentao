import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import * as configLoader from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

function localRuntime() {
  return {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
    nodeVersion: "24.11.0",
    clock: () => 0,
    env: {},
  };
}

it("WP-00 空命令显示本地使用帮助", async () => {
  const runtime = localRuntime();
  await expect(runCli([], runtime)).resolves.toBe(0);
  expect(runtime.stdout).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("bzt mcp"),
  );
  expect(runtime.stderr).not.toHaveBeenCalled();
});

it.each([
  ["配置选项", ["--config", "team.json"]],
  ["产品选项", ["--product", "43"]],
  ["参数分隔符", ["--"]],
])("P2-3 无子命令但带%s时报参数错误", async (_name, args) => {
  const runtime = localRuntime();
  await expect(runCli(args, runtime)).resolves.toBe(2);
  expect(runtime.stdout).not.toHaveBeenCalled();
  expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("参数不合法"),
  );
});

it.each(["-h", "--help"])("P2-3 显式%s仍显示帮助", async (flag) => {
  const runtime = localRuntime();
  await expect(runCli([flag], runtime)).resolves.toBe(0);
  expect(runtime.stdout).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("bzt mcp"),
  );
  expect(runtime.stderr).not.toHaveBeenCalled();
});

it.each([
  ["多余参数", ["mcp", "extra"]],
  ["缺少探查子命令", ["probe"]],
  ["非采集命令的输出目录选项", ["doctor", "--out", "fixtures"]],
  ["未知选项", ["--unknown"]],
])("WP-00 拦截%s", async (_name, args) => {
  const runtime = localRuntime();
  await expect(runCli(args, runtime)).resolves.toBe(2);
  expect(runtime.stdout).not.toHaveBeenCalled();
  expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("参数不合法"),
  );
});

it("CFG-01 doctor 退出状态由本地配置检查决定", async () => {
  const runtime = localRuntime();
  await expect(runCli(["doctor"], runtime)).resolves.toBe(1);
  const [line] = runtime.stdout.mock.calls[0] ?? [];
  expect(JSON.parse(line ?? "")).toMatchObject({ node: "24.11.0", ok: false });
  expect(runtime.stderr).not.toHaveBeenCalled();
});

it.each([
  ["18.19.0", false],
  ["24.10.99", false],
  ["24.11.0", true],
  ["24.22.3", true],
  ["24.11.0-rc.1", false],
  ["26.0.0", false],
  ["invalid", false],
])(
  "CFG-13 doctor 校验 Node %s 并映射退出码",
  async (nodeVersion, supported) => {
    const runtime = {
      ...localRuntime(),
      nodeVersion,
      env: {
        ZENTAO_BASE_URL: "https://fixture.test",
        ZENTAO_ACCOUNT: "acct_a",
        ZENTAO_PASSWORD: "synthetic",
      },
    };
    await expect(runCli(["doctor"], runtime)).resolves.toBe(supported ? 0 : 1);
    const [line] = runtime.stdout.mock.calls[0] ?? [];
    const result: unknown = JSON.parse(line ?? "");
    expect(result).toMatchObject({
      node: nodeVersion,
      ok: supported,
      missingEnv: [],
      requiredNode: ">=24.11.0 <25",
    });
    if (!supported) expect(result).toMatchObject({ sqlite: null });
  },
);

describe("WP-03 离线测试采集命令", () => {
  const hostname = "captured-zen.intra.test";
  const account = "offline-admin-fixture";
  const password = "offline-zen-pass$";
  const token = "fixture-bzt-auth-token-99";
  const realname = "苏拟真";
  // Windows 沙箱允许在工作区内验证原子重命名。
  const tempPrefix = fileURLToPath(
    new URL("../../.bzt-capture-cli-", import.meta.url),
  );
  const blockedFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("离线测试禁止网络请求。");
  });
  let homeDir: string;

  beforeEach(async () => {
    blockedFetch.mockClear();
    vi.stubGlobal("fetch", blockedFetch);
    homeDir = await mkdtemp(tempPrefix);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(homeDir, { recursive: true, force: true });
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  function probeRuntime(credential = password) {
    return {
      ...localRuntime(),
      homeDir,
      env: {
        ZENTAO_BASE_URL: `https://${hostname}/tracker`,
        ZENTAO_ACCOUNT: account,
        ZENTAO_PASSWORD: credential,
        BZT_CONFIG: join(homeDir, "missing-team.json"),
        BZT_LOG_LEVEL: "warn",
      },
    };
  }

  function stubProbeResponses(residualId?: string) {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const { pathname, searchParams } = new URL(String(input));
      if (pathname === "/tracker/api.php/v1/tokens") {
        return Response.json({ token }, { status: 201 });
      }
      if (pathname === "/tracker/index.php") {
        return Response.json({ version: "22.6", URAndSR: true });
      }
      if (pathname === "/tracker/api.php/v1/user") {
        return Response.json({ profile: { account, realname, dept: 7 } });
      }
      if (pathname === "/tracker/api.php/v1/products") {
        const products = [
          { id: 13, status: "normal" },
          {
            id: "53",
            status: "normal",
            password,
            users: { [account]: realname },
            link: `https://${hostname}/internal-product`,
          },
          ...(residualId === undefined
            ? []
            : [{ id: residualId, status: "normal" }]),
        ];
        return Response.json({
          products: searchParams.get("page") === "2" ? [] : products,
          total: products.length,
        });
      }
      return Response.json({ message: token }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  async function teamConfig() {
    const path = join(homeDir, "team.json");
    await writeFile(path, '{"probe":{"productId":29}}', "utf8");
    return path;
  }

  function probeArgs(out: string, config: string) {
    return [
      "probe",
      "capture",
      "--out",
      out,
      "--config",
      config,
      "--product",
      "53",
    ];
  }

  it.each([
    ["--out", "bad\0path", "输出目录不合法。"],
    ["--config", "  ", "配置文件路径不合法。"],
  ])("先验证 %s 路径，再读取配置", async (option, value, message) => {
    const runtime = probeRuntime();
    const loadConfig = vi.spyOn(configLoader, "loadConfig");

    await expect(
      runCli(["probe", "capture", option, value], runtime),
    ).resolves.toBe(2);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(message + "\n");
  });

  it("产品编号非法时返回参数错误", async () => {
    const runtime = probeRuntime();
    const config = await teamConfig();

    await expect(
      runCli(
        ["probe", "capture", "--config", config, "--product", "1.5"],
        runtime,
      ),
    ).resolves.toBe(2);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
      "产品编号必须是正整数。\n",
    );
  });

  it("缺少必填环境变量时只提示变量名称", async () => {
    const runtime = probeRuntime();
    const env = { ZENTAO_BASE_URL: runtime.env.ZENTAO_BASE_URL };

    await expect(
      runCli(["probe", "capture"], { ...runtime, env }),
    ).resolves.toBe(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
      "CONFIG_MISSING 缺少必填禅道环境变量（ZENTAO_ACCOUNT、ZENTAO_PASSWORD）。\n",
    );
  });

  it.each([
    ["损坏 JSON", "{" + password],
    ["多个非法字段", JSON.stringify({ mode: password, timezone: password })],
  ])("团队配置出现%s时安全退出", async (_kind, contents) => {
    const runtime = probeRuntime();
    const config = join(homeDir, account + ".json");
    await writeFile(config, contents, "utf8");

    await expect(
      runCli(["probe", "capture", "--config", config], runtime),
    ).resolves.toBe(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
      "INVALID_INPUT 无法加载夹具采集配置。\n",
    );
  });

  it.each([
    ["缺少字段详情", new BztError("INVALID_INPUT", password), "INVALID_INPUT "],
    ["意外错误", new Error(password), ""],
  ])("加载配置遇到%s时安全退出", async (_kind, error, code) => {
    const runtime = probeRuntime();
    vi.spyOn(configLoader, "loadConfig").mockRejectedValueOnce(error);

    await expect(runCli(["probe", "capture"], runtime)).resolves.toBe(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
      code + "无法加载夹具采集配置。\n",
    );
  });

  it("选取 --product 样本并写入脱敏夹具，缺口保留在采集结果中", async () => {
    const fetcher = stubProbeResponses();
    const runtime = probeRuntime();
    const out = join(homeDir, "fixtures");
    const config = await teamConfig();
    await mkdir(out);
    const previous = join(out, "products.json");
    const unrelated = join(out, "unrelated.json");
    await writeFile(previous, '"previous"', "utf8");
    await writeFile(unrelated, '"keep"', "utf8");

    const exitCode = await runCli(probeArgs(out, config), runtime);
    expect(exitCode, runtime.stderr.mock.lastCall?.[0]).toBe(0);
    expect(
      fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toContain("/tracker/api.php/v1/products/53/releases");
    const files = await readdir(out);
    expect(files).toContain("instance-config.json");
    expect(files).toContain("products.empty.json");
    expect(files.every((name) => name.endsWith(".json"))).toBe(true);
    await expect(readFile(unrelated, "utf8")).resolves.toBe('"keep"');
    const products: unknown = JSON.parse(await readFile(previous, "utf8"));
    expect(products).toEqual({
      endpoint: "products",
      status: 200,
      body: {
        products: [
          { id: 13, status: "normal" },
          { id: "53", status: "normal", link: "https://fixture.example.test" },
        ],
        total: 2,
      },
    });
    const [summary] = runtime.stdout.mock.calls[0] ?? [];
    expect(JSON.parse(summary ?? "")).toMatchObject({
      completeness: "partial",
      captured: files.length - 1,
      gaps: expect.arrayContaining([
        { endpoint: "releases", code: "NOT_FOUND" },
      ]),
    });
    expect(runtime.stderr).toHaveBeenCalled();
    assertNoSensitiveData(
      [
        await Promise.all(
          files.map((file) => readFile(join(out, file), "utf8")),
        ),
        runtime.stdout.mock.calls,
        runtime.stderr.mock.calls,
      ],
      [hostname, account, password, token, realname, out, config],
    );
  });

  it.each([false, true])(
    "二次复扫失败不创建或覆盖夹具（目录已存在 %s）",
    async (exists) => {
      const id = "12045";
      const fetcher = stubProbeResponses(id);
      const runtime = probeRuntime(id);
      const out = join(homeDir, "fixtures");
      const config = await teamConfig();
      const previous = join(out, "instance-config.json");
      if (exists) {
        await mkdir(out);
        await writeFile(previous, '"previous"', "utf8");
      }

      await expect(runCli(probeArgs(out, config), runtime)).resolves.toBe(1);
      expect(
        fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname),
      ).toContain("/tracker/api.php/v1/products");
      expect(runtime.stdout).not.toHaveBeenCalled();
      expect(runtime.stderr).toHaveBeenLastCalledWith(
        expect.stringContaining("INVALID_INPUT"),
      );
      if (exists) {
        await expect(readdir(out)).resolves.toEqual(["instance-config.json"]);
        await expect(readFile(previous, "utf8")).resolves.toBe('"previous"');
      } else {
        await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
      }
      assertNoSensitiveData(runtime.stderr.mock.calls, [
        id,
        hostname,
        account,
        token,
        out,
        config,
      ]);
    },
  );

  it("无法写入输出目录时安全退出", async () => {
    stubProbeResponses();
    const runtime = probeRuntime();
    const out = join(homeDir, "existing-file");
    const config = await teamConfig();
    await writeFile(out, '"previous"', "utf8");

    await expect(runCli(probeArgs(out, config), runtime)).resolves.toBe(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("无法写入"),
    );
    await expect(readFile(out, "utf8")).resolves.toBe('"previous"');
    assertNoSensitiveData(runtime.stderr.mock.calls, [
      hostname,
      account,
      password,
      token,
      out,
      config,
    ]);
  });

  it("夹具重命名失败时清除暂存目录并保留目标内容", async () => {
    stubProbeResponses();
    const runtime = probeRuntime();
    const out = join(homeDir, "fixtures");
    const config = await teamConfig();
    const target = join(out, "instance-config.json");
    await mkdir(target, { recursive: true });
    const existing = join(target, "existing.json");
    await writeFile(existing, '"previous"', "utf8");

    await expect(runCli(probeArgs(out, config), runtime)).resolves.toBe(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenLastCalledWith("无法写入夹具目录。\n");
    await expect(readdir(out)).resolves.toEqual(["instance-config.json"]);
    await expect(readFile(existing, "utf8")).resolves.toBe('"previous"');
    assertNoSensitiveData(runtime.stderr.mock.calls, [
      hostname,
      account,
      password,
      token,
      out,
      config,
    ]);
  });

  it("认证失败时安全退出且不创建夹具目录", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ message: password }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = probeRuntime();
    const out = join(homeDir, "fixtures");
    const config = await teamConfig();

    await expect(runCli(probeArgs(out, config), runtime)).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.stdout).not.toHaveBeenCalled();
    expect(runtime.stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("AUTH_FAILED"),
    );
    await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
    assertNoSensitiveData(runtime.stderr.mock.calls, [
      hostname,
      account,
      password,
      out,
      config,
    ]);
  });
});
