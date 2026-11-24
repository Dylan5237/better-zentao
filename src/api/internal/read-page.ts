import { z } from "zod";
import { zCollection, zCount } from "../../core/dto/common.ts";

export function pageSchema<T>(
  key: string,
  item: z.ZodType<T>,
  positiveKeys = false,
) {
  const rows = zCollection(item, positiveKeys);
  return z
    .looseObject({
      total: zCount.optional(),
      pager: z.object({ recTotal: zCount.optional() }).nullish(),
    })
    .transform((value, context) => {
      const parsed = rows.safeParse(value[key]);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "禅道列表结构不合法。",
        });
        return z.NEVER;
      }
      const count = value.total ?? value.pager?.recTotal;
      return count === undefined
        ? { items: parsed.data }
        : { items: parsed.data, total: count };
    });
}
