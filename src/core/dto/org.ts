import { z } from "zod";
import { brandDto, zAccount, zBool, zId, zNullableId } from "./common.ts";

const instanceConfigBrand: unique symbol = Symbol("InstanceConfig");
const currentUserBrand: unique symbol = Symbol("CurrentUser");
const departmentBrand: unique symbol = Symbol("DepartmentNode");
const userBrand: unique symbol = Symbol("User");

const account = zAccount.pipe(z.string());
const nullableText = z
  .string()
  .nullable()
  .transform((value) => value?.trim() || null);
const roleCode = z
  .union([
    z.string(),
    z.object({ code: z.string() }).transform(({ code }) => code),
    z.null(),
  ])
  .pipe(nullableText);

const directoryIdentity = {
  id: zId,
  account,
  realname: z.string(),
  dept: zNullableId,
  role: roleCode,
};

export const instanceConfigDto = z
  .object({
    version: z.string().min(1),
    URAndSR: zBool,
  })
  .transform((config) => brandDto(config, instanceConfigBrand));

const instanceWebRouteBrand: unique symbol = Symbol("InstanceWebRoute");
export const instanceWebRouteDto = z
  .object({
    requestType: z.string().optional(),
    moduleVar: z
      .string()
      .regex(/^[A-Za-z]\w{0,31}$/u)
      .optional(),
    methodVar: z
      .string()
      .regex(/^[A-Za-z]\w{0,31}$/u)
      .optional(),
  })
  .transform((config) => brandDto(config, instanceWebRouteBrand));

export const currentUserDto = z
  .object({
    profile: z.object(directoryIdentity),
  })
  .transform(({ profile }) => brandDto(profile, currentUserBrand));

export interface DepartmentNode {
  readonly [departmentBrand]: true;
  readonly id: number;
  readonly name: string;
  readonly parent: number | null;
  readonly items: readonly DepartmentNode[];
}

export const departmentNodeDto: z.ZodType<DepartmentNode> = z.lazy(() =>
  z
    .object({
      id: zId,
      name: z.string(),
      parent: zNullableId,
      items: z.array(departmentNodeDto).default([]),
    })
    .transform((department) => brandDto(department, departmentBrand)),
);

export const userDto = z
  .object({
    ...directoryIdentity,
    pinyin: nullableText.default(null),
    deleted: zBool,
  })
  .transform((user) => brandDto(user, userBrand));

export type InstanceConfig = z.output<typeof instanceConfigDto>;
export type CurrentUser = z.output<typeof currentUserDto>;
export type User = z.output<typeof userDto>;
