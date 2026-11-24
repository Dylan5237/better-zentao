import { z } from "zod";
import { bugDtoFor, type Bug } from "./bug.ts";
import { brandDto, zCollection, zCount } from "./common.ts";
import { storySummaryDtoFor, type StorySummary } from "./story.ts";
import { taskDtoFor, type Task } from "./task.ts";

const myWorkPageBrand: unique symbol = Symbol("MyWorkPage");
const myContributePageBrand: unique symbol = Symbol("MyContributePage");
const todoCountBrand: unique symbol = Symbol("TodoCount");

const contributionMode = z.enum(["task", "story", "bug"]);
const workMode = z.enum([...contributionMode.options, "requirement", "epic"]);

export const myWorkQuery = z.strictObject({
  mode: workMode,
  browseType: z.enum(["assignedTo", "reviewBy"]),
});

export const myContributeQuery = z.strictObject({
  mode: contributionMode,
  browseType: z.enum(["openedBy", "finishedBy", "reviewedBy"]),
});

export type MyWorkQuery = z.infer<typeof myWorkQuery>;
export type MyContributeQuery = z.infer<typeof myContributeQuery>;

const todoCountDto = z
  .object({
    task: zCount.optional(),
    story: zCount.optional(),
    bug: zCount.optional(),
    requirement: zCount.optional(),
    epic: zCount.optional(),
  })
  .transform((counts) => brandDto(counts, todoCountBrand));

export type TodoCount = z.infer<typeof todoCountDto>;

type MyItem = Task | Bug | StorySummary;
type MyMode = MyWorkQuery["mode"];

function myCollectionFor(
  mode: MyMode,
  timezone: string,
): {
  key: "tasks" | "bugs" | "stories";
  item: z.ZodType<MyItem>;
} {
  switch (mode) {
    case "task":
      return { key: "tasks", item: taskDtoFor(timezone) };
    case "bug":
      return { key: "bugs", item: bugDtoFor(timezone) };
    default:
      return { key: "stories", item: storySummaryDtoFor(timezone) };
  }
}

export function myPageDtoFor(mode: MyMode, timezone: string) {
  const { key, item } = myCollectionFor(mode, timezone);
  const rows = zCollection(item);
  return z
    .looseObject({
      pager: z.object({ recTotal: zCount }),
      todoCount: todoCountDto,
    })
    .transform((page, context) => {
      const parsed = rows.safeParse(page[key]);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "禅道个人工作列表结构不合法。",
        });
        return z.NEVER;
      }
      return {
        items: parsed.data,
        total: page.pager.recTotal,
        todoCount: page.todoCount,
      };
    });
}

interface MyPageResult {
  readonly items: MyItem[];
  readonly truncated: boolean;
  readonly todoCount: TodoCount;
}

export function toMyWorkPage(result: MyPageResult) {
  return brandDto(result, myWorkPageBrand);
}

export function toMyContributePage(result: MyPageResult) {
  return brandDto(result, myContributePageBrand);
}

export type MyWorkPage = ReturnType<typeof toMyWorkPage>;
export type MyContributePage = ReturnType<typeof toMyContributePage>;
