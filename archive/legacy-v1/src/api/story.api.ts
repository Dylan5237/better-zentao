import {
  InvalidParamError, type ResponseMetadata, unknownResponse,
  ZentaoApiError, ZentaoAuthExpiredError, ZentaoCreateUnconfirmedError,
} from "../core/errors.js";
import type { ZentaoHttp } from "../core/http.js";
import { entityId, isRow, row } from "../core/normalizer.js";
import { story, storyDetail } from "./projection.js";
import { collection, hasNext, pager, projected, response, v1Page, webUrl } from "./response.js";
import type { AssignResult, Page, Story, StoryDetail, StoryPayload, StoryType } from "./types.js";

export const noCreateRetry = "请用现有 ID 或链接核查，禁止重试创建。";

export class StoryApi {
  constructor(private readonly http: ZentaoHttp, private readonly baseUrl: string) {}

  async requiredFields(): Promise<string[]> {
    const data = response(await this.http.request(1, "GET", "/requiredFields"), "必填配置");
    const fields = row(row(data.story).create).fields;
    if (!Array.isArray(fields) || fields.some(field => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field))) {
      throw new ZentaoApiError("无法核实禅道需求创建必填配置");
    }
    return [...new Set(fields as string[])];
  }

  async list(productId: number, type: StoryType, status: "all" | "unclosed", page: number): Promise<Page<Story>> {
    const limit = 100;
    const project = (entry: unknown) => {
      const result = story(entry, this.baseUrl, type);
      return result?.type === type ? result : undefined;
    };
    if (type === "story") {
      const data = response(await this.http.request(1, "GET", "/products/" + productId + "/stories", {
        query: { status, page, limit },
      }), "研发需求");
      return v1Page(data, "stories", page, limit, project);
    }
    const data = response(await this.http.request(2, "GET", "/product/browse", {
      query: { productID: productId, storyType: "requirement", recPerPage: limit, pageID: page },
    }), "用户需求");
    const entries = collection(data.stories, "用户需求");
    return { items: projected(entries, project), scanned: entries.length, hasMore: hasNext(pager(data, page), page) };
  }

  async get(id: number, type: StoryType = "story"): Promise<StoryDetail> {
    const value = type === "story" ? await this.http.request(1, "GET", "/stories/" + id)
      : await this.http.request(2, "GET", "/requirement/view", { query: { storyID: id } });
    const data = response(value, type === "story" ? "研发需求详情" : "用户需求详情");
    const result = storyDetail(data.story ?? data.requirement ?? data, this.baseUrl, type, data);
    if (!result || result.id !== id || result.type !== type) throw new ZentaoApiError("禅道返回的需求 ID 或类型与请求不一致");
    return result;
  }

  url(id: number) {
    return webUrl(this.baseUrl, "story", id);
  }

  async create(productId: number, input: StoryPayload, assignmentAtCreate: boolean) {
    let metadata: ResponseMetadata = unknownResponse;
    let raw: unknown;
    // A create is submitted once. A lost or ambiguous response may have persisted the record.
    try {
      raw = await this.http.request(assignmentAtCreate ? 2 : 1, "POST",
        assignmentAtCreate ? "/stories" : "/products/" + productId + "/stories", {
          query: assignmentAtCreate ? { productID: productId } : undefined,
          body: input, replayUnauthorized: false,
          observe: observation => { metadata = observation; },
        });
    } catch (error) {
      if (error instanceof ZentaoAuthExpiredError) throw error;
      const id = error instanceof ZentaoApiError ? error.candidateId : undefined;
      throw new ZentaoCreateUnconfirmedError(metadata, id, id ? this.url(id) : undefined);
    }
    const id = isRow(raw) ? entityId(raw) : undefined;
    if (!id || (assignmentAtCreate && row(raw).status !== "success")) {
      throw new ZentaoCreateUnconfirmedError(metadata, id, id ? this.url(id) : undefined);
    }
    return this.readCreated(id, productId, input);
  }

  private async readCreated(id: number, productId: number, input: StoryPayload) {
    const url = this.url(id);
    try {
      const story = await this.get(id);
      const differences = [
        story.productId !== productId && "product",
        story.title !== input.title && "title",
        input.module !== undefined && story.moduleId !== input.module && "module",
        story.status !== input.status && "status",
        story.deleted && "deleted",
        story.category !== input.category && "category",
        story.verify !== (input.verify ?? "") && "verify",
        input.source === "ai" && story.source !== input.source && "source",
        input.sourceNote !== undefined && story.sourceNote !== input.sourceNote && "sourceNote",
        input.plan !== undefined && !story.planIds.includes(input.plan) && "plan",
        input.feedbackBy !== undefined && story.feedbackBy !== input.feedbackBy && "feedbackBy",
      ].filter((field): field is string => typeof field === "string");
      return { id, url, story, differences, readbackConfirmed: differences.length === 0 };
    } catch {
      return { id, url, differences: ["readback"], readbackConfirmed: false };
    }
  }

  async assign(id: number, assignedTo: string, comment?: string): Promise<AssignResult> {
    const receipt = { id, url: this.url(id), requestedAssignedTo: assignedTo };
    try {
      const raw = await this.http.request(1, "POST", "/stories/" + id + "/assign", { body: { assignedTo, comment } });
      if (isRow(raw)) response(raw, "指派回执");
    } catch {
      return { ...receipt, assignedTo: null, confirmed: false, assignError: "指派请求未确认，请核查当前负责人。" };
    }
    try {
      const story = await this.get(id);
      const current = story.assignedTo?.account ?? null;
      const confirmed = current === assignedTo && !story.deleted;
      return {
        ...receipt, assignedTo: current, confirmed,
        assignError: confirmed ? undefined : "指派回读与目标负责人不一致。",
      };
    } catch {
      return { ...receipt, assignedTo: null, confirmed: false, assignError: "指派后的需求回读失败，请核查当前负责人。" };
    }
  }

  async delete(id: number, confirm: true) {
    if (confirm !== true) throw new InvalidParamError("软删除必须显式传入 confirm: true");
    const raw = await this.http.request(1, "DELETE", "/stories/" + id);
    if (isRow(raw)) response(raw, "删除回执");
    let deleted = false;
    try {
      deleted = (await this.get(id)).deleted;
    } catch {
      // A failed GET does not prove the result of the deletion.
    }
    const notice = deleted ? "软删除已回读确认，管理员可在回收站恢复。"
      : "软删除结果未回读确认，请按需求 ID 核查，管理员可在回收站检查并恢复。";
    return { id, url: this.url(id), deleted, confirmed: deleted, notice };
  }

  linkStories(id: number, storyIds: readonly number[]) {
    return this.link("story", id, storyIds);
  }

  linkRequirementToStories(requirementId: number, storyIds: readonly number[]) {
    return this.link("requirement", requirementId, storyIds);
  }

  private async link(type: StoryType, id: number, storyIds: readonly number[]): Promise<void> {
    const data = response(await this.http.request(2, "POST", "/" + type + "/linkStory", {
      query: { storyID: id }, body: { stories: storyIds }, replayUnauthorized: false,
    }), "需求关联回执");
    if (data.status !== "success" && data.result !== "success") throw new ZentaoApiError("禅道未确认需求关联请求");
  }
}
