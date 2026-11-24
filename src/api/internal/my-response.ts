import {
  myPageDtoFor,
  type MyContributeQuery,
  type MyWorkQuery,
  type TodoCount,
} from "../../core/dto/my.ts";
import { BztError } from "../../core/errors.ts";
import type { ZentaoReadClient } from "../client.ts";
import { paginate } from "./paginate.ts";
import { getReadClient } from "./read-client.ts";

const myPaths = {
  work: "/api.php/v2/my/work",
  contribute: "/api.php/v2/my/contribute",
} as const;

export async function readMyPage(
  client: ZentaoReadClient,
  endpoint: keyof typeof myPaths,
  query: MyWorkQuery | MyContributeQuery,
) {
  const { http, timezone } = getReadClient(client);
  const firstPage: { todoCount?: TodoCount } = {};
  const schema = myPageDtoFor(query.mode, timezone).transform((page) => {
    // 后续页只补集合，待办汇总保留第一页的快照。
    firstPage.todoCount ??= page.todoCount;
    return page;
  });
  const result = await paginate(
    http,
    {
      pathTemplate: myPaths[endpoint],
      query,
      schemaFields: ["tasks", "bugs", "stories", "pager", "todoCount"],
    },
    { mode: "v2", pageSize: 100, schema },
  );
  if (firstPage.todoCount === undefined) {
    throw new BztError(
      "ZENTAO_SCHEMA_MISMATCH",
      "禅道个人工作列表缺少待办汇总。",
    );
  }
  return { ...result, todoCount: firstPage.todoCount };
}
