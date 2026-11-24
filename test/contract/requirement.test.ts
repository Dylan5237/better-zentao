import { expect, it } from "vitest";
import { getRequirementDetail } from "../../src/api/requirement.ts";
import { getStoryDetail } from "../../src/api/story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("Q9 用户需求详情走 v2 requirement/view 并使用 storyID 参数", async () => {
  const { client, fetch } = mockReadFixture("requirement-detail", {
    path: "/api.php/v2/requirement/view",
    query: { storyID: 4845 },
  });

  const detail = await getRequirementDetail(client, 4845);

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(detail).toMatchObject({
    story: {
      id: 4845,
      type: "requirement",
      module: null,
      plan: [],
      openedBy: "acct_264",
      lastEditedBy: null,
      lastEditedDate: null,
      executions: [],
      tasks: [],
    },
    reviewers: ["acct_017"],
    actions: [
      { id: 115628, action: "opened" },
      { id: 115629 },
      { id: 115630, action: "assigned" },
    ],
  });
  assertNoSensitiveData(detail);
});

it("Q9 误查 v1 用户需求返回 400 时只有安全的业务错误", async () => {
  const secret = "synthetic-private-context";
  const { client, fetch } = mockReadFixture("requirement-detail", {
    path: "/api.php/v1/stories/4845",
  });
  fetch
    .mockResolvedValueOnce(
      Response.json({ token: "fixture-session" }, { status: 201 }),
    )
    .mockResolvedValueOnce(Response.json({ message: secret }, { status: 400 }));

  const result = getStoryDetail(client, 4845);

  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    details: { status: 400 },
  });
  await result.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toMatch(
    /\/v1\/stories\/4845$/u,
  );
});
