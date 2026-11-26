import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import type { CaptureReport } from "../probe-capture.ts";
import { authFailed } from "./auth.ts";
import {
  createCaptureFixtures,
  createCaptureReport,
} from "./capture-fixture.ts";
import { createZentaoHttp } from "./http.ts";
import type { ReadRequest, ZentaoHttpOptions } from "./http.ts";
import { captureRoutes } from "./probe-capture-routes.ts";
import type { CaptureRoute } from "./probe-capture-routes.ts";

const positiveInteger = z.int().positive();
const digitString = z.string().regex(/^\d+$/u).transform(Number);
const receivedId = z.union([
  positiveInteger,
  digitString.pipe(positiveInteger),
]);
const nonNegativeInteger = z.int().nonnegative();
const count = z.union([
  nonNegativeInteger,
  digitString.pipe(nonNegativeInteger),
]);
const fieldsSchema = z.record(z.string(), z.unknown());
const listSchema = z.array(z.unknown());
const keyedList = z.record(z.string().regex(/^\d+$/u), z.unknown());
const entity = z.looseObject({ id: receivedId });
const deletedValues: readonly unknown[] = [true, 1, "1", "true"];
const taskSamplingStages = new Set([
  "developing",
  "developed",
  "testing",
  "tested",
  "verified",
  "released",
]);
const lastSamplePage = 50;
const diagnosticFields = new Set([
  "status",
  "code",
  "result",
  "message",
  "error",
]);
const captureBody = z.unknown().refine((body) => {
  if (body === undefined) return false;
  const record = fields(body);
  // docs/06 §2.2：纯诊断信封应由传输层判为业务错误。
  return (
    !record ||
    (record.error === undefined && record.message === undefined) ||
    Object.entries(record).some(
      ([key, value]) => !diagnosticFields.has(key) && value !== null,
    )
  );
});

type Entity = z.output<typeof entity>;
type CaptureInput = Parameters<typeof createCaptureFixtures>[0][number];

function id(value: unknown): number | undefined {
  return receivedId.safeParse(value).data;
}

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return fieldsSchema.safeParse(value).data;
}

function list(
  value: unknown,
  includeEmptyObject = false,
): readonly unknown[] | undefined {
  const array = listSchema.safeParse(value);
  if (array.success) return array.data;
  const keyed = keyedList.safeParse(value);
  if (!keyed.success) return;
  const rows = Object.values(keyed.data);
  return rows.length > 0 || includeEmptyObject ? rows : undefined;
}

function collection(
  body: unknown,
  names?: readonly string[],
): readonly unknown[] | undefined {
  if (!names) return;
  const direct = list(body);
  if (direct) return direct;
  const root = fields(body);
  const wrapped = list(root?.data);
  if (wrapped) return wrapped;
  for (const candidate of [fields(root?.data), root]) {
    for (const name of [...names, "items", "list"]) {
      const rows = list(candidate?.[name], true);
      if (rows) return rows;
    }
  }
}

function entities(rows: readonly unknown[] | undefined): Entity[] {
  return (rows ?? []).flatMap((row) => {
    const parsed = entity.safeParse(row);
    return parsed.success && !deletedValues.includes(parsed.data.deleted)
      ? [parsed.data]
      : [];
  });
}

function firstSample(
  rows: readonly Entity[],
  preferred?: (row: Entity) => boolean,
): number | undefined {
  const preferredRows = preferred && rows.filter(preferred);
  const candidates = preferredRows?.length ? preferredRows : rows;
  return (candidates.find((row) => row.status !== "closed") ?? candidates[0])
    ?.id;
}

function departmentFromTree(
  rows: readonly unknown[] | undefined,
): number | undefined {
  const queue = [...(rows ?? [])];
  for (const row of queue) {
    const node = fields(row);
    const department = id(node?.id);
    if (department !== undefined) return department;
    for (const child of list(node?.items) ?? list(node?.children) ?? []) {
      queue.push(child);
    }
  }
}

function productOfProject(row: Entity, productId: number | undefined): boolean {
  if (productId === undefined) return false;
  return (
    id(row.product ?? row.productID) === productId ||
    (list(row.products) ?? []).some(
      (product) => id(fields(product)?.id ?? product) === productId,
    )
  );
}

function totalCount(body: unknown): number | undefined {
  const root = fields(body);
  const data = fields(root?.data);
  for (const source of [root, data, fields(root?.pager), fields(data?.pager)]) {
    const parsed = count.safeParse(source?.total ?? source?.recTotal);
    if (parsed.success) return parsed.data;
  }
}

function emptyPageRequest(
  request: ReadRequest,
  body: unknown,
  rowCount: number,
): ReadRequest | undefined {
  const { query } = request;
  if (!query) return;
  const pageKey = query.pageID === 1 ? "pageID" : "page";
  const pageSize = query[pageKey === "pageID" ? "recPerPage" : "limit"];
  if (query[pageKey] !== 1 || typeof pageSize !== "number") return;
  const total = totalCount(body);
  const page =
    total === undefined && rowCount >= pageSize
      ? lastSamplePage
      : Math.ceil(Math.max(total ?? 0, rowCount) / pageSize) + 1;
  if (page <= lastSamplePage)
    return { ...request, query: { ...query, [pageKey]: page } };
}

export async function collectProbeFixtures(
  options: ZentaoHttpOptions,
  requestedProductId?: number,
): Promise<CaptureReport> {
  if (!positiveInteger.optional().safeParse(requestedProductId).success) {
    throw new BztError("INVALID_INPUT", "禅道产品 ID 必须为正整数。");
  }
  if (options.password === undefined)
    throw new BztError("CONFIG_MISSING", "夹具采集需要账号密码登录。");
  const http = createZentaoHttp(options);
  const secrets = new Set([options.password]);
  const instance = URL.parse(options.baseUrl);
  if (instance && instance.hostname !== "fixture.example.test") {
    secrets.add(instance.hostname);
    if (instance.hostname.startsWith("[")) {
      secrets.add(instance.hostname.slice(1, -1));
    }
  }

  const rawSamples: CaptureInput[] = [];
  const emptyPages: Array<{ route: CaptureRoute; request: ReadRequest }> = [];
  const gaps: Array<CaptureReport["gaps"][number]> = [];

  async function read(request: ReadRequest, failedEndpoint?: string) {
    try {
      return await http.read(request, captureBody, {
        observeSession: (value) => {
          secrets.add(value);
        },
      });
    } catch (error) {
      const code =
        error instanceof BztError ? error.code : "ZENTAO_UNAVAILABLE";
      if (code === "AUTH_FAILED") throw authFailed();
      // 接口错误的诊断和原始详情都留在传输层。
      if (failedEndpoint !== undefined)
        gaps.push({ endpoint: failedEndpoint, code });
    }
  }

  async function capture(route: CaptureRoute, sampleId?: number) {
    const { endpoint, pathTemplate, pathId, queryId, query } = route;
    if ((pathId || queryId) && sampleId === undefined) {
      gaps.push({ endpoint, code: "NOT_FOUND" });
      return;
    }
    const request = {
      pathTemplate,
      params: pathId && sampleId !== undefined ? { id: sampleId } : undefined,
      query:
        queryId && sampleId !== undefined
          ? { ...query, [queryId]: sampleId }
          : query,
      objectId: sampleId,
    } satisfies ReadRequest;
    const response = await read(request, endpoint);
    if (!response) return;
    const rows = collection(response.body, route.collection);
    rawSamples.push({
      ...response,
      endpoint,
      sample: rows?.length === 0 ? "empty" : "normal",
    });
    if (rows?.length) {
      const empty = emptyPageRequest(request, response.body, rows.length);
      if (empty) emptyPages.push({ route, request: empty });
    }
    return { body: response.body, rows };
  }

  const routes = captureRoutes;
  await capture(routes.instanceConfig);
  const user = await capture(routes.currentUser);
  const products = await capture(routes.products);
  const projects = await capture(routes.projects);
  const currentExecutions = await capture(routes.executionsV2);
  const allExecutions = await capture(routes.executionsV1);
  if (
    ![user, products, projects, currentExecutions, allExecutions].some(Boolean)
  ) {
    throw new BztError(
      "ZENTAO_UNAVAILABLE",
      "禅道核心读取入口均不可用，未生成夹具。",
    );
  }

  await capture(routes.requiredFields);
  const departments = await capture(routes.departments);
  const users = await capture(routes.users);
  const userData = fields(user?.body);
  const profile =
    fields(userData?.profile) ?? fields(fields(userData?.data)?.profile);
  const departmentId =
    id(profile?.dept) ??
    departmentFromTree(departments?.rows) ??
    entities(users?.rows)
      .map((row) => id(row.dept))
      .find((value) => value !== undefined);
  await capture(routes.usersByDepartment, departmentId);
  await capture(routes.myWork);
  await capture(routes.myContribute);

  const productId = requestedProductId ?? firstSample(entities(products?.rows));
  await capture(routes.productModules, productId);
  const plans = await capture(routes.productPlans, productId);
  const planRows = entities(plans?.rows);
  const childPlans = planRows.flatMap((plan) => list(plan.children) ?? []);
  const planId =
    firstSample(entities(childPlans)) ??
    firstSample(planRows, (plan) => id(plan.parent) !== undefined);
  await capture(routes.planDetail, planId);

  const stories = await capture(routes.productStories, productId);
  const requirements = await capture(routes.productRequirements, productId);
  // docs/06 §4 Q3、Q9：混返中只取对应类型，避免将用户需求发到 v1 详情。
  const storyRows = entities(stories?.rows).filter(
    (story) => story.type === "story",
  );
  const storyId = firstSample(
    storyRows,
    (story) =>
      story.status !== "closed" &&
      typeof story.stage === "string" &&
      taskSamplingStages.has(story.stage),
  );
  const requirementId = firstSample(
    entities(requirements?.rows).filter(
      (story) => story.type === undefined || story.type === "requirement",
    ),
  );
  const story = await capture(routes.storyDetail, storyId);
  await capture(routes.storyDetailV2, storyId);
  await capture(routes.requirementDetail, requirementId);

  const projectId = firstSample(entities(projects?.rows), (project) =>
    productOfProject(project, productId),
  );
  const executions = [
    ...entities(currentExecutions?.rows),
    ...entities(allExecutions?.rows),
  ];
  // docs/06 §3.1：需求详情中的关联执行比全局项目列表更贴近采集产品。
  const linkedExecutions = entities(collection(story?.body, ["executions"]));
  const executionId =
    firstSample(linkedExecutions) ??
    firstSample(
      executions,
      (execution) =>
        projectId !== undefined &&
        id(execution.project ?? execution.projectID) === projectId,
    );
  const tasks = await capture(routes.executionTasks, executionId);
  const taskId = firstSample(
    entities(tasks?.rows),
    (task) => task.mode === "linear" || task.mode === "multi",
  );
  await capture(routes.taskDetail, taskId);
  await capture(routes.productBugs, productId);
  await capture(routes.projectBugs, projectId);
  await capture(routes.releases, productId);
  await capture(routes.storyCreateMetadata, productId);

  for (const { route, request } of emptyPages) {
    // 正常样本已留存，补充空页失败不会造成端点缺口。
    const response = await read(request);
    if (response && collection(response.body, route.collection)?.length === 0) {
      rawSamples.push({
        ...response,
        endpoint: route.endpoint,
        sample: "empty",
      });
    }
  }

  // 登录账号按身份复扫，刷新前后的高敏凭据仍参加整批复扫。
  const fixtures = createCaptureFixtures(rawSamples, {
    knownSecrets: [...secrets],
    configuredAccount: options.account,
  });
  return createCaptureReport(fixtures, gaps);
}
