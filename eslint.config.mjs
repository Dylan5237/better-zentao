import { fileURLToPath } from "node:url";
import importRules from "eslint-plugin-import-x";
import ts from "typescript";
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

const privateApiZone = {
  target: "./src",
  from: "./src/api/internal",
  message: "只允许通过 API 公共接口接收已投影的 DTO。",
};

function declaredInApiInternal(symbol) {
  return symbol?.declarations?.some((declaration) =>
    declaration
      .getSourceFile()
      .fileName.replaceAll("\\", "/")
      .includes("/src/api/internal/"),
  );
}

function exposesRawApiType(program, type, seen = new Set()) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  const symbol = type.getSymbol();
  if (declaredInApiInternal(symbol) || declaredInApiInternal(type.aliasSymbol))
    return true;
  if (["Response", "Request", "Headers"].includes(symbol?.name)) return true;
  if (seen.has(type)) return false;
  seen.add(type);

  const checker = program.getTypeChecker();
  const exposesRaw = (inner) => exposesRawApiType(program, inner, seen);
  if (type.isUnionOrIntersection()) return type.types.some(exposesRaw);
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  if (type.objectFlags & ts.ObjectFlags.Reference) {
    if (checker.getTypeArguments(type).some(exposesRaw)) return true;
  }
  const signatures = [
    ...type.getCallSignatures(),
    ...type.getConstructSignatures(),
  ];
  for (const signature of signatures) {
    if (
      exposesRaw(signature.getReturnType()) ||
      signature
        .getParameters()
        .some((parameter) => exposesRaw(checker.getTypeOfSymbol(parameter)))
    )
      return true;
  }
  // 对 Promise 等外部容器检查类型参数即可，避免深入容器自己的实现类型。
  if (
    symbol?.declarations?.some((declaration) => {
      const source = declaration.getSourceFile();
      return (
        program.isSourceFileDefaultLibrary(source) ||
        program.isSourceFileFromExternalLibrary(source)
      );
    })
  )
    return false;
  return (
    type
      .getProperties()
      .some((property) => exposesRaw(checker.getTypeOfSymbol(property))) ||
    checker
      .getIndexInfosOfType(type)
      .some(({ type: entry }) => exposesRaw(entry))
  );
}

const noRawApiExports = {
  meta: {
    messages: {
      rawExport: "API 门面不能导出私有绑定或未投影的类型（{{name}}）。",
    },
  },
  create(context) {
    const { program, esTreeNodeToTSNodeMap } =
      context.sourceCode.parserServices;
    const checker = program.getTypeChecker();
    return {
      Program(node) {
        const module = checker.getSymbolAtLocation(
          esTreeNodeToTSNodeMap.get(node),
        );
        if (!module) return;
        for (const binding of checker.getExportsOfModule(module)) {
          const target =
            binding.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(binding)
              : binding;
          const type =
            target.flags & ts.SymbolFlags.Value
              ? checker.getTypeOfSymbol(target)
              : checker.getDeclaredTypeOfSymbol(target);
          if (
            declaredInApiInternal(target) ||
            exposesRawApiType(program, type)
          ) {
            context.report({
              node,
              messageId: "rawExport",
              data: { name: binding.name },
            });
          }
        }
      },
    };
  },
};

const noImplicitClock = {
  meta: { messages: { implicitClock: "时间格式化须传入明确的时间。" } },
  create(context) {
    const { program, esTreeNodeToTSNodeMap } =
      context.sourceCode.parserServices;
    const checker = program.getTypeChecker();
    return {
      CallExpression(node) {
        const call = esTreeNodeToTSNodeMap.get(node);
        const declaration = checker.getResolvedSignature(call)?.declaration;
        const owner = declaration?.parent;
        if (
          !owner ||
          !ts.isInterfaceDeclaration(owner) ||
          owner.name.text !== "DateTimeFormat" ||
          !program.isSourceFileDefaultLibrary(owner.getSourceFile()) ||
          !(
            ts.isMethodSignature(declaration) &&
            ts.isIdentifier(declaration.name) &&
            ["format", "formatToParts"].includes(declaration.name.text)
          )
        )
          return;

        const time = call.arguments[0];
        const type = time && checker.getTypeAtLocation(time);
        const possibleTimes = type?.isUnion() ? type.types : [type];
        if (
          possibleTimes.some(
            (part) =>
              !part ||
              part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void),
          )
        ) {
          context.report({ node, messageId: "implicitClock" });
        }
      },
    };
  },
};

const networkModules = {
  regex: "^(?:node:)?(?:http2?|https|net|tls|dgram)(?:/|$)|^undici(?:/|$)",
  message: "禅道 HTTP 请求从 api/internal 发出。",
};
const networkGlobals = ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"];
const restrictedModules = [
  networkModules,
  {
    regex: "^(?:node:)?(?:child_process|worker_threads)(?:/|$)",
    message: "源码不能通过子进程或工作线程绕过传输边界。",
  },
];
const processImports = [
  "process",
  { name: "node:process", allowImportNames: ["stderr"] },
];

const restrictedImportsSyntax = [
  { selector: "ImportExpression", message: "使用可静态核验的文件导入。" },
  { selector: "TSImportType", message: "使用可校验的 import type 声明。" },
];

function restrictedGlobals(...extra) {
  return [
    "error",
    {
      globals: [
        { name: "Date", message: "通过参数注入时钟，使用 core 日历口径。" },
        { name: "console", message: "用 stderr 结构化日志。" },
        "globalThis",
        "global",
        "self",
        "window",
        ...extra,
      ],
    },
  ];
}

export default [
  { ignores: ["dist/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: basePath },
    },
    linterOptions: { noInlineConfig: true },
    plugins: {
      import: importRules,
      bzt: {
        rules: {
          "no-raw-api-exports": noRawApiExports,
          "no-implicit-clock": noImplicitClock,
        },
      },
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        { basePath, zones: [...zones, privateApiZone] },
      ],
      "import/no-unresolved": "error",
      "no-console": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "no-restricted-syntax": ["error", ...restrictedImportsSyntax],
      "no-restricted-globals": restrictedGlobals("process", ...networkGlobals),
      "no-restricted-imports": [
        "error",
        { paths: ["process", "node:process"], patterns: restrictedModules },
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
    rules: { "import/no-restricted-paths": ["error", { basePath, zones }] },
  },
  {
    files: ["src/api/**/*.ts"],
    ignores: [apiInternal],
    rules: {
      "bzt/no-raw-api-exports": "error",
    },
  },
  {
    files: [cli],
    rules: {
      "no-restricted-globals": restrictedGlobals(...networkGlobals),
      "no-restricted-imports": ["error", { patterns: restrictedModules }],
    },
  },
  {
    files: [logger],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: processImports, patterns: restrictedModules },
      ],
    },
  },
  {
    files: ["src/{domain,rules}/**/*.ts", ...pureCoreFiles],
    rules: {
      "bzt/no-implicit-clock": "error",
      "no-restricted-globals": restrictedGlobals(
        "process",
        ...networkGlobals,
        "crypto",
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
    files: ["src/core/store/sqlite.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedImportsSyntax.map((restriction) =>
          restriction.selector === "ImportExpression"
            ? {
                ...restriction,
                selector: 'ImportExpression:not([source.value="node:sqlite"])',
              }
            : restriction,
        ),
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
