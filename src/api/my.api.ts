import type { ZentaoHttp } from "../core/http.js";
import { entityId, integer, row, text } from "../core/normalizer.js";
import { story, task } from "./projection.js";
import { collection, hasNext, pager, projected, response } from "./response.js";
import { MY_TODO_CATEGORIES, type MyPage, type Story, type Task, type Todo, type TodoBreakdown } from "./types.js";

function count(value: unknown): number | undefined {
  const number = integer(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function parseTodoCounts(value: unknown): { todoCount?: number; todoBreakdown?: TodoBreakdown } {
  const source = row(value);
  const breakdown: TodoBreakdown = {};
  let total: number | undefined;
  for (const key of MY_TODO_CATEGORIES) {
    const amount = count(source[key]);
    if (amount === undefined) continue;
    breakdown[key] = amount;
    total = (total ?? 0) + amount;
  }
  return total === undefined ? { todoCount: count(value) ?? count(source.todo) } : { todoCount: total, todoBreakdown: breakdown };
}

export class MyApi {
  constructor(private readonly http: ZentaoHttp, private readonly baseUrl: string) {}

  assignedTasks(): Promise<MyPage<Task>> {
    return this.read("/my/work", { mode: "task", browseType: "assignedTo" },
      "tasks", entry => task(entry, this.baseUrl));
  }

  assignedStories(): Promise<MyPage<Story>> {
    return this.read("/my/work", { mode: "story", browseType: "assignedTo" },
      "stories", entry => story(entry, this.baseUrl));
  }

  openedStories(): Promise<MyPage<Story>> {
    return this.read("/my/contribute", { mode: "story", browseType: "openedBy" },
      "stories", entry => story(entry, this.baseUrl));
  }

  todos(): Promise<MyPage<Todo>> {
    return this.read("/my/todo", {}, "todos", value => {
      const entry = row(value);
      const id = entityId(entry);
      if (!id) return;
      return { id, name: text(entry.name), status: text(entry.status), date: text(entry.date) };
    });
  }

  private async read<T>(
    endpoint: string, query: Record<string, string>, key: string, projector: (entry: unknown) => T | undefined,
  ): Promise<MyPage<T>> {
    let result: MyPage<T> | undefined;
    for (let page = 1; ; page++) {
      const data = response(await this.http.request(2, "GET", endpoint, {
        query: { ...query, recPerPage: 200, pageID: page },
      }), "个人工作");
      const paging = pager(data, page);
      const items = projected(collection(data[key] ?? {}, "个人工作"), projector);
      const counts = parseTodoCounts(data.todoCount);
      const todoCount = counts.todoCount ??
        (endpoint === "/my/todo" ? (count(data.waitCount) ?? 0) + (count(data.doingCount) ?? 0) : undefined);
      result ??= { items: [], pager: paging, todoCount, todoBreakdown: counts.todoBreakdown };
      result.items.push(...items);
      if (!hasNext(paging, page)) return result;
    }
  }
}
