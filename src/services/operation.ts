import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertCapabilityExecutable } from "../api/capabilities.ts";
import {
  confirmOperationSchema,
  getOperationSchema,
  operationPlanSchema,
} from "../contracts/operation.ts";
import type {
  ConfirmOperation,
  GetOperation,
  OperationPlan,
  OperationResult,
  OperationStep,
  PreparedOperation,
} from "../contracts/operation.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import type {
  LocalStore,
  OperationLevel,
  OperationRecord,
  OperationStatus,
  OperationStepRecord,
} from "../core/store/index.ts";
import { instanceHashOf } from "../core/store/index.ts";
import { queryAll } from "../core/store/sqlite-support.ts";

export type { OperationPlan } from "../contracts/operation.ts";

const idSchema = z.int().positive();
const targetSnapshot = z.object({
  id: idSchema,
  type: z.enum(["story", "task", "comment", "link"]),
  product: idSchema,
  status: z.string().nullable().optional(),
  maintainer: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  plan: z.array(idSchema).optional(),
  executions: z.array(idSchema).optional(),
  lastEditedDate: z.int().nullable().optional(),
  spec: z.string().nullable().optional(),
});
export type OperationTargetSnapshot = z.infer<typeof targetSnapshot>;
type Target = Pick<OperationTargetSnapshot, "id" | "type" | "product">;

interface StepRequest {
  opId: string;
  seq: number;
  step: Readonly<OperationStep>;
  id?: number | undefined;
}

interface ReverseQuery {
  opId: string;
  type: OperationStep["type"];
  product: number;
  title: string;
  execution?: number;
  createdBy: string;
  since: number;
  until: number;
}

const lookupResult = z.object({
  complete: z.boolean(),
  matches: z.array(
    z.object({
      id: idSchema,
      product: idSchema,
      title: z.string(),
      createdBy: z.string(),
      createdAt: z.int(),
    }),
  ),
});
const writeReceipt = z.object({
  id: idSchema.optional(),
  actionId: idSchema.optional(),
});
const readbackReceipt = z.object({
  verified: z.boolean(),
  snapshot: targetSnapshot.optional(),
});

/** 业务服务注入已投影的 API 调用。校验和反查必须绕过查询缓存。 */
export interface OperationGateway {
  readTarget(target: Target): Promise<OperationTargetSnapshot>;
  write(request: StepRequest): Promise<z.infer<typeof writeReceipt>>;
  readback(
    request: StepRequest & {
      zentaoId?: number;
      actionId?: number;
      attemptedAt?: number;
    },
  ): Promise<z.infer<typeof readbackReceipt>>;
  reverseLookup(query: ReverseQuery): Promise<z.infer<typeof lookupResult>>;
}

interface ExecutorOptions {
  store: LocalStore;
  baseUrl: string;
  config: Pick<TeamConfig, "mode" | "write">;
  gateway: OperationGateway;
  clock: Clock;
  channel?: "mcp" | "cli" | undefined;
  instanceVersion?: string | undefined;
}

const fingerprintSchema = targetSnapshot.omit({ spec: true }).extend({
  spec: z.string().nullable().optional(),
});
type Fingerprint = z.infer<typeof fingerprintSchema>;
const storedPlanSchema = z.strictObject({
  instanceHash: z.string(),
  plan: operationPlanSchema,
  targets: z.array(fingerprintSchema),
});
const checkpointSchema = z.strictObject({
  attemptedAt: z.int(),
  fingerprint: fingerprintSchema.optional(),
  actionId: idSchema.optional(),
});

const isoFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
});
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const inFlight = new WeakMap<LocalStore, Set<string>>();
const memoryHistory = new WeakMap<LocalStore, string[]>();
const createsObject = new Set([
  "story.create",
  "story.create.design",
  "story.create.feedbackBy",
  "task.create",
]);
const repeatable = new Set([
  "story.assign",
  "story.close",
  "story.linkExecution",
  "story.linkStory",
  "requirement.linkStory",
]);
const destructive = new Set(["story.delete", "task.finish"]);
const staleStepAction = "plan.stale";
const unknownError = "无法确认禅道写入结果。";
const reverseLookupSkewMs = 60_000;
const reverseLookupWindowMs = 600_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeBase32(value: bigint, length: number): string {
  let encoded = "";
  for (let i = 0; i < length; i++) {
    encoded = alphabet.charAt(Number(value & 31n)) + encoded;
    value >>= 5n;
  }
  return encoded;
}

function operationId(now: number): string {
  return (
    "op_" +
    encodeBase32(BigInt(now), 10) +
    encodeBase32(BigInt("0x" + randomBytes(10).toString("hex")), 16)
  );
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BztError("INVALID_INPUT", "操作参数不合法。");
  return parsed.data;
}

function parseStored<T>(schema: z.ZodType<T>, json: string): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch {
    throw new BztError("INVALID_INPUT", "本地操作记录格式不合法。");
  }
}

function fingerprint({
  spec,
  plan,
  executions,
  ...fields
}: OperationTargetSnapshot): Fingerprint {
  return {
    ...fields,
    plan: plan && [...new Set(plan)].sort((a, b) => a - b),
    executions: executions && [...new Set(executions)].sort((a, b) => a - b),
    spec: typeof spec === "string" ? hash(spec) : spec,
  };
}

function getTarget(step: OperationStep, id: number): Target {
  return { type: step.type, product: step.product, id };
}

function targetKey(target: Target): string {
  return `${target.type}:${target.id}`;
}

function changedFields(before: Fingerprint, after: Fingerprint): string[] {
  return Object.keys(fingerprintSchema.shape).filter((key) => {
    const field = z.keyof(fingerprintSchema).parse(key);
    return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  });
}

function stepTarget(step: OperationStep): string {
  if (step.id !== undefined) return `${step.type} #${step.id}`;
  if (step.fromStep !== undefined)
    return `步骤 ${step.fromStep} 的${step.type}`;
  return `产品 #${step.product} 的${step.type}`;
}

function determineLevel(
  plan: OperationPlan,
  actor: string,
  targets: Fingerprint[],
  mode: TeamConfig["mode"],
): OperationLevel {
  const [first] = plan.steps;
  if (plan.steps.every(({ action }) => action === "read")) return "W0";
  if (plan.steps.some(({ action }) => destructive.has(action))) return "W3";
  if (
    mode === "strict-ai" ||
    first === undefined ||
    plan.affects?.some(
      (account) => account !== actor && !account.startsWith(actor + " "),
    )
  )
    return "W2";
  if (
    plan.kind === "create_story" &&
    createsObject.has(first.action) &&
    first.type === "story" &&
    first.fields.status?.value === "draft" &&
    first.fields.assignedTo?.value === actor &&
    plan.steps.every(
      (step, index) =>
        step.product === first.product &&
        (index === 0 ||
          (index === 1 &&
            step.action === "story.assign" &&
            step.fromStep === 1 &&
            step.fields.assignedTo?.value === actor)),
    )
  )
    return "W1";
  if (
    plan.steps.length === 1 &&
    first.type === "story" &&
    targets[0]?.maintainer === actor &&
    ((plan.kind === "assign_story" &&
      first.action === "story.assign" &&
      first.fields.assignedTo?.value === actor) ||
      (plan.kind === "set_story_meta" &&
        first.action === "story.edit" &&
        Object.keys(first.fields).every((key) => key === "keywords")))
  )
    return "W1";
  return "W2";
}

function receiptStatus(
  steps: OperationStepRecord[],
  executed: boolean,
): OperationStatus {
  if (!executed) return "not_executed";
  if (steps.some(({ state }) => state === "unknown")) return "unknown";
  if (steps.every(({ state }) => state === "done" || state === "skipped"))
    return steps.some(({ state }) => state === "done")
      ? "confirmed"
      : "not_executed";
  if (steps.some(({ state }) => state === "done")) return "partial";
  if (steps.some(({ state }) => state === "failed")) return "failed";
  return "not_executed";
}

function rejectWrite(error: unknown): boolean {
  return (
    error instanceof BztError &&
    (error.code === "ZENTAO_BUSINESS_ERROR" ||
      error.code === "PERMISSION_DENIED" ||
      error.code === "AUTH_FAILED")
  );
}

export class OperationExecutor {
  private readonly baseUrl: URL;

  constructor(private readonly options: ExecutorOptions) {
    const url = normalizeZentaoBaseUrl(options.baseUrl);
    if (
      !url ||
      instanceHashOf(url.href) !== options.store.location.instanceHash
    )
      throw new BztError("INVALID_INPUT", "操作实例与本地状态库不一致。");
    this.baseUrl = url;
  }

  private get store(): LocalStore {
    return this.options.store;
  }

  async prepare(
    input: OperationPlan & { level?: unknown },
  ): Promise<PreparedOperation> {
    // 05 §5.2：调用方传入的级别不参与判定，也不落盘。
    const payload = { ...input };
    delete payload.level;
    const plan = parseInput(operationPlanSchema, payload);
    this.checkCapabilities(plan);
    const targets = await this.readTargets(plan);
    const level = determineLevel(
      plan,
      this.store.location.account,
      targets,
      this.options.config.mode,
    );
    const now = this.options.clock();
    const opId = operationId(now);
    const expiresAt =
      now + this.options.config.write.planExpiresMinutes * 60_000;
    this.store.operations.insert({
      opId,
      kind: plan.kind,
      actor: this.store.location.account,
      level,
      inputHash: hash(JSON.stringify(plan)),
      planJson: JSON.stringify({
        instanceHash: this.store.location.instanceHash,
        plan,
        targets,
      }),
      status: "not_executed",
      createdAt: now,
      expiresAt,
      executedAt: null,
    });
    try {
      for (const [index, step] of plan.steps.entries()) {
        this.store.operationSteps.insert({
          opId,
          seq: index + 1,
          action: step.action,
          targetType: step.type,
          targetId: step.id === undefined ? null : String(step.id),
          requestDigest: hash(JSON.stringify(step)),
          zentaoId: null,
          readbackJson: null,
          state: "pending",
          error: null,
        });
      }
    } catch (error) {
      this.store.operations.delete(opId);
      throw error;
    }
    if (this.store.location.dbPath === ":memory:") {
      const history = memoryHistory.get(this.store) ?? [];
      history.unshift(opId);
      memoryHistory.set(this.store, history);
    }
    return {
      ok: true,
      opId,
      kind: plan.kind,
      level,
      expiresAt:
        isoFormatter.format(expiresAt).replace(" ", "T").replace(",", ".") +
        "Z",
      preview: {
        summary: plan.summary,
        affects: plan.affects ?? [],
        steps: plan.steps.map((step, index) => ({
          seq: index + 1,
          action: step.action,
          target: stepTarget(step),
          fields: step.fields,
        })),
      },
      warnings: plan.warnings ?? [],
      requiresPreviewAck: level === "W2",
    };
  }

  private checkCapabilities(plan: OperationPlan): void {
    const { channel, instanceVersion, config } = this.options;
    for (const [index, step] of plan.steps.entries()) {
      if (step.action !== "read") {
        const capabilities = new Set([step.action]);
        if (createsObject.has(step.action) && step.type === "story") {
          if (step.fields.category?.value === "design")
            capabilities.add("story.create.design");
          if (step.fields.feedbackBy?.value !== undefined)
            capabilities.add("story.create.feedbackBy");
        }
        for (const capability of capabilities) {
          assertCapabilityExecutable(capability, {
            channel: channel ?? "mcp",
            instanceVersion,
          });
          if (config.write.disableCapabilities.includes(capability))
            throw new BztError(
              "CAPABILITY_DISABLED",
              "该能力已被团队配置禁用。",
              { capability },
            );
        }
      }
      if (createsObject.has(step.action)) {
        if (Object.hasOwn(step.fields, "plan"))
          assertCapabilityExecutable("story.create.plan", {
            channel: channel ?? "mcp",
          });
        if (
          step.id !== undefined ||
          step.fromStep !== undefined ||
          typeof step.fields.title?.value !== "string" ||
          !step.fields.title.value.trim()
        )
          throw new BztError(
            "INVALID_INPUT",
            "创建步骤需要标题，且不能指定已有对象。",
          );
        continue;
      }
      if (step.fromStep === undefined && step.id !== undefined) continue;
      const source =
        step.fromStep === undefined ? undefined : plan.steps[step.fromStep - 1];
      if (
        step.id !== undefined ||
        step.fromStep === undefined ||
        step.fromStep > index ||
        source?.type !== step.type ||
        source.product !== step.product ||
        !createsObject.has(source.action)
      )
        throw new BztError(
          "INVALID_INPUT",
          "步骤需要已有对象或同产品的前置创建步骤。",
        );
    }
    if (
      plan.steps.some(({ action }) => action === "read") &&
      plan.steps.some(({ action }) => action !== "read")
    )
      throw new BztError("INVALID_INPUT", "只读操作不能与写入步骤混合。");
  }

  private async readSnapshot(target: Target): Promise<Fingerprint> {
    try {
      const snapshot = fingerprint(
        targetSnapshot.parse(await this.options.gateway.readTarget(target)),
      );
      if (snapshot.id === target.id && snapshot.type === target.type)
        return snapshot;
    } catch (error) {
      if (error instanceof BztError && error.code === "NOT_FOUND")
        throw new BztError("NOT_FOUND", "未找到需要校验的禅道对象。");
      throw new BztError(
        "ZENTAO_UNAVAILABLE",
        "无法刷新操作对象，请稍后再试。",
      );
    }
    throw new BztError(
      "ZENTAO_SCHEMA_MISMATCH",
      "禅道回读对象与操作目标不一致。",
    );
  }

  private async readTargets(plan: OperationPlan): Promise<Fingerprint[]> {
    const targets = new Map<string, Fingerprint>();
    for (const step of plan.steps) {
      if (step.id === undefined || step.action === "read") continue;
      const target = getTarget(step, step.id);
      const key = targetKey(target);
      const current = targets.get(key) ?? (await this.readSnapshot(target));
      if (current.product !== target.product)
        throw new BztError("INVALID_INPUT", "操作步骤的产品与禅道对象不一致。");
      targets.set(key, current);
    }
    return [...targets.values()];
  }

  private load(opId: string) {
    const record = this.store.operations.get(opId);
    if (record.actor !== this.store.location.account)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    const stored = parseStored(storedPlanSchema, record.planJson);
    if (stored.instanceHash !== this.store.location.instanceHash)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    return { record, ...stored };
  }

  getOperation(input: { opId: string }): OperationResult;
  getOperation(input?: { recent?: number }): OperationResult[];
  getOperation(input: GetOperation): OperationResult | OperationResult[];
  getOperation(input: GetOperation = {}): OperationResult | OperationResult[] {
    const query = parseInput(getOperationSchema, input);
    if (query.opId !== undefined) {
      const { record, plan } = this.load(query.opId);
      return this.result(record, plan);
    }
    return this.recent(query.recent ?? 10).map((opId) => {
      const { record, plan } = this.load(opId);
      return this.result(record, plan);
    });
  }

  private recent(limit: number): string[] {
    const { dbPath, account, instanceHash } = this.store.location;
    if (dbPath === ":memory:")
      return (memoryHistory.get(this.store) ?? []).slice(0, limit);
    using database = new DatabaseSync(dbPath, { readOnly: true });
    return queryAll(
      database,
      `SELECT op_id FROM operations WHERE actor = ? AND
        CASE WHEN json_valid(plan_json) THEN json_extract(plan_json, '$.instanceHash') END = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [account, instanceHash, limit],
      z.object({ op_id: z.string() }),
      "读取近期操作回执",
    ).map(({ op_id }) => op_id);
  }

  resume(input: Omit<ConfirmOperation, "resume">): Promise<OperationResult> {
    return this.confirm({ ...input, resume: true });
  }

  async confirm(input: ConfirmOperation): Promise<OperationResult> {
    const query = parseInput(confirmOperationSchema, input);
    const { dbPath } = this.store.location;
    const active = inFlight.get(this.store) ?? new Set<string>();
    inFlight.set(this.store, active);
    if (active.has(query.opId)) throw this.busy();
    active.add(query.opId);
    try {
      if (dbPath === ":memory:") return await this.execute(query);
      // LocalStore 没有原子抢占接口。单独持有 SQLite 写锁，主库检查点可独立提交，
      // 同一库的其他进程无法同时派发；进程退出后 SQLite 自动释放锁。
      using lock = new DatabaseSync(realpathSync(dbPath) + ".operation-lock");
      try {
        lock.exec("BEGIN IMMEDIATE");
      } catch {
        throw this.busy();
      }
      return await this.execute(query);
    } finally {
      active.delete(query.opId);
    }
  }

  private busy(): BztError {
    return new BztError("INVALID_INPUT", "本地操作正在执行，请稍后查询回执。");
  }

  private checkExpiry(record: OperationRecord): void {
    if (record.expiresAt !== null && this.options.clock() >= record.expiresAt)
      throw new BztError("PLAN_EXPIRED", "操作计划已过期，请重新生成预览。");
  }

  private checkAuthorization(
    record: OperationRecord,
    query: ConfirmOperation,
  ): void {
    if (record.level === "W3" && this.options.channel !== "cli")
      throw new BztError("CAPABILITY_CLI_ONLY", "该操作仅允许通过 CLI 确认。");
    const requiresDelay =
      record.level === "W2" ||
      (record.level === "W1" && this.options.config.mode === "strict-ai");
    if ((requiresDelay || record.level === "W3") && query.previewAck !== true)
      throw new BztError(
        "PREVIEW_REQUIRED",
        "请先展示操作预览并取得用户确认。",
      );
    if (
      requiresDelay &&
      this.options.clock() - record.createdAt <
        this.options.config.write.minConfirmDelaySeconds * 1000
    )
      throw new BztError(
        "PREVIEW_TOO_FAST",
        "确认间隔不足，请展示预览并等待用户确认。",
      );
  }

  private async execute(query: ConfirmOperation): Promise<OperationResult> {
    const { opId } = query;
    const { record, plan, targets } = this.load(opId);
    const rows = this.store.operationSteps.list(opId);
    if (rows[0]?.action === staleStepAction) {
      const fields = parseStored(
        z.array(z.string()),
        rows[0].readbackJson ?? "[]",
      );
      throw new BztError("PLAN_STALE", "操作目标已变更，请重新生成预览。", {
        fields,
      });
    }
    if (rows.length !== plan.steps.length)
      throw new BztError("INVALID_INPUT", "本地操作的步骤记录不完整。");
    if (
      record.executedAt !== null &&
      (!query.resume ||
        rows.every(({ state }) => state === "done" || state === "skipped"))
    )
      return this.result(record, plan);
    this.checkExpiry(record);
    this.checkCapabilities(plan);
    this.checkAuthorization(record, query);
    const excluded = new Set(query.excludeSteps);
    if ([...excluded].some((seq) => seq > rows.length))
      throw new BztError("INVALID_INPUT", "指定排除的步骤不存在。");
    for (const row of rows) {
      if (excluded.has(row.seq) && row.state !== "pending")
        throw new BztError("INVALID_INPUT", "只能排除尚未执行的步骤。");
    }

    // 先保存所有排除项，前序步骤失败也不会在恢复时执行已排除的步骤。
    for (const seq of excluded) {
      this.store.operationSteps.update(opId, seq, { state: "skipped" });
    }
    // 未知步骤先核对回执，再用已确认的写入结果校验其余目标。
    for (const row of rows) {
      if (row.state !== "unknown") continue;
      const step = plan.steps[row.seq - 1];
      if (step === undefined) continue;
      const request = this.resolveRequest(opId, row.seq, step);
      if (request) await this.reconcile(request, row);
    }
    const current = this.store.operationSteps.list(opId);
    if (current.some(({ state }) => state === "unknown"))
      return this.finish(record, plan);
    const eligible = current.filter(
      (row) =>
        row.state === "pending" ||
        (row.state === "failed" &&
          row.zentaoId === null &&
          repeatable.has(row.action)),
    );
    await this.checkTargets(opId, targets, current, eligible, plan);
    this.checkExpiry(record);
    this.store.operations.updateStatus(opId, {
      status: record.status,
      executedAt: record.executedAt ?? this.options.clock(),
    });
    for (const row of eligible) {
      const step = plan.steps[row.seq - 1];
      if (!step) continue;
      if (
        step.fromStep !== undefined &&
        this.store.operationSteps.get(opId, step.fromStep).state === "skipped"
      ) {
        this.store.operationSteps.update(opId, row.seq, { state: "skipped" });
        continue;
      }
      const request = this.resolveRequest(opId, row.seq, step);
      if (!request) continue;
      if (!(await this.runStep(request))) break;
    }
    return this.finish(record, plan);
  }

  private async checkTargets(
    opId: string,
    targets: Fingerprint[],
    rows: OperationStepRecord[],
    eligible: OperationStepRecord[],
    plan: OperationPlan,
  ): Promise<void> {
    const baseline = new Map(
      targets.map((target) => [targetKey(target), target]),
    );
    for (const row of rows) {
      if (row.state !== "done" || row.readbackJson === null) continue;
      const { fingerprint } = parseStored(checkpointSchema, row.readbackJson);
      if (fingerprint) baseline.set(targetKey(fingerprint), fingerprint);
    }
    const verified = new Set<string>();
    for (const row of eligible) {
      const step = plan.steps[row.seq - 1];
      if (!step || step.action === "read") continue;
      const target = this.resolveRequest(opId, row.seq, step);
      if (target?.id === undefined) continue;
      const key = targetKey(getTarget(step, target.id));
      const before = baseline.get(key);
      if (!before || verified.has(key)) continue;
      verified.add(key);
      let fields: string[];
      try {
        fields = changedFields(before, await this.readSnapshot(before));
      } catch (error) {
        if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
          throw error;
        fields = ["id"];
      }
      if (fields.length) {
        this.store.operationSteps.insert({
          opId,
          seq: 0,
          action: staleStepAction,
          targetType: null,
          targetId: null,
          requestDigest: null,
          zentaoId: null,
          readbackJson: JSON.stringify(fields),
          state: "skipped",
          error: null,
        });
        throw new BztError("PLAN_STALE", "操作目标已变更，请重新生成预览。", {
          fields,
        });
      }
    }
  }

  private resolveRequest(
    opId: string,
    seq: number,
    step: OperationStep,
  ): StepRequest | undefined {
    if (step.fromStep === undefined) return { opId, seq, step, id: step.id };
    const source = this.store.operationSteps.get(opId, step.fromStep);
    if (source.state !== "done" || source.zentaoId === null) return undefined;
    return { opId, seq, step, id: source.zentaoId };
  }

  private invalidate(step: OperationStep): void {
    for (const key of step.cacheKeys ?? []) this.store.cache.delete(key);
  }

  private async runStep(request: StepRequest): Promise<boolean> {
    const { opId, seq, step } = request;
    const { gateway, clock } = this.options;
    const attemptedAt = clock();
    if (step.action === "read" && request.id !== undefined) {
      try {
        await this.readSnapshot(getTarget(step, request.id));
      } catch {
        this.store.operationSteps.update(opId, seq, {
          state: "failed",
          error: "无法读取禅道对象。",
        });
        return false;
      }
      this.store.operationSteps.update(opId, seq, {
        state: "done",
        zentaoId: request.id,
      });
      return true;
    }
    // 先持久化不可重发的检查点。崩溃发生于发送前后，恢复都只能核对。
    this.store.operationSteps.update(opId, seq, {
      state: "unknown",
      readbackJson: JSON.stringify({ attemptedAt }),
      error: unknownError,
    });
    let result: z.infer<typeof writeReceipt>;
    try {
      result = writeReceipt.parse(await gateway.write(request));
    } catch (error) {
      if (rejectWrite(error)) {
        this.store.operationSteps.update(opId, seq, {
          state: "failed",
          error: "禅道明确拒绝执行此步骤。",
        });
        return false;
      }
      this.invalidate(step);
      return this.reconcile(request, this.store.operationSteps.get(opId, seq));
    }
    const zentaoId = createsObject.has(step.action)
      ? result.id
      : (request.id ?? result.id);
    if (zentaoId !== undefined)
      this.store.operationSteps.update(opId, seq, {
        state: "unknown",
        zentaoId,
        readbackJson: JSON.stringify({
          attemptedAt,
          actionId: result.actionId,
        }),
      });
    this.invalidate(step);
    if (
      await this.verifyReadback(request, attemptedAt, zentaoId, result.actionId)
    )
      return true;
    return this.reconcile(request, this.store.operationSteps.get(opId, seq));
  }

  private async reconcile(
    request: StepRequest,
    row: OperationStepRecord,
  ): Promise<boolean> {
    const { opId, seq, step } = request;
    const { attemptedAt, actionId } = parseStored(
      checkpointSchema,
      row.readbackJson ?? "{}",
    );
    this.invalidate(step);
    if (row.zentaoId !== null || !createsObject.has(step.action))
      return this.verifyReadback(
        request,
        attemptedAt,
        row.zentaoId ?? request.id,
        actionId,
      );
    const title = step.fields.title?.value;
    if (typeof title !== "string") return false;
    const createdBy = this.store.location.account;
    const since = Math.floor(attemptedAt / 1000) * 1000 - reverseLookupSkewMs;
    const until =
      Math.min(this.options.clock(), attemptedAt + reverseLookupWindowMs) +
      reverseLookupSkewMs;
    let lookup: z.infer<typeof lookupResult>;
    try {
      lookup = lookupResult.parse(
        await this.options.gateway.reverseLookup({
          opId,
          type: step.type,
          product: step.product,
          title,
          ...(typeof step.fields.execution?.value === "number"
            ? { execution: step.fields.execution.value }
            : {}),
          createdBy,
          since,
          until,
        }),
      );
    } catch {
      return false;
    }
    if (!lookup.complete) return false;
    const ids = new Set(
      lookup.matches
        .filter(
          (match) =>
            match.product === step.product &&
            match.title === title &&
            match.createdBy === createdBy &&
            match.createdAt >= since &&
            match.createdAt <= until,
        )
        .map(({ id }) => id),
    );
    const [id] = ids;
    if (ids.size !== 1 || id === undefined) return false;
    this.store.operationSteps.update(opId, seq, {
      state: "unknown",
      zentaoId: id,
    });
    return this.verifyReadback(request, attemptedAt, id);
  }

  private async verifyReadback(
    request: StepRequest,
    attemptedAt: number,
    zentaoId?: number,
    actionId?: number,
  ): Promise<boolean> {
    const { step, opId, seq } = request;
    if (zentaoId === undefined) return false;
    let receipt: z.infer<typeof readbackReceipt>;
    try {
      receipt = readbackReceipt.parse(
        await this.options.gateway.readback({
          ...request,
          zentaoId,
          attemptedAt,
          ...(actionId === undefined ? {} : { actionId }),
        }),
      );
    } catch {
      return false;
    }
    if (!receipt.verified) return false;
    const snapshot = receipt.snapshot;
    if (
      snapshot &&
      (snapshot.id !== zentaoId ||
        snapshot.type !== step.type ||
        snapshot.product !== step.product)
    )
      return false;
    this.invalidate(step);
    this.store.operationSteps.update(opId, seq, {
      state: "done",
      zentaoId,
      error: null,
      readbackJson: JSON.stringify({
        attemptedAt,
        fingerprint: snapshot && fingerprint(snapshot),
      }),
    });
    return true;
  }

  private finish(
    record: OperationRecord,
    plan: OperationPlan,
  ): OperationResult {
    const executed = {
      ...record,
      executedAt: record.executedAt ?? this.options.clock(),
    };
    const result = this.result(executed, plan);
    this.store.operations.updateStatus(record.opId, { status: result.status });
    return result;
  }

  private result(
    record: OperationRecord,
    plan: OperationPlan,
  ): OperationResult {
    const rows = this.store.operationSteps
      .list(record.opId)
      .filter(({ seq }) => seq > 0);
    const status = receiptStatus(rows, record.executedAt !== null);
    const steps: OperationResult["steps"] = [];
    const created: OperationResult["created"] = [];
    for (const row of rows) {
      const step = plan.steps[row.seq - 1];
      const item: OperationResult["steps"][number] = {
        seq: row.seq,
        action: row.action,
        state: row.state,
      };
      if (row.error !== null) item.error = row.error;
      if (step && row.zentaoId !== null) {
        item.zentaoId = row.zentaoId;
        item.url = new URL(
          `${step.type}-view-${row.zentaoId}.html`,
          this.baseUrl,
        ).href;
        if (createsObject.has(step.action))
          created.push({ type: step.type, id: row.zentaoId, url: item.url });
      }
      steps.push(item);
    }
    const result: OperationResult = {
      ok: status === "confirmed",
      opId: record.opId,
      status,
      steps,
      created,
    };
    if (status === "unknown")
      result.nextActions = ["请在禅道人工核对处理结果，避免重复创建。"];
    if (
      status === "partial" &&
      rows.some(
        (row) =>
          row.state === "pending" ||
          (row.state === "failed" && repeatable.has(row.action)),
      )
    )
      result.nextActions = [`confirm_operation(${record.opId}, resume=true)`];
    return result;
  }
}
