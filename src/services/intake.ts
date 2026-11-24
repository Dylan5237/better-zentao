import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { z } from "zod";
import {
  assertCapabilityExecutable,
  getCapability,
} from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { getPlanDetail } from "../api/plan.ts";
import { getStoryCreateMetadata } from "../api/story.ts";
import {
  operationPlanSchema,
  type OperationResult,
  type OperationStep,
  type PreparedOperation,
} from "../contracts/operation.ts";
import {
  createStoryInputSchema,
  type CreateStoryInput,
} from "../contracts/tools/create_story.ts";
import {
  importStoriesInputSchema,
  maxImportRows,
  type ImportStoriesInput,
} from "../contracts/tools/import_stories.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import { dateTimeSchema } from "../core/dto/common.ts";
import { BztError, type ErrorCode } from "../core/errors.ts";
import type {
  IntakeRecord,
  LocalStore,
  SourceLinkKey,
} from "../core/store/index.ts";
import { parseStoryRoleTag } from "../domain/story-html-spec.ts";
import {
  buildIntakeSpec,
  formatIntakeReceipt,
  formatVersionTag,
  parseCsv,
  parseMarkdownTable,
  recommendStoryCategory,
  validateIntakeContent,
} from "../domain/templates.ts";
import type { DirectoryService } from "./directory.ts";
import type { OperationExecutor } from "./operation.ts";

interface IntakeOptions {
  client: ZentaoReadClient;
  directory: Pick<DirectoryService, "resolveContext">;
  executor: Pick<OperationExecutor, "prepare">;
  store: LocalStore;
  clock: Clock;
  config: Pick<TeamConfig, "write" | "timezone">;
  instanceVersion?: string | undefined;
}

interface PreparedIntake extends PreparedOperation {
  intakes: Array<{ intakeId: string; message: string }>;
  dryRun?: true;
}

type Field = OperationStep["fields"][string];
type Warning = PreparedOperation["warnings"][number];
type Context = Awaited<ReturnType<DirectoryService["resolveContext"]>>["data"];
type Target = {
  product: NonNullable<Context["product"]>;
  module: NonNullable<Context["module"]>;
};
type Group = {
  steps: OperationStep[];
  warnings: Warning[];
  affects: string[];
  intake: IntakeRecord;
  sources: SourceLinkKey[];
};
type Draft = {
  step: OperationStep;
  follows: Array<Pick<OperationStep, "action" | "fields">>;
  affects: string[];
};

const createActions = new Set([
  "story.create",
  "story.create.design",
  "story.create.feedbackBy",
]);
const storedPlan = z.object({
  instanceHash: z.string(),
  plan: operationPlanSchema,
});
const rowErrorCodes = new Set<ErrorCode>([
  "INVALID_INPUT",
  "MISSING_REQUIRED",
  "NOT_FOUND",
  "AMBIGUOUS_ENTITY",
  "CONFIG_MISSING",
  "RULE_VIOLATION",
]);
const inputRecord = z.record(z.string(), z.unknown());
const maxFileBytes = 2 * 1024 * 1024;
const maxXmlBytes = 4 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer, onError: () => BztError): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw onError();
  }
}

function missing(fields: string[]): never {
  throw new BztError("MISSING_REQUIRED", "请补充提需所需的信息。", {
    missing: fields,
  });
}

function storyInput(raw: unknown): CreateStoryInput {
  const parsed = createStoryInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map(({ path }) => path.join("."))),
    ].filter(Boolean);
    throw new BztError("INVALID_INPUT", "提需字段不合法。", { fields });
  }
  validateIntakeContent(parsed.data.spec, parsed.data.verify);
  return parsed.data;
}

function warningText(error: BztError): string {
  const fields = error.details?.missing ?? error.details?.fields;
  const names = z.array(z.string()).safeParse(fields).data;
  return [error.code, error.message, names?.join("、")]
    .filter(Boolean)
    .join(" ");
}

function mergeRow(
  raw: unknown,
  defaults: ImportStoriesInput["defaults"],
): unknown {
  const row = inputRecord.safeParse(raw).data;
  if (!row || !defaults) return raw;
  const spec = inputRecord.safeParse(row.spec).data;
  const ref = inputRecord.safeParse(spec?.designRef).data;
  if (!spec) return { ...defaults, ...row };
  return {
    ...defaults,
    ...row,
    spec: {
      ...defaults.spec,
      ...spec,
      ...(ref ? { designRef: { ...defaults.spec?.designRef, ...ref } } : {}),
    },
  };
}

export class IntakeService {
  constructor(private readonly options: IntakeOptions) {}

  async createStory(raw: unknown): Promise<PreparedIntake> {
    const group = await this.buildGroup(storyInput(raw), 0);
    return this.prepare("create_story", [group], [], false);
  }

  async importStories(raw: unknown): Promise<PreparedIntake> {
    const parsed = importStoriesInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "导入参数不合法，每次最多导入 50 行。",
      );
    const { source, defaults, dryRun } = parsed.data;
    const rows =
      source.kind === "table" ? source.rows : await readImport(source);
    const groups: Group[] = [];
    const warnings: Warning[] = [];
    let offset = 0;
    for (const [index, row] of rows.entries()) {
      const label = `第 ${index + 1} 行`;
      try {
        const group = await this.buildGroup(
          storyInput(mergeRow(row, defaults)),
          offset,
        );
        groups.push(group);
        offset += group.steps.length;
        for (const warning of group.warnings)
          warnings.push({
            ...warning,
            message: `${label}：${warning.message}`,
          });
      } catch (error) {
        if (!(error instanceof BztError) || !rowErrorCodes.has(error.code))
          throw error;
        warnings.push({
          code: "skipped",
          message: `${label} skipped：${warningText(error)}`,
        });
      }
    }
    return this.prepare("import_stories", groups, warnings, dryRun ?? false);
  }

  private async prepare(
    kind: "create_story" | "import_stories",
    groups: Group[],
    rowWarnings: Warning[],
    dryRun: boolean,
  ): Promise<PreparedIntake> {
    const steps = groups.flatMap((group) => group.steps);
    const affects = [...new Set(groups.flatMap((group) => group.affects))];
    const warnings =
      kind === "create_story"
        ? groups.flatMap((group) => group.warnings)
        : rowWarnings;
    const count = steps.filter(({ action }) =>
      createActions.has(action),
    ).length;
    const pendingPlan = warnings.some(
      ({ code, message }) => code === "R06" || message.includes("手工挂"),
    );
    const summary = `准备创建 ${count} 条草稿需求${pendingPlan ? "，有需求待挂计划" : ""}。`;
    if (dryRun || !steps.length) {
      return {
        ok: true,
        opId: "",
        expiresAt: "",
        kind,
        level: "W2",
        requiresPreviewAck: true,
        ...(dryRun ? { dryRun: true } : {}),
        intakes: [],
        warnings,
        preview: {
          summary,
          affects,
          steps: steps.map((step, index) => ({
            seq: index + 1,
            action: step.action,
            target:
              step.fromStep === undefined
                ? `产品 #${step.product} 的story`
                : `步骤 ${step.fromStep} 的story`,
            fields: step.fields,
          })),
        },
      };
    }
    const { store, executor } = this.options;
    const inserted: Group[] = [];
    try {
      for (const group of groups) {
        store.intake.insert(group.intake);
        inserted.push(group);
        // 原始诉求的来源独立于写入步骤保存，确认恢复无需依赖进程内状态。
        for (const source of group.sources)
          store.sourceLinks.upsert({
            ...source,
            origin: "local",
            verifiedAt: null,
          });
      }
      const prepared = await executor.prepare({
        kind,
        summary,
        warnings,
        steps,
        affects,
      });
      return {
        ...prepared,
        intakes: groups.map(({ intake: { intakeId } }) => ({
          intakeId,
          message: formatIntakeReceipt(intakeId),
        })),
      };
    } catch (error) {
      for (const group of inserted) {
        for (const source of group.sources) store.sourceLinks.remove(source);
        store.intake.delete(group.intake.intakeId);
      }
      throw error;
    }
  }

  private async context(input: unknown): Promise<Context> {
    const result = await this.options.directory.resolveContext(input);
    if (result.completeness === "partial" || result.truncated)
      throw new BztError(
        "ZENTAO_UNAVAILABLE",
        "目录读取不完整，无法安全准备提需。",
        {
          completeness: "partial",
          gaps: result.gaps,
        },
      );
    return result.data;
  }

  private async person(input: string): Promise<string> {
    const { people } = await this.context({ people: [input] });
    const person = people[0];
    if (!person) throw new BztError("NOT_FOUND", "未找到人员。");
    return person.account;
  }

  private async feedbackAccount(feedbackBy?: string): Promise<string | null> {
    if (!feedbackBy || /[、，,;]/u.test(feedbackBy)) return null;
    try {
      return await this.person(feedbackBy);
    } catch (error) {
      // N01 的反馈者可以是组织外人员，保留原文。
      if (error instanceof BztError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  private verified(action: string): boolean {
    return (
      getCapability(action, this.options.instanceVersion).state ===
        "verified" &&
      !this.options.config.write.disableCapabilities.includes(action)
    );
  }

  private async buildGroup(
    input: CreateStoryInput,
    offset: number,
  ): Promise<Group> {
    const { product, module, me } = await this.context({
      product: input.product,
      module: input.module,
    });
    if (!product || !module)
      throw new BztError("NOT_FOUND", "无法确认产品和模块。");
    const actor = this.options.store.location.account;
    if (me.account !== actor)
      throw new BztError(
        "PERMISSION_DENIED",
        "当前用户与本地状态库账号不一致。",
      );
    const actualStartedAt = input.backfilled
      ? dateTimeSchema(this.options.config.timezone).safeParse(
          input.backfilled.actualStartedAt,
        ).data
      : null;
    if (input.backfilled && actualStartedAt == null)
      throw new BztError("INVALID_INPUT", "请提供有效的实际开工时间。");
    if (input.backfilled && input.states?.activate)
      throw new BztError("INVALID_INPUT", "补录按草稿受理，请另行移交。");

    const warnings: Warning[] = [];
    const intakeId = `INT-${randomUUID()}`;
    const intake: IntakeRecord = {
      intakeId,
      rawText:
        input.intake?.rawText ??
        [input.title, input.spec?.background].filter(Boolean).join("\n"),
      feedbackByText: input.feedbackBy ?? null,
      feedbackByAccount: await this.feedbackAccount(input.feedbackBy),
      channel: input.intake?.channel ?? (input.requirementId ? "zentao" : null),
      createdBy: actor,
      createdAt: this.options.clock(),
      backfilled: input.backfilled !== undefined,
      actualStartedAt: actualStartedAt ?? null,
    };
    if (!intake.feedbackByText || !(intake.channel || input.source))
      warnings.push({
        code: "N01",
        message: "请补充反馈者及来源渠道，便于后续反馈处理进度。",
      });
    const target = { product, module };
    const category = this.category(input, warnings);
    const drafts = [
      await this.draft(input, target, me, intake, category, warnings),
    ];
    if (input.pair) {
      const other = await this.context({
        product: input.pair.product,
        module: input.pair.module,
      });
      if (!other.product || !other.module)
        throw new BztError("NOT_FOUND", "无法确认配对产品和模块。");
      if (other.product.id === product.id)
        throw new BztError("INVALID_INPUT", "配对需求须属于不同产品。");
      drafts.push(
        await this.draft(
          {
            ...input,
            product: input.pair.product,
            module: input.pair.module,
            title: input.pair.title ?? input.title,
            plan: undefined,
          },
          { product: other.product, module: other.module },
          me,
          intake,
          category,
          warnings,
        ),
      );
    }

    const steps = drafts.map(({ step }) => step);
    const sources: SourceLinkKey[] = [];
    const from = { fromType: "intake", fromId: intakeId };
    if (input.requirementId)
      sources.push({
        ...from,
        toType: "requirement",
        toId: String(input.requirementId),
        relation: "links",
      });
    if (input.derivesFrom)
      sources.push({
        ...from,
        toType: "story",
        toId: String(input.derivesFrom),
        relation: "derives",
      });
    const canPair = this.verified("story.linkStory");
    const canLinkRequirement = this.verified("requirement.linkStory");
    if ((input.pair || input.derivesFrom) && !canPair)
      warnings.push({
        code: "CAPABILITY_UNVERIFIED",
        message: "配对或衍生关系将在创建回读确认后记录到本地。",
      });
    if (input.requirementId && !canLinkRequirement)
      warnings.push({
        code: "CAPABILITY_UNVERIFIED",
        message: `与用户需求 #${input.requirementId} 的关联将在创建回读确认后记录到本地。`,
      });
    for (const [index, draft] of drafts.entries()) {
      const fromStep = offset + index + 1;
      const follow = (action: string, fields: OperationStep["fields"]) => {
        steps.push({
          action,
          fields,
          fromStep,
          product: draft.step.product,
          type: "story",
        });
      };
      if (input.pair && canPair && index === 0)
        follow("story.linkStory", {
          pairFromStep: { value: fromStep + 1, origin: "derived" },
        });
      if (input.requirementId && canLinkRequirement)
        follow("requirement.linkStory", {
          requirementId: { value: input.requirementId, origin: "user" },
        });
      if (input.derivesFrom && canPair)
        follow("story.linkStory", {
          derivesFrom: { value: input.derivesFrom, origin: "user" },
        });
      for (const { action, fields } of draft.follows) follow(action, fields);
    }
    return {
      steps,
      warnings,
      affects: drafts.flatMap(({ affects }) => affects),
      intake,
      sources,
    };
  }

  private async draft(
    input: CreateStoryInput,
    { product, module }: Target,
    me: Context["me"],
    intake: IntakeRecord,
    category: Field,
    warnings: Warning[],
  ): Promise<Draft> {
    const { client, instanceVersion } = this.options;
    const plan = await this.resolvePlan(input, { product, module }, warnings);
    const actorDesign =
      me.roles.includes("DM") ||
      me.roles.includes("po") ||
      me.roles.includes("design");
    const designLead = module.designLead;
    if (input.backfilled && !designLead) missing(["maintainer"]);
    const maintainerInput = input.backfilled
      ? designLead
      : input.crossModule
        ? me.account
        : input.maintainer;
    const maintainer = maintainerInput
      ? await this.person(maintainerInput)
      : actorDesign || !designLead
        ? me.account
        : await this.person(designLead);
    const receiver = module.devLead
      ? await this.person(module.devLead)
      : undefined;
    if ((input.crossModule || input.states?.activate) && !receiver)
      missing(["receiver"]);
    const assignTo =
      input.assignTo && !input.backfilled
        ? await this.person(input.assignTo)
        : maintainer;
    if (assignTo !== maintainer)
      warnings.push({
        code: "N05",
        message: "草稿应由状态维护人推进，请核对指派对象。",
      });

    const action =
      category.value === "design"
        ? "story.create.design"
        : input.feedbackBy
          ? "story.create.feedbackBy"
          : "story.create";
    const actions = [action];
    if (action === "story.create.design" && input.feedbackBy)
      actions.push("story.create.feedbackBy");
    for (const capability of actions) {
      assertCapabilityExecutable(
        capability,
        instanceVersion ? { instanceVersion } : {},
      );
      if (!this.verified(capability))
        throw new BztError(
          "CAPABILITY_DISABLED",
          "当前团队禁用了该创建能力。",
          {
            capability,
          },
        );
    }
    const source = input.source ?? (intake.channel ? "user" : undefined);
    const fields: OperationStep["fields"] = {
      product: { value: product.id, origin: "derived" },
      module: { value: module.id, origin: "derived" },
      modules: { value: [module.id], origin: "derived" },
      title: { value: input.title, origin: "user" },
      category,
      status: { value: "draft", origin: "default" },
      assignedTo: {
        value: assignTo,
        origin:
          input.assignTo && !input.backfilled
            ? assignTo === input.assignTo
              ? "user"
              : "derived"
            : "default",
      },
      pri: { value: input.pri ?? 3, origin: input.pri ? "user" : "default" },
      estimate: { value: 0, origin: "default" },
      reviewer: { value: [], origin: "default" },
      verify: { value: input.verify ?? "", origin: "user" },
      spec: {
        value: buildIntakeSpec(
          input.spec ?? {},
          { ...input, channel: intake.channel ?? undefined, source },
          { maintainer, receiver, intake: intake.intakeId },
        ),
        origin: "derived",
      },
    };
    if (source)
      fields.source = {
        value: source,
        origin: input.source ? "user" : "derived",
      };
    if (input.sourceNote)
      fields.sourceNote = { value: input.sourceNote, origin: "user" };
    if (input.feedbackBy)
      fields.feedbackBy = { value: input.feedbackBy, origin: "user" };
    if (input.version)
      fields.keywords = {
        value: formatVersionTag(input.version),
        origin: "derived",
      };
    if (plan && this.verified("story.create.plan"))
      fields.plan = { value: plan.id, origin: input.plan ? "user" : "default" };
    else if (plan)
      warnings.push({
        code: "CAPABILITY_UNVERIFIED",
        message: `已解析${input.plan ? "" : "本月默认"} L3 计划 #${plan.id}，请在创建后手工挂入该计划。`,
      });

    const metadata = await getStoryCreateMetadata(client, product.id);
    const absent = Object.entries(metadata.fields)
      .filter(
        ([name, setting]) =>
          setting?.required &&
          (fields[name]?.value === undefined || fields[name]?.value === ""),
      )
      .map(([name]) => name);
    if (absent.length) missing(absent);
    if (
      (source && !metadata.fields.source.options.includes(source)) ||
      !metadata.fields.category.options.includes(String(category.value))
    )
      throw new BztError(
        "INVALID_INPUT",
        "来源或类别不在目标产品的可选范围内。",
      );
    const follows: Draft["follows"] = [];
    const affects = [assignTo];
    if (input.states?.activate && receiver) {
      if (this.verified("story.activate"))
        follows.push({
          action: "story.activate",
          fields: { status: { value: "active", origin: "user" } },
        });
      else
        warnings.push({
          code: "CAPABILITY_UNVERIFIED",
          message: "激活能力当前不可用，请手动激活。",
        });
      if (this.verified("story.assign")) {
        follows.push({
          action: "story.assign",
          fields: {
            assignedTo: { value: receiver, origin: "derived" },
            notify: { value: true, origin: "default" },
          },
        });
        affects.push(receiver);
      } else
        warnings.push({
          code: "CAPABILITY_UNVERIFIED",
          message: "指派能力当前不可用，请手动移交研发主管。",
        });
      if (this.verified("story.comment"))
        follows.push({
          action: "story.comment",
          fields: {
            comment: { value: `移交研发主管 ${receiver}。`, origin: "derived" },
          },
        });
      else
        warnings.push({
          code: "CAPABILITY_UNVERIFIED",
          message: "评论能力当前不可用，请手动记录移交。",
        });
    }
    return {
      step: {
        action,
        product: product.id,
        type: "story",
        fields,
        cacheKeys: [`stories:${product.id}`],
      },
      follows,
      affects,
    };
  }

  private category(input: CreateStoryInput, warnings: Warning[]): Field {
    if (input.category) return { value: input.category, origin: "user" };
    const recommendation = recommendStoryCategory({
      title: input.title,
      body: [input.spec?.background, input.spec?.scope].join("\n"),
      crossProduct: !!input.pair,
      crossModule: input.crossModule,
    });
    warnings.push({
      code: "N02",
      message: `建议类别为${recommendation.value === "design" ? "设计类" : "研发类"}，${recommendation.reason}。`,
    });
    return { value: recommendation.value, origin: recommendation.origin };
  }

  private async resolvePlan(
    input: CreateStoryInput,
    { product, module }: Target,
    warnings: Warning[],
  ) {
    const query = input.plan ?? "L3 本月";
    try {
      const { plan } = await this.context({
        product: String(product.id),
        module: String(module.id),
        plan: query,
      });
      if (plan?.level !== "L3")
        throw new BztError("INVALID_INPUT", "请指定目标产品的 L3 模块计划。");
      const { plan: detail } = await getPlanDetail(
        this.options.client,
        plan.id,
      );
      if (
        detail.product !== product.id ||
        detail.parent === null ||
        detail.parent === -1 ||
        detail.deleted ||
        detail.status === "closed"
      )
        throw new BztError("INVALID_INPUT", "请指定目标产品内可用的 L3 计划。");
      return plan;
    } catch (error) {
      if (
        input.plan ||
        !(error instanceof BztError) ||
        error.code !== "NOT_FOUND" ||
        error.details?.field !== "plan"
      )
        throw error;
      warnings.push({
        code: "R06",
        message: "待挂计划：该模块本月缺少 L3 计划，请补建并挂入。",
      });
      return undefined;
    }
  }

  /**
   * 供确认入口在每次执行或恢复后调用。持久化的步骤状态是写入依据，
   * 即使整批只部分完成，也只登记已回读确认的创建步骤。
   */
  recordConfirmed(opId: string, result: OperationResult): void {
    if (result.opId !== opId)
      throw new BztError("INVALID_INPUT", "操作回执编号不一致。");
    const { store, clock } = this.options;
    const record = store.operations.get(opId);
    if (record.actor !== store.location.account)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    if (record.kind !== "create_story" && record.kind !== "import_stories")
      return;
    let stored: z.infer<typeof storedPlan>;
    try {
      stored = storedPlan.parse(JSON.parse(record.planJson));
    } catch {
      throw new BztError("INVALID_INPUT", "本地操作记录格式不合法。");
    }
    if (stored.instanceHash !== store.location.instanceHash)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    const { plan } = stored;
    const done = store.operationSteps
      .list(opId)
      .filter(({ state }) => state === "done");
    const groups = new Map<string, number[]>();
    const at = record.executedAt ?? clock();
    const saveLink = (key: SourceLinkKey, native = false) => {
      const prior = store.sourceLinks.find(key);
      if (!prior || (native && prior.origin !== "native"))
        store.sourceLinks.upsert({
          ...key,
          origin: native ? "native" : "local",
          verifiedAt: native ? at : null,
        });
    };
    const nativeStep = (seq: number, field: string) =>
      done.some((row) => {
        const step = plan.steps[row.seq - 1];
        return step?.fromStep === seq && Object.hasOwn(step.fields, field);
      });
    for (const { seq, action, zentaoId } of done) {
      if (zentaoId === null || !createActions.has(action)) continue;
      const html = plan.steps[seq - 1]?.fields.spec?.value;
      const tag =
        typeof html === "string" ? parseStoryRoleTag(html) : undefined;
      if (!tag?.intake) continue;
      const toId = String(zentaoId);
      saveLink({
        fromType: "intake",
        fromId: tag.intake,
        toType: "story",
        toId,
        relation: "source",
      });
      for (const source of store.sourceLinks.listFrom("intake", tag.intake)) {
        if (source.relation === "links")
          saveLink(
            {
              fromType: "requirement",
              fromId: source.toId,
              toType: "story",
              toId,
              relation: "links",
            },
            nativeStep(seq, "requirementId"),
          );
        if (source.relation === "derives")
          saveLink(
            {
              fromType: "story",
              fromId: toId,
              toType: "story",
              toId: source.toId,
              relation: "derives",
            },
            nativeStep(seq, "derivesFrom"),
          );
      }
      try {
        store.storyRoles.get(zentaoId);
      } catch (error) {
        if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
          throw error;
        store.storyRoles.upsert({
          storyId: zentaoId,
          maintainer: tag.maintainer ?? null,
          receiver: tag.receiver ?? null,
          updatedAt: at,
        });
      }
      const paired = groups.get(tag.intake) ?? [];
      paired.push(seq);
      groups.set(tag.intake, paired);
    }
    for (const [first, second] of groups.values()) {
      if (first === undefined || second === undefined) continue;
      const a = done.find(({ seq }) => seq === first)?.zentaoId;
      const b = done.find(({ seq }) => seq === second)?.zentaoId;
      if (a == null || b == null) continue;
      const native = nativeStep(first, "pairFromStep");
      for (const [fromId, toId] of [
        [a, b],
        [b, a],
      ]) {
        saveLink(
          {
            fromType: "story",
            fromId: String(fromId),
            toType: "story",
            toId: String(toId),
            relation: "pairs",
          },
          native,
        );
      }
    }
  }
}

type FileSource = Extract<ImportStoriesInput["source"], { kind: "file" }>;

async function readImport({ path, format }: FileSource): Promise<unknown[]> {
  let file: Buffer;
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes)
        throw new BztError("INVALID_INPUT", "请选择不超过 2 MiB 的普通文件。");
      const bytes = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== info.size)
        throw new BztError("INVALID_INPUT", "导入文件在读取期间发生变化。");
      file = bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof BztError) throw error;
    throw new BztError("INVALID_INPUT", "无法读取导入文件。");
  }

  const text = () =>
    decodeUtf8(
      file,
      () => new BztError("INVALID_INPUT", "导入文件必须是有效的 UTF-8 编码。"),
    );
  const table =
    format === "xlsx"
      ? readWorkbook(file)
      : format === "csv"
        ? parseCsv(text())
        : parseMarkdownTable(text());
  const [header, ...rows] = table;
  if (!header?.length || !rows.length)
    throw new BztError("INVALID_INPUT", "导入文件需要表头及至少一行数据。");
  if (rows.length > maxImportRows)
    throw new BztError("INVALID_INPUT", "每次最多导入 50 行。");
  const names = header.map((name) => name.trim());
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        !/^[A-Za-z]\w*(?:\.[A-Za-z]\w*){0,2}$/u.test(name) ||
        name
          .split(".")
          .some((part) =>
            ["__proto__", "prototype", "constructor"].includes(part),
          ),
    )
  )
    throw new BztError(
      "INVALID_INPUT",
      "文件表头应使用互不重复的提需字段名，例如 title、spec.scope。",
    );
  const column = names.map((name) => name.split("."));
  return rows.map((row) => {
    if (row.length > names.length) return null;
    const result: Record<string, unknown> = {};
    for (const [index, keys] of column.entries()) {
      const value = row[index];
      if (value === undefined || value.trim() === "") continue;
      let target = result;
      for (const key of keys.slice(0, -1)) {
        const existing = Object.hasOwn(target, key) ? target[key] : undefined;
        if (existing !== undefined && typeof existing !== "object") return null;
        const child: Record<string, unknown> =
          inputRecord.safeParse(existing).data ?? {};
        target[key] = child;
        target = child;
      }
      const key = keys.at(-1);
      if (key === undefined || Object.hasOwn(target, key)) return null;
      if (
        ["pri", "derivesFrom", "requirementId"].includes(key) &&
        /^\d+$/u.test(value.trim())
      )
        target[key] = Number(value);
      else if (
        ["crossModule", "activate"].includes(key) &&
        /^(?:true|false)$/u.test(value.trim())
      )
        target[key] = value.trim() === "true";
      else target[key] = value;
    }
    return result;
  });
}

function workbookError(): BztError {
  return new BztError(
    "INVALID_INPUT",
    "XLSX 工作簿不合法、格式不支持或超过安全上限。",
  );
}

function stripXmlComments(xml: string): string {
  let cursor = 0;
  let result = "";
  while (cursor < xml.length) {
    const start = xml.indexOf("<!--", cursor);
    if (start === -1) {
      result += xml.slice(cursor);
      break;
    }
    const end = xml.indexOf("-->", start + 4);
    if (end === -1) throw workbookError();
    result += xml.slice(cursor, start);
    cursor = end + 3;
  }
  return result;
}

// 只从 ZIP 中读取需要的 XML 部件，不解包到磁盘；同时限制声明和实际解压体积。
function workbookParts(zip: Buffer): (name: string) => string | undefined {
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 65_535);
  for (; end >= earliest; end--) {
    if (
      zip.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + zip.readUInt16LE(end + 20) === zip.length
    )
      break;
  }
  if (end < earliest || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6))
    throw workbookError();
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const centralStart = cursor;
  if (
    count > 256 ||
    count !== zip.readUInt16LE(end + 8) ||
    cursor + zip.readUInt32LE(end + 12) !== end
  )
    throw workbookError();
  const entries = new Map<
    string,
    {
      offset: number;
      size: number;
      bytes: number;
      crc: number;
      method: number;
      flags: number;
    }
  >();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50)
      throw workbookError();
    const nameEnd = cursor + 46 + zip.readUInt16LE(cursor + 28);
    const next =
      nameEnd + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
    if (next > end || zip.readUInt16LE(cursor + 34)) throw workbookError();
    const name = zip.toString("utf8", cursor + 46, nameEnd);
    if (entries.has(name)) throw workbookError();
    entries.set(name, {
      flags: zip.readUInt16LE(cursor + 8),
      method: zip.readUInt16LE(cursor + 10),
      crc: zip.readUInt32LE(cursor + 16),
      bytes: zip.readUInt32LE(cursor + 20),
      size: zip.readUInt32LE(cursor + 24),
      offset: zip.readUInt32LE(cursor + 42),
    });
    cursor = next;
  }
  if (cursor !== end) throw workbookError();
  let unpacked = 0;
  return (name) => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const { offset, size, bytes, flags, method, crc } = entry;
    unpacked += size;
    if (
      offset + 30 > centralStart ||
      zip.readUInt32LE(offset) !== 0x04034b50 ||
      zip.readUInt16LE(offset + 6) !== flags ||
      zip.readUInt16LE(offset + 8) !== method ||
      (flags & 1) !== 0 ||
      unpacked > maxXmlBytes ||
      (method !== 0 && method !== 8)
    )
      throw workbookError();
    const nameEnd = offset + 30 + zip.readUInt16LE(offset + 26);
    const start = nameEnd + zip.readUInt16LE(offset + 28);
    if (
      start + bytes > centralStart ||
      zip.toString("utf8", offset + 30, nameEnd) !== name
    )
      throw workbookError();
    const data = zip.subarray(start, start + bytes);
    const content =
      method === 0
        ? data
        : inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
    if (content.length !== size || crc32(content) !== crc)
      throw workbookError();
    const xml = decodeUtf8(content, workbookError);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) throw workbookError();
    return stripXmlComments(xml);
  };
}

const xmlEntities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function xmlText(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (_, key: string) => {
    if (!key.startsWith("#")) return xmlEntities.get(key) ?? `&${key};`;
    const point = key.startsWith("#x")
      ? Number.parseInt(key.slice(2), 16)
      : Number(key.slice(1));
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff)
      throw workbookError();
    return String.fromCodePoint(point);
  });
}

function isXmlWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isXmlNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 58 ||
    code === 46 ||
    code === 45
  );
}

function xmlAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && isXmlWhitespace(text.charCodeAt(index)))
      index++;
  };
  skipWhitespace();
  while (index < text.length) {
    const nameStart = index;
    while (index < text.length && isXmlNameChar(text.charCodeAt(index)))
      index++;
    if (index === nameStart) throw workbookError();
    const name = text.slice(nameStart, index);
    skipWhitespace();
    if (text.charAt(index) !== "=") throw workbookError();
    index++;
    skipWhitespace();
    const quote = text.charAt(index);
    if (quote !== '"' && quote !== "'") throw workbookError();
    const valueStart = index + 1;
    const valueEnd = text.indexOf(quote, valueStart);
    if (valueEnd === -1) throw workbookError();
    attributes.set(name, xmlText(text.slice(valueStart, valueEnd)));
    index = valueEnd + 1;
    if (index < text.length) {
      if (!isXmlWhitespace(text.charCodeAt(index))) throw workbookError();
      skipWhitespace();
    }
  }
  return attributes;
}

// 按标签边界扫描，避免同名开始标签未闭合时反复遍历剩余 XML。
function* xmlElements(xml: string, name: string) {
  const tags = new RegExp(`<(/?)([\\w.-]+:)?${name}(?=[\\s/>])([^<>]*)>`, "gu");
  let start: { attributes: string; prefix: string; offset: number } | undefined;
  for (const match of xml.matchAll(tags)) {
    const [tag, closing, prefix = "", attributes = ""] = match;
    if (closing) {
      if (!start || start.prefix !== prefix) throw workbookError();
      yield {
        attributes: start.attributes,
        body: xml.slice(start.offset, match.index),
      };
      start = undefined;
    } else {
      if (start) throw workbookError();
      if (tag.endsWith("/>"))
        yield { attributes: attributes.slice(0, -1), body: "" };
      else start = { attributes, prefix, offset: match.index + tag.length };
    }
  }
  if (start) throw workbookError();
}

function cellTexts(xml: string): string {
  return Array.from(xmlElements(xml, "t"), ({ body }) => xmlText(body)).join(
    "",
  );
}

function worksheetPath(target: string): string {
  const path = posix.normalize(
    target.startsWith("/") ? target.slice(1) : `xl/${target}`,
  );
  if (!path.startsWith("xl/") || !path.endsWith(".xml")) throw workbookError();
  return path;
}

function readWorkbook(file: Buffer): string[][] {
  try {
    const read = workbookParts(file);
    const workbook = read("xl/workbook.xml");
    const relationships = read("xl/_rels/workbook.xml.rels");
    if (!workbook || !relationships) throw workbookError();
    const firstSheet = xmlElements(workbook, "sheet").next().value;
    const id = [...xmlAttributes(firstSheet?.attributes ?? "")].find(([name]) =>
      name.endsWith(":id"),
    )?.[1];
    const relations = Array.from(
      xmlElements(relationships, "Relationship"),
      ({ attributes }) => xmlAttributes(attributes),
    );
    const sheet = relations.find(
      (relation) =>
        relation.get("Id") === id &&
        relation.get("Type")?.endsWith("/worksheet"),
    );
    const target = sheet?.get("Target");
    if (!id || !target || sheet?.get("TargetMode") === "External")
      throw workbookError();
    const xml = read(worksheetPath(target));
    const sheetData = xml
      ? xmlElements(xml, "sheetData").next().value
      : undefined;
    if (!sheetData) throw workbookError();
    const sharedTarget = relations
      .find(
        (relation) =>
          relation.get("Type")?.endsWith("/sharedStrings") &&
          relation.get("TargetMode") !== "External",
      )
      ?.get("Target");
    const sharedXml = sharedTarget
      ? read(worksheetPath(sharedTarget))
      : read("xl/sharedStrings.xml");
    const shared = Array.from(xmlElements(sharedXml ?? "", "si"), ({ body }) =>
      cellTexts(body),
    );
    const rows: string[][] = [];
    for (const { body } of xmlElements(sheetData.body, "row")) {
      const cells: string[] = [];
      for (const { attributes: attrs, body: cell } of xmlElements(body, "c")) {
        const attributes = xmlAttributes(attrs);
        const ref = /^([A-Z]{1,3})[1-9]\d*$/u.exec(
          attributes.get("r") ?? "",
        )?.[1];
        const index = ref
          ? [...ref].reduce(
              (total, char) => total * 26 + char.charCodeAt(0) - 64,
              0,
            ) - 1
          : cells.length;
        if (index >= 128 || cells[index] !== undefined) throw workbookError();
        const type = attributes.get("t");
        const value = xmlElements(cell, "v").next().value?.body ?? "";
        if (!xmlElements(cell, "f").next().done) throw workbookError();
        if (type === "s") {
          const text = /^\d+$/u.test(value) ? shared[Number(value)] : undefined;
          if (text === undefined) throw workbookError();
          cells[index] = text;
        } else if (type === "inlineStr") cells[index] = cellTexts(cell);
        else if (type === "b") cells[index] = value === "1" ? "true" : "false";
        else cells[index] = xmlText(value);
      }
      if (cells.every((cell) => !cell?.trim())) continue;
      if (rows.length >= maxImportRows + 1)
        throw new BztError("INVALID_INPUT", "每次最多导入 50 行。");
      rows.push(Array.from(cells, (cell) => cell ?? ""));
    }
    return rows;
  } catch (error) {
    if (error instanceof BztError) throw error;
    throw workbookError();
  }
}
