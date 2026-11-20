import { z } from "zod";
import { PROBE_PRODUCT_ID } from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";

export function probeDenied(): BztError {
  return new BztError("PERMISSION_DENIED", "探查请求超出已确认的 #29 范围。");
}

export function parseProbeBaseUrl(input: string): URL {
  const url = URL.parse(input);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw probeDenied();
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}

const id = z.int().positive();
const ownedItems = z
  .array(z.object({ id, product: id }))
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  );
// 阶段 2 的合成回读结构。真实端点响应须在 WP-04 按夹具投影。
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
  const ownership = ownershipResponse.safeParse(raw);
  if (!ownership.success) throw invalidOwnership();

  const evidence: VerifiedOwnership = Object.freeze({ [ownershipBrand]: true });
  verified.set(evidence, { baseUrl: instance.href, data: ownership.data });
  return evidence;
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
