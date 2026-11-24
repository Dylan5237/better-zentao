import { z } from "zod";
import { actionDtoFor } from "./action.ts";
import {
  brandDto,
  dateTimeSchema,
  zAccount,
  zBool,
  zCollection,
  zCount,
  zDate,
  zHours,
  zId,
  zNullableId,
} from "./common.ts";

const taskBrand: unique symbol = Symbol("Task");
const taskDetailBrand: unique symbol = Symbol("TaskDetail");
const taskTeamMemberBrand: unique symbol = Symbol("TaskTeamMember");

const taskStatus = z.enum([
  "wait",
  "doing",
  "pause",
  "changed",
  "done",
  "closed",
  "cancel",
]);
const emptyMode = z.union([z.literal(""), z.null()]).transform(() => null);
const taskMode = z.union([z.enum(["single", "linear", "multi"]), emptyMode]);

function taskFieldsFor(timezone: string) {
  const datetime = dateTimeSchema(timezone);
  return z.object({
    id: zId,
    project: zNullableId.optional(),
    execution: zId,
    product: zNullableId.optional(),
    module: zNullableId.optional(),
    story: zNullableId,
    storyTitle: z.string().optional(),
    parent: zNullableId,
    isParent: zBool,
    name: z.string().min(1),
    type: z.string().min(1),
    mode: taskMode,
    status: taskStatus,
    pri: zNullableId.optional(),
    desc: z.string().nullable().optional(),
    assignedTo: zAccount.optional(),
    openedBy: zAccount.optional(),
    finishedBy: zAccount.optional(),
    closedReason: z.string().nullable().optional(),
    estStarted: zDate,
    deadline: zDate,
    estimate: zHours,
    consumed: zHours,
    left: zHours,
    openedDate: datetime.optional(),
    assignedDate: datetime.optional(),
    realStarted: datetime.optional(),
    finishedDate: datetime.optional(),
    closedDate: datetime.optional(),
    lastEditedDate: datetime.optional(),
    deleted: zBool.optional(),
  });
}

export function taskDtoFor(timezone: string) {
  return taskFieldsFor(timezone).transform((task) => brandDto(task, taskBrand));
}

export type Task = z.output<ReturnType<typeof taskDtoFor>>;

// docs/06 §4 Q6 目录按账号解析姓名，team.realname 是团队记录 ID。
const taskTeamMemberDto = z
  .object({
    account: zAccount.pipe(z.string().min(1)),
    estimate: zHours.optional(),
    consumed: zHours.optional(),
    left: zHours.optional(),
    status: z.union([taskStatus, emptyMode]).optional(),
    order: zCount.optional(),
  })
  .transform((member) => brandDto(member, taskTeamMemberBrand));

export function taskDetailDtoFor(timezone: string) {
  return taskFieldsFor(timezone)
    .extend({
      // 22.6 已关闭任务用 false 表示没有多人团队（docs/06 Q6）。
      team: z
        .union([
          zCollection(taskTeamMemberDto),
          z.literal(false).transform(() => []),
        ])
        .default([]),
      children: zCollection(taskDtoFor(timezone)).default([]),
      actions: zCollection(actionDtoFor(timezone)).default([]),
    })
    .transform((task) => brandDto(task, taskDetailBrand));
}

export type TaskDetail = z.output<ReturnType<typeof taskDetailDtoFor>>;
