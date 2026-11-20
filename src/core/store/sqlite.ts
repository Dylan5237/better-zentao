import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const versionRow = z.object({ version: z.string() });

export function checkSqlite(): string {
  const database = new DatabaseSync(":memory:");
  try {
    return versionRow.parse(
      database.prepare("SELECT sqlite_version() AS version").get(),
    ).version;
  } finally {
    database.close();
  }
}
