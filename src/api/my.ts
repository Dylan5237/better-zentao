import {
  myContributeQuery,
  myPageDtoFor,
  myWorkQuery,
  toMyContributePage,
  toMyWorkPage,
  type MyContributePage,
  type MyContributeQuery,
  type MyWorkPage,
  type MyWorkQuery,
} from "../core/dto/my.ts";
import { BztError } from "../core/errors.ts";
import type { ZentaoReadClient } from "./client.ts";
import { readMyPage } from "./internal/my-response.ts";
import { getReadClient } from "./internal/read-client.ts";

/** One page per mode. This is a change hint, not a full work report. */
export async function sampleMyActivity(client: ZentaoReadClient) {
  const { http, timezone } = getReadClient(client);
  return Promise.all(
    (["task", "story"] as const).map(async (mode) => {
      const page = await http.read(
        {
          pathTemplate: "/api.php/v2/my/work",
          query: { mode, browseType: "assignedTo", pageID: 1, recPerPage: 8 },
          schemaFields: ["tasks", "stories", "pager", "todoCount"],
        },
        myPageDtoFor(mode, timezone),
      );
      return {
        mode,
        total: page.total,
        counts: page.todoCount,
        items: page.items
          .slice(0, 8)
          .sort((a, b) => a.id - b.id)
          .map((item) => [
            item.id,
            item.status,
            item.assignedTo,
            item.assignedDate,
            "lastEditedDate" in item ? item.lastEditedDate : undefined,
            "deadline" in item ? item.deadline : undefined,
          ]),
      };
    }),
  );
}

export async function listMyWork(
  client: ZentaoReadClient,
  query: MyWorkQuery,
): Promise<MyWorkPage> {
  const parsed = myWorkQuery.safeParse(query);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "待办查询参数不合法。");
  return toMyWorkPage(await readMyPage(client, "work", parsed.data));
}

export async function listMyContributions(
  client: ZentaoReadClient,
  query: MyContributeQuery,
): Promise<MyContributePage> {
  const parsed = myContributeQuery.safeParse(query);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "贡献查询参数不合法。");
  return toMyContributePage(
    await readMyPage(client, "contribute", parsed.data),
  );
}
