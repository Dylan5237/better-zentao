import { BztError } from "../../core/errors.ts";

export const FIXTURE_URL = "https://fixture.example.test";

const credentialField =
  /password|passwd|passphrase|pwd|zentaoaccount|token|authorization|bearer|secret|apikey|credential|cookie|zentaosid|phpsessid|sessionid|webhook|privatekey|salt/u;
const privateField =
  /email|phone|mobile|qq|weixin|wechat|dingding|skype|slack|whatsapp|address|zipcode|birthday|gender|avatar|userpairs/u;
const sensitiveText = [
  /\b(?:token|authorization|password|x-api-key|(?:set-)?cookie|zentaosid|phpsessid|session[_-]?id)\s*[:=]\s*\S/iu,
  /\bbearer\s+\S/iu,
  /(?:[?&]|\b)key\s*=\s*[^&#\s]+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu,
  /\$(?:2[aby]|argon2(?:id|i|d))\$\S/u,
  /[a-f\d]{32}/iu,
  /[\p{L}\p{N}.!#$%&'*+/=?^_{}\x60|~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u,
  /(?:^|\D)1[3-9]\d(?:[ -]?\d){8}(?!\d)/u,
  /(?:\+\d{1,3}[ -]|\(\d{3}\)[ -]?)\d(?:[ -]?\d){6,13}(?!\d)/u,
  /\b(?:https?|ftps?|file):\/\//iu,
  /(?:^|[\s"'(])(?:\/\/|\\\\)[a-z\d][a-z\d.-]+/iu,
  /(?:^|[\s"'(])(?:[a-z]:\\|\/(?:home|Users|var|srv|tmp|mnt)\/)[^\s]+/iu,
  /\b(?:[a-z\d-]+\.)+(?:local|lan|intranet|internal|corp|invalid)\b/iu,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
];

export function fixtureKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z\d]/gu, "");
}

export function isCredentialFixtureField(key: string): boolean {
  return credentialField.test(fixtureKey(key).replace(/\d/gu, ""));
}

// docs/09 §3 uses the same key families as S01. Treat IP as a word so "description" can survive.
export function isSensitiveFixtureField(key: string, value: unknown): boolean {
  const normalized = fixtureKey(key).replace(/\d/gu, "");
  const words = key.replace(/([a-z\d])([A-Z])/gu, "$1 $2").replace(/_/gu, " ");
  return (
    credentialField.test(normalized) ||
    privateField.test(normalized) ||
    /^(?:headers|requestheaders|responseheaders)$/u.test(normalized) ||
    /\bip(?:v[46])?\b/iu.test(words) ||
    /(?:last|login|client|remote|user)ip/u.test(normalized) ||
    (normalized === "users" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value))
  );
}

function containsToken(value: string, token: string): boolean {
  let position = value.indexOf(token);
  while (position !== -1) {
    const before = value[position - 1] ?? "";
    const after = value[position + token.length] ?? "";
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))
      return true;
    position = value.indexOf(token, position + token.length);
  }
  return false;
}

function checkText(
  value: string,
  knownSecrets: readonly string[],
  knownIdentities: readonly string[],
): void {
  if (
    knownSecrets.some((secret) =>
      secret.length >= 4
        ? value.includes(secret)
        : containsToken(value, secret),
    ) ||
    // A short account such as "acct" cannot identify a person inside "acct_001".
    knownIdentities.some((identity) => containsToken(value, identity)) ||
    (value !== FIXTURE_URL &&
      sensitiveText.some((pattern) => pattern.test(value)))
  ) {
    throw residual();
  }
}

function residual(): BztError {
  return new BztError("INVALID_INPUT", "夹具二次复扫发现敏感数据或非法 JSON。");
}

function readEmbeddedJson(text: string): unknown {
  if (!/^[{["]/u.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

// This pass reads the emitted tree independently. It never transforms a hit or reports its value.
export function assertSanitizedJson(
  input: unknown,
  knownSecrets: readonly string[] = [],
  knownIdentities: readonly string[] = [],
): void {
  const visiting = new WeakSet<object>();
  const secrets = knownSecrets.filter((secret) => secret.trim() !== "");
  const identities = knownIdentities.filter(
    (identity) => identity.trim() !== "",
  );

  function scan(value: unknown): void {
    if (typeof value === "string") {
      checkText(value, secrets, identities);
      const embedded = readEmbeddedJson(value.trim());
      if (embedded !== undefined) scan(embedded);
      else if (value.includes("\n")) {
        for (const line of value.split(/\r?\n/u)) scan(line);
      }
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      checkText(String(value), secrets, identities);
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value !== "object" || visiting.has(value)) throw residual();

    visiting.add(value);
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw residual();
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          typeof key !== "string" ||
          descriptor === undefined ||
          !("value" in descriptor)
        ) {
          throw residual();
        }
        const child: unknown = descriptor.value;
        if (isSensitiveFixtureField(key, child)) throw residual();
        checkText(key, secrets, identities);
        scan(child);
      }
    }
    visiting.delete(value);
  }

  try {
    scan(input);
  } catch {
    throw residual();
  }
}
