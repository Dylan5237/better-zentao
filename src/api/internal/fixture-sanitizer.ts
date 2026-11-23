import { z } from "zod";
import type { SanitizedJson } from "../../core/dto/fixture.ts";
import { BztError } from "../../core/errors.ts";
import {
  accountFields,
  freeTextFields,
  isFixtureEnum,
  isIdString,
  isSchemaFixtureKey,
  isUrlFixtureString,
  nameFields,
  preserveFixtureString,
} from "./fixture-fields.ts";
import {
  assertSanitizedJson,
  FIXTURE_URL,
  fixtureKey,
  isCredentialFixtureField,
  isFixtureHeaderEnvelope,
  isSensitiveFixtureField,
  rememberFixtureCredential,
} from "./fixture-sensitivity.ts";
import { sanitizeFixtureText } from "./fixture-text.ts";

export { assertSanitizedJson } from "./fixture-sensitivity.ts";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
type JsonObject = { [key: string]: Json };
const formEntities = new Set([
  "story",
  "requirement",
  "epic",
  "task",
  "bug",
  "product",
  "project",
  "execution",
  "release",
]);

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
    .split(/(\s*[,;、，；|]\s*)/u)
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
      mapIdentities(value, (part) => alias(part, aliases.accounts)),
    intake: (value: string) =>
      value === "" ? "" : alias(value, aliases.intake),
  };
}

function isFeedback(field: string): boolean {
  return field === "feedbackby" || field === "feedbackbytext";
}

function collectAliases(
  value: Json,
  field: string,
  aliases: Aliases,
  knownSecrets: Set<string>,
  ancestors: WeakSet<object>,
): void {
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
      collectAliases(entry, field, aliases, knownSecrets, ancestors);
  } else {
    collectRecordAliases(value, aliases, knownSecrets, ancestors);
  }
  ancestors.delete(value);
}

function collectRecordAliases(
  value: JsonObject,
  aliases: Aliases,
  knownSecrets: Set<string>,
  ancestors: WeakSet<object>,
): void {
  for (const [key, child] of Object.entries(value)) {
    const canonical = fixtureKey(key);
    if (
      (canonical === "users" || canonical === "userpairs") &&
      isRecord(child)
    ) {
      // Q1 dictionaries never become output. They still tell us which aliases a later field refers to.
      for (const [account, user] of Object.entries(child)) {
        if (!isIdString(account)) metadataAliases(aliases).account(account);
        collectAliases(user, "realname", aliases, knownSecrets, ancestors);
      }
    } else if (isCredentialFixtureField(key)) {
      collectCredentialScalars(child, knownSecrets, ancestors);
    } else if (
      isFixtureHeaderEnvelope(key) ||
      !isSensitiveFixtureField(key, child)
    ) {
      // Removed headers are still inspected for duplicates in fields that must preserve their type.
      collectAliases(child, canonical, aliases, knownSecrets, ancestors);
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

function sanitizeString(
  value: string,
  field: string,
  inRequiredFields: boolean,
  aliases: Aliases,
): string {
  if (value.trim() === "") return "";
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

function sanitizeJson(
  value: Json,
  field: string,
  inRequiredFields: boolean,
  aliases: Aliases,
  listLimit: number,
): SanitizedJson {
  if (typeof value === "string")
    return sanitizeString(value, field, inRequiredFields, aliases);
  if (Array.isArray(value)) {
    return representativeList(value, listLimit, representativeTraits).map(
      (entry) =>
        sanitizeJson(entry, field, inRequiredFields, aliases, listLimit),
    );
  }
  if (!isRecord(value)) return value;

  const entries: [string, SanitizedJson][] = [];
  const insideFieldDefinitions = inRequiredFields || field === "requiredfields";
  const rawEntries = Object.entries(value);
  const selected =
    rawEntries.every(([key]) => isIdString(key)) &&
    rawEntries.some(([, child]) => isRecord(child))
      ? representativeList(rawEntries, listLimit, ([, child]) =>
          representativeTraits(child),
        )
      : rawEntries;
  for (const [key, child] of selected) {
    if (isSensitiveFixtureField(key, child)) continue;
    const canonical = fixtureKey(key);
    const isFieldDefinition =
      insideFieldDefinitions ||
      (formEntities.has(field) &&
        (canonical === "create" || canonical === "edit"));
    const outputKey =
      isSchemaFixtureKey(key) || isIdString(key) || isFixtureEnum(field, key)
        ? key
        : alias(key, aliases.fields);
    entries.push([
      outputKey,
      sanitizeJson(child, canonical, isFieldDefinition, aliases, listLimit),
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

  function sanitizeBatch(inputs: readonly unknown[]): SanitizedJson[] {
    const decoded = inputs.map(readFixtureJson);
    const aliases = createAliases(previous);
    const secrets = new Set(previousSecrets);
    const ancestors = new WeakSet<object>();
    let identities: Set<string>;
    let clean: SanitizedJson[];
    try {
      for (const entry of decoded)
        collectAliases(entry, "", aliases, secrets, ancestors);
      identities = new Set([
        ...aliases.accounts.values.keys(),
        ...aliases.names.values.keys(),
        ...aliases.intake.values.keys(),
      ]);
      avoidIdentityAliases(aliases.accounts, previous.accounts, identities);
      avoidIdentityAliases(aliases.names, previous.names, identities);
      avoidIdentityAliases(aliases.intake, previous.intake, identities);
      clean = decoded.map((entry) =>
        sanitizeJson(entry, "", false, aliases, limit),
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
