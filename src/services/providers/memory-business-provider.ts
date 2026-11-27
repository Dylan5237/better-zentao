import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import { currentUserDto, userDto } from "../../core/dto/org.ts";
import { productDto, productModuleMenuSchema } from "../../core/dto/product.ts";
import { productPlanDto } from "../../core/dto/plan.ts";
import { executionDto } from "../../core/dto/execution.ts";
import { taskDtoFor, taskDetailDtoFor } from "../../core/dto/task.ts";
import { bugDtoFor } from "../../core/dto/bug.ts";
import {
  storyDtoFor,
  storyDetailDtoFor,
  storyDetailV2DtoFor,
  requirementDetailDtoFor,
} from "../../core/dto/story.ts";
import type { Task } from "../../core/dto/task.ts";
import type { Story, StoryDetail } from "../../core/dto/story.ts";
import type { OperationGateway } from "../ports/operation-gateway.ts";
import type {
  BusinessProvider,
  PagedList,
} from "../ports/business-provider.ts";
import { parseZentaoDateTime } from "../../core/calendar.ts";
import { instanceHashOf } from "../../core/store/location.ts";
import { normalizeZentaoBaseUrl } from "../../core/base-url.ts";

/**
 * CR-009 §4.1（M1-BASE-01）：零禅道依赖的内存业务底座。
 * 不导入任何 src/api/* 与 ZentaoReadClient；DTO 均经 src/core/dto
 * 的 zod 白名单投影构造，与 HTTP 实现产出同构品牌对象。
 */

const timezone = "Asia/Shanghai";
const storyDto = storyDtoFor(timezone);
const storyDetailDto = storyDetailDtoFor(timezone);
const storyDetailV2Dto = storyDetailV2DtoFor(timezone);
const requirementDetailDto = requirementDetailDtoFor(timezone);
const taskDto = taskDtoFor(timezone);
const taskDetailDto = taskDetailDtoFor(timezone);
const bugDto = bugDtoFor(timezone);

const accountText = z.string().trim().min(1);
const positiveId = z.coerce.number().int().positive();

/** 能力覆盖：默认全部 verified，可注入任意状态模拟未验证/禁用/CLI-only。 */
export type MemoryCapabilityOverride = Readonly<{
  id: string;
  state: "verified" | "unverified" | "disabled" | "cli-only";
}>;

/** 读故障注入：source -> 错误码（映射为 BztError 以驱动 partial/gaps）。 */
export type MemoryReadFaultInput = Readonly<{ code: string }>;

export interface MemoryStorySeed {
  readonly id: number;
  readonly product: number;
  readonly module?: number | null;
  readonly title: string;
  readonly status?: string;
  readonly category?: "feature" | "design" | "other" | null;
  readonly assignedTo?: string | null;
  readonly openedBy?: string | null;
  readonly spec?: string | null;
  readonly verify?: string | null;
  readonly plan?: readonly number[];
  readonly executions?: readonly number[];
  readonly deleted?: boolean;
  readonly openedDate?: string | null;
  readonly lastEditedDate?: string | null;
  readonly closedDate?: string | null;
  readonly keywords?: string | null;
}

export interface MemoryTaskSeed {
  readonly id: number;
  readonly execution: number;
  readonly name: string;
  readonly status: Task["status"];
  readonly assignedTo?: string | null;
  readonly story?: number | null;
  readonly parent?: number | null;
  readonly isParent?: boolean;
  readonly deleted?: boolean;
  readonly deadline?: string | null;
  readonly estStarted?: string | null;
  readonly openedBy?: string | null;
}

export interface MemoryBugSeed {
  readonly id: number;
  readonly product: number;
  readonly title: string;
  readonly status?: string;
  readonly severity?: number;
  readonly story?: number | null;
  readonly deleted?: boolean;
}

export interface MemoryExecutionSeed {
  readonly id: number;
  readonly project: number;
  readonly name: string;
  readonly begin: string;
  readonly end: string;
  readonly status?: string;
  readonly type?: string;
}

export interface MemoryProductSeed {
  readonly id: number;
  readonly name: string;
  readonly deleted?: boolean;
  readonly modules?: readonly { id: number; name: string }[];
}

export interface MemoryPlanSeed {
  readonly id: number;
  readonly product: number;
  readonly parent?: number | null;
  readonly title: string;
  readonly begin?: string | null;
  readonly end?: string | null;
}

export interface MemoryStoryActionSeed {
  readonly storyId: number;
  readonly id: number;
  readonly actor: string;
  readonly action: string;
  readonly date?: string | null;
  readonly comment?: string | null;
}

export interface MemoryUserSeed {
  readonly id: number;
  readonly account: string;
  readonly realname: string;
  readonly role?: string | null;
  readonly dept?: number | null;
  readonly pinyin?: string | null;
  readonly deleted?: boolean;
}

/** 写故障注入：模拟透传成功、明确拒绝、超时/unknown、回读不一致与并发外部编辑。 */
export type MemoryWriteFault =
  | { readonly kind: "ok" }
  | {
      readonly kind: "reject";
      readonly code: "ZENTAO_BUSINESS_ERROR" | "PERMISSION_DENIED";
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "readbackMismatch" }
  | { readonly kind: "externalEdit" };

export interface MemoryProviderSeed {
  readonly baseUrl?: string;
  readonly instanceHash?: string;
  readonly currentUser?: MemoryUserSeed | undefined;
  readonly users?: readonly MemoryUserSeed[];
  readonly products?: readonly MemoryProductSeed[];
  readonly plans?: readonly MemoryPlanSeed[];
  readonly executions?: readonly MemoryExecutionSeed[];
  readonly stories?: readonly MemoryStorySeed[];
  readonly storyActions?: readonly MemoryStoryActionSeed[];
  readonly tasks?: readonly MemoryTaskSeed[];
  readonly bugs?: readonly MemoryBugSeed[];
  readonly capabilities?: readonly MemoryCapabilityOverride[];
  /** 读路径故障：source 名称 -> 故障定义。 */
  readonly readFaults?: Readonly<Record<string, MemoryReadFaultInput>>;
  /** 写路径故障：action 名称 -> 故障序列（按调用次数依次消耗）。 */
  readonly writeFaults?: Readonly<Record<string, readonly MemoryWriteFault[]>>;
}

interface MemoryStory {
  readonly id: number;
  readonly product: number;
  readonly module: number | null;
  readonly title: string;
  status: string;
  category: "feature" | "design" | "other" | null;
  assignedTo: string | null;
  readonly openedBy: string | null;
  readonly spec: string | null;
  readonly verify: string | null;
  plan: number[];
  readonly executions: number[];
  readonly deleted: boolean;
  readonly openedDate: string | null;
  lastEditedDate: string | null;
  readonly closedDate: string | null;
  keywords: string | null;
  linkStories: number[];
}

interface MemoryTask {
  readonly id: number;
  readonly execution: number;
  readonly name: string;
  readonly status: Task["status"];
  readonly assignedTo: string | null;
  readonly story: number | null;
  readonly parent: number | null;
  readonly isParent: boolean;
  readonly deleted: boolean;
  readonly deadline: string | null;
  readonly estStarted: string | null;
  readonly openedBy: string | null;
}

const defaultBaseUrl = "https://memory.fixture.test/";

function page<T>(items: readonly T[]): PagedList<T> {
  return { items: [...items], truncated: false };
}

function zentaoMs(value: string | null): number {
  if (value === null) return 0;
  return parseZentaoDateTime(value, timezone) ?? 0;
}

function memoryFault(source: string, fault: MemoryReadFaultInput): never {
  throw new BztError("ZENTAO_UNAVAILABLE", "内存底座读取故障。", {
    completeness: "partial",
    gaps: [{ source, reason: `注入故障（${fault.code}）。` }],
  });
}

/**
 * CR-009 PC-02：内存业务底座。写入直接变更内部状态并计数，
 * 供测试断言“拒绝路径上游写入数为 0”。
 */
export type MemoryBusinessProvider = BusinessProvider & {
  upstreamWriteCount(): number;
  inspectStory(storyId: number): MemoryStory | undefined;
  mutateStory(
    storyId: number,
    patch: { readonly assignedTo?: string | null; readonly status?: string },
  ): void;
};

export function createMemoryBusinessProvider(
  seed: MemoryProviderSeed = {},
): MemoryBusinessProvider {
  const baseUrl = seed.baseUrl ?? defaultBaseUrl;
  // 与 LocalStore 同口径：从归一化 baseUrl 派生实例哈希（执行器会交叉校验）。
  const instanceHash =
    seed.instanceHash ??
    instanceHashOf(normalizeZentaoBaseUrl(baseUrl)?.href ?? baseUrl);
  const users = [...(seed.users ?? [])];
  const products = new Map<
    number,
    {
      id: number;
      name: string;
      deleted: boolean;
      modules: { id: number; name: string }[];
    }
  >();
  const plans = new Map<
    number,
    {
      id: number;
      product: number;
      parent: number | null;
      title: string;
      begin: string | null;
      end: string | null;
    }
  >();
  const executions = new Map<
    number,
    {
      id: number;
      project: number;
      name: string;
      begin: string;
      end: string;
      status: string;
      type: string;
    }
  >();
  const stories = new Map<number, MemoryStory>();
  const storyActions = new Map<
    number,
    {
      id: number;
      actor: string;
      action: string;
      date: string | null;
      comment: string | null;
    }[]
  >();
  const tasks = new Map<number, MemoryTask>();
  const bugs = new Map<
    number,
    {
      id: number;
      product: number;
      title: string;
      status: string;
      severity: number;
      story: number | null;
      deleted: boolean;
    }
  >();
  const capabilityOverrides = new Map<
    string,
    MemoryCapabilityOverride["state"]
  >((seed.capabilities ?? []).map(({ id, state }) => [id, state]));
  const readFaults: Record<string, MemoryReadFaultInput> = {
    ...(seed.readFaults ?? {}),
  };
  const writeFaults = new Map<string, readonly MemoryWriteFault[]>(
    Object.entries(seed.writeFaults ?? {}).map(([action, faults]) => [
      action,
      [...faults],
    ]),
  );
  const writeFaultCursor = new Map<string, number>();
  const upstreamWrites = { count: 0 };
  let nextStoryId = 1;
  let nextActionId = 1;

  for (const product of seed.products ?? [])
    products.set(product.id, {
      id: product.id,
      name: product.name,
      deleted: product.deleted ?? false,
      modules: [...(product.modules ?? [])],
    });
  for (const plan of seed.plans ?? [])
    plans.set(plan.id, {
      id: plan.id,
      product: plan.product,
      parent: plan.parent ?? null,
      title: plan.title,
      begin: plan.begin ?? null,
      end: plan.end ?? null,
    });
  for (const execution of seed.executions ?? [])
    executions.set(execution.id, {
      id: execution.id,
      project: execution.project,
      name: execution.name,
      begin: execution.begin,
      end: execution.end,
      status: execution.status ?? "doing",
      type: execution.type ?? "sprint",
    });
  for (const story of seed.stories ?? [])
    stories.set(story.id, {
      id: story.id,
      product: story.product,
      module: story.module ?? null,
      title: story.title,
      status: story.status ?? "draft",
      category: story.category ?? "feature",
      assignedTo: story.assignedTo ?? null,
      openedBy: story.openedBy ?? currentAccount(),
      spec: story.spec ?? null,
      verify: story.verify ?? null,
      plan: [...(story.plan ?? [])],
      executions: [...(story.executions ?? [])],
      deleted: story.deleted ?? false,
      openedDate: story.openedDate ?? "2026-11-01 08:00:00",
      lastEditedDate: story.lastEditedDate ?? null,
      closedDate: story.closedDate ?? null,
      keywords: story.keywords ?? null,
      linkStories: [],
    });
  for (const action of seed.storyActions ?? []) {
    const rows = storyActions.get(action.storyId) ?? [];
    rows.push({
      id: action.id,
      actor: action.actor,
      action: action.action,
      date: action.date ?? null,
      comment: action.comment ?? null,
    });
    storyActions.set(action.storyId, rows);
  }
  for (const task of seed.tasks ?? [])
    tasks.set(task.id, {
      id: task.id,
      execution: task.execution,
      name: task.name,
      status: task.status,
      assignedTo: task.assignedTo ?? null,
      story: task.story ?? null,
      parent: task.parent ?? null,
      isParent: task.isParent ?? false,
      deleted: task.deleted ?? false,
      deadline: task.deadline ?? null,
      estStarted: task.estStarted ?? null,
      openedBy: task.openedBy ?? currentAccount(),
    });
  for (const bug of seed.bugs ?? [])
    bugs.set(bug.id, {
      id: bug.id,
      product: bug.product,
      title: bug.title,
      status: bug.status ?? "active",
      severity: bug.severity ?? 3,
      story: bug.story ?? null,
      deleted: bug.deleted ?? false,
    });

  function currentAccount(): string {
    return seed.currentUser?.account ?? users[0]?.account ?? "memory-user";
  }

  function requireStory(storyId: number): MemoryStory {
    const story = stories.get(storyId);
    if (!story || story.deleted)
      throw new BztError("NOT_FOUND", "内存底座未找到该需求。", { storyId });
    return story;
  }

  function checkRead(source: string): void {
    const fault = readFaults[source];
    if (fault) memoryFault(source, fault);
  }

  function consumeWriteFault(action: string): MemoryWriteFault | undefined {
    const cursor = writeFaultCursor.get(action) ?? 0;
    const faults = writeFaults.get(action);
    const fault = faults?.[cursor];
    if (fault) writeFaultCursor.set(action, cursor + 1);
    return fault;
  }

  function storyDtoOf(story: MemoryStory): Story {
    return storyDto.parse({
      id: story.id,
      type: "story",
      product: story.product,
      title: story.title,
      status: story.status,
      module: story.module,
      plan: story.plan.length ? story.plan.join(",") : undefined,
      category: story.category ?? undefined,
      assignedTo: story.assignedTo ?? undefined,
      openedBy: story.openedBy ?? undefined,
      openedDate: story.openedDate ?? undefined,
      closedDate: story.closedDate ?? undefined,
      lastEditedDate: story.lastEditedDate ?? undefined,
      keywords: story.keywords ?? undefined,
      deleted: story.deleted,
      linkStories: story.linkStories.length
        ? story.linkStories.join(",")
        : undefined,
    });
  }

  function storyDetailDtoOf(story: MemoryStory): StoryDetail {
    return storyDetailDto.parse({
      ...storyPlain(story),
      spec: story.spec ?? undefined,
      verify: story.verify ?? undefined,
      executions: story.executions.map((id) => ({
        id,
        name: `execution-${id}`,
      })),
      tasks: [],
      bugs: [],
      actions: (storyActions.get(story.id) ?? []).map((action) => ({
        id: action.id,
        actor: action.actor,
        action: action.action,
        date: action.date ?? undefined,
        comment: action.comment ?? undefined,
      })),
      requirements: [],
    });
  }

  function storyPlain(story: MemoryStory) {
    return {
      id: story.id,
      type: "story" as const,
      product: story.product,
      title: story.title,
      status: story.status,
      module: story.module,
      plan: story.plan.length ? story.plan.join(",") : undefined,
      category: story.category ?? undefined,
      assignedTo: story.assignedTo ?? undefined,
      openedBy: story.openedBy ?? undefined,
      openedDate: story.openedDate ?? undefined,
      closedDate: story.closedDate ?? undefined,
      lastEditedDate: story.lastEditedDate ?? undefined,
      keywords: story.keywords ?? undefined,
      deleted: story.deleted,
      linkStories: story.linkStories.length
        ? story.linkStories.join(",")
        : undefined,
    };
  }

  function taskDtoOf(task: MemoryTask): Task {
    return taskDto.parse({
      id: task.id,
      execution: task.execution,
      name: task.name,
      status: task.status,
      assignedTo: task.assignedTo ?? undefined,
      story: task.story,
      parent: task.parent,
      isParent: task.isParent,
      deleted: task.deleted,
      deadline: task.deadline ?? "",
      estStarted: task.estStarted ?? "",
      openedBy: task.openedBy ?? undefined,
      type: "devel",
      mode: "single",
      estimate: 0,
      consumed: 0,
      left: 0,
    });
  }

  const gateway: OperationGateway = {
    async readTarget({ id, product, type }) {
      const storyId = positiveId.parse(id);
      const story = requireStory(storyId);
      if (story.product !== product)
        throw new BztError("NOT_FOUND", "未找到目标产品内的需求。");
      return {
        id: story.id,
        type,
        product,
        status: story.status,
        maintainer: null,
        assignedTo: story.assignedTo,
        plan: story.plan,
        executions: story.executions,
        lastEditedDate: story.lastEditedDate
          ? parseZentaoDateTime(story.lastEditedDate, timezone)
          : null,
        spec: story.spec,
      };
    },
    async write(request) {
      const action = request.step.action;
      const fault = consumeWriteFault(action);
      if (fault && fault.kind !== "ok") {
        if (fault.kind === "reject")
          throw new BztError(fault.code, "内存底座注入写入拒绝。", {
            phase: "pre_send",
          });
        if (fault.kind === "unknown") return {};
        if (fault.kind === "readbackMismatch") {
          const existing = request.id;
          if (existing !== undefined) return { id: existing };
          upstreamWrites.count += 1;
          return { id: createStory(request) };
        }
        // externalEdit：写入成功但目标被并发外部修改（触发 PLAN_STALE 场景）。
        upstreamWrites.count += 1;
        const created = applyWrite(request);
        mutateExternally(request);
        return created;
      }
      upstreamWrites.count += 1;
      return applyWrite(request);
    },
    async readback(request) {
      const zentaoId = request.zentaoId;
      if (zentaoId === undefined) return { verified: false };
      const story = stories.get(zentaoId);
      if (!story) return { verified: false };
      const { step } = request;
      let verified = true;
      switch (step.action) {
        case "story.assign":
          verified = story.assignedTo === step.fields.assignedTo?.value;
          break;
        case "story.activate":
          verified = story.status === "active";
          break;
        case "story.close":
          verified = story.status === "closed";
          break;
        case "story.edit":
          verified =
            (step.fields.keywords === undefined ||
              (story.keywords ?? "") === step.fields.keywords.value) &&
            (step.fields.plan === undefined ||
              story.plan.includes(positiveId.parse(step.fields.plan.value)));
          break;
        case "story.linkExecution":
          verified = story.executions.includes(
            positiveId.parse(step.fields.execution?.value),
          );
          break;
        default:
          verified = true;
      }
      if (!verified) return { verified: false };
      return {
        verified: true,
        snapshot: {
          id: story.id,
          type: step.type,
          product: story.product,
          status: story.status,
          maintainer: null,
          assignedTo: story.assignedTo,
          plan: story.plan,
          executions: story.executions,
          lastEditedDate: story.lastEditedDate
            ? parseZentaoDateTime(story.lastEditedDate, timezone)
            : null,
          spec: story.spec,
        },
      };
    },
    async reverseLookup(query) {
      const rows = [...stories.values()].filter(
        (story) =>
          story.product === query.product &&
          story.title === query.title &&
          story.openedBy === query.createdBy &&
          story.openedDate !== null &&
          (parseZentaoDateTime(story.openedDate, timezone) ?? 0) >=
            query.since &&
          (parseZentaoDateTime(story.openedDate, timezone) ?? 0) <= query.until,
      );
      return {
        complete: true,
        matches: rows.map((story) => ({
          id: story.id,
          product: story.product,
          title: story.title,
          createdBy: story.openedBy ?? "",
          createdAt: zentaoMs(story.openedDate),
        })),
      };
    },
  };

  const provider: MemoryBusinessProvider = {
    providerId: "memory",
    baseUrl,
    instanceHash,
    async getCurrentUser() {
      checkRead("me");
      const me = seed.currentUser ?? users[0];
      if (!me) throw new BztError("AUTH_FAILED", "内存底座未配置当前用户。");
      return currentUserDto.parse({
        profile: {
          id: me.id,
          account: me.account,
          realname: me.realname,
          dept: me.dept ?? 0,
          role: me.role ?? undefined,
        },
      });
    },
    async listUsers() {
      checkRead("users");
      return page(
        users.map((user) =>
          userDto.parse({
            id: user.id,
            account: user.account,
            realname: user.realname,
            dept: user.dept ?? 0,
            role: user.role ?? undefined,
            pinyin: user.pinyin ?? undefined,
            deleted: user.deleted ?? false,
          }),
        ),
      );
    },
    async listProducts() {
      checkRead("products");
      return page(
        [...products.values()].map((product) =>
          productDto.parse({
            id: product.id,
            name: product.name,
            status: "normal",
            deleted: product.deleted,
          }),
        ),
      );
    },
    async listProductModules(productId) {
      checkRead(`modules:${productId}`);
      const product = products.get(productId);
      if (!product)
        throw new BztError("NOT_FOUND", "内存底座未找到该产品。", {
          productId,
        });
      const menu = productModuleMenuSchema.parse({
        id: productId,
        moduleOptionMenu: product.modules,
      });
      return menu.items;
    },
    async listProductPlans(productId) {
      checkRead(`plans:${productId}`);
      return page(
        [...plans.values()]
          .filter((plan) => plan.product === productId)
          .map((plan) =>
            productPlanDto.parse({
              id: plan.id,
              product: plan.product,
              parent: plan.parent,
              title: plan.title,
              status: "wait",
              begin: plan.begin ?? "",
              end: plan.end ?? "",
              deleted: false,
              children: [],
            }),
          ),
      );
    },
    async listExecutions() {
      checkRead("executions");
      return page(
        [...executions.values()].map((execution) =>
          executionDto.parse({
            id: execution.id,
            project: execution.project,
            name: execution.name,
            type: execution.type,
            status: execution.status,
            begin: execution.begin,
            end: execution.end,
          }),
        ),
      );
    },
    async listExecutionTasks(executionId) {
      checkRead(`tasks:${executionId}`);
      return page(
        [...tasks.values()]
          .filter((task) => task.execution === executionId)
          .map(taskDtoOf),
      );
    },
    async getTaskDetail(taskId) {
      checkRead(`task:${taskId}`);
      const task = tasks.get(taskId);
      if (!task || task.deleted)
        throw new BztError("NOT_FOUND", "内存底座未找到该任务。", { taskId });
      return taskDetailDto.parse({
        ...taskDtoOf(task),
        team: [],
        children: [],
        actions: [],
      });
    },
    async listProductBugs(productId) {
      checkRead(`bugs:${productId}`);
      return page(
        [...bugs.values()]
          .filter((bug) => bug.product === productId && !bug.deleted)
          .map((bug) =>
            bugDto.parse({
              id: bug.id,
              product: bug.product,
              title: bug.title,
              status: bug.status,
              severity: bug.severity,
              story: bug.story ?? undefined,
              deleted: bug.deleted,
            }),
          ),
      );
    },
    async getStoryDetail(storyId) {
      checkRead(`story:${storyId}`);
      return storyDetailDtoOf(requireStory(storyId));
    },
    async listProductStories(productId) {
      checkRead(`stories:${productId}`);
      return page(
        [...stories.values()]
          .filter((story) => story.product === productId)
          .map(storyDtoOf),
      );
    },
    async getStoryDetailV2(storyId) {
      checkRead(`story:${storyId}`);
      const story = requireStory(storyId);
      return storyDetailV2Dto.parse({
        story: {
          ...storyPlain(story),
          tasks: [],
          reviewer: [],
          spec: story.spec ?? undefined,
          verify: story.verify ?? undefined,
        },
        actions: (storyActions.get(storyId) ?? []).map((action) => ({
          id: action.id,
          actor: action.actor,
          action: action.action,
          date: action.date ?? undefined,
          comment: action.comment ?? undefined,
        })),
        bugs: [],
        relations: [],
      });
    },
    async listProductRequirements(productId) {
      checkRead(`requirements:${productId}`);
      return page(
        [...stories.values()]
          .filter((story) => story.product === productId)
          .map(storyDtoOf),
      );
    },
    async getRequirementDetail(requirementId) {
      checkRead(`requirement:${requirementId}`);
      const story = requireStory(requirementId);
      return requirementDetailDto.parse({
        story: {
          ...storyPlain(story),
          type: "requirement",
          tasks: [],
          reviewer: [],
          spec: story.spec ?? undefined,
          verify: story.verify ?? undefined,
        },
        actions: [],
        bugs: [],
        relations: [],
      });
    },
    createOperationGateway(options) {
      void options;
      return gateway;
    },
    async resolveInstanceVersion() {
      return "22.6";
    },
    checkCapability(id, options) {
      const state = capabilityOverrides.get(id) ?? "verified";
      if (state === "unverified")
        throw new BztError(
          "CAPABILITY_UNVERIFIED",
          "内存底座将该能力标记为未验证。",
          { capability: id },
        );
      if (state === "disabled")
        throw new BztError(
          "CAPABILITY_DISABLED",
          "内存底座将该能力标记为已禁用。",
          { capability: id },
        );
      if (state === "cli-only" && options.channel !== "cli")
        throw new BztError(
          "CAPABILITY_CLI_ONLY",
          "内存底座将该能力标记为仅限 CLI。",
          { capability: id },
        );
    },
    formatObjectUrl(type, id) {
      return new URL(`${type}-view-${id}.html`, baseUrl).href;
    },
    /** 测试辅助：断言拒绝路径零上游写入。 */
    upstreamWriteCount(): number {
      return upstreamWrites.count;
    },
    /** 测试辅助：直接读取内部故事状态。 */
    inspectStory(storyId: number): MemoryStory | undefined {
      return stories.get(storyId);
    },
    /** 测试辅助：模拟外部并发修改以触发 PLAN_STALE。 */
    mutateStory(
      storyId: number,
      patch: { readonly assignedTo?: string | null; readonly status?: string },
    ): void {
      const story = stories.get(storyId);
      if (!story) return;
      if (patch.assignedTo !== undefined) story.assignedTo = patch.assignedTo;
      if (patch.status !== undefined) story.status = patch.status;
    },
  };
  return provider;

  function createStory(
    request: Parameters<OperationGateway["write"]>[0],
  ): number {
    const fields = request.step.fields;
    const title = accountText.parse(fields.title?.value ?? "");
    const storyId = nextStoryId++;
    stories.set(storyId, {
      id: storyId,
      product: request.step.product,
      module: null,
      title,
      status: "draft",
      category: "feature",
      assignedTo:
        typeof fields.assignedTo?.value === "string"
          ? fields.assignedTo.value
          : null,
      openedBy: currentAccount(),
      spec: typeof fields.spec?.value === "string" ? fields.spec.value : null,
      verify: null,
      plan: [],
      executions: [],
      deleted: false,
      openedDate: "2026-11-24 08:00:00",
      lastEditedDate: null,
      closedDate: null,
      keywords: null,
      linkStories: [],
    });
    return storyId;
  }

  function mutateExternally(
    request: Parameters<OperationGateway["write"]>[0],
  ): void {
    const id = request.id;
    if (id === undefined) return;
    const story = stories.get(id);
    if (!story) return;
    stories.set(id, {
      ...story,
      status: story.status === "closed" ? story.status : "externally-edited",
      lastEditedDate: "2026-11-24 09:00:00",
    });
  }

  function applyWrite(request: Parameters<OperationGateway["write"]>[0]): {
    id?: number;
    actionId?: number;
  } {
    const { step, id } = request;
    const fields = Object.fromEntries(
      Object.entries(step.fields).map(([key, field]) => [key, field.value]),
    );
    if (createsObject(step.action) && id === undefined) {
      const storyId = nextStoryId++;
      stories.set(storyId, {
        id: storyId,
        product: step.product,
        module: typeof fields.module === "number" ? fields.module : null,
        title: accountText.parse(fields.title ?? ""),
        status: typeof fields.status === "string" ? fields.status : "draft",
        category:
          fields.category === "design"
            ? "design"
            : fields.category === "feature"
              ? "feature"
              : "other",
        assignedTo:
          typeof fields.assignedTo === "string" ? fields.assignedTo : null,
        openedBy: currentAccount(),
        spec: typeof fields.spec === "string" ? fields.spec : null,
        verify: null,
        plan: [],
        executions: [],
        deleted: false,
        openedDate: "2026-11-24 08:00:00",
        lastEditedDate: null,
        closedDate: null,
        keywords: null,
        linkStories: [],
      });
      return { id: storyId };
    }
    if (id === undefined) return {};
    const story = stories.get(id);
    if (!story) return {};
    const next: MemoryStory = { ...story };
    if (step.action === "story.assign") {
      next.assignedTo = accountText.parse(fields.assignedTo ?? "");
    } else if (step.action === "story.activate") {
      next.status = "active";
    } else if (step.action === "story.edit") {
      if (typeof fields.keywords === "string") next.keywords = fields.keywords;
      if (typeof fields.plan === "number") next.plan = [fields.plan];
    } else if (step.action === "story.close") {
      next.status = "closed";
    } else if (step.action === "story.comment") {
      const actionId = nextActionId++;
      const rows = storyActions.get(id) ?? [];
      rows.push({
        id: actionId,
        actor: currentAccount(),
        action: "commented",
        date: "2026-11-24 08:01:00",
        comment: accountText.parse(fields.comment ?? ""),
      });
      storyActions.set(id, rows);
      return { actionId };
    } else if (step.action === "story.linkStory") {
      const storiesArg = fields.stories;
      const first = Array.isArray(storiesArg) ? storiesArg[0] : undefined;
      const target = positiveId.parse(first);
      next.linkStories = [...new Set([...story.linkStories, target])];
    }
    stories.set(id, next);
    return { id };
  }
}

function createsObject(action: string): boolean {
  return (
    action === "story.create" ||
    action === "story.create.design" ||
    action === "story.create.feedbackBy"
  );
}
