const sensitiveKey =
  /password|passwd|pwd|zentaoaccount|token|authorization|secret|apikey|credential|cookie|zentaosid|phpsessid|sessionid|webhook|privatekey|email|phone|mobile|salt|qq|weixin|wechat|dingding|skype|slack|whatsapp|address|zipcode|birthday|gender|avatar|userpairs/u;
const sensitiveValues = [
  /\b(?:token|authorization|password|x-api-key)\s*[:=]\s*\S+/iu,
  /\bbearer\s+\S+/iu,
  /\b(?:zentaosid|phpsessid)\s*=\s*\S+/iu,
  /\bhttps?:\/\/[^\s?#]*\/webhook(?:\/[^\s?#]*)?\?(?:[^\s#]*&)?key=[^&#\s]+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\$(?:2[aby]|argon2(?:id|i|d))\$\S+/u,
  /[a-f\d]{32}/iu, // 禅道历史密码哈希可能夹在正文中。
];
// pnpm 会把同级依赖的 32 位哈希附在堆栈帧的包目录名上。
const pnpmStackHash =
  /(^[ \t]+at [^\r\n]*[/\\]node_modules[/\\]\.pnpm[/\\][^/\\\s]+_)[a-f\d]{32}(?=[/\\]node_modules[/\\][^\r\n]+:\d+:\d+\)?[ \t]*$)/gimu;

function hasSensitiveKey(key: string, normalized: string): boolean {
  // IP 按词匹配，否则 description、skipped 等字段也会被拦截。
  const words = key.replace(/([a-z\d])([A-Z])/gu, "$1 $2");
  return (
    sensitiveKey.test(normalized) ||
    /\bip(?:v[46])?\b/iu.test(words.replace(/_/gu, " ")) ||
    /(?:last|login|client|remote|user)ip/u.test(normalized)
  );
}

function readJsonLine(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith('"'))
    return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function assertNoSensitiveData(
  payload: unknown,
  knownSecrets: readonly string[] = [],
): void {
  const visited = new WeakSet<object>();

  function scanEntry(key: unknown, child: unknown, stack = false): void {
    const name = typeof key === "symbol" ? key.description : key;
    if (typeof name === "string") {
      const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
      if (hasSensitiveKey(name, normalized)) {
        throw new Error("S01 检测到凭据或隐私字段。");
      }
      if (
        normalized === "users" &&
        typeof child === "object" &&
        child !== null &&
        !Array.isArray(child)
      ) {
        throw new Error("S01 检测到原始 users 字典。");
      }
    }
    scan(name);
    scan(child, stack);
  }

  function scan(value: unknown, stack = false): void {
    if (typeof value === "string") {
      const text = stack ? value.replace(pnpmStackHash, "$1") : value;
      if (
        knownSecrets.some(
          (secret) => secret !== "" && value.includes(secret),
        ) ||
        sensitiveValues.some((pattern) => pattern.test(text))
      ) {
        throw new Error("S01 检测到敏感值特征。");
      }

      const json = readJsonLine(text.trim());
      if (json !== undefined) scan(json);
      else if (text.includes("\n")) {
        for (const line of text.split(/\r?\n/u)) scan(line);
      }
      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value))
      return;
    visited.add(value);
    if (value instanceof Uint8Array) {
      scan(new TextDecoder().decode(value));
    } else if (
      value instanceof Map ||
      value instanceof Headers ||
      value instanceof URLSearchParams
    ) {
      for (const [key, child] of value) scanEntry(key, child);
    } else if (value instanceof Set) {
      for (const child of value) scan(child);
    }

    const keys = new Set(
      value instanceof Uint8Array
        ? Object.getOwnPropertySymbols(value)
        : Reflect.ownKeys(value),
    );
    if (value instanceof Error) {
      // name 等标准字段也可能来自原型。
      for (const key of ["name", "message", "stack", "cause"]) keys.add(key);
    }
    for (const key of keys) {
      scanEntry(
        key,
        Reflect.get(value, key),
        value instanceof Error && key === "stack",
      );
    }
  }

  scan(payload);
}
