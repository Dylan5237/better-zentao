import type { ExecutionApi } from "../api/execution.api.js";
import type { OrgApi } from "../api/org.api.js";
import { planMatchesMonth, type ProductApi } from "../api/product.api.js";
import type { Department, Execution, Module, Plan, Product, User } from "../api/types.js";
import type { BetterZentaoConfig } from "../core/config.js";
import { InvalidParamError } from "../core/errors.js";
import { kinds, type Kind, type ResolveInput, type State } from "./inputs.js";

export interface DepartmentEntry {
  id: number;
  name: string;
  parent: number;
  path: string;
  ancestorIds: number[];
}

export interface UserEntry extends User {
  deptName: string;
  departmentPath: string;
}

export interface Match<T> {
  match: "exact" | "fuzzy" | null;
  ambiguous: boolean;
  candidates: T[];
}

class TtlCache<K, V> {
  private readonly entries = new Map<K, { expires: number; promise: Promise<V> }>();

  constructor(private readonly ttl: number, private readonly now: () => Date) {}

  get(key: K, load: () => Promise<V>) {
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now().getTime()) return cached.promise;
    const entry = {
      expires: Infinity,
      promise: load().then(value => {
        entry.expires = this.now().getTime() + this.ttl;
        return value;
      }).catch((error: unknown) => {
        this.entries.delete(key);
        throw error;
      }),
    };
    this.entries.set(key, entry);
    return entry.promise;
  }
}

export function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function matches<T>(items: T[], query: string, keys: (item: T) => string[]): Match<T> {
  const value = normalized(query);
  if (!value) return { match: null, ambiguous: false, candidates: [] };
  const exact = items.filter(item => keys(item).some(key => normalized(key) === value));
  const candidates = exact.length ? exact : items.filter(item => keys(item).some(key => normalized(key).includes(value)));
  return { match: exact.length ? "exact" : candidates.length ? "fuzzy" : null, ambiguous: candidates.length > 1, candidates };
}

function referenceMatches<T extends { id: number }>(items: T[], query: string | number, keys: (item: T) => string[]): Match<T> {
  const ref = normalized(String(query));
  if (!/^#?\d+$/.test(ref)) return matches(items, ref, keys);
  const candidates = items.filter(item => item.id === Number(ref.replace(/^#/, "")));
  return { match: candidates.length ? "exact" : null, ambiguous: candidates.length > 1, candidates };
}

function flattenDepartments(root: Department[]): DepartmentEntry[] {
  const result: DepartmentEntry[] = [];
  function visit(items: Department[], parents: DepartmentEntry[] = []) {
    for (const item of items) {
      const { id, name, parent } = item;
      const path = [...parents.map(entry => entry.name), name].join(" / ");
      const entry = { id, name, parent, path, ancestorIds: parents.map(entry => entry.id) };
      result.push(entry);
      visit(item.items, [...parents, entry]);
    }
  }
  visit(root);
  return result;
}

export class DirectoryService {
  private readonly userCache: TtlCache<string, UserEntry[]>;
  private readonly departmentCache: TtlCache<string, DepartmentEntry[]>;
  private readonly productCache: TtlCache<string, Product[]>;
  private readonly moduleCache: TtlCache<number, Module[]>;
  private readonly planCache: TtlCache<number, Plan[]>;
  private readonly executionCache: TtlCache<string, Execution[]>;

  constructor(
    private readonly org: OrgApi,
    private readonly product: ProductApi,
    private readonly execution: ExecutionApi,
    private readonly config: Pick<BetterZentaoConfig, "cacheTtlMs" | "defaults" | "productId">,
    now: () => Date = () => new Date(),
  ) {
    const ttl = config.cacheTtlMs;
    this.userCache = new TtlCache(ttl, now);
    this.departmentCache = new TtlCache(ttl, now);
    this.productCache = new TtlCache(ttl, now);
    this.moduleCache = new TtlCache(ttl, now);
    this.planCache = new TtlCache(ttl, now);
    this.executionCache = new TtlCache(ttl, now);
  }

  departments() {
    return this.departmentCache.get("all", async () => flattenDepartments(await this.org.departments()));
  }

  users() {
    return this.userCache.get("all", async () => {
      const [users, departments] = await Promise.all([this.org.users(), this.departments()]);
      const departmentIndex = new Map(departments.map(entry => [entry.id, entry]));
      return [...new Map(users.map(user => {
        const department = departmentIndex.get(user.dept);
        const entry = { ...user, deptName: department?.name ?? "", departmentPath: department?.path ?? "" };
        return [user.account, entry];
      })).values()];
    });
  }

  async currentUser() {
    const [user, departments] = await Promise.all([this.org.self(), this.departments()]);
    const department = departments.find(item => item.id === user.dept);
    return { ...user, deptName: department?.name ?? "", departmentPath: department?.path ?? "" };
  }

  products() {
    return this.productCache.get("all", () => this.product.products());
  }

  modules(productId: number) {
    return this.moduleCache.get(productId, () => this.product.modules(productId));
  }

  plans(productId: number) {
    return this.planCache.get(productId, () => this.product.plans(productId));
  }

  executions() {
    return this.executionCache.get("all", () => this.execution.activeExecutions());
  }

  async findUser(query: string) {
    const users = await this.users();
    const account = users.filter(item => normalized(item.account) === normalized(query));
    return account.length ? { match: "exact" as const, ambiguous: account.length > 1, candidates: account }
      : matches(users, query, item => [item.account, item.realname, item.pinyin]);
  }

  async findDepartment(query: string | number) {
    return referenceMatches(await this.departments(), query, item => [item.name, item.path]);
  }

  async membersOf(departmentId: number) {
    const [departments, users] = await Promise.all([this.departments(), this.users()]);
    const ids = new Set(departments.filter(item => item.ancestorIds.includes(departmentId)).map(item => item.id));
    ids.add(departmentId);
    return users.filter(user => ids.has(user.dept));
  }

  async findProduct(query: string | number) {
    return referenceMatches(await this.products(), query, item => [item.name, item.code]);
  }

  stateProductId(state: State) {
    return this.config.defaults[state + "ProductId" as "designProductId" | "runtimeProductId" | "deliveryProductId"];
  }

  async chooseProduct(selection: { product?: string | number; state?: State } = {}): Promise<Product> {
    const { product, state } = selection;
    if (product !== undefined && state !== undefined) throw new InvalidParamError("请在 product 和 state 中指定一种产品定位方式");
    const ref = product ?? (state ? this.stateProductId(state) : this.config.productId ?? this.stateProductId("design"));
    const match = await this.findProduct(ref);
    if (match.ambiguous) throw new InvalidParamError("产品存在多个候选，请用 resolve_context 查看并指定产品 ID");
    if (!match.candidates[0]) throw new InvalidParamError("找不到可访问的目标产品，请核对产品 ID 或名称");
    return match.candidates[0];
  }

  findModule(query: string | number, modules: Module[]) {
    return referenceMatches(modules, query, item => [item.name, item.path]);
  }

  async findPlan(productId: number, query: string | number) {
    const plans = await this.plans(productId);
    if (typeof query === "string" && /^\d{4}-\d{2}$/.test(query)) {
      const candidates = plans.filter(plan => planMatchesMonth(plan, query));
      return { match: candidates.length ? "fuzzy" as const : null, ambiguous: candidates.length > 1, candidates };
    }
    return referenceMatches(plans, query, item => [item.title, item.ownerHint ?? ""]);
  }

  async activeL3Plans(productId: number) {
    return (await this.plans(productId)).filter(plan => plan.level === "L3" &&
      !["closed", "done", "finished", "cancel"].includes(plan.status));
  }

  async resolveContext({ query, kinds: requested = [...kinds], product }: ResolveInput) {
    const selected = [...new Set(requested)];
    const scope = selected.some(kind => kind === "module" || kind === "plan")
      ? this.chooseProduct({ product }) : undefined;
    const byKind = {
      user: () => this.findUser(query),
      department: () => this.findDepartment(query),
      product: async () => {
        const found = await this.findProduct(query);
        const candidates = await Promise.all(found.candidates.map(async product => {
          const [modules, activeL3Plans] = await Promise.all([this.modules(product.id), this.activeL3Plans(product.id)]);
          return { ...product, moduleSummary: { count: modules.length, modules }, activeL3Plans };
        }));
        return { ...found, candidates };
      },
      module: async () => this.findModule(query, await this.modules((await scope!).id)),
      plan: async () => this.findPlan((await scope!).id, query),
      execution: async () => referenceMatches(await this.executions(), query, item => [item.name, item.projectName]),
    };
    const entries = await Promise.all(selected.map(async kind => [kind, await byKind[kind]()] as const));
    const results: Partial<Record<Kind, Match<unknown>>> = Object.fromEntries(entries);
    return { query, ambiguous: entries.some(([, match]) => match.ambiguous), matches: results };
  }
}
