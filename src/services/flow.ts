import type { ZentaoReadClient } from "../api/client.ts";
import { getStoryDetail } from "../api/story.ts";
import type {
  OperationStep,
  PreparedOperation,
} from "../contracts/operation.ts";
import { assignStoryInputSchema } from "../contracts/tools/assign_story.ts";
import type { TeamConfig } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import { BztError } from "../core/errors.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { parseStoryRoleTag } from "../domain/story-html-spec.ts";
import type { RuleInput } from "../rules/types.ts";
import * as r04 from "../rules/r04-premature-assignment.ts";
import type { DirectoryService } from "./directory.ts";
import type { OperationExecutor } from "./operation.ts";

type StoryRoles = NonNullable<RuleInput["roles"]>;

interface FlowOptions {
  readonly client: ZentaoReadClient;
  readonly directory: Pick<DirectoryService, "resolveContext">;
  readonly executor: Pick<OperationExecutor, "prepare">;
  readonly storyRoles?: { readonly get: (id: number) => StoryRoles["stored"] };
  readonly config: Pick<
    TeamConfig,
    "roles" | "teams" | "modules" | "moduleDefaults" | "rules"
  >;
}

function developmentAccounts(config: FlowOptions["config"]): Set<string> {
  const accounts = new Set(config.roles.RM);
  for (const { devLead } of [
    ...Object.values(config.modules),
    ...Object.values(config.moduleDefaults),
  ]) {
    if (devLead) accounts.add(devLead);
  }
  for (const { lead, members, executionKinds } of Object.values(config.teams)) {
    if (!executionKinds?.includes("dev")) continue;
    accounts.add(lead);
    for (const member of members) accounts.add(member);
  }
  return accounts;
}

export class FlowService {
  constructor(private readonly options: FlowOptions) {}

  async assignStory(raw: unknown): Promise<PreparedOperation> {
    const parsed = assignStoryInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "请提供有效的需求编号和指派对象，并检查指派参数。",
      );
    const { client, executor, config } = this.options;
    const { storyIds, to, comment, notify } = parsed.data;
    const person = await this.readPerson(to);
    if (!person) throw new BztError("NOT_FOUND", "未找到指派对象。");

    const ids = [...new Set(storyIds)];
    const stories = await Promise.all(
      ids.map((id) => this.readStory(client, id)),
    );
    const accounts = developmentAccounts(config);
    if (person.roles.includes("dev")) accounts.add(person.account);
    const steps: OperationStep[] = [];
    const warnings: PreparedOperation["warnings"] = [];
    const previousAccounts = new Set<string>();
    const explicitNotify =
      typeof raw === "object" &&
      raw !== null &&
      "notify" in raw &&
      raw.notify !== undefined;
    const fields: OperationStep["fields"] = {
      assignedTo: {
        value: person.account,
        origin: to === person.account ? "user" : "derived",
      },
      ...(comment === undefined
        ? {}
        : { comment: { value: comment, origin: "user" } }),
      // 通知意图由执行层在指派确认后使用，禅道请求只接收指派账号和原因。
      notify: { value: notify, origin: explicitNotify ? "user" : "default" },
    };
    for (const story of stories) {
      const { id, product, assignedTo } = story;
      if (
        assignedTo &&
        assignedTo !== "closed" &&
        assignedTo !== person.account
      )
        previousAccounts.add(assignedTo);
      steps.push({
        action: "story.assign",
        type: "story",
        product,
        id,
        fields,
        cacheKeys: [`story:${id}`, `stories:${product}`],
      });
      if (!config.rules.R04.enabled) continue;
      const proposed = { ...story, assignedTo: person.account };
      const roles = this.roleInputs(story);
      for (const hit of r04.evaluate(
        { story: proposed, roles },
        { developmentAccounts: accounts },
      )) {
        const { maintainer } = resolveStoryRoles({ ...roles, story: proposed });
        let waiting = "状态维护人待确认";
        if (parseStoryRoleTag(story.spec ?? "")?.maintainer)
          waiting = "状态维护人来自需求正文角色标签（不可信，待核实）";
        else if (maintainer) waiting = `等待状态维护人 ${maintainer} 推进`;
        warnings.push({
          code: hit.ruleId,
          message: `需求 #${id} 指派后属于「已指派但未就绪」，${waiting}。建议就绪后用 handoff_story 激活并移交研发。`,
        });
      }
    }

    const previousAffects = await Promise.all(
      [...previousAccounts].map(async (account) => {
        try {
          const previous = await this.readPerson(account);
          if (previous?.account === account)
            return `${account} ${previous.realname}`.trim();
        } catch (error) {
          if (
            !(error instanceof BztError) ||
            (error.code !== "NOT_FOUND" && error.code !== "AMBIGUOUS_ENTITY")
          )
            throw error;
        }
        return account;
      }),
    );

    return executor.prepare({
      kind: "assign_story",
      summary: `将 ${ids.length} 条需求指派给 ${person.account}。`,
      steps,
      affects: [
        `${person.account} ${person.realname}`.trim(),
        ...previousAffects,
      ],
      warnings,
    });
  }

  private async readPerson(input: string) {
    const context = await this.options.directory.resolveContext({
      people: [input],
    });
    // 目录截断时，未读取的记录仍可能影响姓名或拼音匹配的唯一性。
    if (context.completeness === "partial" || context.truncated)
      throw new BztError(
        "ZENTAO_UNAVAILABLE",
        "人员目录读取不完整，无法准备指派。",
        {
          completeness: "partial",
          gaps: context.gaps,
        },
      );
    return context.data.people[0];
  }

  private roleInputs({ id, product, module }: StoryDetail): StoryRoles {
    const { config, storyRoles } = this.options;
    const configured = config.modules[`${product}:${module}`];
    const defaults = config.moduleDefaults[product];
    let stored: StoryRoles["stored"];
    try {
      stored = storyRoles?.get(id);
    } catch (error) {
      if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
        throw error;
    }
    return {
      stored,
      module: {
        maintainer: configured?.designLead ?? defaults?.designLead,
        devLead: configured?.devLead ?? defaults?.devLead,
      },
    };
  }

  private async readStory(
    client: ZentaoReadClient,
    id: number,
  ): Promise<StoryDetail> {
    try {
      const story = await getStoryDetail(client, id);
      if (story.type !== "story" || story.id !== id)
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "禅道返回的需求类型或编号与请求不一致。",
        );
      if (story.deleted)
        throw new BztError("NOT_FOUND", "需求已删除，无法指派。");
      return story;
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      throw new BztError(
        error.code,
        `无法确认需求 #${id}，请检查需求及查看权限。`,
        {
          completeness: "partial",
          gaps: [
            {
              source: `story:${id}`,
              reason: `需求预检失败（${error.code}）。`,
            },
          ],
        },
      );
    }
  }
}
