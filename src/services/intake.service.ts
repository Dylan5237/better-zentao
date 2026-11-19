import type { ProductApi } from "../api/product.api.js";
import { noCreateRetry, type StoryApi } from "../api/story.api.js";
import type { AssignResult, Module, Plan, Product, StoryPayload } from "../api/types.js";
import { batchDetails, markStory } from "../core/ai-mark.js";
import type { BetterZentaoConfig, Mode } from "../core/config.js";
import { InvalidParamError, ZentaoCreateUnconfirmedError, ZentaoError } from "../core/errors.js";
import type { UserRef } from "../core/normalizer.js";
import type { DirectoryService } from "./directory.service.js";
import {
  assignInput, createInput, deleteInput, importInput, validateInput,
  type AssignInput, type CreateInput, type DeleteInput, type ImportInput,
} from "./inputs.js";

interface Preflight {
  requiredFields: string[];
  modules: Map<number, Promise<Module[]>>;
}

interface Draft {
  product: Product;
  resolvedModule: Module | null;
  resolvedPlan: Plan | null;
  resolvedAssignTo: UserRef | null;
  payloadPreview: StoryPayload;
  apiVersion: 1 | 2;
  errors: string[];
  warnings: string[];
  availableModules: Module[];
  candidatePlans: Plan[];
}

interface LinkResult {
  storyIds: number[];
  requirementId?: number;
}

interface Receipt {
  product: Product;
  category: StoryPayload["category"];
  id?: number;
  url?: string;
  readbackConfirmed: boolean;
  differences?: string[];
  assignResult: AssignResult | null;
  linkResult: LinkResult | null;
  linkError?: string;
  notice: string;
  error?: { code: string; message: string };
}

const writableFields = new Set([
  "product", "title", "spec", "type", "category", "pri", "status", "reviewer", "module", "modules",
  "assignedTo", "plan", "feedbackBy", "source", "sourceNote", "verify", "needNotReview",
]);
const feedbackSources = new Set(["customer", "user", "market", "service", "operation", "support", "forum"]);

function requiredIssues(fields: string[], values: StoryPayload & { product: number }) {
  const data = new Map(Object.entries(values));
  return [...new Set(fields.flatMap(field => {
    if (!writableFields.has(field)) return ["禅道要求当前工具尚未支持的创建字段，请核对必填配置。"];
    const value = data.get(field);
    const missing = value === undefined || value === null || value === 0 ||
      (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
    return missing ? ["缺少禅道必填项 " + (field === "assignedTo" ? "assignTo（指派人）" : field)] : [];
  }))];
}

function complete(result: Receipt): boolean {
  return result.readbackConfirmed && result.assignResult?.confirmed !== false && !result.linkError;
}

function summarize(results: Receipt[]) {
  return {
    created: results.filter(result => result.id !== undefined).length,
    failed: results.filter(result => result.id === undefined).length,
    readbackUnconfirmed: results.filter(result => result.id !== undefined && !result.readbackConfirmed).length,
  };
}

export class IntakeService {
  constructor(
    private readonly directory: DirectoryService,
    private readonly product: ProductApi,
    private readonly story: StoryApi,
    private readonly config: Pick<BetterZentaoConfig, "mode" | "defaults" | "aiMark">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private checkMode(mode: Mode, skipReview: boolean | undefined) {
    if (mode === "strict-ai" && skipReview) throw new InvalidParamError("strict-ai 模式要求草稿状态，请移除 skipReview");
  }

  private async getAssignee(name: string): Promise<UserRef> {
    const match = await this.directory.findUser(name);
    if (match.ambiguous) throw new InvalidParamError("指派人有多个候选，请用 resolve_context 核对后指定账号");
    const user = match.candidates[0];
    if (!user) throw new InvalidParamError("未找到指派人，请核对账号或姓名");
    return { account: user.account, realname: user.realname };
  }

  private loadModules(id: number, preflight: Preflight) {
    let pending = preflight.modules.get(id);
    if (!pending) {
      pending = this.product.modules(id);
      preflight.modules.set(id, pending);
    }
    return pending;
  }

  private async drafts(input: CreateInput, mode: Mode, batch: ReturnType<typeof batchDetails>, preflight: Preflight) {
    const selections = input.states ? [...new Set(input.states)].map(state => ({ state })) : [input];
    const commonIssues: string[] = [];
    const [products, assignee] = await Promise.all([
      Promise.all(selections.map(selection => this.directory.chooseProduct(selection))),
      input.assignTo ? this.getAssignee(input.assignTo).catch((error: unknown) => {
        if (!(error instanceof InvalidParamError)) throw error;
        commonIssues.push(error.message);
        return null;
      }) : null,
    ]);
    if (input.requirementId !== undefined) {
      try {
        const requirement = await this.story.get(input.requirementId, "requirement");
        if (requirement.deleted) commonIssues.push("指定的用户需求已删除，请核对 requirementId。");
      } catch {
        commonIssues.push("无法回读指定的用户需求，请核对 requirementId 和访问权限。");
      }
    }
    const targets = [...new Map(products.map(product => [product.id, product])).values()];
    const categories = input.createDevPair ? ["design", "feature"] as const : [input.category ?? this.config.defaults.defaultCategory];
    const shareBatch = targets.length * categories.length > 1 || Boolean(input.batch);
    const marked = markStory(input, mode, this.config.aiMark, batch, shareBatch);
    const assignmentAtCreate = preflight.requiredFields.includes("assignedTo");

    const sets = await Promise.all(targets.map(async product => {
      const [availableModules, candidatePlans, plan, metadata] = await Promise.all([
        this.loadModules(product.id, preflight), this.directory.activeL3Plans(product.id),
        input.plan !== undefined ? this.directory.findPlan(product.id, input.plan) : undefined,
        input.skipReview ? this.product.storyCreateMetadata(product.id) : undefined,
      ]);
      const module = input.module !== undefined ? this.directory.findModule(input.module, availableModules) : undefined;
      const resolvedModule = module?.candidates.length === 1 ? module.candidates[0] : null;
      const resolvedPlan = plan?.candidates.length === 1 ? plan.candidates[0] : null;
      const errors = [...commonIssues];
      if (module && !resolvedModule) errors.push("无法唯一定位本产品的需求模块，请从 availableModules 选择 ID。");
      if (plan && !resolvedPlan) errors.push("无法唯一定位本产品的需求计划，请核对计划 ID。");
      if (metadata?.forceReview) errors.push("目标产品要求评审，请改为提交草稿。");
      const warnings = resolvedPlan?.level === "L3" ? [] : ["未关联 L3 计划，请查看本产品的活跃候选计划。"];
      if (input.feedbackBy && !feedbackSources.has(marked.source)) {
        warnings.push("当前来源可能使禅道清空 feedbackBy，写后需核对实际反馈者。");
      }
      const moduleId = resolvedModule?.id;
      return categories.map((category): Draft => {
        const payloadPreview: StoryPayload = {
          ...marked, type: "story", category, pri: input.pri ?? this.config.defaults.defaultPri, reviewer: [],
          status: input.skipReview ? "active" : "draft",
          ...(input.skipReview ? { needNotReview: true as const } : {}),
          module: assignmentAtCreate ? moduleId ?? 0 : moduleId,
          modules: assignmentAtCreate ? [moduleId ?? 0] : undefined,
          assignedTo: assignmentAtCreate ? assignee?.account : undefined,
          plan: resolvedPlan?.id, verify: input.verify, feedbackBy: input.feedbackBy,
        };
        const validation = { ...payloadPreview, product: product.id, assignedTo: assignee?.account };
        return {
          product, resolvedModule, resolvedPlan, resolvedAssignTo: assignee, payloadPreview,
          apiVersion: assignmentAtCreate ? 2 : 1, errors: [...errors, ...requiredIssues(preflight.requiredFields, validation)],
          warnings, availableModules, candidatePlans,
        };
      });
    }));
    return sets.flat();
  }

  async createStory(input: CreateInput) {
    input = validateInput(createInput, input);
    const mode = input.mode ?? this.config.mode;
    this.checkMode(mode, input.skipReview);
    const dryRun = input.dryRun ?? true;
    const batch = batchDetails(this.config.aiMark.sourceNotePrefix, input.batch, this.now());
    const preflight = { requiredFields: await this.story.requiredFields(), modules: new Map<number, Promise<Module[]>>() };
    const drafts = await this.drafts(input, mode, batch, preflight);
    const warnings = [...new Set(drafts.flatMap(draft => draft.warnings))];
    const allOk = drafts.every(draft => !draft.errors.length);
    if (dryRun) return { dryRun: true as const, allOk, warnings, drafts };
    if (!allOk) return { dryRun: false as const, allOk, warnings, drafts, results: [], created: 0, failed: 0, readbackUnconfirmed: 0 };
    const results = await this.submit(drafts, input.requirementId, drafts.length > 1);
    return { dryRun: false as const, allOk: results.every(complete), warnings, results, ...summarize(results) };
  }

  async importStories(input: ImportInput) {
    input = validateInput(importInput, input);
    const mode = input.mode ?? this.config.mode;
    for (const item of input.stories) this.checkMode(mode, item.skipReview);
    const dryRun = input.dryRun ?? true;
    const preflight = { requiredFields: await this.story.requiredFields(), modules: new Map<number, Promise<Module[]>>() };
    const now = this.now();
    const entries = [];
    for (const [index, item] of input.stories.entries()) {
      const batch = batchDetails(this.config.aiMark.sourceNotePrefix, item.batch, now);
      const drafts = await this.drafts({ ...item, product: input.product, state: input.state }, mode, batch, preflight);
      entries.push({ index: index + 1, drafts, allOk: drafts.every(draft => !draft.errors.length), requirementId: item.requirementId });
    }
    const issueCount = entries.filter(item => !item.allOk).length;
    const warnings = [...new Set(entries.flatMap(entry => entry.drafts.flatMap(draft => draft.warnings)))];
    if (dryRun) return { dryRun: true as const, allOk: issueCount === 0, issueCount, warnings, entries };
    const results = [];
    for (const entry of entries) {
      const receipts = entry.allOk ? await this.submit(entry.drafts, entry.requirementId, true) : [];
      results.push({ index: entry.index, receipts, errors: entry.drafts.flatMap(draft => draft.errors), allOk: entry.allOk && receipts.every(complete) });
    }
    const summary = summarize(results.flatMap(result => result.receipts));
    return {
      dryRun: false as const, allOk: results.every(result => result.allOk), issueCount, warnings, results,
      ...summary, failed: summary.failed + issueCount,
    };
  }

  private async submit(drafts: Draft[], requirementId: number | undefined, continueAfterFailure: boolean) {
    const receipts: Receipt[] = [];
    for (const draft of drafts) {
      try {
        receipts.push(await this.submitOne(draft));
      } catch (error) {
        const uncertain = error instanceof ZentaoCreateUnconfirmedError ? error : undefined;
        if (!continueAfterFailure && !uncertain?.id) throw error;
        receipts.push({
          product: draft.product, category: draft.payloadPreview.category, id: uncertain?.id, url: uncertain?.url,
          readbackConfirmed: false, assignResult: null, linkResult: null,
          error: error instanceof ZentaoError ? { code: error.code, message: error.message } : { code: "RUNTIME_ERROR", message: "写入未确认" },
          notice: noCreateRetry,
        });
      }
    }
    const eligible = receipts.filter((item): item is Receipt & { id: number } => item.readbackConfirmed && item.id !== undefined);
    for (const [index, receipt] of eligible.entries()) {
      const rest = eligible.slice(index + 1);
      if (!rest.length) break;
      try {
        await this.story.linkStories(receipt.id, rest.map(item => item.id));
        (receipt.linkResult ??= { storyIds: [] }).storyIds.push(...rest.map(item => item.id));
        for (const target of rest) (target.linkResult ??= { storyIds: [] }).storyIds.push(receipt.id);
      } catch {
        this.noteLinkError([receipt, ...rest], "需求互链未确认，请按已有 ID 核对并人工补链。");
      }
    }
    if (requirementId !== undefined && eligible.length) {
      try {
        await this.story.linkRequirementToStories(requirementId, eligible.map(item => item.id));
        for (const item of eligible) (item.linkResult ??= { storyIds: [] }).requirementId = requirementId;
      } catch {
        this.noteLinkError(eligible, "用户需求关联未确认，请按已有 ID 核对并人工补链。");
      }
    }
    return receipts;
  }

  private noteLinkError(receipts: Receipt[], message: string) {
    for (const receipt of receipts) {
      receipt.linkError = receipt.linkError ? receipt.linkError + message : message;
      receipt.notice += message + noCreateRetry;
    }
  }

  private async submitOne(draft: Draft): Promise<Receipt> {
    const { product, payloadPreview, resolvedAssignTo, apiVersion } = draft;
    const created = await this.story.create(product.id, payloadPreview, apiVersion === 2);
    const { id, url, readbackConfirmed, differences } = created;
    const requested = resolvedAssignTo?.account;
    let assignResult: AssignResult | null = null;
    if (requested) {
      if (readbackConfirmed && apiVersion === 1) {
        assignResult = await this.story.assign(id, requested);
      } else {
        const current = created.story?.assignedTo?.account ?? null;
        const confirmed = readbackConfirmed && current === requested;
        assignResult = {
          id, url, requestedAssignedTo: requested, assignedTo: current, confirmed,
          assignError: confirmed ? undefined : "指派结果未回读确认，请核查当前负责人。",
        };
      }
    }
    const notice = !readbackConfirmed ? "需求字段回读未确认。" + noCreateRetry
      : assignResult?.confirmed === false ? "需求已创建，负责人未确认。" + noCreateRetry : "需求已创建并回读确认。";
    return { product, category: payloadPreview.category, id, url, readbackConfirmed, differences,
      assignResult, linkResult: null, notice };
  }

  async assignStory(input: AssignInput) {
    const { storyId, assignedTo, comment } = validateInput(assignInput, input);
    const assignee = await this.getAssignee(assignedTo);
    return this.story.assign(storyId, assignee.account, comment);
  }

  async deleteStory(input: DeleteInput) {
    const { storyId, confirm } = validateInput(deleteInput, input);
    return this.story.delete(storyId, confirm);
  }
}
