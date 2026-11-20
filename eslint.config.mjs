import { fileURLToPath } from "node:url";
import importRules from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const basePath = fileURLToPath(new URL(".", import.meta.url));
const cli = "src/adapters/cli/bzt.ts";
const logger = "src/core/logger.ts";
const apiInternal = "src/api/internal/**";

const layers = {
  adapters: ["adapters", "services", "contracts"],
  services: ["services", "domain", "rules", "api", "core", "contracts"],
  domain: ["domain", "core"],
  rules: ["rules", "domain", "core"],
  api: ["api", "core"],
  contracts: ["contracts", "core"],
  core: ["core"],
};

const pureCore = ["dto", "clock.ts", "calendar.ts", "errors.ts"];
const pureCoreFiles = pureCore.map((entry) =>
  entry.endsWith(".ts")
    ? "src/core/" + entry
    : "src/core/" + entry + "/**/*.ts",
);
const pureTargets = [
  "./src/domain",
  "./src/rules",
  ...pureCore.map((entry) => "./src/core/" + entry),
];

const zones = [
  ...Object.entries(layers).map(([layer, allowed]) => ({
    target: "./src/" + layer,
    from: "./src",
    except: allowed.map((entry) => "./" + entry),
  })),
  {
    target: Object.keys(layers)
      .filter((layer) => layer !== "api")
      .map((layer) => "./src/" + layer),
    from: "./src/api/internal",
    message: "只允许通过 API 公共接口接收已投影的 DTO。",
  },
  {
    target: "./src",
    from: ["./test", "./dist"],
    message: "源码依赖须由源码分层规则检查。",
  },
  {
    target: pureTargets,
    from: "./src/core",
    except: pureCore.map((entry) => "./" + entry),
    message: "纯模块只能使用 core 中的纯模块。",
  },
];

const networkModules = {
  regex: "^(?:node:)?(?:http2?|https|net|tls|dgram)(?:/|$)|^undici(?:/|$)",
  message: "禅道 HTTP 请求从 api/internal 发出。",
};
const processImports = [
  "process",
  { name: "node:process", allowImportNames: ["stderr"] },
];

function restrictedGlobals(...extra) {
  return [
    "error",
    {
      globals: [
        { name: "Date", message: "通过参数注入时钟，使用 core 日历口径。" },
        { name: "console", message: "用 stderr 结构化日志。" },
        ...extra,
      ],
      checkGlobalObject: true,
    },
  ];
}

export default [
  { ignores: ["dist/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    linterOptions: { noInlineConfig: true },
    plugins: { import: importRules },
    rules: {
      "import/no-restricted-paths": ["error", { basePath, zones }],
      "import/no-unresolved": "error",
      "no-console": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ImportExpression", message: "使用可静态核验的文件导入。" },
        {
          selector: "TSImportType",
          message: "使用可校验的 import type 声明。",
        },
      ],
      "no-restricted-globals": restrictedGlobals("process", "fetch"),
      "no-restricted-imports": [
        "error",
        { paths: ["process", "node:process"], patterns: [networkModules] },
      ],
    },
  },
  {
    files: [apiInternal],
    rules: {
      "no-restricted-globals": restrictedGlobals("process"),
      "no-restricted-imports": [
        "error",
        { paths: ["process", "node:process"] },
      ],
    },
  },
  {
    files: ["src/api/**/*.ts"],
    ignores: [apiInternal],
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          basePath,
          zones: [
            ...zones,
            {
              target: "./src/api",
              from: [
                "./src/api/internal/probe-transport.ts",
                "./src/api/internal/story-response.ts",
              ],
              message: "原始传输和响应解码仅供 API 私有模块使用。",
            },
          ],
        },
      ],
    },
  },
  {
    files: [cli],
    rules: {
      "no-restricted-globals": restrictedGlobals("fetch"),
      "no-restricted-imports": ["error", { patterns: [networkModules] }],
    },
  },
  {
    files: [logger],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: processImports, patterns: [networkModules] },
      ],
    },
  },
  {
    files: ["src/{domain,rules}/**/*.ts", ...pureCoreFiles],
    rules: {
      "no-restricted-globals": restrictedGlobals(
        "process",
        "fetch",
        "XMLHttpRequest",
        "WebSocket",
        "setTimeout",
        "setInterval",
        "setImmediate",
        "performance",
      ),
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.{1,2}/|zod$)",
              message: "纯模块不可导入 I/O 或外部模块。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_" },
      ],
    },
  },
];
