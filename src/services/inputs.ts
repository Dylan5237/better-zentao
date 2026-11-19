import { z } from "zod";
import { modes } from "../core/config.js";
import { InvalidParamError } from "../core/errors.js";
import { STORY_WRITE_CATEGORIES } from "../api/types.js";

const text = z.string().trim().min(1);
const id = z.number().int().positive();
export const entityRef = z.union([id, text]);
const moduleRef = z.union([z.number().int().nonnegative(), text]);
export const states = ["design", "runtime", "delivery"] as const;
export const kinds = ["user", "department", "product", "module", "plan", "execution"] as const;
export type State = typeof states[number];
export type Kind = typeof kinds[number];

const state = z.enum(states);
const mode = z.enum(modes);
const selector = { product: entityRef.optional(), state: state.optional() };
const singleProduct = (value: { product?: string | number; state?: State; states?: State[] }) =>
  [value.product, value.state, value.states].filter(part => part !== undefined).length <= 1;
const storyFields = {
  title: text,
  spec: z.string().refine(value => value.trim().length > 0),
  verify: z.string().optional(),
  category: z.enum(STORY_WRITE_CATEGORIES).optional(),
  pri: z.literal([1, 2, 3, 4]).optional(),
  module: moduleRef.optional(),
  plan: entityRef.optional(),
  assignTo: text.optional(),
  feedbackBy: text.optional(),
  source: z.string().trim().optional(),
  batch: text.optional(),
  requirementId: id.optional(),
  skipReview: z.boolean().optional(),
};

export const resolveInput = z.strictObject({
  query: text, kinds: z.array(z.enum(kinds)).min(1).optional(), product: entityRef.optional(),
});
export const dashboardInput = z.strictObject({
  upcomingDays: z.number().int().nonnegative().optional(),
});
export const overdueInput = z.strictObject({
  team: text.optional(), department: entityRef.optional(), members: z.array(text).min(1).optional(),
  includeParentTasks: z.boolean().optional(), includeMultiUserDetail: z.boolean().optional(),
}).refine(value => [value.team, value.department, value.members].filter(part => part !== undefined).length <= 1,
  "请在 team、department 和 members 中选择一种团队范围");
export const queryInput = z.strictObject({
  ...selector, keyword: text.optional(), category: text.optional(), status: text.optional(), stage: text.optional(),
  plan: entityRef.optional(), assignedTo: text.optional(), openedBy: text.optional(), feedbackBy: text.optional(),
  storyType: z.enum(["story", "requirement"]).optional(),
  limit: id.max(200).optional(), maxScanPages: id.optional(),
}).refine(singleProduct, "请在 product 和 state 中指定一种产品定位方式");
export const progressInput = z.strictObject({
  product: entityRef.optional(), storyId: id.optional(), requirementId: id.optional(), feedbackBy: text.optional(),
  includeActions: z.boolean().optional(),
}).refine(value => [value.storyId, value.requirementId, value.feedbackBy].filter(part => part !== undefined).length === 1,
  "请在 storyId、requirementId、feedbackBy 中提供且只提供一项");
export const createInput = z.strictObject({
  ...storyFields, ...selector, states: z.array(state).min(1).max(3).optional(),
  createDevPair: z.boolean().optional(), mode: mode.optional(), dryRun: z.boolean().optional(),
}).refine(singleProduct, "请在 product、state 和 states 中指定一种产品定位方式");
export const importInput = z.strictObject({
  ...selector, stories: z.array(z.strictObject(storyFields)).min(1).max(100), mode: mode.optional(), dryRun: z.boolean().optional(),
}).refine(singleProduct, "请在 product 和 state 中指定一种产品定位方式");
export const assignInput = z.strictObject({
  storyId: id, assignedTo: text, comment: z.string().optional(),
});
export const deleteInput = z.strictObject({
  storyId: id, confirm: z.literal(true),
});

export type ResolveInput = z.infer<typeof resolveInput>;
export type DashboardInput = z.infer<typeof dashboardInput>;
export type OverdueInput = z.infer<typeof overdueInput>;
export type QueryInput = z.infer<typeof queryInput>;
export type ProgressInput = z.infer<typeof progressInput>;
export type CreateInput = z.infer<typeof createInput>;
export type ImportInput = z.infer<typeof importInput>;
export type AssignInput = z.infer<typeof assignInput>;
export type DeleteInput = z.infer<typeof deleteInput>;

export function validateInput<S extends z.ZodObject>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const rule = result.error.issues.find(issue => issue.code === "custom" && issue.path.length === 0);
  if (rule) throw new InvalidParamError(rule.message);
  const invalid = new Set<string>();
  if (!result.error.issues.length) throw new InvalidParamError("工具参数无效");
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === "confirm") throw new InvalidParamError("软删除必须显式传入 confirm: true");
    if (typeof field === "string" && Object.hasOwn(schema.shape, field)) invalid.add(field);
  }
  throw new InvalidParamError(invalid.size ? "参数无效，请检查 " + [...invalid].join("、") : "参数格式无效或含未知字段");
}
