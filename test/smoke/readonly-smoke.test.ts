import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { listProductBugs } from "../../src/api/bug.ts";
import {
  createZentaoReadClient,
  type ZentaoReadClient,
} from "../../src/api/client.ts";
import { listExecutions, listProjects } from "../../src/api/execution.ts";
import {
  getCurrentUser,
  getDepartments,
  getInstanceConfig,
  getRequiredFields,
  listUsers,
} from "../../src/api/org.ts";
import { listProductPlans } from "../../src/api/plan.ts";
import { getProductModules, listProducts } from "../../src/api/product.ts";
import {
  getStoryCreateMetadata,
  getStoryDetail,
  listProductStories,
} from "../../src/api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../../src/api/task.ts";
import {
  findMissingEnv,
  readConfigEnvironment,
} from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

describe("P0 禅道只读冒烟（09 §7 / S01）", () => {
  let client: ZentaoReadClient;
  const secrets = new Set<string>();
  const logs: string[] = [];

  beforeAll(() => {
    const env = process.env;
    const missing = findMissingEnv(env);
    if (missing.length) {
      throw new Error(`只读冒烟缺少必填环境变量（${missing.join("、")}）。`);
    }

    const {
      zentao: { baseUrl, account },
    } = readConfigEnvironment({
      ZENTAO_BASE_URL: env.ZENTAO_BASE_URL,
      ZENTAO_ACCOUNT: env.ZENTAO_ACCOUNT,
      ZENTAO_TIMEOUT_MS: env.ZENTAO_TIMEOUT_MS,
    });
    const password = env.ZENTAO_PASSWORD;
    if (!baseUrl || !account || !password)
      throw new Error("只读冒烟配置不完整。");
    secrets.add(baseUrl);
    secrets.add(password);

    const login = new URL("api.php/v1/tokens", baseUrl).href;
    const send = globalThis.fetch;
    const readOnlyFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        !url.startsWith(baseUrl) ||
        (method !== "GET" && (method !== "POST" || url !== login))
      ) {
        throw new Error("只读冒烟已拦截超出范围的请求。");
      }
      const token = new Headers(init?.headers).get("Token");
      if (token) secrets.add(token);
      return send(input, init);
    };
    vi.stubGlobal("fetch", readOnlyFetch);
    client = createZentaoReadClient({
      baseUrl,
      account,
      password,
      env,
      clock: () => Date.now(),
      logSink: (line) => logs.push(line),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    assertNoSensitiveData(logs, [...secrets]);
  });

  async function checkedRead<T>(
    endpoint: string,
    read: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await read();
    } catch (error) {
      const reason = error instanceof BztError ? error.code : "读取失败";
      throw new Error(`${endpoint} ${reason}`);
    }
    try {
      assertNoSensitiveData(result, [...secrets]);
    } catch {
      throw new Error(`${endpoint} 未通过 S01 复扫。`);
    }
    return result;
  }

  async function checkedList<T>(
    endpoint: string,
    read: () => Promise<{ items: T[]; truncated: boolean }>,
  ): Promise<T[]> {
    const { items, truncated } = await checkedRead(endpoint, read);
    if (truncated) throw new Error(`${endpoint} 分页读取不完整。`);
    return items;
  }

  it("实例设置、登录身份、必填字段、部门和人员目录可投影", async () => {
    await Promise.all([
      checkedRead("getInstanceConfig", () => getInstanceConfig(client)),
      checkedRead("getCurrentUser", () => getCurrentUser(client)),
      checkedRead("getRequiredFields", () => getRequiredFields(client)),
      checkedRead("getDepartments", () => getDepartments(client)),
      checkedList("listUsers", () => listUsers(client)),
    ]);
  });

  it("产品、模块、计划、研发需求列表和详情、Bug 及创建表单元数据可投影", async () => {
    const products = await checkedList("listProducts", () =>
      listProducts(client),
    );
    for (const product of products) {
      if (product.deleted) continue;
      const stories = await checkedList("listProductStories", () =>
        listProductStories(client, product.id),
      );
      const story = stories.find((item) => !item.deleted);
      if (!story) continue;
      const [detail] = await Promise.all([
        checkedRead("getStoryDetail", () => getStoryDetail(client, story.id)),
        checkedRead("getProductModules", () =>
          getProductModules(client, product.id),
        ),
        checkedList("listProductPlans", () =>
          listProductPlans(client, product.id),
        ),
        checkedList("listProductBugs", () =>
          listProductBugs(client, product.id),
        ),
        checkedRead("getStoryCreateMetadata", () =>
          getStoryCreateMetadata(client, product.id),
        ),
      ]);
      if (detail.id !== story.id || detail.product !== product.id) {
        throw new Error("getStoryDetail 回读身份或产品归属不一致。");
      }
      return;
    }
    throw new Error("getStoryDetail 缺少可读的研发需求样本。");
  });

  it("项目、执行、执行任务列表和任务详情可投影", async () => {
    const [, executions] = await Promise.all([
      checkedList("listProjects", () => listProjects(client)),
      checkedList("listExecutions", () => listExecutions(client)),
    ]);
    for (const execution of executions) {
      const tasks = await checkedList("listExecutionTasks", () =>
        listExecutionTasks(client, execution.id),
      );
      const task = tasks.find((item) => !item.deleted);
      if (!task) continue;
      const detail = await checkedRead("getTaskDetail", () =>
        getTaskDetail(client, task.id),
      );
      if (detail.id !== task.id || detail.execution !== execution.id) {
        throw new Error("getTaskDetail 回读身份或执行归属不一致。");
      }
      return;
    }
    throw new Error("getTaskDetail 缺少可读的执行任务样本。");
  });
});
