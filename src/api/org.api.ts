import { ZentaoApiError } from "../core/errors.js";
import type { ZentaoHttp } from "../core/http.js";
import { entityId, flag, integer, row, rows, text } from "../core/normalizer.js";
import { allPages, collection, hasNext, pager, projected, response } from "./response.js";
import type { Department, User } from "./types.js";

function user(value: unknown): User | undefined {
  const entry = row(value);
  const account = text(entry.account).trim();
  if (!account || flag(entry.deleted)) return;
  const realname = text(entry.realname).trim();
  const role = typeof entry.role === "string" ? entry.role : text(row(entry.role).code);
  return {
    id: entityId(entry), account, realname: /^\d+$/.test(realname) ? "" : realname,
    dept: integer(entry.dept) ?? 0, role: role.trim(), pinyin: text(entry.pinyin), deleted: 0,
  };
}

function department(value: unknown): Department | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id) return;
  return { id, name: text(entry.name), parent: integer(entry.parent) ?? 0, items: projected(rows(entry.items), department) };
}

export class OrgApi {
  constructor(private readonly http: ZentaoHttp) {}

  async self(): Promise<User> {
    const data = response(await this.http.request(1, "GET", "/user"), "当前用户");
    const result = user(data.profile);
    if (!result) throw new ZentaoApiError("禅道当前用户缺少有效账号");
    return result;
  }

  async departments(): Promise<Department[]> {
    const data = await this.http.request(1, "GET", "/departments");
    const entries = Array.isArray(data) ? data : response(data, "部门").departments;
    return projected(collection(entries, "部门"), department);
  }

  users(): Promise<User[]> {
    return this.readUsers("/users", { recPerPage: 3000 });
  }

  usersByDepartment(deptId: number): Promise<User[]> {
    return this.readUsers("/company/browse", { param: deptId, type: "bydept", recPerPage: 500 });
  }

  private readUsers(endpoint: string, query: Record<string, string | number>): Promise<User[]> {
    return allPages(async page => {
      const data = response(await this.http.request(2, "GET", endpoint, { query: { ...query, pageID: page } }), "用户");
      const raw = collection(data.users, "用户");
      return { items: projected(raw, user), scanned: raw.length, hasMore: hasNext(pager(data, page), page) };
    });
  }
}
