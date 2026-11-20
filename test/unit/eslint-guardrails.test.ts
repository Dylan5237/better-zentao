import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
});

describe("WP-00 实际 ESLint 配置自检", () => {
  it.each([
    [
      "服务反向导入 CLI",
      "src/services/check.ts",
      'import "../adapters/cli/bzt.ts";',
      "import/no-restricted-paths",
    ],
    [
      "CLI 跳过服务层",
      "src/adapters/cli/check.ts",
      'import "../../core/dto/story.ts";',
      "import/no-restricted-paths",
    ],
    [
      "核心反向导入服务",
      "src/core/check.ts",
      'import "../services/doctor.ts";',
      "import/no-restricted-paths",
    ],
    [
      "领域导入 API",
      "src/domain/check.ts",
      'import "../api/internal/story-response.ts";',
      "import/no-restricted-paths",
    ],
    [
      "规则再导出 API",
      "src/rules/check.ts",
      'export { decodeStoryResponse } from "../api/internal/story-response.ts";',
      "import/no-restricted-paths",
    ],
    [
      "服务导入私有响应",
      "src/services/check.ts",
      'import "../api/internal/story-response.ts";',
      "import/no-restricted-paths",
    ],
    [
      "服务引用私有传输类型",
      "src/services/check.ts",
      'export type { ProbeWriteOptions } from "../api/internal/probe-transport.ts";',
      "import/no-restricted-paths",
    ],
    [
      "API 门面再导出原始传输",
      "src/api/check.ts",
      'export { createProbeWriteSender } from "./internal/probe-transport.ts";',
      "import/no-restricted-paths",
    ],
    [
      "API 门面绕到私有解码器",
      "src/api/stories/check.ts",
      'export { decodeStoryResponse } from "../internal/story-response.ts";',
      "import/no-restricted-paths",
    ],
    [
      "领域从测试目录引入运行时代码",
      "src/domain/check.ts",
      'import "../../test/unit/probe-transport.test.ts";',
      "import/no-restricted-paths",
    ],
    [
      "规则间接引入 SQLite",
      "src/rules/check.ts",
      'import "../core/store/sqlite.ts";',
      "import/no-restricted-paths",
    ],
    [
      "核心 DTO 引入 I/O",
      "src/core/dto/check.ts",
      'import "../store/sqlite.ts";',
      "import/no-restricted-paths",
    ],
    [
      "导入路径无法解析",
      "src/services/check.ts",
      'import "./missing.ts";',
      "import/no-unresolved",
    ],
    [
      "领域导入 fs",
      "src/domain/check.ts",
      'import "node:fs";',
      "no-restricted-imports",
    ],
    [
      "规则导入 http",
      "src/rules/check.ts",
      'import "http";',
      "no-restricted-imports",
    ],
    [
      "规则导入 sqlite",
      "src/rules/check.ts",
      'import "node:sqlite";',
      "no-restricted-imports",
    ],
    [
      "领域读系统时间",
      "src/domain/check.ts",
      "export const now = new Date();",
      "no-restricted-globals",
    ],
    [
      "规则调用 Date.now",
      "src/rules/check.ts",
      "export const now = Date.now();",
      "no-restricted-globals",
    ],
    [
      "通过 globalThis 读当前时间",
      "src/rules/check.ts",
      'export const now = globalThis["Date"].now();',
      "no-restricted-globals",
    ],
    [
      "业务直接 fetch",
      "src/services/check.ts",
      "export const get = () => fetch('offline');",
      "no-restricted-globals",
    ],
    [
      "业务 console.log",
      "src/services/check.ts",
      "console.log('noise');",
      "no-console",
    ],
    [
      "业务写 stdout",
      "src/services/check.ts",
      "process.stdout.write('noise');",
      "no-restricted-globals",
    ],
    [
      "通过模块导入 stdout",
      "src/services/check.ts",
      'import { stdout as out } from "node:process"; out.write("noise");',
      "no-restricted-imports",
    ],
    [
      "动态导入绕过纯函数边界",
      "src/domain/check.ts",
      "export const read = (name: string) => import(name);",
      "no-restricted-syntax",
    ],
    [
      "动态导入私有传输",
      "src/services/check.ts",
      'export const read = () => import("../api/internal/probe-transport.ts");',
      "no-restricted-syntax",
    ],
  ])("拦截%s", async (_name, filePath, source, ruleId) => {
    const [result] = await eslint.lintText(source, { filePath });
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId, severity: 2 }),
      ]),
    );
  });

  it.each([
    [
      "领域使用注入时钟",
      "src/domain/check.ts",
      'import type { Clock } from "../core/clock.ts"; export const now = (clock: Clock) => clock();',
    ],
    [
      "服务使用安全 DTO",
      "src/services/check.ts",
      'export type { StoryDetail } from "../core/dto/story.ts";',
    ],
    [
      "日志使用 stderr",
      "src/core/logger.ts",
      'import { stderr } from "node:process"; stderr.write("ok");',
    ],
    [
      "CLI 允许渲染 stdout",
      "src/adapters/cli/bzt.ts",
      "process.stdout.write('ok');",
    ],
  ])("放行%s", async (_name, filePath, source) => {
    const [result] = await eslint.lintText(source, { filePath });
    expect(result?.messages).toEqual([]);
  });
});
