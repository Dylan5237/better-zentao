import {
  myContributeQuery,
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
