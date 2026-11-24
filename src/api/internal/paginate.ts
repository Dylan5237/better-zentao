import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import type { createZentaoHttp, ReadRequest } from "./http.ts";

const maxPages = 50;
const pageSizeSetting = z.int().positive();
const paginationMode = z.enum(["v1", "v2"]);

interface PaginationOptions<T> {
  readonly mode: z.infer<typeof paginationMode>;
  readonly pageSize: number;
  readonly schema: z.ZodType<{ items: readonly T[]; total?: number }>;
  readonly countItems?: (items: readonly T[]) => number;
}

export async function paginate<T>(
  http: Pick<ReturnType<typeof createZentaoHttp>, "read">,
  request: ReadRequest,
  options: PaginationOptions<T>,
): Promise<{ items: T[]; truncated: boolean }> {
  const { mode, pageSize, schema, countItems } = options;
  if (
    !pageSizeSetting.safeParse(pageSize).success ||
    !paginationMode.safeParse(mode).success
  ) {
    throw new BztError("INVALID_INPUT", "禅道分页参数不合法。");
  }

  const items: T[] = [];
  let received = 0;
  let total: number | undefined;
  const [sizeKey, pageKey] =
    mode === "v1"
      ? (["limit", "page"] as const)
      : (["recPerPage", "pageID"] as const);
  for (let page = 1; page <= maxPages; page++) {
    const data = await http.read(
      {
        ...request,
        query: { ...request.query, [sizeKey]: pageSize, [pageKey]: page },
      },
      schema,
    );
    for (const item of data.items) items.push(item);
    const pageCount = countItems?.(data.items) ?? data.items.length;
    received += pageCount;
    total = data.total ?? total;
    if (total !== undefined && received >= total)
      return { items, truncated: false };
    if (pageCount < pageSize) return { items, truncated: total !== undefined };
  }
  return { items, truncated: true };
}
