import { BztError } from "../../core/errors.ts";
import {
  accountFields,
  fixtureArrayItemContext,
  fixtureChildContext,
  fixtureKey,
  fixtureOptionMap,
  freeTextFields,
  isFixtureEndpoint,
  isFixtureEnum,
  isFixtureEnumMapKey,
  isFixtureModuleMenu,
  isFixtureModulePath,
  isFixtureRequiredFieldList,
  isFixtureRoleCode,
  isIdString,
  isSchemaFixtureKey,
  nameFields,
  rootFixtureContext,
  type FixtureFieldContext,
  type FixtureOptionMap,
} from "./fixture-fields.ts";
import { FIXTURE_TEXT, fixtureTextIdentityContent } from "./fixture-text.ts";

export const FIXTURE_URL = "https://fixture.example.test";
export const FIXTURE_CLOSED_ACCOUNT = "closed";
export const fixtureIdentityParts = /(\s*[,;、，；|]\s*)/u;

export function isFixtureClosedAccountOption(
  key: string,
  label: unknown,
): boolean {
  return key === FIXTURE_CLOSED_ACCOUNT && label === "Closed";
}

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

export function isCredentialFixtureField(key: string): boolean {
  return credentialField.test(fixtureKey(key).replace(/\d/gu, ""));
}

export function isFixtureHeaderEnvelope(key: string): boolean {
  return /^(?:headers|requestheaders|responseheaders)$/u.test(
    fixtureKey(key).replace(/\d/gu, ""),
  );
}

export function rememberFixtureCredential(
  value: string | number,
  knownSecrets: Set<string>,
): void {
  const text = String(value).trim();
  knownSecrets.add(text);
  const authorization = /^(?:Bearer|Basic)\s+(\S+)$/iu.exec(text)?.[1];
  if (authorization !== undefined) knownSecrets.add(authorization);
  const cookie =
    /\b(?:token|zentaosid|phpsessid|session[_-]?id)\s*=\s*["']?([^"';,\s]+)/giu;
  for (const pair of text.matchAll(cookie)) {
    if (pair[1] !== undefined) knownSecrets.add(pair[1]);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isFixtureUsersDictionary(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  if (!isPlainRecord(value)) return true;

  // Q1 account-to-name maps are discarded. The users endpoint can index records by ID.
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 0 ||
    keys.some((key) => {
      if (typeof key !== "string" || !/^[1-9]\d*$/u.test(key)) return true;
      const row: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (!isPlainRecord(row)) return true;
      const id = Object.getOwnPropertyDescriptor(row, "id");
      return id === undefined || !("value" in id);
    })
  );
}

// docs/09 §3 uses the same key families as S01. Treat IP as a word so "description" can survive.
export function isSensitiveFixtureField(key: string, value: unknown): boolean {
  const normalized = fixtureKey(key).replace(/\d/gu, "");
  const words = key.replace(/([a-z\d])([A-Z])/gu, "$1 $2").replace(/_/gu, " ");
  return (
    credentialField.test(normalized) ||
    privateField.test(normalized) ||
    isFixtureHeaderEnvelope(key) ||
    /\bip(?:v[46])?\b/iu.test(words) ||
    /(?:last|login|client|remote|user)ip/u.test(normalized) ||
    (normalized === "users" && isFixtureUsersDictionary(value))
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
  identityContent = value,
): void {
  if (
    knownSecrets.some((secret) =>
      secret.length >= 4
        ? value.includes(secret)
        : containsToken(value, secret),
    ) ||
    (value !== FIXTURE_URL &&
      sensitiveText.some((pattern) => pattern.test(value)))
  ) {
    throw residual();
  }
  if (knownIdentities.length === 0 || identityContent === "") return;

  const text = identityContent.normalize("NFC");
  const outsideNameAliases = text.replace(
    /(?<![\p{L}\p{N}_])人员\d{3,}(?![\p{L}\p{N}_])/gu,
    "",
  );
  // Han names can occur without delimiters. Word boundaries avoid treating a short
  // account such as "acct" as an identity inside an alias such as "acct_001".
  if (
    knownIdentities.some(
      (identity) =>
        containsToken(text, identity) ||
        (/\p{Script=Han}/u.test(identity) &&
          outsideNameAliases.includes(identity)),
    )
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

interface ScanContext extends FixtureFieldContext {
  readonly optionLabel?: boolean;
  readonly closedAccountOption?: boolean;
  readonly modulePath?: boolean;
}

function identityContent(value: string, context: ScanContext): string {
  const { field } = context;
  if (context.closedAccountOption) return "";
  if (context.optionLabel) return value === FIXTURE_TEXT ? "" : value;
  if (accountFields.has(field)) {
    return value
      .split(fixtureIdentityParts)
      .map((part) => (part === FIXTURE_CLOSED_ACCOUNT ? "" : part))
      .join("");
  }
  if (
    nameFields.has(field) ||
    field === "feedbackby" ||
    field === "feedbackbytext"
  ) {
    return value;
  }
  if (field === "endpoint" && isFixtureEndpoint(value)) {
    // Fixed route text can overlap an account. Dynamic IDs still need to be checked.
    return [...value.matchAll(/[/=](-?\d+)(?=[/?&]|$)/gu)]
      .map(([, id]) => id)
      .join(" ");
  }
  if (
    isFixtureEnum(field, value) ||
    isFixtureRoleCode(context, value) ||
    (context.inRequiredFields &&
      !freeTextFields.has(field) &&
      isFixtureRequiredFieldList(value)) ||
    (context.modulePath && isFixtureModulePath(value)) ||
    value === FIXTURE_URL
  ) {
    return "";
  }
  return fixtureTextIdentityContent(value);
}

function isFixedKey(
  key: string,
  context: FixtureFieldContext,
  optionMap: FixtureOptionMap | undefined,
  closedAccountOption: boolean,
): boolean {
  if (optionMap?.kind === "account") return closedAccountOption;
  const enumKey =
    optionMap?.kind === "enum" && isFixtureEnumMapKey(optionMap, key);
  if (optionMap?.kind === "enum" && optionMap.nested) return enumKey;
  return (
    enumKey || isSchemaFixtureKey(key) || isFixtureEnum(context.field, key)
  );
}

// This pass reads the emitted tree independently. It never transforms a hit or reports its value.
export function assertSanitizedJson(
  input: unknown,
  knownSecrets: readonly string[] = [],
  knownIdentities: readonly string[] = [],
): void {
  const visiting = new WeakSet<object>();
  const secrets = knownSecrets.filter((secret) => secret.trim() !== "");
  const identities = knownIdentities
    .map((identity) => identity.trim().normalize("NFC"))
    .filter((identity) => identity !== "");

  function scan(
    value: unknown,
    context: ScanContext = rootFixtureContext,
  ): void {
    if (typeof value === "string") {
      checkText(
        value,
        secrets,
        identities,
        identities.length === 0 ? "" : identityContent(value, context),
      );
      const embedded = readEmbeddedJson(value.trim());
      if (embedded !== undefined) scan(embedded);
      else if (value.includes("\n")) {
        for (const line of value.split(/\r?\n/u)) scan(line, context);
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
      for (const child of value)
        scan(child, fixtureArrayItemContext(context, child));
    } else {
      if (!isPlainRecord(value)) throw residual();
      const entries = Reflect.ownKeys(value).map((key): [string, unknown] => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          typeof key !== "string" ||
          descriptor === undefined ||
          !("value" in descriptor)
        ) {
          throw residual();
        }
        return [key, descriptor.value];
      });
      const optionMap = fixtureOptionMap(context, entries);
      for (const [key, child] of entries) {
        if (isSensitiveFixtureField(key, child)) throw residual();
        const closedAccountOption =
          optionMap?.kind === "account" &&
          isFixtureClosedAccountOption(key, child);
        if (optionMap?.kind === "account" && !closedAccountOption) {
          if (key !== "" && !/^acct_\d{3,}$/u.test(key)) throw residual();
          if (child !== FIXTURE_TEXT && !(key === "" && child === ""))
            throw residual();
        }
        checkText(
          key,
          secrets,
          identities,
          isFixedKey(key, context, optionMap, closedAccountOption) ? "" : key,
        );
        scan(child, {
          ...fixtureChildContext(context, key),
          closedAccountOption,
          optionLabel: optionMap !== undefined,
          modulePath:
            typeof child === "string" &&
            isFixtureModuleMenu(context.field) &&
            isIdString(key),
        });
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
