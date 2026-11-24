import { z } from "zod";
import { brandDto, zBool, zId } from "./common.ts";

const productBrand: unique symbol = Symbol("Product");
const productModuleBrand: unique symbol = Symbol("ProductModule");

export const productDto = z
  .object({
    id: zId,
    name: z.string(),
    status: z.string(),
    deleted: zBool,
  })
  .transform((product) => brandDto(product, productBrand));

const moduleRow = z.object({
  id: z.union([zId, z.literal(0), z.literal("0").transform(() => 0 as const)]),
  name: z.string(),
});

export const productModuleMenuSchema = z
  .object({
    id: zId,
    moduleOptionMenu: z.array(moduleRow),
  })
  .transform(({ id: productId, moduleOptionMenu }) => ({
    productId,
    items: moduleOptionMenu.map((item) =>
      brandDto({ ...item, productId }, productModuleBrand),
    ),
  }));

export type Product = z.output<typeof productDto>;
export type ProductModule = z.output<
  typeof productModuleMenuSchema
>["items"][number];
