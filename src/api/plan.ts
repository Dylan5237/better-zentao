import {
  planDetailDtoFor,
  productPlanDto,
  walkProductPlans,
} from "../core/dto/plan.ts";
import type { PlanDetail, ProductPlan } from "../core/dto/plan.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const planPage = pageSchema("plans", productPlanDto);

export async function listProductPlans(
  client: ZentaoReadClient,
  productId: number,
): Promise<{ items: ProductPlan[]; truncated: boolean }> {
  const schema = planPage.refine(
    ({ items }) =>
      Array.from(walkProductPlans(items)).every(
        (plan) => plan.product === productId,
      ),
    { path: ["plans", "product"] },
  );
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v1/products/{id}/plans",
      params: { id: productId },
      objectId: productId,
      schemaFields: ["plans", "total", "pager"],
    },
    {
      mode: "v1",
      pageSize: 100,
      schema,
      // docs/06 §5.2 的分页总数包含嵌套的 L3 行。
      countItems: (items) => Array.from(walkProductPlans(items)).length,
    },
  );
}

export async function getPlanDetail(
  client: ZentaoReadClient,
  planId: number,
): Promise<PlanDetail> {
  const { http, timezone } = getReadClient(client);
  const schema = planDetailDtoFor(timezone).refine(
    (detail) => detail.plan.id === planId,
    { path: ["plan", "id"] },
  );
  return http.read(
    {
      pathTemplate: "/api.php/v2/productplan/view",
      query: { planID: planId },
      objectId: planId,
      schemaFields: Object.keys(schema.in.shape),
    },
    schema,
  );
}
