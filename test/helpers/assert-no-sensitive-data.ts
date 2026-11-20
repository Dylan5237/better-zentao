const sensitiveKey =
  /password|passwd|pwd|zentaoaccount|token|authorization|secret|apikey|credential|cookie|zentaosid|sessionid|privatekey|email|phone|mobile|salt|qq|weixin|wechat|dingding|skype|slack|whatsapp|address|zipcode|birthday|gender|avatar|userpairs/u;
const sensitiveValues = [
  /\b(?:token|authorization|password|x-api-key)\s*[:=]\s*\S+/iu,
  /\bbearer\s+\S+/iu,
  /\bzentaosid\s*=\s*\S+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\$(?:2[aby]|argon2(?:id|i|d))\$\S+/u,
  /[a-f\d]{32}/iu, // 禅道历史密码哈希可能夹在正文中。
];

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

  function scan(value: unknown): void {
    if (typeof value === "string") {
      if (
        knownSecrets.some(
          (secret) => secret !== "" && value.includes(secret),
        ) ||
        sensitiveValues.some((pattern) => pattern.test(value))
      ) {
        throw new Error("S01 检测到敏感值特征。");
      }

      const json = readJsonLine(value.trim());
      if (json !== undefined) scan(json);
      else if (value.includes("\n")) {
        for (const line of value.split(/\r?\n/u)) scan(line);
      }
      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value))
      return;
    visited.add(value);
    if (value instanceof Uint8Array) {
      scan(new TextDecoder().decode(value));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/gu, "");
      if (hasSensitiveKey(key, normalized)) {
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
      scan(child);
    }
  }

  scan(payload);
}
