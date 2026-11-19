export type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function row(value: unknown): Row {
  return isRow(value) ? value : {};
}

export function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : Object.values(row(value));
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function number(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim()))) {
    return undefined;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function integer(value: unknown): number | undefined {
  const result = number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

export function entityId(value: unknown): number | undefined {
  const id = integer(isRow(value) ? value.id : value);
  return id !== undefined && id > 0 ? id : undefined;
}

export function idList(value: unknown): number[] {
  const parts = typeof value === "string" ? value.split(",")
    : isRow(value) && "id" in value ? [value]
    : typeof value === "object" ? rows(value) : [value];
  return [...new Set(parts.map(entityId).filter((id): id is number => id !== undefined))];
}

export function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export interface UserRef {
  account: string;
  realname: string;
}

export function userRef(value: unknown): UserRef | null {
  const record = row(value);
  const account = (typeof value === "string" ? value : text(record.account)).trim();
  if (!account) return null;
  const name = text(record.realname).trim();
  return { account, realname: name && !/^\d+$/.test(name) ? name : "" };
}

export function dayNumber(value: unknown): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(text(value));
  if (!match || match[1] === "0000") return undefined;
  const date = match[1] + "-" + match[2] + "-" + match[3];
  const milliseconds = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date) return undefined;
  return milliseconds / 86_400_000;
}

export function localDate(now: Date): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map(part => String(part).padStart(2, "0")).join("-");
}
