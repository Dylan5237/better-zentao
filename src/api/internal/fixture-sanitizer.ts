import { z } from "zod";
import type { SanitizedJson } from "../../core/dto/fixture.ts";
import { BztError } from "../../core/errors.ts";
import {
  accountFields,
  fixtureArrayItemContext,
  fixtureChildContext,
  fixtureKey,
  fixtureOptionMap,
  freeTextFields,
  isFixtureEnum,
  isFixtureEnumMapKey,
  isFixtureModuleMenu,
  isFixtureRoleCode,
  isIdString,
  isSchemaFixtureKey,
  isUrlFixtureString,
  maskUnknownFixtureDate,
  nameFields,
  preserveFixtureString,
  rootFixtureContext,
  type FixtureFieldContext,
} from "./fixture-fields.ts";
import {
  assertSanitizedJson,
  FIXTURE_CLOSED_ACCOUNT,
  FIXTURE_URL,
  fixtureIdentityParts,
  isCredentialFixtureField,
  isFixtureClosedAccountOption,
  isFixtureHeaderEnvelope,
  isFixtureUsersDictionary,
  isSensitiveFixtureField,
  rememberFixtureCredential,
} from "./fixture-sensitivity.ts";
import { FIXTURE_TEXT, sanitizeFixtureText } from "./fixture-text.ts";

export { assertSanitizedJson } from "./fixture-sensitivity.ts";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
type JsonObject = { [key: string]: Json };

interface Aliases {
  accounts: AliasTable;
  names: AliasTable;
  intake: AliasTable;
  fields: AliasTable;
}

interface AliasTable {
  prefix: string;
  values: Map<string, string>;
  next: number;
}

function aliasTable(prefix: string, previous?: AliasTable): AliasTable {
  return {
    prefix,
    values: new Map(previous?.values),
    next: previous?.next ?? 1,
  };
}

function createAliases(previous?: Aliases): Aliases {
  return {
    accounts: aliasTable("acct_", previous?.accounts),
    names: aliasTable("人员", previous?.names),
    intake: aliasTable("intake_", previous?.intake),
    fields: aliasTable("field_", previous?.fields),
  };
}

function isRecord(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nextAlias(table: AliasTable): string {
  const number = table.next++;
  return table.prefix + String(number).padStart(3, "0");
}

function alias(raw: string, table: AliasTable): string {
  const existing = table.values.get(raw);
  if (existing !== undefined) return existing;
  const name = nextAlias(table);
  table.values.set(raw, name);
  return name;
}

function avoidIdentityAliases(
  table: AliasTable,
  previous: AliasTable,
  originals: ReadonlySet<string>,
): void {
  for (const [raw, label] of table.values) {
    if (previous.values.has(raw) || !originals.has(label)) continue;
    let replacement = nextAlias(table);
    while (originals.has(replacement)) replacement = nextAlias(table);
    table.values.set(raw, replacement);
  }
}

function mapIdentities(
  value: string,
  translate: (part: string) => string,
): string {
  return value
    .split(fixtureIdentityParts)
    .map((part, index) => {
      if (index % 2 !== 0) return part;
      const identity = part.trim().normalize("NFC");
      return identity === "" ? "" : translate(identity);
    })
    .join("");
}

function metadataAliases(aliases: Aliases) {
  return {
    account: (value: string) =>
      mapIdentities(value, (part) =>
        part === FIXTURE_CLOSED_ACCOUNT ? part : alias(part, aliases.accounts),
      ),
    intake: (value: string) =>
      value === "" ? "" : alias(value, aliases.intake),
  };
}

function isFeedback(field: string): boolean {
  return field === "feedbackby" || field === "feedbackbytext";
}

function accountOptionAlias(key: string, aliases: Aliases): string {
  return alias(key.trim().normalize("NFC"), aliases.accounts);
}

function collectAliases(
  value: Json,
  context: FixtureFieldContext,
  aliases: Aliases,
  knownSecrets: Set<string>,
  ancestors: WeakSet<object>,
): void {
  const { field } = context;
  if (typeof value === "string") {
    if (accountFields.has(field)) metadataAliases(aliases).account(value);
    else if (
      (nameFields.has(field) && !isIdString(value)) ||
      isFeedback(field)
    ) {
      mapIdentities(value, (part) => alias(part, aliases.names));
    } else if (value.includes("bzt:"))
      sanitizeFixtureText(value, metadataAliases(aliases));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw invalidJson();
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value)
      collectAliases(
        entry,
        fixtureArrayItemContext(context, entry),
        aliases,
        knownSecrets,
        ancestors,
      );
  } else {
    collectRecordAliases(value, context, aliases, knownSecrets, ancestors);
  }
  ancestors.delete(value);
}

function collectRecordAliases(
  value: JsonObject,
  context: FixtureFieldContext,
  aliases: Aliases,
  knownSecrets: Set<string>,
  ancestors: WeakSet<object>,
): void {
  const entries = Object.entries(value);
  const optionMap = fixtureOptionMap(context, entries);
  if (optionMap?.kind === "account") {
    const nameContext = fixtureChildContext(context, "realname");
    for (const [account, label] of entries) {
      // The map's keys are accounts. A credential-shaped key still informs the rescan.
      if (isCredentialFixtureField(account)) {
        collectCredentialScalars(label, knownSecrets, ancestors);
      }
      if (account === "" || isFixtureClosedAccountOption(account, label))
        continue;
      accountOptionAlias(account, aliases);
      collectAliases(label, nameContext, aliases, knownSecrets, ancestors);
    }
    return;
  }
  for (const [key, child] of entries) {
    const canonical = fixtureKey(key);
    const dictionary = canonical.replace(/\d/gu, "");
    if (
      isRecord(child) &&
      (dictionary === "userpairs" ||
        (dictionary === "users" && isFixtureUsersDictionary(child)))
    ) {
      // Q1 dictionaries never become output. They still tell us which aliases a later field refers to.
      for (const [account, user] of Object.entries(child)) {
        if (
          dictionary === "users" &&
          account === FIXTURE_CLOSED_ACCOUNT &&
          user === "Closed"
        )
          continue;
        if (!isIdString(account)) metadataAliases(aliases).account(account);
        collectAliases(
          user,
          fixtureChildContext(context, "realname"),
          aliases,
          knownSecrets,
          ancestors,
        );
      }
    } else if (isCredentialFixtureField(key)) {
      collectCredentialScalars(child, knownSecrets, ancestors);
    } else if (
      isFixtureHeaderEnvelope(key) ||
      !isSensitiveFixtureField(key, child)
    ) {
      // Removed headers are still inspected for duplicates in fields that must preserve their type.
      if (typeof child !== "string" || optionMap === undefined) {
        collectAliases(
          child,
          fixtureChildContext(context, key),
          aliases,
          knownSecrets,
          ancestors,
        );
      }
    }
  }
}

function collectCredentialScalars(
  value: Json,
  knownSecrets: Set<string>,
  ancestors: WeakSet<object>,
): void {
  if (typeof value === "string" || typeof value === "number") {
    rememberFixtureCredential(value, knownSecrets);
  } else if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) throw invalidJson();
    ancestors.add(value);
    for (const child of Object.values<Json>(value)) {
      collectCredentialScalars(child, knownSecrets, ancestors);
    }
    ancestors.delete(value);
  }
}

function representativeTraits(value: Json): string[] {
  if (!isRecord(value)) return [];
  const traits: string[] = [];
  const { status, deleted, mode, parent, isParent } = value;
  if (typeof status === "string" && isFixtureEnum("status", status)) {
    traits.push("status:" + status.toLowerCase());
  }
  if (
    typeof deleted === "boolean" ||
    typeof deleted === "number" ||
    typeof deleted === "string"
  ) {
    traits.push("deleted:" + typeof deleted + ":" + String(deleted));
  }
  if (mode === "linear" || mode === "multi") traits.push("mode:" + mode);
  if (
    (typeof parent === "number" && parent > 0) ||
    (typeof parent === "string" && isIdString(parent) && Number(parent) > 0)
  ) {
    traits.push("child");
  }
  if (
    isParent === true ||
    isParent === 1 ||
    isParent === "1" ||
    isParent === "true"
  ) {
    traits.push("parent");
  }
  return traits;
}

function representativeList<T>(
  values: T[],
  limit: number,
  traitsFor: (value: T) => string[],
): T[] {
  if (values.length <= limit) return values;
  if (limit === 1) return values.slice(0, 1);

  const traits = values.map(traitsFor);
  const last = values.length - 1;
  const selected = new Set([0, last]);
  const covered = new Set([...(traits[0] ?? []), ...(traits[last] ?? [])]);

  // A single row can cover several new forms. Ties use the original order.
  while (selected.size < limit) {
    let bestIndex = 0;
    let bestScore = -1;
    for (const [index, candidate] of traits.entries()) {
      if (selected.has(index)) continue;
      const score = candidate.filter((trait) => !covered.has(trait)).length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    selected.add(bestIndex);
    for (const trait of traits[bestIndex] ?? []) covered.add(trait);
  }
  return values.filter((_value, index) => selected.has(index));
}

function moduleDepth(value: string): number {
  return value.split("/").filter((part) => part.trim() !== "").length;
}

function representativeModuleEntries(
  entries: [string, Json][],
  limit: number,
): [string, Json][] {
  if (entries.length <= limit) return entries;

  const selected = new Set<number>();
  const root = entries.findIndex(([key]) => key === "0");
  if (root !== -1) selected.add(root);

  // Preserve hierarchy even when most entries are siblings.
  const depths = new Set<number>();
  for (const [index, [key, value]] of entries.entries()) {
    if (selected.size === limit) break;
    if (index === root || !isIdString(key) || typeof value !== "string") {
      continue;
    }
    const depth = moduleDepth(value);
    if (depth === 0 || depths.has(depth)) continue;
    selected.add(index);
    depths.add(depth);
  }

  for (let index = 0; selected.size < limit; index++) selected.add(index);
  return entries.filter((_entry, index) => selected.has(index));
}

function sanitizeString(
  value: string,
  context: FixtureFieldContext,
  aliases: Aliases,
): string {
  if (value.trim() === "") return "";
  const { key, field, inRequiredFields } = context;
  if (!isSchemaFixtureKey(key)) {
    if (/^[+-]?1[3-9]\d{9}$/u.test(value.trim())) return FIXTURE_TEXT;
    const date = maskUnknownFixtureDate(value);
    if (date !== undefined) return date;
  }
  if (accountFields.has(field)) return metadataAliases(aliases).account(value);
  if (nameFields.has(field) && isIdString(value)) return value; // docs/06 Q6
  if (nameFields.has(field) || isFeedback(field)) {
    return mapIdentities(
      value,
      (part) =>
        (isFeedback(field) ? aliases.accounts.values.get(part) : undefined) ??
        alias(part, aliases.names),
    );
  }
  if (isFixtureRoleCode(context, value)) return value;
  if (
    (!freeTextFields.has(field) || field === "keywords") &&
    preserveFixtureString(field, value, inRequiredFields)
  ) {
    return value;
  }
  if (isUrlFixtureString(field, value)) return FIXTURE_URL;
  return sanitizeFixtureText(
    value,
    metadataAliases(aliases),
    field === "title" || field === "name",
  );
}

function sanitizeAccountOptions(
  entries: [string, Json][],
  aliases: Aliases,
  limit: number,
): SanitizedJson {
  const sentinels: [string, string][] = [];
  const accounts: string[] = [];
  for (const [key, label] of entries) {
    if (key === "") {
      sentinels.push([key, label === "" ? "" : FIXTURE_TEXT]);
    } else if (isFixtureClosedAccountOption(key, label)) {
      sentinels.push([key, "Closed"]);
    } else {
      accounts.push(key);
    }
  }
  return Object.fromEntries([
    ...sentinels.slice(0, limit),
    ...accounts
      .slice(0, Math.max(0, limit - sentinels.length))
      .map((key): [string, string] => [
        accountOptionAlias(key, aliases),
        FIXTURE_TEXT,
      ]),
  ]);
}

function sanitizeJson(
  value: Json,
  context: FixtureFieldContext,
  aliases: Aliases,
  listLimit: number,
): SanitizedJson {
  if (typeof value === "string") return sanitizeString(value, context, aliases);
  if (Array.isArray(value)) {
    return representativeList(value, listLimit, representativeTraits).map(
      (entry) =>
        sanitizeJson(
          entry,
          fixtureArrayItemContext(context, entry),
          aliases,
          listLimit,
        ),
    );
  }
  if (!isRecord(value)) return value;

  const { field } = context;
  const moduleMenu = isFixtureModuleMenu(field);
  const entries: [string, SanitizedJson][] = [];
  const rawEntries = Object.entries(value);
  const optionMap = fixtureOptionMap(context, rawEntries);
  if (optionMap?.kind === "account") {
    return sanitizeAccountOptions(rawEntries, aliases, listLimit);
  }
  let selected = rawEntries;
  if (moduleMenu) {
    selected = representativeModuleEntries(
      rawEntries.filter(([key, child]) => !isSensitiveFixtureField(key, child)),
      listLimit,
    );
  } else if (
    rawEntries.every(([key]) => isIdString(key)) &&
    rawEntries.some(([, child]) => isRecord(child))
  ) {
    selected = representativeList(rawEntries, listLimit, ([, child]) =>
      representativeTraits(child),
    );
  }
  for (const [key, child] of selected) {
    if (isSensitiveFixtureField(key, child)) continue;
    const enumKey =
      optionMap?.kind === "enum" && isFixtureEnumMapKey(optionMap, key);
    const fixedKey =
      enumKey ||
      (!optionMap?.nested &&
        (isSchemaFixtureKey(key) ||
          isIdString(key) ||
          isFixtureEnum(field, key)));
    const outputKey = fixedKey ? key : alias(key, aliases.fields);
    if (optionMap?.kind === "enum") {
      entries.push([outputKey, FIXTURE_TEXT]);
      continue;
    }
    if (moduleMenu && isIdString(key) && typeof child === "string") {
      const segments = Array<string>(moduleDepth(child)).fill(FIXTURE_TEXT);
      const path = child.trim() === "" ? "" : "/" + segments.join("/");
      entries.push([outputKey, path]);
      continue;
    }
    entries.push([
      outputKey,
      sanitizeJson(
        child,
        fixtureChildContext(context, key),
        aliases,
        listLimit,
      ),
    ]);
  }
  return Object.fromEntries(entries);
}

function readFixtureJson(input: unknown): Json {
  try {
    return jsonSchema.parse(input);
  } catch {
    throw invalidJson();
  }
}

function invalidJson(): BztError {
  return new BztError("INVALID_INPUT", "夹具输入不是可处理的 JSON。");
}

interface FixtureSanitizerOptions {
  configuredAccount?: string;
  knownSecrets?: readonly string[];
  listLimit?: number;
}

export function createFixtureSanitizer(options: FixtureSanitizerOptions = {}) {
  const limit = options.listLimit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new BztError("INVALID_INPUT", "夹具列表上限必须是正整数。");
  }

  let previous = createAliases();
  let previousSecrets = new Set(options.knownSecrets);
  const configuredAccount = options.configuredAccount?.trim().normalize("NFC");

  function sanitizeBatch(inputs: readonly unknown[]): SanitizedJson[] {
    const decoded = inputs.map(readFixtureJson);
    const aliases = createAliases(previous);
    const secrets = new Set(previousSecrets);
    const ancestors = new WeakSet<object>();
    let identities: Set<string>;
    let clean: SanitizedJson[];
    try {
      for (const entry of decoded)
        collectAliases(entry, rootFixtureContext, aliases, secrets, ancestors);
      identities = new Set([
        ...aliases.accounts.values.keys(),
        ...aliases.names.values.keys(),
        ...aliases.intake.values.keys(),
      ]);
      if (configuredAccount) identities.add(configuredAccount);
      avoidIdentityAliases(aliases.accounts, previous.accounts, identities);
      avoidIdentityAliases(aliases.names, previous.names, identities);
      avoidIdentityAliases(aliases.intake, previous.intake, identities);
      clean = decoded.map((entry) =>
        sanitizeJson(entry, rootFixtureContext, aliases, limit),
      );
    } catch {
      throw invalidJson();
    }
    assertSanitizedJson(clean, [...secrets], [...identities]);
    previous = aliases;
    previousSecrets = secrets;
    return clean;
  }

  return {
    sanitize(input: unknown): SanitizedJson {
      const [first = null] = sanitizeBatch([input]);
      return first;
    },
    sanitizeBatch,
  };
}
