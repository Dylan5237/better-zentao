import { z } from "zod";

const versionRow = z.object({ version: z.string() });

export async function checkSqlite(): Promise<string> {
  // doctor 在确认 Node 版本后才加载 SQLite，让旧版 Node 也能报告诊断结果。
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    return versionRow.parse(
      database.prepare("SELECT sqlite_version() AS version").get(),
    ).version;
  } finally {
    database.close();
  }
}
