import { ZentaoApiError } from "../core/errors.js";
import type { ZentaoHttp } from "../core/http.js";
import { dayNumber, entityId, flag, integer, row, rows, text } from "../core/normalizer.js";
import { allPages, collection, projected, response, v1Page, webUrl } from "./response.js";
import { STORY_WRITE_CATEGORIES, type Module, type Plan, type Product } from "./types.js";

const storySources = [
  "", "customer", "user", "po", "market", "service", "operation", "support",
  "competitor", "partner", "dev", "tester", "bug", "forum", "other", "ai",
];

function product(value: unknown, baseUrl: string): Product | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id || flag(entry.deleted)) return;
  return { id, name: text(entry.name), code: text(entry.code), status: text(entry.status), url: webUrl(baseUrl, "product", id) };
}

function moduleOption(value: unknown): Module | undefined {
  const entry = row(value);
  const id = integer(entry.id);
  const label = text(entry.name).trim();
  const path = label.replace(/^\/+/, "") || (id === 0 && label ? label : "");
  if (id === undefined || id < 0 || !path) return;
  const name = path.split("/").at(-1)?.trim() || path;
  return { id, name, path };
}

function flattenPlans(items: unknown[], productId: number, baseUrl: string): Plan[] {
  const source = new Map<number, { entry: ReturnType<typeof row>; parent?: number }>();
  function visit(value: unknown, parent?: number) {
    const entry = row(value);
    const id = entityId(entry);
    if (!id || flag(entry.deleted)) return;
    const previous = source.get(id);
    source.set(id, { entry, parent: parent ?? previous?.parent ?? entityId(entry.parent) });
    for (const child of rows(entry.children)) visit(child, id);
  }
  items.forEach(item => visit(item));
  const parentIds = new Set([...source.values()].map(item => item.parent));
  return [...source.entries()].map(([id, item]) => {
    const { entry, parent } = item;
    const title = text(entry.title);
    return {
      id, title, productId, parentId: parent, parentTitle: parent ? text(source.get(parent)?.entry.title) || undefined : undefined,
      level: parent ? "L3" : integer(entry.parent) === -1 || parentIds.has(id) ? "L2" : "standalone",
      ownerHint: /【([^】]+)】/.exec(title)?.[1], begin: text(entry.begin), end: text(entry.end),
      status: text(entry.status), url: webUrl(baseUrl, "productplan", id),
    };
  });
}

export function planMatchesMonth(plan: Plan, month: string): boolean {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return false;
  const [year, monthNumber] = month.split("-").map(Number);
  const begin = dayNumber(plan.begin);
  const end = dayNumber(plan.end);
  if (begin !== undefined && end !== undefined && begin <= end) {
    const start = dayNumber(month + "-01");
    if (start === undefined) return false;
    const next = new Date(start * 86_400_000);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return end >= start && begin < next.getTime() / 86_400_000;
  }
  const mentions = [
    ...plan.title.matchAll(/(?<!\d)(?:(\d{4})\s*年\s*)?(0?[1-9]|1[0-2])\s*月/g),
    ...plan.title.matchAll(/(?<!\d)(\d{4})[-/.](0?[1-9]|1[0-2])(?!\d)/g),
  ];
  return mentions.some(([, yearText, monthText]) =>
    Number(monthText) === monthNumber && (yearText === undefined || Number(yearText) === year));
}

export class ProductApi {
  constructor(private readonly http: ZentaoHttp, private readonly baseUrl: string) {}

  products(): Promise<Product[]> {
    const limit = 100;
    return allPages(async page => {
      const data = response(await this.http.request(1, "GET", "/products", { query: { page, limit } }), "产品");
      return v1Page(data, "products", page, limit, entry => product(entry, this.baseUrl));
    });
  }

  async modules(productId: number): Promise<Module[]> {
    const data = response(await this.http.request(1, "GET", "/products/" + productId, {
      query: { fields: "moduleOptionMenu" },
    }), "产品模块");
    if (data.id !== undefined && entityId(data) !== productId) throw new ZentaoApiError("禅道返回的产品模块与目标产品不一致");
    return projected(collection(data.moduleOptionMenu, "产品模块"), moduleOption);
  }

  async plans(productId: number): Promise<Plan[]> {
    const limit = 200;
    const raw = await allPages(async page => {
      const data = response(await this.http.request(1, "GET", "/products/" + productId + "/plans",
        { query: { page, limit } }), "产品计划");
      return v1Page(data, "plans", page, limit, entry => row(entry));
    });
    return flattenPlans(raw, productId, this.baseUrl);
  }

  async storyCreateMetadata(productId: number) {
    const data = response(await this.http.request(2, "GET", "/story/create", { query: { productID: productId } }), "创建表单");
    const fields = row(data.fields);
    return {
      forceReview: flag(data.forceReview), needReview: flag(data.needReview), needNotReview: flag(data.needNotReview),
      categoryOptions: STORY_WRITE_CATEGORIES.filter(category => Object.hasOwn(row(row(fields.category).options), category)),
      sourceOptions: storySources.filter(source => Object.hasOwn(row(row(fields.source).options), source)),
    };
  }
}
