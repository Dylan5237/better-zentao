import { icon } from "./meridian-icons.js";
import { createMeridianShell } from "./meridian-shell.js";
import { beginSkeleton, skeletonBlock } from "./skeleton.js";
import { querySkeleton, roleOptionsSkeleton } from "./portal-skeleton.js";
import {
  sectionsFor,
  renderGuide,
  renderReview,
  renderShortcuts,
} from "./review-page.js";
const roleHome = {
  FB: {
    title: "我提出的需求",
    description: "查看自己反馈的事项、处理进展和回执。",
    groups: ["raised"],
  },
  DM: {
    title: "待接收与评审",
    description: "查看需要设计评审、接收或继续跟进的需求。",
    groups: ["action", "waiting_ready"],
  },
  DS: {
    title: "设计维护与交付",
    description: "跟踪自己维护的需求，以及可以开始的验收和交付。",
    groups: ["maintained", "can_start"],
  },
  RM: {
    title: "接收与研发就绪",
    description: "查看待接收的需求、未就绪的事项和需要处理的任务。",
    groups: ["action", "waiting_ready"],
  },
  RD: {
    title: "我的研发待办",
    description: "查看新分配、逾期和临期任务，按需求查看研发范围。",
    groups: ["action", "new"],
  },
  QA: {
    title: "测试就绪",
    description: "查看可开测、即将开测和待处理的事项。",
    groups: ["can_start", "action"],
  },
  PM: {
    title: "月度计划与发布",
    description: "查看计划交付、版本门禁、承诺和迭代指标。",
    view: "plan",
  },
  PJ: {
    title: "迭代与承诺",
    description: "查看迭代指标、月度承诺和计划完成情况。",
    view: "iteration",
  },
};

const roleResponsibilities = {
  FB: "反馈业务需求，跟进本人提出的事项。",
  PM: "跟进月度计划和版本发布，登记门禁例外。",
  PJ: "核对迭代、月度承诺和成员排期。",
  DM: "评审、指派和移交设计需求，安排设计任务。",
  DS: "维护设计需求，跟踪验收与交付。",
  RM: "接收研发需求，安排排期和指派，跟进挪月和收尾。",
  RD: "处理研发待办，核对需求范围与验收条件。",
  QA: "核对可开测需求，跟进测试事项与风险。",
};

const textField = (name, label, placeholder) => ({ name, label, placeholder });
const select = (name, label, options) => ({ name, label, options });
const number = (name, label, min = 1, step = 1) => ({
  name,
  label,
  type: "number",
  min,
  step,
});
const date = (name, label) => ({ name, label, type: "date" });
const checkbox = (name, label) => ({ name, label, type: "checkbox" });

const product = textField("product", "产品", "名称或编号");
const team = textField("team", "团队", "名称或代号");
const moduleField = textField("module", "模块", "名称、路径或编号");
const month = { name: "month", label: "月份", type: "month" };
const plan = textField("plan", "计划", "名称或编号");
const members = textField("members", "成员账号", "多个账号用逗号隔开");
const version = textField("version", "版本", "禅道版本标识");

const reads = {
  get_my_work: {
    label: "我的工作",
    fields: [number("horizonDays", "临期窗口（工作日）", 0)],
  },
  query_stories: {
    label: "需求查询",
    description: "按关键词、范围或登记时间查找禅道需求。",
    fields: [
      textField("keyword", "关键词", "需求标题或关键词"),
      product,
      month,
      moduleField,
      plan,
      version,
      select("category", "需求类别", [
        ["", "全部"],
        ["design", "设计"],
        ["feature", "研发"],
      ]),
      select("type", "记录类型", [
        ["", "全部"],
        ["story", "需求"],
        ["requirement", "来源需求"],
      ]),
      select("role", "关联方式", [
        ["", "不限"],
        ["maintainer", "维护人"],
        ["receiver", "接收人"],
        ["raised", "提出者"],
        ["assigned", "当前处理人"],
      ]),
      textField("who", "关联人", "账号、姓名或角色"),
      date("openedFrom", "登记日期起"),
      date("openedTo", "登记日期止"),
      number("limit", "最多返回条数"),
    ],
  },
  get_story_progress: {
    label: "需求进展",
    description: "用需求编号或来源编号核对进展、阶段和待办。",
    fields: [
      select("lookup", "查找方式", [
        ["storyId", "需求编号"],
        ["intakeId", "提需回执编号"],
        ["requirementId", "来源需求编号"],
      ]),
      {
        ...number("storyId", "需求编号"),
        when: ["lookup", "storyId"],
        required: true,
      },
      {
        ...textField("intakeId", "提需回执编号"),
        when: ["lookup", "intakeId"],
        required: true,
      },
      {
        ...number("requirementId", "来源需求编号"),
        when: ["lookup", "requirementId"],
        required: true,
      },
      select("view", "内容范围", [
        ["full", "完整进展"],
        ["dev", "研发范围与验收"],
      ]),
      select("format", "显示方式", [
        ["data", "工作台明细"],
        ["card", "可转发进度卡"],
      ]),
    ],
  },
  get_team_work: {
    label: "团队工作",
    description: "查看团队或指定成员的未完成、逾期和临期任务。",
    fields: [
      team,
      members,
      product,
      select("view", "任务范围", [
        ["overdue", "逾期"],
        ["due_soon", "临期"],
        ["all_open", "全部未完成"],
      ]),
      select("groupBy", "分组", [
        ["member", "按成员"],
        ["story", "按需求"],
        ["execution", "按迭代"],
      ]),
    ],
  },
  get_member_schedule: {
    label: "成员排期",
    description: "查看禅道可见投入和未来排期，可按预计工时试算人选。",
    fields: [
      members,
      number("weeks", "查看周数"),
      select("bucket", "汇总方式", [
        ["week", "按周"],
        ["day", "按日"],
      ]),
      number("estimateHours", "拟增任务预计工时", 0, "any"),
      date("earliestStart", "最早开始日期"),
      date("deadline", "预计截止日期"),
    ],
  },
  get_plan_progress: {
    label: "计划与交付",
    fields: [
      select("view", "管理视图", [
        ["plan", "计划交付"],
        ["release", "发布门禁"],
        ["commitment", "月度承诺"],
        ["iteration", "迭代指标"],
      ]),
      product,
      month,
      { ...plan, when: ["view", "plan"] },
      { ...version, when: ["view", "release"] },
      {
        ...textField("execution", "迭代", "名称或编号"),
        when: ["view", "iteration"],
      },
      {
        ...select("groupBy", "分组", [
          ["owner", "按负责人"],
          ["module", "按模块"],
          ["progress", "按进展"],
        ]),
        when: ["view", "plan"],
      },
    ],
  },
  get_monthly_dev_queue: {
    label: "月度研发队列",
    description: "查看待接收、开发中、结转和计划与迭代衔接情况。",
    fields: [team, month, checkbox("includeNotReady", "同时显示未就绪需求")],
  },
  scan_workflow_risks: {
    label: "流程风险",
    description: "按范围核对流程风险、命中依据和处理建议。",
    fields: [
      product,
      team,
      moduleField,
      month,
      select("minSeverity", "最低严重程度", [
        ["info", "提示"],
        ["low", "低"],
        ["medium", "中"],
        ["high", "高"],
      ]),
      select("groupBy", "分组", [
        ["rule", "按规则"],
        ["owner", "按负责人"],
        ["story", "按需求"],
      ]),
      textField("rules", "风险规则", "如 R02，多个用逗号隔开"),
      checkbox("mine", "仅看与我相关的风险"),
    ],
  },
};

const writes = {
  import_stories: {
    label: "批量导入草稿",
    description: "逐行检查草稿，预览后确认导入。",
  },
  create_story: {
    label: "提出需求",
    description: "填写实际背景、范围和验收条件，先查看操作预览。",
  },
  assign_story: {
    label: "指派需求",
    description: "核对需求编号和接收人的账号。",
  },
  decompose_stories: {
    label: "拆解任务",
    description: "按角色适用的模板预览阶段任务。",
  },
  handoff_story: {
    label: "需求移交",
    description: "核对移交方式、接收人和本次实现范围。",
  },
  reschedule_story: {
    label: "需求挪月",
    description: "说明拟调整月份和变更原因。",
  },
  close_stories: {
    label: "关闭与收尾",
    description: "核对待关闭需求或清理范围。",
  },
  set_story_meta: {
    label: "登记门禁例外",
    description: "填写已确认的例外原因，查看登记预览。",
  },
};

export function navigationFor(role) {
  return [...new Set(role.actions)].flatMap((tool) => {
    if (Object.hasOwn(reads, tool))
      return [{ tool, label: reads[tool].label, kind: "read" }];
    if (Object.hasOwn(writes, tool))
      return [{ tool, label: writes[tool].label, kind: "write" }];
    return [];
  });
}

export function initialAction(role) {
  const items = navigationFor(role);
  const preferred = roleHome[role.id]?.view
    ? "get_plan_progress"
    : "get_my_work";
  return items.find(({ tool }) => tool === preferred)?.tool ?? items[0]?.tool;
}

function defaults(tool, role) {
  switch (tool) {
    case "get_story_progress":
      if (role === "RD") return { view: "dev" };
      if (role === "FB") return { format: "card" };
      return {};
    case "get_plan_progress":
      if (role === "QA") return { view: "release" };
      return { view: roleHome[role]?.view ?? "plan" };
    case "get_monthly_dev_queue":
      return { includeNotReady: true };
    default:
      return {};
  }
}

function listed(value) {
  return (value ?? "")
    .split(/[,，、\n]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readFields(tool, role) {
  return reads[tool].fields.filter(({ name }) => {
    if (role === "QA" && name === "mine") return false;
    return (
      role !== "FB" ||
      tool !== "query_stories" ||
      !["role", "who"].includes(name)
    );
  });
}

export function buildReadInput(tool, role, values = {}) {
  const input = defaults(tool, role);
  const lookup = values.lookup || "storyId";
  if (
    tool === "get_story_progress" &&
    !["storyId", "intakeId", "requirementId"].includes(lookup)
  )
    return null;
  const selections = { ...input, ...values, lookup };
  for (const field of readFields(tool, role)) {
    const { name, type, min, step, when, required } = field;
    if (name === "lookup" || (when && selections[when[0]] !== when[1]))
      continue;
    const value = values[name]?.trim();
    if (!value) {
      if (required) return null;
      continue;
    }
    if (type === "number") {
      const parsed = Number(value);
      if (
        !Number.isFinite(parsed) ||
        parsed < min ||
        (step === 1 && !Number.isSafeInteger(parsed))
      )
        return null;
      input[name] = parsed;
    } else if (type === "checkbox") {
      input[name] = value === "true";
    } else {
      input[name] = value;
    }
  }
  if (tool === "get_my_work") {
    return { ...input, groups: roleHome[role]?.groups, markSeen: false };
  }
  if (tool === "scan_workflow_risks") {
    const { product, team, module, month, mine, rules, ...options } = input;
    const scope = Object.fromEntries(
      Object.entries({
        product,
        team,
        module,
        month,
        mine: role === "QA" ? true : mine,
      }).filter(([, value]) => value !== undefined),
    );
    const ruleList = listed(rules);
    return {
      ...options,
      scope,
      ...(ruleList.length ? { rules: ruleList } : {}),
    };
  }
  if (tool === "get_member_schedule") {
    const { estimateHours, earliestStart, deadline, members, ...options } =
      input;
    if ((estimateHours === 0 || earliestStart || deadline) && !estimateHours)
      return null;
    const newTask =
      estimateHours === undefined
        ? undefined
        : {
            estimateHours,
            ...(earliestStart && { earliestStart }),
            ...(deadline && { deadline }),
          };
    const memberList = listed(members);
    return {
      ...options,
      format: "table",
      ...(memberList.length ? { members: memberList } : {}),
      ...(newTask ? { newTask } : {}),
    };
  }
  if (tool === "get_team_work" && input.members) {
    const entries = listed(input.members);
    if (entries.length) input.members = entries;
    else delete input.members;
  }
  return input;
}

class StalePortalRequest extends Error {
  constructor() {
    super("此页面已失效，请回到当前工作区重新操作。");
    this.name = "StalePortalRequest";
  }
}

async function requestJson(send, url, { body, account, launch, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (account !== undefined)
    headers["X-Bzt-Account"] = encodeURIComponent(account);
  if (launch) headers["X-Bzt-Launch"] = launch;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await send(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    throw Object.assign(
      new Error(data?.message || "本地服务未返回可用结果，请重试。"),
      {
        status: response.status,
        code: data?.code,
        details: data?.details,
      },
    );
  }
  return data;
}

export function takeLaunchFragment(location, history) {
  if (!location.hash.startsWith("#launch=")) return undefined;
  const launch = new URLSearchParams(location.hash.slice(1)).get("launch");
  if (!launch) return undefined;
  const url = new URL(location.href);
  url.hash = "";
  history.replaceState(history.state, "", url.href);
  return launch;
}

export function watchLaunchFragment(browser, onLaunch) {
  browser.addEventListener("hashchange", () => {
    const launch = takeLaunchFragment(browser.location, browser.history);
    if (launch) onLaunch(launch);
  });
}

function launchDenied(error) {
  return error.status === 403 && error.code === "PERMISSION_DENIED";
}

export async function initializePortalSession(session, launch) {
  await session.restore();
  if (session.identity) return {};
  let startup;
  try {
    startup = await session.startup(launch);
  } catch (error) {
    if (!launch || !launchDenied(error)) throw error;
    return { startup: await session.startup(), launchRejected: true };
  }
  if (!launch || !startup.hasSavedLogin) return { startup };
  try {
    await session.loginSaved(launch);
  } catch (error) {
    if (error.name === "StalePortalRequest") throw error;
    if (launchDenied(error))
      return { startup: await session.startup(), launchRejected: true };
    return { startup, savedFailed: true };
  }
  return { startup };
}

export function createPortalSession(send = fetch) {
  let version = 0;
  let identity = null;
  let role;

  function invalidate() {
    identity = null;
    role = undefined;
    return ++version;
  }

  function setIdentity(next, preferred) {
    identity = next;
    role =
      (identity.account === preferred?.account &&
        identity.roles.find(({ id }) => id === preferred.role)) ||
      identity.roles[0];
  }

  async function load(url, body, preferred) {
    const attempt = invalidate();
    let next;
    try {
      next = await requestJson(send, url, { body });
    } catch (error) {
      if (version !== attempt) throw new StalePortalRequest();
      if (body === undefined && error.status === 401) return;
      throw error;
    }
    if (version !== attempt) throw new StalePortalRequest();
    setIdentity(next, preferred);
  }

  return {
    get identity() {
      return identity;
    },
    get role() {
      return role;
    },
    restore() {
      return load("/api/session", undefined, {
        account: identity?.account,
        role: role?.id,
      });
    },
    async sync() {
      const before = version;
      let next;
      try {
        next = await requestJson(send, "/api/session");
      } catch (error) {
        if (error.status !== 401) throw error;
        next = null;
      }
      if (
        before !== version ||
        JSON.stringify(next) === JSON.stringify(identity)
      )
        return "unchanged";
      const retained =
        next?.account === identity?.account
          ? next?.roles.find(({ id }) => id === role?.id)
          : undefined;
      const preserveForm =
        retained &&
        JSON.stringify(retained.actions) === JSON.stringify(role.actions);
      identity = next;
      role = retained ?? next?.roles[0];
      if (preserveForm) return "roles";
      ++version;
      return "workspace";
    },
    startup(launch) {
      return requestJson(send, "/api/startup", { launch });
    },
    login(account, password, { baseUrl, launch } = {}) {
      return load("/api/login", {
        account,
        password,
        ...(baseUrl && { baseUrl }),
        ...(launch && { launch }),
      });
    },
    loginSaved(launch) {
      return load("/api/login", { launch, saved: true });
    },
    async saveRoles(roles, revision) {
      if (!identity?.roleSetup)
        throw Object.assign(new Error("当前账号无法设置职责。"), {
          code: "PERMISSION_DENIED",
        });
      const account = identity.account;
      const before = version;
      const next = await requestJson(send, "/api/roles", {
        account,
        body: { roles, revision },
      });
      if (version !== before || next.account !== account)
        throw new StalePortalRequest();
      ++version;
      setIdentity(next, { account, role: role?.id });
    },
    async logout() {
      const account = identity?.account;
      invalidate();
      if (account !== undefined)
        await requestJson(send, "/api/logout", { account, body: {} });
    },
    selectRole(id) {
      const next = identity?.roles.find((entry) => entry.id === id);
      if (!next) return false;
      if (next !== role) ++version;
      role = next;
      return true;
    },
    scope(signal) {
      const versionAtOpen = version;
      const accountAtOpen = identity?.account;
      const roleAtOpen = role;
      const current = () =>
        Boolean(roleAtOpen && version === versionAtOpen && !signal?.aborted);
      function check() {
        if (!current()) throw new StalePortalRequest();
      }
      return {
        current,
        async refreshIfRevoked() {
          check();
          const latest = await requestJson(send, "/api/session", { signal });
          check();
          if (latest.account !== accountAtOpen) {
            throw Object.assign(new Error("登录账号已切换。"), {
              status: 409,
              code: "AUTH_FAILED",
            });
          }
          if (latest.roles.some(({ id }) => id === roleAtOpen.id)) return false;
          ++version;
          identity = latest;
          role = latest.roles[0];
          return true;
        },
        async call(tool, input) {
          check();
          if (
            !roleAtOpen.actions.includes(tool) &&
            !["confirm_operation", "get_operation"].includes(tool)
          ) {
            throw Object.assign(new Error("当前职责无权执行该操作。"), {
              code: "PERMISSION_DENIED",
            });
          }
          try {
            const result = await requestJson(send, "/api/call", {
              account: accountAtOpen,
              signal,
              body: { role: roleAtOpen.id, tool, input },
            });
            check();
            return result;
          } catch (error) {
            check();
            throw error;
          }
        },
      };
    },
  };
}

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(text, error = false) {
  const message = make("p", text, error ? "notice notice-error" : "notice");
  message.setAttribute("role", error ? "alert" : "status");
  return message;
}

function queryError(tool, error) {
  const message = notice(
    error.status ? error.message : "查询失败，请检查本机服务后重试。",
    true,
  );
  const details = error.details;
  if (!details) return message;
  const labels = new Map(
    reads[tool].fields.map(({ name, label }) => [name, label]),
  );
  for (const [key, title] of [
    ["missing", "需要补齐"],
    ["fields", "请核对字段"],
  ]) {
    if (!Array.isArray(details[key])) continue;
    const names = details[key]
      .filter((value) => typeof value === "string")
      .map((name) => labels.get(name) ?? name);
    if (names.length)
      message.append(make("small", `${title} ${names.join("、")}`));
  }
  if (Array.isArray(details.candidates)) {
    const names = details.candidates
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const name = entry?.realname ?? entry?.name ?? entry?.title;
        const key = entry?.account ?? entry?.id;
        return [name, key]
          .filter(
            (value) => typeof value === "string" || typeof value === "number",
          )
          .join(" · ");
      })
      .filter(Boolean);
    if (names.length) message.append(make("small", `候选 ${names.join("、")}`));
  }
  return message;
}

function accountChanged(error) {
  return error.status === 409 && error.code === "AUTH_FAILED";
}

function queryForm(tool, role, preset = {}) {
  const form = make("form", undefined, "filter-panel");
  const grid = make("div", undefined, "filter-grid");
  const labels = [];
  const initial = { ...defaults(tool, role), ...preset };
  for (const field of readFields(tool, role)) {
    const wrapper = make(
      "label",
      undefined,
      field.type === "checkbox" ? "filter-check" : "field",
    );
    const label = make("span", field.label);
    const control = make(field.options ? "select" : "input");
    control.name = field.name;
    if (field.options) {
      for (const [value, text] of field.options) {
        if (
          role === "QA" &&
          tool === "get_plan_progress" &&
          field.name === "view" &&
          value !== "release"
        )
          continue;
        const option = make("option", text);
        option.value = value;
        control.append(option);
      }
    } else {
      control.type = field.type ?? "text";
      if (field.placeholder) control.placeholder = field.placeholder;
      if (field.min !== undefined) control.min = field.min;
      if (field.step !== undefined) control.step = field.step;
    }
    if (field.type === "checkbox") {
      control.value = "true";
      control.checked = initial[field.name] === true;
      wrapper.append(control, label);
      if (field.name === "includeNotReady") {
        const unchecked = make("input");
        unchecked.type = "hidden";
        unchecked.name = field.name;
        unchecked.value = "false";
        wrapper.prepend(unchecked);
      }
    } else {
      if (initial[field.name] !== undefined)
        control.value = initial[field.name];
      wrapper.append(label, control);
    }
    labels.push({ field, control, wrapper });
    grid.append(wrapper);
  }
  const sync = () => {
    for (const { field, control, wrapper } of labels) {
      const visible =
        !field.when ||
        form.elements.namedItem(field.when[0]).value === field.when[1];
      wrapper.hidden = !visible;
      control.disabled = !visible;
      control.required = visible && Boolean(field.required);
    }
  };
  const submit = make("button", "查询", "btn btn-primary");
  submit.type = "submit";
  const footer = make("div", undefined, "filter-actions");
  footer.append(submit);
  form.append(grid, footer);
  form.addEventListener("change", sync);
  sync();
  return { form, submit };
}

function mountPortal(
  {
    renderRead,
    renderWrite,
    renderWorkbench,
    renderIntake,
    renderStories,
    renderStoryDrawer,
    renderSchedule,
    renderReleaseRisks,
  },
  launch,
) {
  const byId = (id) => document.getElementById(id);
  const session = createPortalSession();
  const loginPage = byId("login-page");
  const loginForm = byId("login-form");
  const loginStatus = byId("login-status");
  const accountInput = byId("login-account");
  const passwordInput = byId("login-password");
  const baseUrlInput = byId("login-base-url");
  const baseUrlField = byId("login-base-url-field");
  const launchRequired = byId("launch-required");
  const loginButton = byId("login-button");
  const startup = byId("startup");
  const portal = byId("portal-shell");
  const accountDisplay = byId("session-account");
  const roleTabs = byId("role-tabs");
  const guideButton = byId("guide-button");
  const shortcutsButton = byId("shortcuts-button");
  const roleSettings = byId("role-settings-button");
  const nav = byId("role-nav");
  const workspace = byId("workspace");
  const sessionStatus = byId("session-status");
  const sessionUpdates =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("bzt-portal-session")
      : undefined;
  let page;
  let overlay;
  let reviewAccount;
  const meetingRecords = new Map();
  const badges = new Map();
  const badgeRevisions = new Map();
  let readRevision = 0;

  let editingRoles = false;
  let pendingLaunch;
  let currentSection = "workbench";
  let badgeReads;
  const sidebar = byId("sidebar");
  const accountDialog = byId("account-dialog");
  const shell = createMeridianShell({
    byId,
    session,
    sectionsFor,
    openSection,
    openStory,
    openTool,
    getCurrent: () => currentSection,
    showAccount: () => accountDialog.showModal(),
    selectRole: (id) => {
      if (session.selectRole(id)) showSession();
    },
    toolsFor: navigationFor,
    contextFor: viewContext,
  });

  function openPendingLaunch() {
    if (
      !pendingLaunch ||
      session.identity ||
      !startup.hidden ||
      loginButton.disabled
    )
      return;
    launch = pendingLaunch;
    pendingLaunch = undefined;
    void restore("", true);
  }

  function discardPage() {
    shell.clear();
    closeOverlay();
    page?.abort();
    workspace.replaceChildren();
  }

  function showRoleOptions(identity, role) {
    shell.drawRoles(identity, role);
    byId("account-start").hidden = false;
    byId("account-start").classList.toggle("only-compact", Boolean(role));
    roleTabs.hidden = !role;
    roleSettings.hidden = !identity.roleSetup || !role;
    guideButton.hidden = !role;
    shortcutsButton.hidden = !role;
  }

  async function syncSession() {
    if (!startup.hidden || loginButton.disabled) return;
    const previousAccount = session.identity?.account;
    try {
      const change = await session.sync();
      if (
        editingRoles &&
        session.identity?.account === previousAccount &&
        session.identity?.roleSetup
      )
        return;
      if (change === "workspace" || (editingRoles && change === "roles")) {
        if (session.identity) showSession("本机会话已更新。");
        else await showLogin("请重新登录禅道。");
      } else if (change === "roles") {
        showRoleOptions(session.identity, session.role);
      }
    } catch {
      // 等待下一次会话信号或工具调用验证状态，避免中断正在填写的表单。
    }
  }

  function showSession(message = "") {
    const { identity, role } = session;
    if (identity) {
      launch = undefined;
      pendingLaunch = undefined;
    }
    discardPage();
    editingRoles = false;
    startup.hidden = true;
    loginPage.hidden = Boolean(identity);
    portal.hidden = !identity;
    loginStatus.textContent = identity ? "" : message;
    sessionStatus.textContent = identity ? message : "";
    sessionStatus.hidden = !sessionStatus.textContent;
    nav.replaceChildren();
    badgeReads?.abort();
    badges.clear();
    badgeRevisions.clear();
    if (reviewAccount !== identity?.account) {
      meetingRecords.clear();
      reviewAccount = identity?.account;
    }
    if (!identity) {
      accountDialog.close();
      accountDisplay.textContent = "";
      roleTabs.replaceChildren();
      openPendingLaunch();
      return;
    }
    accountDisplay.textContent = "当前账号 · " + identity.account;
    passwordInput.value = "";
    showRoleOptions(identity, role);
    sidebar.hidden = !role;
    nav.hidden = !role;
    if (role) {
      shell.drawSidebar(identity, role);
      setBadge(
        "review-board",
        16 -
          [...meetingRecords.values()].filter((record) => record.status).length,
      );
      openSection("workbench");
      badgeReads = new AbortController();
      const badgeContext = viewContext(badgeReads.signal);
      const idleTimer = setTimeout(
        () => void readNavCounts(badgeContext),
        1000,
      );
      badgeReads.signal.addEventListener(
        "abort",
        () => clearTimeout(idleTimer),
        { once: true },
      );
    } else if (identity.roleSetup) {
      showRoleSetup();
    } else {
      showEmpty(
        "当前账号尚未配置职责",
        "请让团队配置维护者在角色表中加入此账号，保存后退出并重新登录。可用 bzt config-ui 打开配置编辑器。",
      );
    }
  }

  function showRoleSetup({ changes = new Map(), message = "" } = {}) {
    const { identity, role } = session;
    const setup = identity?.roleSetup;
    if (!setup) return;
    discardPage();
    editingRoles = true;
    sidebar.hidden = true;
    byId("account-start").hidden = false;
    byId("account-start").classList.remove("only-compact");
    nav.hidden = true;
    roleTabs.hidden = true;
    guideButton.hidden = true;
    shortcutsButton.hidden = true;
    roleSettings.hidden = true;

    const form = make("form", undefined, "role-setup");
    const heading = make("h1", role ? "我的职责" : "选择你的职责");
    heading.tabIndex = -1;
    const hint = make("p", "可多选，只会更新当前账号的职责。", "muted");
    const options = make("fieldset", undefined, "role-options");
    options.setAttribute("aria-label", "可选择的职责");
    const selected = new Set(setup.selected);
    const locked = new Set(setup.locked);
    const controls = setup.choices.map(({ id, label }) => {
      const item = make("label", undefined, "role-option");
      const input = make("input");
      input.type = "checkbox";
      input.name = "roles";
      input.value = id;
      input.checked = locked.has(id) || (changes.get(id) ?? selected.has(id));
      const title = make("strong", label);
      const summary = make("small", roleResponsibilities[id], "muted");
      const text = make("span");
      text.append(title, summary);
      if (locked.has(id))
        text.append(make("small", "由已有测试主管职责保留。", "muted"));
      item.append(input, text);
      options.append(item);
      return input;
    });

    const actions = make("div", undefined, "role-setup-actions");
    const save = make(
      "button",
      role ? "保存职责" : "保存并进入工作台",
      "btn btn-primary",
    );
    save.type = "submit";
    const refresh = make("button", "重新读取职责", "btn");
    refresh.type = "button";
    refresh.hidden = true;
    const cancel = make("button", "取消", "btn");
    cancel.type = "button";
    cancel.hidden = !role;
    const status = notice(message);
    status.hidden = !message;
    actions.append(save, refresh, cancel);
    const stack = make("div", undefined, "sk-role-stack");
    const overlaySlot = make("div", undefined, "sk-role-overlay");
    stack.append(options, overlaySlot);
    form.append(heading, hint, stack, actions, status);
    workspace.append(form);
    heading.focus();

    let busy = false;
    function syncControls() {
      for (const input of controls)
        input.disabled = busy || locked.has(input.value);
      save.disabled =
        busy || (!role && !controls.some(({ checked }) => checked));
      refresh.disabled = busy;
      cancel.disabled = busy;
    }
    syncControls();
    function setStatus(text, error = false) {
      status.textContent = text;
      status.hidden = false;
      status.classList.toggle("notice-error", error);
    }
    async function run(reloading, action) {
      if (busy) return;
      busy = true;
      syncControls();
      status.textContent = "";
      status.hidden = reloading;
      const finish = reloading
        ? beginSkeleton(
            overlaySlot,
            (doc) => roleOptionsSkeleton(doc, controls.length),
            { current: () => form.isConnected },
          )
        : beginSkeleton(status, (doc) => skeletonBlock(doc, "short"), {
            current: () => form.isConnected,
          });
      try {
        await action();
      } catch (error) {
        if (!form.isConnected) return;
        setStatus(
          error.status ? error.message : "无法完成操作，请重试或重新读取职责。",
          true,
        );
        refresh.hidden = false;
      } finally {
        finish();
        busy = false;
        syncControls();
      }
    }
    options.addEventListener("change", syncControls);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const roles = controls
        .filter(({ checked }) => checked)
        .map(({ value }) => value);
      void run(false, async () => {
        await session.saveRoles(roles, setup.revision);
        if (!form.isConnected) return;
        showSession("已保存你的职责。");
        sessionUpdates?.postMessage("changed");
        workspace.querySelector("h1")?.focus();
      });
    });
    refresh.addEventListener("click", () => {
      const edits = new Map();
      for (const input of controls) {
        if (
          !locked.has(input.value) &&
          input.checked !== selected.has(input.value)
        )
          edits.set(input.value, input.checked);
      }
      void run(true, async () => {
        await session.sync();
        if (!form.isConnected) return;
        if (!session.identity) await showLogin("请重新登录禅道。");
        else if (
          session.identity.account === identity.account &&
          session.identity.roleSetup
        )
          showRoleSetup({
            changes: edits,
            message: "已读取最新职责，请核对勾选后保存。",
          });
        else showSession("本机会话已更新。");
      });
    });
    cancel.addEventListener("click", () => {
      showSession();
      roleSettings.focus();
    });
  }

  function showEmpty(title, description) {
    const panel = make("section", undefined, "empty-panel");
    const heading = make("h1", title);
    heading.tabIndex = -1;
    panel.append(heading, make("p", description, "muted"));
    workspace.append(panel);
  }

  async function showLogin(message, settings) {
    discardPage();
    loginPage.hidden = true;
    portal.hidden = true;
    startup.hidden = false;
    try {
      const { needsBaseUrl, account } = settings ?? (await session.startup());
      const canSetBaseUrl = needsBaseUrl && Boolean(launch);
      baseUrlField.hidden = !canSetBaseUrl;
      baseUrlInput.disabled = !canSetBaseUrl;
      baseUrlInput.required = canSetBaseUrl;
      launchRequired.hidden = !needsBaseUrl || canSetBaseUrl;
      loginForm.hidden = !launchRequired.hidden;
      if (account && !accountInput.value) accountInput.value = account;
    } catch {
      message = "无法读取本机登录设置，请刷新页面后重试。";
    }
    showSession(message);
  }

  async function restore(message, launched = false) {
    discardPage();
    loginPage.hidden = true;
    portal.hidden = true;
    startup.hidden = false;
    try {
      const result = await initializePortalSession(
        session,
        launched ? launch : undefined,
      );
      if (result.launchRejected) {
        launch = undefined;
        message = "启动链接已失效，请双击本机启动器打开新页面。";
      } else if (result.savedFailed) {
        message = "已保存的账号登录失败，请手动登录。";
      }
      if (session.identity) showSession(message);
      else await showLogin(message, result.startup);
    } catch (error) {
      if (error.name !== "StalePortalRequest")
        await showLogin("无法读取本机会话。请确认服务已启动后重试。");
    }
  }

  function setBadge(id, count, revision = ++readRevision) {
    if ((badgeRevisions.get(id) ?? 0) > revision) return;
    const target = Array.from(nav.querySelectorAll("[data-view]")).find(
      (el) => el.dataset.view === id,
    );
    if (!target || target.disabled) return;
    badgeRevisions.set(id, revision);
    if (badges.get(id) === count) return;
    badges.set(id, count);
    target.querySelector(".sk-nav-slot")?.remove();
    target.querySelector(".nav-badge")?.remove();
    if (Number.isSafeInteger(count) && count > 0)
      target.append(
        make(
          "span",
          String(count),
          "nav-badge tabular " +
            (id === "release-risks" ? "tone-danger" : "tone-accent"),
        ),
      );
  }

  function countFromReport(tool, input, report, revision) {
    if (!report?.ok || report.completeness !== "complete" || !report.data)
      return;
    const data = report.data;
    if (tool === "get_monthly_dev_queue" && !input.team && !input.month)
      setBadge("schedule", data.counts?.toReceive, revision);
    if (
      tool === "scan_workflow_risks" &&
      !input.rules &&
      !input.minSeverity &&
      !Object.keys(input.scope ?? {}).length &&
      !report.truncated
    )
      setBadge(
        "release-risks",
        data.hits?.filter((hit) => !hit.waived).length,
        revision,
      );
    if (
      tool === "query_stories" &&
      !input.who &&
      !input.keyword &&
      !input.product &&
      !input.module &&
      data.countsByProgress
    ) {
      if (input.type === "requirement" && input.unlinked)
        setBadge(
          "intake",
          Object.values(data.countsByProgress).reduce(
            (total, n) => total + n,
            0,
          ),
          revision,
        );
      if (
        input.category === "design" &&
        input.progress?.length === 1 &&
        input.progress[0] === "待移交"
      )
        setBadge("stories", data.countsByProgress["待移交"] ?? 0, revision);
    }
  }
  async function readNavCounts(ctx) {
    if (ctx.role.id === "FB") return;
    const queries = [
      ["schedule", "get_monthly_dev_queue", {}],
      ["release-risks", "scan_workflow_risks", { scope: {} }],
      [
        "intake",
        "query_stories",
        { type: "requirement", unlinked: true, limit: 1 },
      ],
      [
        "stories",
        "query_stories",
        { type: "story", category: "design", progress: ["待移交"], limit: 1 },
      ],
    ];
    for (const [id, tool, input] of queries) {
      if (!ctx.current()) return;
      if (badges.has(id) || !ctx.role.actions.includes(tool)) continue;
      const target = nav.querySelector(`[data-view="${id}"]`);
      if (!target || target.disabled) continue;
      const slot = make("span", undefined, "sk-nav-slot");
      target.append(slot);
      const finish = beginSkeleton(slot, (doc) => skeletonBlock(doc, "chip"), {
        signal: ctx.signal,
        current: () => ctx.current() && !badges.has(id),
      });
      try {
        await ctx.call(tool, input);
      } catch {
        /* Unavailable counts stay blank. */
      } finally {
        finish();
        slot.remove();
      }
    }
  }

  function closeOverlay() {
    const active = overlay;
    if (!active) return;
    overlay = undefined;
    active.controller.abort();
    active.dialog.close();
    active.dialog.remove();
  }

  function openOverlay(label, drawer, render, provideHeader = true) {
    if (!session.role) return;
    closeOverlay();
    const dialog = make(
      "dialog",
      undefined,
      drawer ? "bzt-drawer portal-drawer" : "write-modal portal-dialog",
    );
    const controller = new AbortController();
    overlay = { dialog, controller };
    dialog.setAttribute("aria-label", label);
    dialog.addEventListener("close", () => {
      if (overlay?.dialog === dialog) closeOverlay();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        closeOverlay();
    });
    let content = dialog;
    if (provideHeader) {
      const head = make(
        "div",
        undefined,
        drawer ? "drawer-head" : "modal-head modal-header",
      );
      const close = make("button", undefined, "icon-btn-subtle");
      close.setAttribute("aria-label", "关闭");
      close.append(icon("X", 16));
      close.type = "button";
      close.addEventListener("click", closeOverlay);
      const heading = make(
        "div",
        undefined,
        drawer ? "drawer-head-left" : "modal-head-title",
      );
      if (render === renderGuide || render === renderShortcuts) {
        const glyph = icon(
          render === renderGuide ? "BookOpen" : "Sparkles",
          17,
        );
        glyph.classList.add("header-glyph");
        heading.append(glyph);
      }
      heading.append(make("strong", label));
      head.append(heading, close);
      content = make(
        "div",
        undefined,
        drawer ? "management-drawer-body" : "modal-body",
      );
      dialog.append(head, content);
    }
    portal.append(dialog);
    dialog.showModal();
    runView(render, content, viewContext(controller.signal));
  }

  function runView(render, content, ctx, initial) {
    return Promise.resolve()
      .then(() => ctx.current() && render(content, ctx, initial))
      .catch((error) => {
        if (ctx.current())
          content.append(
            notice(
              error.status ? error.message : "页面加载失败，请重新打开此入口。",
              true,
            ),
          );
      });
  }

  function openStory(id, tab) {
    if (!session.role?.actions.includes("get_story_progress")) return;
    openOverlay(
      "需求详情",
      true,
      (content, ctx) => renderStoryDrawer(content, ctx, id, tab),
      false,
    );
  }

  function viewContext(signal) {
    const scope = session.scope(signal);
    const role = session.role;
    function recoverSession(error) {
      if (!scope.current()) return;
      if (error.status === 401) void restore("请重新登录禅道。");
      if (accountChanged(error)) void restore("登录账号已切换，已刷新工作台。");
    }
    const call = async (name, input) => {
      const revision = ++readRevision;
      try {
        const result = await scope.call(name, input);
        if (scope.current()) {
          shell.date(result.scope?.asOf);
          countFromReport(name, input, result, revision);
        }
        return result;
      } catch (error) {
        if (scope.current() && error.status === 403) {
          try {
            if (await scope.refreshIfRevoked())
              showSession("当前职责已撤销，已刷新工作台。");
          } catch (sessionError) {
            recoverSession(sessionError);
          }
        } else {
          recoverSession(error);
        }
        throw error;
      }
    };
    return {
      role,
      account: session.identity.account,
      displayName: session.identity.displayName || session.identity.account,
      releaseCalendar:
        role.id !== "FB" ? session.identity.releaseCalendar : undefined,
      designMaintainers:
        role.id === "DM" ? session.identity.designMaintainers : undefined,
      developmentTeams: ["DM", "PM", "PJ", "RM"].includes(role.id)
        ? session.identity.developmentTeams
        : undefined,
      mode: shell.mode(),
      setMode: shell.setMode,
      canSwitchRole: (id) => session.identity.roles.some((r) => r.id === id),
      switchRole: (id, view, initial) => {
        if (!session.selectRole(id)) return;
        showSession();
        if (view && view !== "workbench") openSection(view, initial);
      },
      intakeCatalog: session.identity.intakeCatalog,
      current: scope.current,
      signal,
      call,
      navigate: openSection,
      openTool,
      openStory,
      close: closeOverlay,
      setBadge: (id, count) => {
        if (scope.current()) setBadge(id, count);
      },
      renderRead,
      tools: navigationFor(role),
      renderWrite: (container, tool, initial, options) =>
        renderWrite(
          container,
          tool,
          call,
          role.id,
          session.identity.account,
          initial,
          { ...options, signal },
        ),
    };
  }

  function openSection(id, initial = {}) {
    if (
      !session.role ||
      !sectionsFor(session.role).find((section) => section.id === id)?.enabled
    )
      return;
    discardPage();
    currentSection = id;
    page = new AbortController();
    for (const item of nav.querySelectorAll("[data-view]")) {
      const active = item.dataset.view === id;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    const renderer = {
      workbench: renderWorkbench,
      intake: renderIntake,
      stories: renderStories,
      schedule: renderSchedule,
      "release-risks": renderReleaseRisks,
      "review-board": (content, ctx) =>
        renderReview(content, ctx, meetingRecords),
    }[id];
    const ctx = viewContext(page.signal);
    const asOf = byId("as-of");
    const finishDate =
      id === "workbench" && !asOf.textContent
        ? beginSkeleton(asOf, (doc) => skeletonBlock(doc, "short"), {
            signal: ctx.signal,
            current: () => ctx.current() && !asOf.textContent,
          })
        : undefined;
    void runView(renderer, workspace, ctx, initial).finally(finishDate);
  }

  function openTool(tool, initial = {}, options = {}) {
    if (!session.role?.actions.includes(tool)) return;
    const action = reads[tool] ?? writes[tool];
    if (!action) return;
    openOverlay(action.label, false, (body, ctx) => {
      if (Object.hasOwn(writes, tool))
        return ctx.renderWrite(body, tool, initial, options);
      renderQuery(body, ctx, tool, initial);
    });
  }

  function renderQuery(body, ctx, tool, initial) {
    const { role, call } = ctx;
    const values = { ...initial, ...initial.scope, ...initial.newTask };
    if (Array.isArray(initial.members))
      values.members = initial.members.join(", ");
    if (initial.requirementId) values.lookup = "requirementId";
    if (initial.intakeId) values.lookup = "intakeId";
    const { form, submit } = queryForm(tool, role.id, values);
    const refresh = make("button", "刷新结果", "btn btn-sm");
    refresh.type = "button";
    refresh.disabled = true;
    form.querySelector(".filter-actions").append(refresh);
    const results = make("section", undefined, "view-results");
    results.setAttribute("aria-label", "查询结果");
    body.append(form, results);
    let lastInput;
    let busy = false;
    async function run(input) {
      if (busy || !ctx.current()) return;
      lastInput = input;
      busy = true;
      submit.disabled = true;
      refresh.disabled = true;
      const finish = beginSkeleton(
        results,
        (doc) => querySkeleton(doc, tool, input),
        ctx,
      );
      try {
        const result = await call(tool, input);
        if (!ctx.current()) return;
        results.replaceChildren();
        renderRead(results, tool, result);
      } catch (error) {
        if (ctx.current()) results.replaceChildren(queryError(tool, error));
      } finally {
        finish();
        if (ctx.current()) {
          busy = false;
          submit.disabled = false;
          refresh.disabled = false;
        }
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = buildReadInput(
        tool,
        role.id,
        Object.fromEntries(new FormData(form)),
      );
      if (input) void run(input);
      else
        results.replaceChildren(
          notice("请核对编号、工时或日期筛选后再查询。", true),
        );
    });
    refresh.addEventListener("click", () => {
      if (lastInput) void run(lastInput);
    });
    if (Object.keys(initial).length || tool === "get_my_work")
      form.requestSubmit();
  }

  guideButton.addEventListener("click", () =>
    openOverlay("评审说明与 15 分钟走查路线", true, renderGuide),
  );
  shortcutsButton.addEventListener("click", () =>
    openOverlay(
      "一句话体验助手 · " +
        (session.identity.displayName || session.identity.account),
      true,
      renderShortcuts,
    ),
  );
  roleSettings.addEventListener("click", () => {
    accountDialog.close();
    showRoleSetup();
  });
  byId("account-start").onclick = () => accountDialog.showModal();
  byId("account-close").onclick = () => accountDialog.close();
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginButton.disabled) return;
    loginButton.disabled = true;
    loginStatus.textContent = "";
    const finish = beginSkeleton(loginStatus, (doc) =>
      skeletonBlock(doc, "short"),
    );
    try {
      await session.login(accountInput.value.trim(), passwordInput.value, {
        baseUrl: baseUrlInput.disabled ? undefined : baseUrlInput.value.trim(),
        launch,
      });
      showSession();
      sessionUpdates?.postMessage("changed");
      workspace.querySelector("h1")?.focus();
    } catch (error) {
      if (error.name === "StalePortalRequest") return;
      passwordInput.value = "";
      if (launch && launchDenied(error)) {
        launch = undefined;
        await showLogin("启动链接已失效，请双击本机启动器打开新页面。");
      } else {
        loginStatus.textContent = error.status
          ? error.message
          : "无法连接本机服务，请稍后重试。";
      }
      passwordInput.focus();
    } finally {
      finish();
      loginButton.disabled = false;
      openPendingLaunch();
    }
  });
  byId("logout-button").addEventListener("click", async () => {
    accountDialog.close();
    discardPage();
    portal.hidden = true;
    startup.hidden = false;
    try {
      await session.logout();
      sessionUpdates?.postMessage("changed");
      await showLogin();
      accountInput.focus();
    } catch (error) {
      if (error.status === 401) await showLogin();
      else
        await restore(
          accountChanged(error)
            ? "登录账号已切换，已刷新工作台。"
            : "退出未完成，请重试。",
        );
    }
  });
  sessionUpdates?.addEventListener("message", (event) => {
    if (event.data === "changed") void syncSession();
  });
  window.addEventListener("focus", () => {
    if (!sessionUpdates) void syncSession();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void syncSession();
  });
  watchLaunchFragment(window, (next) => {
    if (session.identity) return;
    pendingLaunch = next;
    openPendingLaunch();
  });
  void restore("", true);
}

if (typeof document !== "undefined") {
  const launch = takeLaunchFragment(window.location, window.history);
  Promise.all([
    import("./read-views.js"),
    import("./write-views.js"),
    import("./workbench-page.js"),
    import("./daily-pages.js"),
    import("./management-pages.js"),
  ])
    .then((modules) =>
      mountPortal(
        Object.assign({}, ...modules),
        takeLaunchFragment(window.location, window.history) ?? launch,
      ),
    )
    .catch(() => {
      const startup = document.getElementById("startup");
      startup.removeAttribute("aria-label");
      startup.setAttribute("role", "alert");
      startup.textContent = "无法加载工作台。请重新构建并启动本机服务。";
    });
}
