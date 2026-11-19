import { ZentaoApiError } from "../core/errors.js";
import { integer, isRow, row, rows, text, type Row } from "../core/normalizer.js";
import type { Page, Pager } from "./types.js";

export function response(value: unknown, label: string): Row {
  if (!isRow(value)) throw new ZentaoApiError("禅道返回的" + label + "格式无效");
  const status = text(value.status ?? value.result).toLowerCase();
  if (["fail", "failed", "error"].includes(status)) throw new ZentaoApiError("禅道未能返回" + label);
  return value;
}

export function collection(value: unknown, label: string): unknown[] {
  if (value === null || Array.isArray(value) || isRow(value)) return rows(value);
  throw new ZentaoApiError("禅道返回的" + label + "列表格式无效");
}

export function projected<T>(items: unknown[], project: (item: unknown) => T | undefined): T[] {
  const result: T[] = [];
  for (const item of items) {
    const safe = project(item);
    if (safe !== undefined) result.push(safe);
  }
  return result;
}

export function v1Page<T>(data: Row, field: string, page: number, limit: number, project: (entry: unknown) => T | undefined): Page<T> {
  const items = collection(data[field], field);
  const total = integer(data.total);
  const pageSize = integer(data.limit) || limit;
  return {
    items: projected(items, project),
    scanned: items.length,
    hasMore: items.length > 0 && (total === undefined ? items.length >= pageSize : page * pageSize < total),
  };
}

export function pager(data: Row, page: number): Pager {
  const source = row(data.pager);
  return {
    pageID: integer(source.pageID) ?? page,
    pageTotal: integer(source.pageTotal) ?? page,
    recTotal: integer(source.recTotal),
    recPerPage: integer(source.recPerPage),
  };
}

export function hasNext(paging: Pager, requestedPage: number) {
  return paging.pageID === requestedPage && paging.pageTotal > requestedPage;
}

export async function allPages<T>(read: (page: number) => Promise<Page<T>>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const slice = await read(page);
    result.push(...slice.items);
    if (!slice.hasMore) return result;
  }
}

const idParameters = {
  story: "storyID", requirement: "storyID", epic: "storyID", product: "productID",
  productplan: "planID", task: "taskID", execution: "executionID",
} as const;

export function webUrl(baseUrl: string, module: keyof typeof idParameters, id: number): string {
  return baseUrl + "/index.php?m=" + module + "&f=view&" + idParameters[module] + "=" + id;
}
