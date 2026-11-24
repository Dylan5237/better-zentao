import { z } from "zod";
import { PROBE_PRODUCT_ID } from "../../core/config.ts";
import { walkProductPlans } from "../../core/dto/plan.ts";
import { BztError } from "../../core/errors.ts";
import type { ZentaoReadClient } from "../client.ts";
import { listProductPlans } from "../plan.ts";
import { getProductModules } from "../product.ts";
import { normalizeZentaoBaseUrl } from "./base-url.ts";
import { getReadClient } from "./read-client.ts";

export function probeDenied(): BztError {
  return new BztError("PERMISSION_DENIED", "探查请求超出已确认的 #29 范围。");
}

export function parseProbeBaseUrl(input: string): URL {
  const url = normalizeZentaoBaseUrl(input);
  if (!url) throw probeDenied();
  return url;
}

const id = z.int().positive();
const ownedItems = z
  .array(z.object({ id, product: id }))
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  );
// 阶段 2 的合成响应与正式只读 DTO 共用归属校验及签发。
const ownershipResponse = z.object({ modules: ownedItems, plans: ownedItems });
const ownershipBrand: unique symbol = Symbol("VerifiedOwnership");
export type VerifiedOwnership = Readonly<{ [ownershipBrand]: true }>;

const verified = new WeakMap<
  VerifiedOwnership,
  { baseUrl: string; data: z.infer<typeof ownershipResponse> }
>();

function invalidOwnership(): BztError {
  return new BztError("ZENTAO_SCHEMA_MISMATCH", "无法从回读确认探查归属。");
}

function issueOwnership(baseUrl: string, rows: unknown): VerifiedOwnership {
  const ownership = ownershipResponse.safeParse(rows);
  if (!ownership.success) throw invalidOwnership();

  const evidence: VerifiedOwnership = Object.freeze({ [ownershipBrand]: true });
  verified.set(evidence, { baseUrl, data: ownership.data });
  return evidence;
}

export async function decodeProbeOwnership(
  baseUrl: string,
  response: Response,
): Promise<VerifiedOwnership> {
  const instance = parseProbeBaseUrl(baseUrl);
  if (!response.ok) {
    throw new BztError("ZENTAO_UNAVAILABLE", "探查归属回读失败。", {
      status: response.status,
    });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw invalidOwnership();
  }
  return issueOwnership(instance.href, raw);
}

export async function readProbeOwnership(
  client: ZentaoReadClient,
): Promise<VerifiedOwnership> {
  const { baseUrl } = getReadClient(client);
  const [modules, plans] = await Promise.all([
    getProductModules(client, PROBE_PRODUCT_ID),
    listProductPlans(client, PROBE_PRODUCT_ID),
  ]);
  if (plans.truncated) throw invalidOwnership();
  return issueOwnership(baseUrl, {
    modules: modules
      .filter(({ id }) => id > 0)
      .map(({ id, productId }) => ({ id, product: productId })),
    plans: Array.from(walkProductPlans(plans.items), ({ id, product }) => ({
      id,
      product,
    })),
  });
}

export function hasProbeOwnership(
  evidence: VerifiedOwnership,
  baseUrl: URL,
  module: number,
  plan: number | undefined,
): boolean {
  const scope = verified.get(evidence);
  if (scope?.baseUrl !== baseUrl.href) return false;
  const matches = (id: number) => (row: { id: number; product: number }) =>
    row.id === id && row.product === PROBE_PRODUCT_ID;
  return (
    scope.data.modules.some(matches(module)) &&
    (plan === undefined || scope.data.plans.some(matches(plan)))
  );
}
