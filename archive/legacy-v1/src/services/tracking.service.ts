import type { ExecutionApi } from "../api/execution.api.js";
import type { MyApi } from "../api/my.api.js";
import type { StoryApi } from "../api/story.api.js";
import type { Plan, Story, StoryDetail, Task } from "../api/types.js";
import type { BetterZentaoConfig } from "../core/config.js";
import { InvalidParamError } from "../core/errors.js";
import { dayNumber, localDate, type UserRef } from "../core/normalizer.js";
import { mapLimit, requestPool } from "./concurrency.js";
import { normalized, type DirectoryService, type UserEntry } from "./directory.service.js";
import {
  states, type DashboardInput, type OverdueInput, type ProgressInput, type QueryInput,
} from "./inputs.js";

const statuses: Record<string, string> = {
  draft: "草稿", active: "激活", reviewing: "评审中", changing: "变更中", closed: "已关闭",
  finished: "已完成", completed: "已完成", done: "已完成", canceled: "已取消", suspend: "已挂起",
};
const stages: Record<string, string> = {
  wait: "未开始", planned: "已计划", projected: "已立项", developing: "研发中", developed: "研发完毕",
  designing: "设计中", designed: "设计完成", testing: "测试中", tested: "测试完毕", verified: "验收完毕",
  released: "已发布", closed: "已关闭", delivering: "交付中", delivered: "已交付",
};
const categories: Record<string, string> = { design: "设计类", feature: "研发类" };
const terminalTasks = new Set(["done", "closed", "cancel", "finished"]);

function pickCode(value: string | undefined, labels: Record<string, string>) {
  return value && (Object.keys(labels).find(code => labels[code] === value) ?? normalized(value));
}

function unfinished(task: Task): boolean {
  return Boolean(task.status && !terminalTasks.has(task.status));
}

function daysUntil(task: Task, today: number): number | undefined {
  const deadline = dayNumber(task.deadline);
  return deadline === undefined ? undefined : deadline - today;
}

function uniqueById<T extends { id: number }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

type PeopleIndex = Map<string, UserEntry>;
function displayName(account: string, realname?: string) {
  return realname || (/^\d+$/.test(account) ? "" : account);
}

function withName(ref: UserRef | null, people: PeopleIndex): UserRef | null {
  if (!ref || ref.account === "closed") return null;
  return { account: ref.account, realname: displayName(ref.account, people.get(ref.account)?.realname || ref.realname) };
}

function storyResult(story: Story, people: PeopleIndex, plan?: Plan, preferredPlanId = story.planIds[0]) {
  return {
    id: story.id, title: story.title, type: story.type, productId: story.productId,
    category: story.category, categoryLabel: Object.hasOwn(categories, story.category) ? categories[story.category] : story.category,
    status: story.status, statusLabel: Object.hasOwn(statuses, story.status) ? statuses[story.status] : "状态未识别",
    stage: story.stage, stageLabel: Object.hasOwn(stages, story.stage) ? stages[story.stage] : "阶段未标记",
    pri: story.pri, planId: preferredPlanId, planTitle: plan?.title, planUrl: plan?.url,
    assignedTo: withName(story.assignedTo, people), openedBy: withName(story.openedBy, people),
    feedbackBy: story.feedbackBy, url: story.url,
  };
}

function taskResult(task: Task, today: number, assignedTo = task.assignedTo) {
  const delta = daysUntil(task, today);
  return { ...task, assignedTo, overdueDays: unfinished(task) && delta !== undefined && delta < 0 ? -delta : 0 };
}

export class TrackingService {
  constructor(
    private readonly directory: DirectoryService,
    private readonly my: MyApi,
    private readonly execution: ExecutionApi,
    private readonly story: StoryApi,
    private readonly config: Pick<BetterZentaoConfig, "teams">,
    private readonly now: () => Date = () => new Date(),
    private readonly concurrency = 8,
  ) {}

  async getMyDashboard({ upcomingDays = 3 }: DashboardInput = {}) {
    const today = dayNumber(localDate(this.now()))!;
    const [me, tasks, assigned, opened] = await Promise.all([
      this.directory.currentUser(), this.my.assignedTasks(), this.my.assignedStories(), this.my.openedStories(),
    ]);
    const workPages = [tasks, assigned, opened];
    const counts = workPages.find(page => page.todoBreakdown !== undefined) ??
      workPages.find(page => page.todoCount !== undefined) ?? await this.my.todos();
    const { todoCount = 0, todoBreakdown } = counts;
    const active = uniqueById(tasks.items).filter(task => !task.isParent && unfinished(task));
    const overdueTasks = active.map(task => taskResult(task, today))
      .filter(task => task.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays);
    const upcomingTasks = active.filter(task => {
      const delta = daysUntil(task, today);
      return delta !== undefined && delta >= 0 && delta <= upcomingDays;
    }).sort((a, b) => daysUntil(a, today)! - daysUntil(b, today)!).map(task => taskResult(task, today));
    const needsDirectory = [...assigned.items, ...opened.items].some(item =>
      [item.assignedTo, item.openedBy].some(ref => ref && ref.account !== me.account && ref.account !== "closed"));
    const users = needsDirectory ? await this.directory.users() : [];
    const people: PeopleIndex = new Map(users.map(user => [user.account, user]));
    if (me.realname) people.set(me.account, me);
    return {
      me: { account: me.account, realname: me.realname, deptName: me.deptName }, todoCount,
      ...(todoBreakdown ? { todoBreakdown } : {}),
      overdueTasks, upcomingTasks,
      assignedStories: assigned.items.map(story => storyResult(story, people)),
      openedStories: opened.items.map(story => storyResult(story, people)),
      summary: "逾期任务 " + overdueTasks.length + " 项，临期任务 " + upcomingTasks.length + " 项，待办 " + todoCount + " 项。",
    };
  }

  private async resolveTeam({ department, team, members }: OverdueInput) {
    if ([department, team, members].filter(value => value !== undefined).length > 1) {
      throw new InvalidParamError("请在 team、department 和 members 中选择一种团队范围");
    }
    const alias = team && Object.hasOwn(this.config.teams, team) ? this.config.teams[team] : undefined;
    if (team && !alias && team !== "本部门") throw new InvalidParamError("未找到团队别名，请检查业务偏好或指定部门");
    const useCurrent = !department && !members && !alias;
    const requestedDepartment = department ?? alias?.department;
    const current = useCurrent ? await this.directory.currentUser() : undefined;
    let deptId = current?.dept;
    let deptName = current?.deptName;
    if (requestedDepartment !== undefined) {
      const found = await this.directory.findDepartment(requestedDepartment);
      if (found.ambiguous || !found.candidates[0]) {
        throw new InvalidParamError("无法唯一定位部门，请先用 resolve_context 核对部门路径或 ID");
      }
      deptId = found.candidates[0].id;
      deptName = found.candidates[0].name;
    }
    if (useCurrent && (!deptId || !deptName)) throw new InvalidParamError("当前用户没有可识别的部门，请显式指定团队范围");
    const people = new Map((deptId ? await this.directory.membersOf(deptId) : []).map(user => [user.account, user]));
    const unresolvedMembers = new Set<string>();
    for (const name of members ?? alias?.members ?? []) {
      const found = await this.directory.findUser(name);
      if (found.ambiguous || !found.candidates[0]) unresolvedMembers.add(name);
      else people.set(found.candidates[0].account, found.candidates[0]);
    }
    const type = team ? "team" : members ? "members" : "department";
    return {
      scope: { type, name: team ?? deptName, departmentId: deptId, memberCount: people.size },
      people, unresolvedMembers: [...unresolvedMembers],
    };
  }

  async getTeamOverdue(input: OverdueInput = {}) {
    const { includeParentTasks = false, includeMultiUserDetail = true } = input;
    const asOfDate = localDate(this.now());
    const today = dayNumber(asOfDate)!;
    const { scope, people, unresolvedMembers } = await this.resolveTeam(input);
    const executions = people.size ? await this.directory.executions() : [];
    const pages = await mapLimit(executions, this.concurrency, execution => this.execution.tasks(execution.id, "delayed"));
    const overdue = uniqueById(pages.flat()).filter(task =>
      (includeParentTasks || !task.isParent) && unfinished(task) && (daysUntil(task, today) ?? 0) < 0);
    const buckets = new Map<string, ReturnType<typeof taskResult>[]>();
    const taskOwners = await mapLimit(overdue, this.concurrency, async task => {
      if (includeMultiUserDetail && ["linear", "multi"].includes(task.mode)) {
        const detail = await this.execution.task(task.id);
        if (detail.team?.length) {
          const accounts = detail.team.filter(member => !terminalTasks.has(member.status) && dayNumber(member.finishedDate) === undefined)
            .map(member => member.account);
          return { task, accounts: [...new Set(accounts)] };
        }
      }
      return { task, accounts: task.assignedTo ? [task.assignedTo.account] : [] };
    });
    let totalOverdueTasks = 0;
    for (const { task, accounts } of taskOwners) {
      const owners = accounts.filter(account => people.has(account));
      if (owners.length) totalOverdueTasks++;
      for (const account of owners) {
        const user = people.get(account)!;
        const display = taskResult(task, today, { account, realname: displayName(account, user.realname) });
        const bucket = buckets.get(account);
        if (bucket) bucket.push(display);
        else buckets.set(account, [display]);
      }
    }
    const byMember = [...buckets].map(([account, tasks]) => {
      tasks.sort((a, b) => b.overdueDays - a.overdueDays || a.id - b.id);
      const user = people.get(account)!;
      return { account, realname: displayName(account, user.realname), deptName: user.deptName, overdueCount: tasks.length,
        maxOverdueDays: tasks[0].overdueDays, tasks };
    }).sort((a, b) => b.maxOverdueDays - a.maxOverdueDays || b.overdueCount - a.overdueCount || a.account.localeCompare(b.account));
    return { scope, asOfDate, totalOverdueTasks, affectedMembersCount: byMember.length, byMember, unresolvedMembers };
  }

  private async userAccount(ref: string | undefined) {
    if (!ref) return undefined;
    const match = await this.directory.findUser(ref);
    if (match.ambiguous) throw new InvalidParamError("人员存在多个候选，请用 resolve_context 核对后指定账号");
    if (!match.candidates[0]) throw new InvalidParamError("人员未匹配，请用 resolve_context 核对账号");
    return match.candidates[0].account;
  }

  private async scanStories(input: QueryInput) {
    const { storyType = "story", limit = 30, maxScanPages = 10, keyword, feedbackBy } = input;
    const [product, assignee, opener] = await Promise.all([
      this.directory.chooseProduct(input), this.userAccount(input.assignedTo), this.userAccount(input.openedBy),
    ]);
    const plan = input.plan !== undefined ? await this.directory.findPlan(product.id, input.plan) : undefined;
    if (plan && (plan.ambiguous || !plan.candidates[0])) throw new InvalidParamError("无法唯一定位计划，请核对计划 ID");
    const planId = plan?.candidates[0]?.id;
    const status = pickCode(input.status, statuses);
    const stage = pickCode(input.stage, stages);
    const category = pickCode(input.category, categories);
    const upstreamStatus = status === "closed" || status === "all" ? "all" : "unclosed";
    const matched = new Map<number, Story>();
    let totalScanned = 0;
    let truncated = false;
    for (let page = 1; page <= maxScanPages; page++) {
      const result = await this.story.list(product.id, storyType, upstreamStatus, page);
      totalScanned += result.scanned;
      for (const item of result.items) {
        if (keyword && !normalized(item.title + " " + item.keywords).includes(normalized(keyword))) continue;
        if (feedbackBy && !normalized(item.feedbackBy).includes(normalized(feedbackBy))) continue;
        if (status && status !== "all" && status !== "unclosed" && item.status !== status) continue;
        if (upstreamStatus === "unclosed" && item.status === "closed") continue;
        if (category && item.category !== category) continue;
        if (stage && item.stage !== stage) continue;
        if (planId && !item.planIds.includes(planId)) continue;
        if (assignee && item.assignedTo?.account !== assignee) continue;
        if (opener && item.openedBy?.account !== opener) continue;
        matched.set(item.id, item);
      }
      if (!result.hasMore) break;
      truncated = page === maxScanPages;
    }
    return { product, totalScanned, truncated, matchedCount: matched.size, planId, items: [...matched.values()].slice(0, limit) };
  }

  async queryStories(input: QueryInput = {}) {
    const { items, planId, ...result } = await this.scanStories(input);
    const [users, plans] = await Promise.all([
      items.some(item => item.assignedTo || item.openedBy) ? this.directory.users() : [],
      items.some(item => item.planIds.length) ? this.directory.plans(result.product.id) : [],
    ]);
    const people = new Map(users.map(user => [user.account, user]));
    const planIndex = new Map(plans.map(entry => [entry.id, entry]));
    const stories = items.map(item => {
      const selectedPlan = planId ?? item.planIds[0];
      return storyResult(item, people, planIndex.get(selectedPlan), selectedPlan);
    });
    return { ...result, stories };
  }

  private async progressCard(
    story: StoryDetail, today: number, includeActions: boolean,
    people: PeopleIndex, loadExecution: (id: number) => Promise<Task[]>,
    loadTask: (id: number) => Promise<Task>,
  ) {
    const embedded = uniqueById(story.tasks);
    const incomplete = embedded.some(task => task.deadline === undefined || task.left === undefined);
    const [plans, pages] = await Promise.all([
      story.productId && story.planIds.length ? this.directory.plans(story.productId) : [],
      incomplete ? mapLimit(story.executionIds, this.concurrency, loadExecution) : [],
    ]);
    const taskIndex = new Map(pages.flat().map(task => [task.id, task]));
    const tasks = await mapLimit(embedded, this.concurrency, async task => {
      let detail = taskIndex.get(task.id) ?? task;
      if (detail.deadline === undefined || detail.left === undefined) detail = await loadTask(task.id);
      return taskResult(detail, today, withName(detail.assignedTo, people));
    });
    const plan = plans.find(plan => plan.id === story.planIds[0]);
    const result = storyResult(story, people, plan);
    const overdueCount = tasks.filter(task => !task.isParent && task.overdueDays > 0).length;
    const feedbackSummary = "《" + result.title + "》当前状态为" + result.statusLabel + "，阶段为" + result.stageLabel +
      (plan ? "，所属计划为「" + plan.title + "」" : "") +
      "。关联任务 " + tasks.filter(task => !task.isParent).length + " 项，逾期 " + overdueCount + " 项。" + "\n" + story.url;
    return {
      ...result, spec: story.spec, verify: story.verify, plan: plan ?? null, tasks, overdueCount,
      ...(includeActions ? { actions: story.actions } : {}), feedbackSummary,
    };
  }

  async getStoryProgress({ storyId, requirementId, feedbackBy, product, includeActions = false }: ProgressInput) {
    if ([storyId, requirementId, feedbackBy].filter(value => value !== undefined).length !== 1) {
      throw new InvalidParamError("请在 storyId、requirementId、feedbackBy 中提供且只提供一项");
    }
    const executionReads = new Map<number, Promise<Task[]>>();
    const run = requestPool(this.concurrency);
    const loadExecution = (id: number) => {
      let pending = executionReads.get(id);
      if (!pending) {
        pending = run(() => this.execution.tasks(id));
        executionReads.set(id, pending);
      }
      return pending;
    };
    const today = dayNumber(localDate(this.now()))!;
    const people = new Map((await this.directory.users()).map(user => [user.account, user]));
    const loadTask = (id: number) => run(() => this.execution.task(id));
    const card = (detail: StoryDetail) => this.progressCard(detail, today, includeActions, people, loadExecution, loadTask);
    if (storyId) return card(await this.story.get(storyId));
    if (requirementId) {
      const detail = await this.story.get(requirementId, "requirement");
      const requirement = await card(detail);
      const linkedStories = await mapLimit(detail.linkedStoryIds, this.concurrency,
        async id => card(await this.story.get(id)));
      const feedbackSummary = [requirement.feedbackSummary, ...linkedStories.map(item => item.feedbackSummary)].join("\n\n");
      return { requirement, linkedStories, feedbackSummary };
    }
    const targets = product !== undefined ? [product] : [...new Set(states.map(state => this.directory.stateProductId(state)))];
    const scans = await mapLimit(targets, this.concurrency, product => this.scanStories({ product, feedbackBy, status: "all" }));
    const stories = await mapLimit(uniqueById(scans.flatMap(scan => scan.items)), this.concurrency,
      async item => card(await this.story.get(item.id)));
    const truncated = scans.some(scan => scan.truncated || scan.matchedCount > scan.items.length);
    const feedbackSummary = stories.map(item => item.feedbackSummary).join("\n\n") || "在所查产品中没有找到该反馈者的需求。";
    return { feedbackBy, products: scans.map(scan => scan.product), stories, truncated, feedbackSummary };
  }
}
