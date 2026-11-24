import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getCurrentUser, listUsers } from "../api/org.ts";
import { listProductPlans } from "../api/plan.ts";
import { getProductModules, listProducts } from "../api/product.ts";
import {
  resolveContextInputSchema,
  resolveContextOutputSchema,
} from "../contracts/tools/resolve_context.ts";
import type { ResolveContextOutput } from "../contracts/tools/resolve_context.ts";
import { formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { CurrentUser, User } from "../core/dto/org.ts";
import { walkProductPlans } from "../core/dto/plan.ts";
import type { Product } from "../core/dto/product.ts";
import type { Execution } from "../core/dto/execution.ts";
import { BztError } from "../core/errors.ts";

/** 由调用方按禅道实例、账号和团队配置隔离，并负责过期。 */
export interface DirectoryCache {
  get(key: string): unknown;
  set(
    key: string,
    value: ResolveContextOutput,
    ttlMs: number,
  ): void | Promise<void>;
}

interface DirectoryOptions {
  readonly client: ZentaoReadClient;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly cache?: DirectoryCache;
}

type Context = ResolveContextOutput["data"];
type Person = Context["people"][number];
type ReadState = Pick<ResolveContextOutput, "gaps" | "truncated">;
type Rows<T> = { items: T[]; truncated: boolean };

function key(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function matchesId(input: string, id: number): boolean {
  return input === String(id);
}

function choose<T>(
  candidates: T[],
  field: string,
  input: string,
  complete = true,
  identify: (candidate: T) => unknown = (candidate) => candidate,
): T | undefined {
  if (candidates.length > 1) {
    throw new BztError("AMBIGUOUS_ENTITY", "匹配到多个候选，请选择。", {
      field,
      input,
      candidates: candidates.map(identify),
    });
  }
  if (!complete) return undefined;
  if (!candidates.length) {
    throw new BztError("NOT_FOUND", "未找到匹配对象，或没有查看权限。", {
      field,
      input,
    });
  }
  return candidates[0];
}

async function readRows<T>(
  state: ReadState,
  source: string,
  read: () => Promise<Rows<T>>,
): Promise<Rows<T>> {
  try {
    const rows = await read();
    if (rows.truncated) {
      state.truncated = true;
      state.gaps.push({ source, reason: "目录分页未读完整。" });
    }
    return rows;
  } catch (error) {
    if (!(error instanceof BztError)) throw error;
    state.gaps.push({ source, reason: `目录读取失败（${error.code}）。` });
    return { items: [], truncated: true };
  }
}

function uniqueBy<T>(
  items: Iterable<T>,
  id: (item: T) => string | number,
): T[] {
  return [...new Map(Array.from(items, (item) => [id(item), item])).values()];
}

const utcFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function isoTime(timestamp: number): string {
  const fields = Object.fromEntries(
    utcFormat.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  const { year, month, day, hour, minute, second, fractionalSecond } = fields;
  return `${year?.padStart(4, "0")}-${month}-${day}T${hour}:${minute}:${second}.${fractionalSecond}Z`;
}

function relativeMonth(input: string, current: string): string {
  const offset = { 上月: -1, 本月: 0, 下月: 1 } as const;
  if (input !== "上月" && input !== "本月" && input !== "下月") return input;
  const index =
    Number(current.slice(0, 4)) * 12 +
    Number(current.slice(5)) -
    1 +
    offset[input];
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function planQuery(input: string, month: string, current: string) {
  const match =
    /^(?:(l[23])\s+)?(本月|上月|下月|(?:\d{4}年)?(?:1[0-2]|0?[1-9])月|\d{4}-(?:0[1-9]|1[0-2]))(?:\s+(.+))?$/u.exec(
      key(input),
    );
  if (!match?.[2]) return undefined;
  const [, level, time, module] = match;
  const numeric = /^(?:(\d{4})年)?(\d{1,2})月$/u.exec(time);
  return {
    level: level === "l2" ? "L2" : "L3",
    month: numeric?.[2]
      ? `${numeric[1] ?? month.slice(0, 4)}-${numeric[2].padStart(2, "0")}`
      : relativeMonth(time, current),
    module,
  };
}

function modulePath(value: string): string {
  return key(value)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namingPattern(
  template: string,
  fields: Readonly<Record<string, string>>,
): RegExp {
  const seen = new Set<string>();
  const source = key(template)
    .split(/(\{[a-z]+\})/u)
    .map((part) => {
      const field = part.slice(1, -1);
      if (!part.startsWith("{") || !Object.hasOwn(fields, field))
        return escapeRegex(part);
      if (seen.has(field)) return `\\k<${field}>`;
      seen.add(field);
      return `(?<${field}>${fields[field]})`;
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

function executionMetadata(
  execution: Execution,
  naming: TeamConfig["naming"]["execution"],
): Pick<NonNullable<Context["execution"]>, "month" | "kind"> {
  const name = key(execution.name);
  const kinds = Object.entries(naming.kinds);
  const fields = {
    product: ".+?",
    kind: kinds.map(([, label]) => escapeRegex(key(label))).join("|"),
    yyyy: "\\d{4}",
    mm: "1[0-2]|0?[1-9]",
  };
  for (const pattern of [naming.pattern, ...naming.legacyPatterns]) {
    const match = namingPattern(pattern, fields).exec(name);
    if (!match) continue;
    const kindLabel = match.groups?.kind;
    const matchedKinds = kinds.filter(([, label]) => key(label) === kindLabel);
    const kind = matchedKinds.length === 1 ? matchedKinds[0]?.[0] : undefined;
    const month = match.groups?.mm?.padStart(2, "0");
    const year =
      match.groups?.yyyy ??
      [execution.begin, execution.end]
        .find((date) => date?.slice(5, 7) === month)
        ?.slice(0, 4);
    return {
      kind:
        kind === "dev" || kind === "design" || kind === "ui"
          ? kind
          : !kindLabel && /\bui\b/u.test(key(pattern))
            ? "ui"
            : "other",
      month: month
        ? year
          ? `${year}-${month}`
          : undefined
        : execution.begin?.slice(0, 7),
    };
  }
  return { kind: "other", month: execution.begin?.slice(0, 7) };
}

export class DirectoryService {
  constructor(private readonly options: DirectoryOptions) {}

  resolveTeam(input: string) {
    if (!input.trim())
      throw new BztError("INVALID_INPUT", "团队名称不能为空。");
    const teams = Object.entries(this.options.config.teams).map(
      ([id, { name, lead, members }]) => ({
        id,
        name,
        lead,
        members: [...members],
      }),
    );
    const exact = teams.filter(({ id }) => id === input.trim());
    return choose(
      exact.length
        ? exact
        : teams.filter(({ id, name }) =>
            [id, name].some((value) => key(value) === key(input)),
          ),
      "team",
      input,
      true,
      ({ id, name, lead }) => ({ id, name, lead }),
    );
  }

  async resolveContext(raw: unknown): Promise<ResolveContextOutput> {
    const parsed = resolveContextInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BztError(
        "INVALID_INPUT",
        "解析参数不合法，请检查字段、名称和月份格式。",
      );
    }
    const input = parsed.data;
    const { client, clock, config, cache } = this.options;
    const now = clock();
    const currentMonth = formatLocalDate(now, config.timezone).slice(0, 7);
    const month = input.month
      ? relativeMonth(input.month, currentMonth)
      : undefined;
    const filters = { ...input, ...(month ? { month } : {}) };
    const ttl =
      Math.min(
        config.cache.directoryMinutes,
        input.execution
          ? config.cache.executionMinutes
          : config.cache.directoryMinutes,
      ) * 60_000;
    const cacheKey = `resolve_context:${currentMonth}:${JSON.stringify(filters)}`;
    if (cache && ttl > 0) {
      try {
        const hit = resolveContextOutputSchema.safeParse(
          await cache.get(cacheKey),
        );
        if (hit.success && hit.data.completeness === "complete")
          return hit.data;
      } catch {
        // 缓存不可用时仍可直接读取禅道。
      }
    }

    const state: ReadState = { gaps: [] };
    const inferences: ResolveContextOutput["inferences"] = [];
    let me: Context["me"];
    try {
      me = this.identity(await getCurrentUser(client));
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      throw new BztError(error.code, "无法确认当前禅道用户。", {
        completeness: "partial",
        gaps: [{ source: "me", reason: `当前用户读取失败（${error.code}）。` }],
      });
    }

    const data: Context = { me, people: [] };
    try {
      if (input.people?.length)
        data.people = await this.people(input.people, state);

      const moduleParts = input.module?.split("/");
      const prefix =
        moduleParts && moduleParts.length > 1
          ? moduleParts[0]?.trim()
          : undefined;
      let products: Rows<Product> = { items: [], truncated: false };
      let product: Product | undefined;
      if (input.product || input.module || input.plan) {
        products = await readRows(state, "products", () =>
          listProducts(client),
        );
        products.items = uniqueBy(
          products.items.filter(({ deleted }) => !deleted),
          ({ id }) => id,
        );
      }
      const productInput =
        input.product ??
        (prefix &&
        products.items.some((item) => this.productMatches(item, key(prefix)))
          ? prefix
          : undefined);
      if (productInput) product = this.product(productInput, products);

      // 显式产品无法确认时，不扩大到全产品范围。
      const parents = product
        ? { items: [product], truncated: false }
        : productInput
          ? { items: [], truncated: true }
          : products;
      if (input.module) {
        const moduleInput =
          product && prefix && this.productMatches(product, key(prefix))
            ? (moduleParts?.slice(1).join("/") ?? input.module)
            : input.module;
        const resolved = await this.module(moduleInput, parents, state);
        if (resolved) {
          data.module = resolved.module;
          product ??= products.items.find(
            ({ id }) => id === resolved.productId,
          );
        }
      }
      if (product) data.product = this.productOutput(product);
      if (input.plan) {
        const planProducts = product
          ? { items: [product], truncated: false }
          : parents;
        data.plan = await this.plan(
          input.plan,
          planProducts,
          month ?? currentMonth,
          currentMonth,
          input.module ? (data.module?.path ?? null) : undefined,
          state,
        );
        if (!data.plan) delete data.plan;
      }
      if (input.execution && (!productInput || product)) {
        data.execution = await this.execution(
          input.execution,
          product,
          month,
          state,
        );
        if (data.execution) {
          inferences.push({
            field: "execution.kind",
            level: "inferred",
            basis: "按配置的迭代命名解析职能。",
          });
          if (data.execution.month)
            inferences.push({
              field: "execution.month",
              level: "inferred",
              basis: "按迭代名称与记录日期解析月份。",
            });
        } else delete data.execution;
      }
    } catch (error) {
      if (!(error instanceof BztError) || !state.gaps.length) throw error;
      throw new BztError(error.code, error.message, {
        ...error.details,
        ...state,
        completeness: "partial",
      });
    }
    const output = resolveContextOutputSchema.safeParse({
      ok: true,
      data,
      scope: { asOf: isoTime(now), filters },
      completeness: state.gaps.length ? "partial" : "complete",
      ...state,
      inferences,
    });
    if (!output.success) {
      throw new BztError("ZENTAO_SCHEMA_MISMATCH", "目录结果不符合工具契约。");
    }
    const result = output.data;
    if (cache && ttl > 0 && result.completeness === "complete") {
      try {
        await cache.set(cacheKey, result, ttl);
      } catch {
        // 写缓存失败不影响已确认的读取结果。
      }
    }
    return result;
  }

  private identity(user: CurrentUser | User): Context["me"] {
    const { account, realname, role } = user;
    if (!account)
      throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道用户缺少账号。");
    const roles = Object.entries(this.options.config.roles)
      .filter(([, accounts]) => accounts?.includes(account))
      .map(([role]) => role);
    if (role && !roles.includes(role)) roles.push(role);
    return { account, realname, roles };
  }

  private async people(inputs: string[], state: ReadState): Promise<Person[]> {
    const { client, config } = this.options;
    const rows = await readRows(state, "users", () => listUsers(client));
    const missingAccounts = rows.items.some(
      ({ account, deleted }) => !deleted && !account,
    );
    if (missingAccounts)
      state.gaps.push({ source: "users", reason: "部分在用用户缺少账号。" });
    const active = uniqueBy(
      rows.items.filter(({ account, deleted }) => account && !deleted),
      ({ account }) => account ?? "",
    );
    return inputs.flatMap((input) => {
      const query = key(input);
      const direct = active.filter(({ account }) => account === input);
      const aliases = Object.entries(config.aliases)
        .filter(([alias]) => key(alias) === query)
        .map(([, account]) => account);
      const accounts = direct.length
        ? direct
        : active.filter(({ account }) => account && aliases.includes(account));
      const candidates =
        direct.length || aliases.length
          ? accounts
          : active.filter(
              ({ account, realname, pinyin }) =>
                (account && key(account) === query) ||
                key(realname) === query ||
                (pinyin &&
                  key(pinyin).replace(/\s+/gu, "") ===
                    query.replace(/\s+/gu, "")),
            );
      const person = choose(
        candidates.map((user) => {
          const identity = this.identity(user);
          const teams = Object.entries(config.teams).filter(
            ([, { lead, members }]) =>
              lead === identity.account || members.includes(identity.account),
          );
          const team = teams.length === 1 ? teams[0]?.[0] : undefined;
          return { input, ...identity, ...(team ? { team } : {}) };
        }),
        "people",
        input,
        (!rows.truncated && !missingAccounts) ||
          direct.length > 0 ||
          (new Set(aliases).size === 1 && accounts.length > 0),
      );
      return person ? [person] : [];
    });
  }

  private productMatches(product: Product, query: string): boolean {
    const configured = this.options.config.products[product.id];
    return (
      matchesId(query, product.id) ||
      [product.name, configured?.name].some(
        (name) => name !== undefined && key(name) === query,
      )
    );
  }

  private productOutput({
    id,
    name,
  }: Product): NonNullable<Context["product"]> {
    return {
      id,
      name,
      state: this.options.config.products[id]?.state ?? "other",
    };
  }

  private product(input: string, rows: Rows<Product>): Product | undefined {
    const query = key(input);
    const ids = rows.items.filter(({ id }) => matchesId(query, id));
    return choose(
      ids.length
        ? ids
        : rows.items.filter((product) => this.productMatches(product, query)),
      "product",
      input,
      !rows.truncated || ids.length > 0,
      (product) => this.productOutput(product),
    );
  }

  private async module(
    input: string,
    parents: Rows<Product>,
    state: ReadState,
  ) {
    const query = modulePath(input);
    const fullPath = key(input).startsWith("/") || query.includes("/");
    const perProduct = await Promise.all(
      parents.items.map(async ({ id }) =>
        readRows(state, `modules:${id}`, async () => ({
          items: await getProductModules(this.options.client, id),
          truncated: false,
        })),
      ),
    );
    const modules = uniqueBy(
      perProduct.flatMap(({ items }) => items.filter(({ id }) => id !== 0)),
      ({ productId, id }) => `${productId}:${id}`,
    );
    const ids = modules.filter(({ id }) => matchesId(query, id));
    const { modules: configModules, moduleDefaults } = this.options.config;
    const candidates = ids.length
      ? ids
      : modules.filter(({ productId, id, name }) => {
          const path = modulePath(name);
          return (
            path === query ||
            (!fullPath &&
              (path.split("/").at(-1) === query ||
                modulePath(configModules[`${productId}:${id}`]?.name ?? "") ===
                  query))
          );
        });
    const match = choose(
      candidates,
      "module",
      input,
      !parents.truncated && perProduct.every(({ truncated }) => !truncated),
      ({ id, name, productId }) => ({ id, path: name, productId }),
    );
    if (!match) return undefined;
    const { id, productId, name: path } = match;
    const config = configModules[`${productId}:${id}`];
    const defaults = moduleDefaults[productId];
    const designLead = config?.designLead ?? defaults?.designLead;
    const devLead = config?.devLead ?? defaults?.devLead;
    const testLead = config?.testLead ?? defaults?.testLead;
    return {
      productId,
      module: {
        id,
        path,
        ...(designLead ? { designLead } : {}),
        ...(devLead ? { devLead } : {}),
        ...(testLead ? { testLead } : {}),
      },
    };
  }

  private async plan(
    input: string,
    parents: Rows<Product>,
    month: string,
    current: string,
    path: string | null | undefined,
    state: ReadState,
  ) {
    const perProduct = await Promise.all(
      parents.items.map(async ({ id }) =>
        readRows(state, `plans:${id}`, () =>
          listProductPlans(this.options.client, id),
        ),
      ),
    );
    const plans = uniqueBy(
      perProduct.flatMap(({ items }) =>
        [...walkProductPlans(items)].filter(({ deleted }) => !deleted),
      ),
      ({ id }) => id,
    );
    const query = key(input);
    const ids = plans.filter(({ id }) => matchesId(query, id));
    const titles = plans.filter(({ title }) => key(title) === query);
    const search = planQuery(input, month, current);
    if (
      !ids.length &&
      !titles.length &&
      search?.level === "L3" &&
      !search.module &&
      path === null
    )
      return undefined;
    const label =
      search?.module ??
      (search?.level === "L3" && path
        ? modulePath(path).split("/").at(-1)
        : undefined);
    const l3Name = label
      ? namingPattern(this.options.config.naming.l3Plan.pattern, {
          owner: ".+?",
          module: ".+?",
          yyyy: "\\d{4}",
          mm: "1[0-2]|0?[1-9]",
        })
      : undefined;
    const matchesModule = (title: string) => {
      if (!label) return true;
      const name = key(title);
      const module = l3Name?.exec(name)?.groups?.module;
      return key(module ?? name) === key(label);
    };
    const level = (parent: number | null): "L2" | "L3" =>
      parent === -1 || parent === null ? "L2" : "L3";
    const dateMatch = (begin: string | null, end: string | null) =>
      search &&
      begin &&
      end &&
      begin.slice(0, 7) <= search.month &&
      search.month <= end.slice(0, 7);
    const matches = ids.length
      ? ids
      : titles.length
        ? titles
        : plans.filter(
            (plan) =>
              search &&
              level(plan.parent) === search.level &&
              dateMatch(plan.begin, plan.end) &&
              matchesModule(plan.title),
          );
    const incompleteDates =
      !!search &&
      !ids.length &&
      !titles.length &&
      plans.some(
        (plan) =>
          level(plan.parent) === search.level &&
          matchesModule(plan.title) &&
          (!plan.begin || !plan.end),
      );
    if (incompleteDates)
      state.gaps.push({
        source: "plans",
        reason: "候选计划缺少日期，无法确认月份范围。",
      });
    const match = choose(
      matches,
      "plan",
      input,
      ids.length > 0 ||
        (!parents.truncated &&
          !incompleteDates &&
          perProduct.every(({ truncated }) => !truncated)),
      ({ id, product, title, begin, end, parent }) => ({
        id,
        productId: product,
        title,
        begin,
        end,
        level: level(parent),
      }),
    );
    if (!match) return undefined;
    if (!match.begin || !match.end) {
      state.gaps.push({
        source: `plans:${match.product}`,
        reason: "匹配的计划缺少起止日期。",
      });
      return undefined;
    }
    return {
      id: match.id,
      title: match.title,
      begin: match.begin,
      end: match.end,
      level: level(match.parent),
    };
  }

  private async execution(
    input: string,
    product: Product | undefined,
    month: string | undefined,
    state: ReadState,
  ) {
    const { client, config } = this.options;
    const projects = product
      ? config.products[product.id]?.projects
      : undefined;
    if (product && !projects?.length) {
      state.gaps.push({
        source: "executions",
        reason: "产品未配置关联项目，无法确认迭代归属。",
      });
      return undefined;
    }
    const rows = await readRows(state, "executions", () =>
      listExecutionsIncludingClosed(client),
    );
    const query = key(input);
    const executions = uniqueBy(
      rows.items.filter(
        ({ project }) => !projects || projects.includes(project),
      ),
      ({ id }) => id,
    );
    const ids = executions.filter(({ id }) => matchesId(query, id));
    const matches = (
      ids.length ? ids : executions.filter(({ name }) => key(name) === query)
    ).map((item) => {
      const { kind, month } = executionMetadata(item, config.naming.execution);
      return {
        id: item.id,
        name: item.name,
        kind,
        ...(month ? { month } : {}),
      };
    });
    const missingMonth =
      month !== undefined && matches.some((match) => !match.month);
    if (missingMonth)
      state.gaps.push({
        source: "executions",
        reason: "候选迭代缺少可确认的月份。",
      });
    return choose(
      matches.filter((item) => !month || month === item.month),
      "execution",
      input,
      !missingMonth && (!rows.truncated || ids.length > 0),
    );
  }
}
