import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const absolutePath = (file: string) => resolve(cwd, file).replaceAll("\\", "/");
const sources = new Map<string, string>();

function fixtures(rows: [string, string, string, string?][]) {
  return rows.map(([name, file, source, ruleId]) => {
    const filePath = file.replace(/\/check\.ts$/u, `/check-${sources.size}.ts`);
    sources.set(absolutePath(filePath), source);
    return { name, filePath, source, ruleId };
  });
}

function createFixtureChecks() {
  // 测试片段参与类型分析，源文件与分层路径无需写入工作树。
  const config = ts.readConfigFile(
    absolutePath("tsconfig.json"),
    ts.sys.readFile,
  );
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
  const host = ts.createCompilerHost(options);
  const loadSource = host.getSourceFile;
  host.getSourceFile = (file, target, onError, createNew) => {
    const source = sources.get(absolutePath(file));
    return source === undefined
      ? loadSource(file, target, onError, createNew)
      : ts.createSourceFile(file, source, target, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const eslint = new ESLint({
    cwd,
    overrideConfig: {
      files: ["src/**/*.ts"],
      languageOptions: {
        parserOptions: { projectService: false, programs: [program] },
      },
    },
  });
  return { eslint, program };
}

describe("WP-00 实际 ESLint 配置自检", () => {
  const globalAccess = [
    ["通过 Node global 读时钟", "void global.Date.now();"],
    ["通过 Node global 访问 crypto", "void global.crypto.randomUUID();"],
    ["通过 Node global 访问 performance", "void global.performance.now();"],
    [
      "通过 Node global 访问 fetch",
      'void global.fetch("https://offline.test");',
    ],
    ["通过 Node global 访问 console", 'global.console.log("noise");'],
    ["通过 Node global 访问 stdout", 'global.process.stdout.write("noise");'],
    [
      "通过 Node global 访问内置模块",
      'void global.process.getBuiltinModule("node:fs");',
    ],
    ["通过 globalThis 别名读时钟", "const g = globalThis; void g.Date.now();"],
    [
      "解构 globalThis",
      "const { Date: D, fetch: f } = globalThis; void D; void f;",
    ],
    [
      "通过 Reflect.get 访问 globalThis",
      'const key = "fetch"; void Reflect.get(globalThis, key);',
    ],
    ["计算 globalThis 属性名", 'const key = "fetch"; void globalThis[key];'],
    ["访问 self", "void self;"],
    ["访问 window", "void window;"],
  ] as const;
  const blocked = fixtures([
    ...["domain", "services"].flatMap((layer) =>
      globalAccess.map<[string, string, string, string]>(([name, source]) => [
        `${layer} ${name}`,
        `src/${layer}/check.ts`,
        source,
        "no-restricted-globals",
      ]),
    ),
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
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面绕到私有解码器",
      "src/api/stories/check.ts",
      'export { decodeStoryResponse } from "../internal/story-response.ts";',
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面导出 Response 类型别名",
      "src/api/check.ts",
      "export type RawStory = Response;",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面以本地别名导出原始传输",
      "src/api/check.ts",
      'import { createProbeWriteSender as sender } from "./internal/probe-transport.ts"; export const send = sender;',
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在包装返回值中暴露原始响应",
      "src/api/check.ts",
      "export async function read() { return { payload: new Response() }; }",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面导出未投影的未知载荷",
      "src/api/check.ts",
      "export type RawStory = { body: unknown };",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面以同名值掩盖 Response 类型导出",
      "src/api/check.ts",
      "export const leak = 1; export type leak = Response;",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面返回原始响应体流",
      "src/api/check.ts",
      'import { readStoryResponse } from "./internal/story-response.ts"; export async function stream(id: number) { return (await readStoryResponse(id)).body; }',
      "bzt/no-raw-api-exports",
    ],
    ...["RequestInit", "ResponseInit", "HeadersInit", "Blob", "FormData"].map<
      [string, string, string, string]
    >((type) => [
      `API 门面导出 Fetch 载体 ${type}`,
      "src/api/check.ts",
      `export type Transport = ${type};`,
      "bzt/no-raw-api-exports",
    ]),
    [
      "API 门面用 Pick 包装带响应体的原始响应",
      "src/api/check.ts",
      'export async function raw(): Promise<Pick<Response, "text" | "body" | "status">> { return new Response(); }',
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面用 Pick 包装不带响应体的原始响应",
      "src/api/check.ts",
      'export async function raw(): Promise<Pick<Response, "text" | "status">> { return new Response(); }',
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面用 Omit、Partial、Readonly 多层包装原始响应",
      "src/api/check.ts",
      'export type Transport = Readonly<Partial<Omit<Pick<Response, "text" | "status">, "status">>>;',
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在函数的泛型约束中暴露 Response",
      "src/api/check.ts",
      "export function wrap<T extends Response>(r: T) { return r; }",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在函数的默认类型参数中暴露 Response",
      "src/api/check.ts",
      "export function wrap<T = Response>(r?: T) { return !!r; }",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在类型别名的默认类型参数中暴露 Response",
      "src/api/check.ts",
      "export type Box<T = Response> = { value: T };",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在类型别名的泛型约束中暴露 Response",
      "src/api/check.ts",
      "export type Box<T extends Response> = { value: T };",
      "bzt/no-raw-api-exports",
    ],
    [
      "API 门面在化简为字符串的类型别名中暴露 Response",
      "src/api/check.ts",
      "export type Name<T = Response> = string;",
      "bzt/no-raw-api-exports",
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
      "服务调用 performance.now",
      "src/services/check.ts",
      "export const now = performance.now();",
      "no-restricted-globals",
    ],
    [
      "服务读取 performance.timeOrigin",
      "src/services/check.ts",
      "export const origin = performance.timeOrigin;",
      "no-restricted-globals",
    ],
    [
      "CLI 处理器通过 performance 读时钟",
      "src/adapters/cli/run-cli.ts",
      "export const now = performance.timeOrigin + performance.now();",
      "no-restricted-globals",
    ],
    [
      "CLI 非组装入口调用 Date.now",
      "src/adapters/cli/check.ts",
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
      "领域 Intl.DateTimeFormat.format 缺少时间参数",
      "src/domain/check.ts",
      "export const now = Intl.DateTimeFormat().format();",
      "bzt/no-implicit-clock",
    ],
    [
      "规则 Intl.DateTimeFormat.formatToParts 缺少时间参数",
      "src/rules/check.ts",
      "export const now = Intl.DateTimeFormat().formatToParts();",
      "bzt/no-implicit-clock",
    ],
    [
      "纯模块 Intl 显式传 undefined 隐式读时钟",
      "src/core/dto/check.ts",
      "export const now = Intl.DateTimeFormat().format(undefined);",
      "bzt/no-implicit-clock",
    ],
    [
      "纯模块调用脱离实例的 Intl 时间格式化方法",
      "src/core/calendar.ts",
      "const format = Intl.DateTimeFormat().format; export const now = format();",
      "bzt/no-implicit-clock",
    ],
    [
      "服务 Intl.DateTimeFormat.format 缺少时间参数",
      "src/services/check.ts",
      "export const now = Intl.DateTimeFormat().format();",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化展开不确定的时间参数",
      "src/domain/check.ts",
      "const args: number[] = []; export const now = Intl.DateTimeFormat().format(...args);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .call 未给时间",
      "src/domain/check.ts",
      "export const now = Intl.DateTimeFormat().format.call(null);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .call 显式传 undefined",
      "src/domain/check.ts",
      "export const now = Intl.DateTimeFormat().format.call(null, undefined);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .apply 未给时间",
      "src/rules/check.ts",
      "const formatter = Intl.DateTimeFormat(); export const now = formatter.formatToParts.apply(formatter, []);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .apply 展开不确定的首项",
      "src/rules/check.ts",
      "const args: [number?] = []; export const now = Intl.DateTimeFormat().format.apply(null, [...args]);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .bind 后无参调用",
      "src/services/check.ts",
      "const bound = Intl.DateTimeFormat().format.bind(null); export const now = bound();",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 .bind 用 undefined 预绑时间",
      "src/domain/check.ts",
      "export const now = Intl.DateTimeFormat().format.bind(null, undefined)();",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 Reflect.apply 未给时间",
      "src/domain/check.ts",
      "export const now = Reflect.apply(Intl.DateTimeFormat().format, null, []);",
      "bzt/no-implicit-clock",
    ],
    [
      "Intl 时间格式化 Reflect.apply 的数组长度不确定",
      "src/domain/check.ts",
      "export const render = (args: number[]) => Reflect.apply(Intl.DateTimeFormat().format, null, args);",
      "bzt/no-implicit-clock",
    ],
    [
      "纯模块访问 crypto 全局",
      "src/core/dto/check.ts",
      "export const id = globalThis.crypto.randomUUID();",
      "no-restricted-globals",
    ],
    [
      "领域用 Reflect.get 访问 globalThis",
      "src/domain/check.ts",
      "export function access(key: string) { Reflect.get(globalThis, key); }",
      "no-restricted-globals",
    ],
    [
      "规则计算 globalThis 属性名",
      "src/rules/check.ts",
      'const key = "Date"; export const now = globalThis[key].now();',
      "no-restricted-globals",
    ],
    [
      "服务直接创建 WebSocket",
      "src/services/check.ts",
      'export const conn = new WebSocket("ws://offline.test");',
      "no-restricted-globals",
    ],
    [
      "非 internal 的 API 创建 XMLHttpRequest",
      "src/api/check.ts",
      "export function read() { new XMLHttpRequest(); }",
      "no-restricted-globals",
    ],
    ...(
      [
        ["WebSocket", 'new WebSocket("wss://offline.test");'],
        ["XMLHttpRequest", "new XMLHttpRequest();"],
        ["EventSource", 'new EventSource("https://offline.test");'],
      ] as const
    ).map<[string, string, string, string]>(([name, source]) => [
      `API 内部使用 ${name}`,
      "src/api/internal/check.ts",
      source,
      "no-restricted-globals",
    ]),
    ...[
      "node:child_process",
      "node:worker_threads",
      "http",
      "node:http2",
      "node:https",
      "node:net",
      "node:tls",
      "dgram",
      "undici",
    ].map<[string, string, string, string]>((name) => [
      `API 内部导入 ${name}`,
      "src/api/internal/check.ts",
      `import "${name}";`,
      "no-restricted-imports",
    ]),
    [
      "CLI 通过 globalThis 创建 EventSource",
      "src/adapters/cli/check.ts",
      'new globalThis.EventSource("https://offline.test");',
      "no-restricted-globals",
    ],
    [
      "服务导入 child_process",
      "src/services/check.ts",
      'import "child_process";',
      "no-restricted-imports",
    ],
    [
      "API 导入 node:child_process",
      "src/api/check.ts",
      'import "node:child_process";',
      "no-restricted-imports",
    ],
    [
      "CLI 导入 worker_threads",
      "src/adapters/cli/check.ts",
      'import "worker_threads";',
      "no-restricted-imports",
    ],
    [
      "核心导入 node:worker_threads",
      "src/core/check.ts",
      'import "node:worker_threads";',
      "no-restricted-imports",
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
    [
      "服务把 JSON.parse 直接赋给品牌 DTO",
      "src/services/check.ts",
      'import type { StoryDetail } from "../core/dto/story.ts"; export function read(raw: string) { const s: StoryDetail = JSON.parse(raw); return s; }',
      "@typescript-eslint/no-unsafe-assignment",
    ],
    [
      "API 门面直接返回 Response.json",
      "src/api/check.ts",
      "export async function read(r: Response) { return r.json(); }",
      "@typescript-eslint/no-unsafe-return",
    ],
    [
      "把未校验的 JSON 当作品牌 DTO 参数",
      "src/services/check.ts",
      'import type { StoryDetail } from "../core/dto/story.ts"; function getId(s: StoryDetail) { return s.id; } export const read = (raw: string) => getId(JSON.parse(raw));',
      "@typescript-eslint/no-unsafe-argument",
    ],
    [
      "直接读取未校验 JSON 的成员",
      "src/services/check.ts",
      "export const read = (raw: string) => JSON.parse(raw).id;",
      "@typescript-eslint/no-unsafe-member-access",
    ],
    [
      "直接调用未校验的 JSON",
      "src/services/check.ts",
      "export const read = (raw: string) => JSON.parse(raw)();",
      "@typescript-eslint/no-unsafe-call",
    ],
  ]);

  const permitted = fixtures([
    [
      "领域 Intl 使用显式时间",
      "src/domain/check.ts",
      'import type { Clock } from "../core/clock.ts"; export const render = (clock: Clock) => Intl.DateTimeFormat().format(clock());',
    ],
    [
      "服务 Intl 间接调用仍允许显式时间",
      "src/services/check.ts",
      `import type { Clock } from "../core/clock.ts";
export function render(clock: Clock) {
  const formatter = Intl.DateTimeFormat();
  const args: [number] = [clock()];
  const bound = formatter.format.bind(null);
  return [
    formatter.format(0),
    formatter.formatToParts.call(formatter, clock()),
    formatter.format.apply(null, args),
    formatter.format.bind(null, clock())(),
    bound(clock()),
    Reflect.apply(formatter.formatToParts, formatter, [clock()]),
  ];
}`,
    ],
    [
      "规则中的非时间格式化函数无需时钟",
      "src/rules/check.ts",
      'const formatter = { format: () => "safe" }; export const text = formatter.format();',
    ],
    [
      "src/api/story.ts 调用内部解码器并返回品牌 DTO",
      "src/api/story.ts",
      'import { decodeStoryResponse } from "./internal/story-response.ts"; import type { StoryDetail } from "../core/dto/story.ts"; declare function read(id: number): Promise<Response>; export async function getStoryDetail(id: number): Promise<StoryDetail> { return decodeStoryResponse(await read(id)); }',
    ],
    [
      "API 门面公开安全的泛型约束和默认类型",
      "src/api/check.ts",
      'export type Label<T extends string = "draft"> = { value: T }; export function wrap<T extends number>(value: T) { return { value }; }',
    ],
    [
      "API 内部允许内置 fetch",
      "src/api/internal/check.ts",
      "export function send(url: URL) { return fetch(url); }",
    ],
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
      "CLI 组装入口使用 Date.now 注入时钟并渲染 stdout",
      "src/adapters/cli/bzt.ts",
      "const clock = () => Date.now(); process.stdout.write(String(clock()));",
    ],
  ]);

  const incompatible = fixtures([
    [
      "服务用 Zod 公开品牌伪造 StoryDetail",
      "src/services/check.ts",
      `import { $brand } from "zod";
import type { StoryDetail } from "../core/dto/story.ts";
const raw = { id: 11, product: 29, type: "story" as const, title: "测试", status: "draft", executions: [], password: "synthetic" };
const forged = { ...raw, [$brand]: { StoryDetail: true as const } };
export function read(): StoryDetail { return forged; }`,
    ],
  ]);
  const { eslint, program } = createFixtureChecks();

  beforeAll(async () => {
    // 首次加载 ESLint 解析器、import 解析器与 TypeScript 类型信息，单独留出初始化时间。
    const warmup = [
      blocked[0],
      blocked.find(({ ruleId }) => ruleId === "bzt/no-raw-api-exports"),
      blocked.find(
        ({ ruleId }) => ruleId === "@typescript-eslint/no-unsafe-assignment",
      ),
    ];
    for (const fixture of warmup) {
      if (!fixture) throw new Error("未加载 ESLint 自检片段。");
      await eslint.lintText(fixture.source, { filePath: fixture.filePath });
    }
  }, 30_000);

  it.each(blocked)("拦截 $name", async ({ filePath, source, ruleId }) => {
    const [result] = await eslint.lintText(source, { filePath });
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId, severity: 2 }),
      ]),
    );
  });

  it.each(permitted)("放行 $name", async ({ filePath, source }) => {
    const [result] = await eslint.lintText(source, { filePath });
    expect(result?.messages).toEqual([]);
  });

  it.each(incompatible)("类型检查拦截 $name", ({ filePath }) => {
    const file = program.getSourceFile(absolutePath(filePath));
    if (!file) throw new Error("未加载虚拟源码。");
    const diagnostics = program.getSemanticDiagnostics(file);
    expect(diagnostics.map(({ code }) => code)).toEqual([2741]);
  });
});
