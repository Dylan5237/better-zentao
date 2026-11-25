import { z } from "zod";
import { PROBE_PRODUCT_ID } from "../../core/config.ts";
import { zId } from "../../core/dto/common.ts";
import {
  probeExecutionDto,
  probeProjectDto,
  probeProjectViewDto,
} from "../../core/dto/execution.ts";
import { walkProductPlans } from "../../core/dto/plan.ts";
import {
  requirementDetailDtoFor,
  storySummaryDtoFor,
} from "../../core/dto/story.ts";
import { BztError } from "../../core/errors.ts";
import type { ZentaoReadClient } from "../client.ts";
import { listProductPlans } from "../plan.ts";
import { getProductModules } from "../product.ts";
import { getStoryDetailV2 } from "../story.ts";
import { getTaskDetail } from "../task.ts";
import { normalizeZentaoBaseUrl } from "./base-url.ts";
import type { ReadRequest } from "./http.ts";
import { paginate } from "./paginate.ts";
import { getReadClient } from "./read-client.ts";
import { pageSchema } from "./read-page.ts";
import { readStoryDetail } from "./story-response.ts";

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
  .array(
    z.object({
      id,
      product: id,
      status: z.string().optional(),
      deleted: z.boolean().optional(),
    }),
  )
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
    plans: Array.from(
      walkProductPlans(plans.items),
      ({ id, product, status, deleted }) => ({ id, product, status, deleted }),
    ),
  });
}

export function getProbeOwnershipOptions(evidence: VerifiedOwnership): {
  modules: number[];
  openPlans: number[];
} {
  const scope = verified.get(evidence);
  if (!scope) throw invalidOwnership();
  return {
    modules: scope.data.modules
      .filter(({ product }) => product === PROBE_PRODUCT_ID)
      .map(({ id }) => id),
    openPlans: scope.data.plans
      .filter(
        ({ product, status, deleted }) =>
          product === PROBE_PRODUCT_ID &&
          status !== undefined &&
          status !== "closed" &&
          deleted === false,
      )
      .map(({ id }) => id),
  };
}

export function hasProbeOwnership(
  evidence: VerifiedOwnership | undefined,
  baseUrl: URL,
  module: number,
  plan: number | undefined,
): boolean {
  if (!evidence) return false;
  const scope = verified.get(evidence);
  if (scope?.baseUrl !== baseUrl.href) return false;
  const matches = (id: number) => (row: { id: number; product: number }) =>
    row.id === id && row.product === PROBE_PRODUCT_ID;
  return (
    scope.data.modules.some(matches(module)) &&
    (plan === undefined || scope.data.plans.some(matches(plan)))
  );
}

export function hasOpenProbePlan(
  evidence: VerifiedOwnership | undefined,
  baseUrl: URL,
  planId: number,
): boolean {
  return (
    evidence !== undefined &&
    verified.get(evidence)?.baseUrl === baseUrl.href &&
    getProbeOwnershipOptions(evidence).openPlans.includes(planId)
  );
}

export interface ProbeStoryIdentity {
  readonly title: string;
  readonly openedBy: string;
}

export async function assertProbeStoryOwnership(
  client: ZentaoReadClient | undefined,
  baseUrl: URL,
  id: number,
  expected?: ProbeStoryIdentity,
): Promise<void> {
  if (!client || getReadClient(client).baseUrl !== baseUrl.href) {
    throw probeDenied();
  }
  const story = await readStoryDetail(client, id);
  if (
    story.id !== id ||
    story.type !== "story" ||
    story.product !== PROBE_PRODUCT_ID ||
    story.deleted ||
    (expected &&
      (story.title !== expected.title || story.openedBy !== expected.openedBy))
  ) {
    throw probeDenied();
  }
}

function assertProbeProducts(products: readonly number[]): void {
  if (
    !products.includes(PROBE_PRODUCT_ID) ||
    products.some((id) => id !== PROBE_PRODUCT_ID)
  )
    throw probeDenied();
}

function isOpen(row: { status: string; deleted?: boolean }): boolean {
  return !row.deleted && (row.status === "wait" || row.status === "doing");
}

async function readScopePage<T>(
  client: ZentaoReadClient,
  request: ReadRequest,
  schema: z.ZodType<{ items: readonly T[]; total?: number }>,
  mode: "v1" | "v2" = "v1",
): Promise<T[]> {
  const { items, truncated } = await paginate(
    getReadClient(client).http,
    request,
    { mode, pageSize: 100, schema },
  );
  if (truncated) throw invalidOwnership();
  return items;
}

export async function readProbeExecutions(client: ZentaoReadClient) {
  const projects = await readScopePage(
    client,
    {
      pathTemplate: "/api.php/v1/products/{id}/projects",
      params: { id: PROBE_PRODUCT_ID },
    },
    pageSchema("projects", probeProjectDto),
  );
  const executions: { id: number; project: number }[] = [];
  const { http } = getReadClient(client);
  for (const project of projects) {
    if (project.products !== undefined) assertProbeProducts(project.products);
    if (project.multiple === false || !isOpen(project)) continue;
    let verifiedProducts = project.products;
    if (project.multiple === undefined || verifiedProducts === undefined) {
      const view = await http.read(
        {
          pathTemplate: "/api.php/v2/project/view",
          query: { projectID: project.id },
          objectId: project.id,
        },
        probeProjectViewDto,
      );
      if (view.project.id !== project.id) throw probeDenied();
      const products = view.products ?? view.project.products;
      if (products !== undefined) assertProbeProducts(products);
      if (!view.project.multiple || !isOpen(view.project)) continue;
      if (products === undefined) throw probeDenied();
      verifiedProducts = products;
    }
    // 执行关联需求时，禅道也会写入父项目的关联记录。
    if (verifiedProducts === undefined) throw probeDenied();
    const rows = await readScopePage(
      client,
      {
        pathTemplate: "/api.php/v1/projects/{id}/executions",
        params: { id: project.id },
      },
      pageSchema("executions", probeExecutionDto),
    );
    for (const row of rows) {
      if (row.products !== undefined) assertProbeProducts(row.products);
      if (row.project !== project.id) throw probeDenied();
      if (!isOpen(row)) continue;
      const execution = await http.read(
        {
          pathTemplate: "/api.php/v1/executions/{id}",
          params: { id: row.id },
        },
        probeExecutionDto,
      );
      if (execution.id !== row.id || execution.project !== project.id)
        throw probeDenied();
      assertProbeProducts(execution.products ?? []);
      if (isOpen(execution))
        executions.push({ id: execution.id, project: project.id });
    }
  }
  return { projectsCount: projects.length, executions };
}

export async function readProbeExecutionStories(
  client: ZentaoReadClient,
  execution: number,
) {
  const stories = await readScopePage(
    client,
    {
      pathTemplate: "/api.php/v1/executions/{id}/stories",
      params: { id: execution },
    },
    pageSchema("stories", z.object({ id: zId, product: zId })),
  );
  if (stories.some(({ product }) => product !== PROBE_PRODUCT_ID))
    throw probeDenied();
  return stories;
}

export async function readProbeRequirement(
  client: ZentaoReadClient,
  id: number,
) {
  const { http, timezone } = getReadClient(client);
  const { story } = await http.read(
    {
      pathTemplate: "/api.php/v2/requirement/view",
      query: { storyID: id },
      objectId: id,
    },
    requirementDetailDtoFor(timezone),
  );
  if (
    story.id !== id ||
    story.product !== PROBE_PRODUCT_ID ||
    story.deleted ||
    story.status === "closed"
  )
    throw probeDenied();
  return story;
}

export async function findProbeRequirement(client: ZentaoReadClient) {
  const { timezone } = getReadClient(client);
  const rows = storySummaryDtoFor(timezone);
  const requirements = await readScopePage(
    client,
    {
      pathTemplate: "/api.php/v2/product/browse",
      query: { productID: PROBE_PRODUCT_ID, storyType: "requirement" },
    },
    z.union([pageSchema("stories", rows), pageSchema("requirements", rows)]),
    "v2",
  );
  const available = requirements.find(
    ({ type, status, deleted }) =>
      type === "requirement" && status !== "closed" && !deleted,
  );
  if (available === undefined) return undefined;
  if (available.product !== PROBE_PRODUCT_ID) throw probeDenied();
  return (await readProbeRequirement(client, available.id)).id;
}

export async function readProbeStoryLinks(
  client: ZentaoReadClient,
  id: number,
  type: "story" | "requirement",
) {
  if (type === "requirement")
    return (await readProbeRequirement(client, id)).linkStories;
  const { story } = await getStoryDetailV2(client, id);
  if (story.id !== id || story.product !== PROBE_PRODUCT_ID || story.deleted)
    throw probeDenied();
  return story.linkStories;
}

export async function readProbeTask(client: ZentaoReadClient, id: number) {
  const task = await getTaskDetail(client, id);
  if (
    task.id !== id ||
    task.deleted ||
    (task.product != null && task.product !== PROBE_PRODUCT_ID)
  )
    throw probeDenied();
  return task;
}
