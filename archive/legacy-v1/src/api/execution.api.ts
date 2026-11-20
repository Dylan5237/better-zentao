import { ZentaoApiError } from "../core/errors.js";
import type { ZentaoHttp } from "../core/http.js";
import { entityId, number, row, rows, text } from "../core/normalizer.js";
import { task, taskMember } from "./projection.js";
import { allPages, collection, hasNext, pager, projected, response, v1Page, webUrl } from "./response.js";
import type { Execution, Task } from "./types.js";

function execution(value: unknown, baseUrl: string): Execution | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id) return;
  return {
    id, name: text(entry.name), project: entityId(entry.project), projectName: text(entry.projectName),
    status: text(entry.status), begin: text(entry.begin), end: text(entry.end),
    delay: number(entry.delay), progress: number(entry.progress), totalLeft: number(entry.totalLeft),
    url: webUrl(baseUrl, "execution", id),
  };
}

export class ExecutionApi {
  constructor(private readonly http: ZentaoHttp, private readonly baseUrl: string) {}

  activeExecutions(): Promise<Execution[]> {
    return allPages(async page => {
      const data = response(await this.http.request(2, "GET", "/executions", {
        query: { recPerPage: 200, pageID: page },
      }), "执行");
      const raw = collection(data.executions, "执行");
      const items = projected(raw, entry => execution(entry, this.baseUrl));
      return {
        items: items.filter(entry => !["closed", "done", "cancel", "suspended"].includes(entry.status)),
        hasMore: hasNext(pager(data, page), page), scanned: raw.length,
      };
    });
  }

  tasks(executionId: number, status?: "undone" | "delayed"): Promise<Task[]> {
    const limit = 200;
    return allPages(async page => {
      const data = response(await this.http.request(1, "GET", "/executions/" + executionId + "/tasks", {
        query: { limit, page, status },
      }), "执行任务");
      return v1Page(data, "tasks", page, limit, entry => {
        const projected = task(entry, this.baseUrl);
        return projected && { ...projected, executionId };
      });
    });
  }

  async task(id: number): Promise<Task> {
    const data = response(await this.http.request(1, "GET", "/tasks/" + id), "任务详情");
    const entry = row(data.task ?? data);
    const result = task(entry, this.baseUrl);
    if (!result || result.id !== id) throw new ZentaoApiError("禅道返回的任务 ID 与请求不一致");
    return { ...result, team: projected(rows(entry.team ?? data.team), taskMember) };
  }
}
