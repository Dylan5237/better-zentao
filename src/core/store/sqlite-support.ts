import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BztError } from "../errors.ts";

/** node:sqlite 匿名参数只接受这些标量。 */
export type BindValue = null | number | string;

const sqliteFailure = z.object({
  code: z.string().optional(),
  errcode: z.number().optional(),
  errstr: z.string().optional(),
});

function countChanges(changes: number | bigint): number {
  return typeof changes === "bigint" ? Number(changes) : changes;
}

/**
 * SQLite 没有独立的存储错误码，docs/07 §2.4 也未定义；
 * 统一映射到 INVALID_INPUT，并把原始约束原因留在 details。
 */
export function toStoreError(action: string, error: unknown): BztError {
  if (error instanceof BztError) return error;

  const failure = sqliteFailure.safeParse(error);
  const code = failure.success ? failure.data.code : undefined;
  const errcode = failure.success ? failure.data.errcode : undefined;
  const errstr = failure.success ? failure.data.errstr : undefined;
  const rawMessage = error instanceof Error ? error.message : "";

  if (
    code === "ERR_INVALID_STATE" ||
    /database (?:connection )?is not open/iu.test(rawMessage)
  )
    return new BztError("INVALID_INPUT", "本地状态库已关闭。", { action });

  if (
    errcode === 1555 ||
    errcode === 2067 ||
    /(?:UNIQUE|PRIMARY KEY) constraint failed/iu.test(rawMessage)
  )
    return new BztError("INVALID_INPUT", "本地状态库记录已存在。", {
      action,
      errcode,
    });

  if (errcode === 787 || /FOREIGN KEY constraint failed/iu.test(rawMessage))
    return new BztError("INVALID_INPUT", "本地状态库关联记录不存在。", {
      action,
      errcode,
    });

  if (
    errcode === 275 ||
    errcode === 1299 ||
    /(?:CHECK|NOT NULL) constraint failed/iu.test(rawMessage)
  )
    return new BztError("INVALID_INPUT", "本地状态库字段取值不合法。", {
      action,
      errcode,
    });

  return new BztError("INVALID_INPUT", `本地状态库${action}失败。`, {
    action,
    code,
    errcode,
    errstr,
  });
}

export function execSql(
  database: DatabaseSync,
  sql: string,
  action: string,
): void {
  try {
    database.exec(sql);
  } catch (error) {
    throw toStoreError(action, error);
  }
}

/** 执行写语句并返回受影响行数。 */
export function execute(
  database: DatabaseSync,
  sql: string,
  parameters: readonly BindValue[],
  action: string,
): number {
  try {
    return countChanges(database.prepare(sql).run(...parameters).changes);
  } catch (error) {
    throw toStoreError(action, error);
  }
}

function parseRow<S extends z.ZodType>(
  schema: S,
  row: unknown,
  action: string,
): z.output<S> {
  const parsed = schema.safeParse(row);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "本地状态库数据格式不合法。", {
      action,
      issue: parsed.error.issues[0]?.message,
    });
  return parsed.data;
}

export function queryAll<S extends z.ZodType>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly BindValue[],
  schema: S,
  action: string,
): z.output<S>[] {
  let rows: unknown[];
  try {
    rows = database.prepare(sql).all(...parameters);
  } catch (error) {
    throw toStoreError(action, error);
  }
  return rows.map((row) => parseRow(schema, row, action));
}

export function queryOne<S extends z.ZodType>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly BindValue[],
  schema: S,
  action: string,
): z.output<S> | undefined {
  let row: unknown;
  try {
    row = database.prepare(sql).get(...parameters);
  } catch (error) {
    throw toStoreError(action, error);
  }
  return row === undefined ? undefined : parseRow(schema, row, action);
}
