import { productDto, productModuleMenuSchema } from "../core/dto/product.ts";
import type { Product, ProductModule } from "../core/dto/product.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const productPage = pageSchema("products", productDto);

export async function listProducts(
  client: ZentaoReadClient,
): Promise<{ items: Product[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    { pathTemplate: "/api.php/v1/products" },
    {
      mode: "v1",
      pageSize: 100,
      schema: productPage,
    },
  );
}

export async function getProductModules(
  client: ZentaoReadClient,
  productId: number,
): Promise<ProductModule[]> {
  const schema = productModuleMenuSchema
    .refine((menu) => menu.productId === productId, { path: ["id"] })
    .transform(({ items }) => items);

  return getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/products/{id}",
      params: { id: productId },
      objectId: productId,
      query: { fields: "moduleOptionMenu" },
    },
    schema,
  );
}
