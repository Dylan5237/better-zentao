const sensitiveKey =
  /^(?:(?:zentao)?(?:password|passwd|pwd)(?:hash)?|zentaoaccount|x?(?:zentao|auth|access|refresh|session)?token|(?:proxy)?authorization|(?:client)?secret|x?apikey|credentials?|cookie|setcookie|email|phone|telephone|mobile|salt)$/u;
const sensitiveValues = [
  /\b(?:token|authorization|password|x-api-key)\s*[:=]\s*\S+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\$(?:2[aby]|argon2(?:id|i|d))\$\S+/u,
  /^[a-f\d]{32}$/iu, // 禅道历史密码哈希特征。
];

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
      if (sensitiveKey.test(normalized)) {
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
