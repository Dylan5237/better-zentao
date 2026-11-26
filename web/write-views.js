import { icon } from "./meridian-icons.js";
import { previewSkeleton, receiptSkeleton } from "./daily-skeleton.js";
import { beginSkeleton } from "./skeleton.js";

const reviewDelayMs = 3000;
const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const separator = /[\s,，、;；]+/u;
const origins = { user: "用户填写", default: "默认值", derived: "规则推导" };
const states = {
  confirmed: "已确认",
  partial: "部分完成",
  unknown: "结果待核对",
  not_executed: "未执行",
  failed: "执行失败",
  done: "已执行",
  skipped: "已跳过",
  pending: "待执行",
};
const objects = { story: "需求", task: "任务", comment: "备注", link: "关联" };
const actions = {
  "story.create": "创建需求",
  "story.create.design": "创建设计需求",
  "story.create.feedbackBy": "创建需求",
  "story.assign": "指派需求",
  "story.activate": "激活需求",
  "story.edit": "更新需求",
  "story.close": "关闭需求",
  "story.comment": "记录需求备注",
  "story.linkStory": "关联需求",
  "requirement.linkStory": "关联用户需求",
  "story.linkExecution": "关联执行",
  "task.create": "创建任务",
  "task.close": "关闭任务",
};

function field(name, label, kind = "text", options = {}) {
  return { name, label, kind, ...options };
}

const required = { required: true };
const storyId = field("storyId", "需求编号", "id", required);
const storyIds = field("storyIds", "需求编号", "ids", {
  required: true,
  placeholder: "多个编号用逗号或顿号分隔",
});
const notify = field("notify", "发送企微提醒", "checkbox", { value: true });
const months = { required: true, placeholder: "例如 2026-12 或 下月" };
const fromDesign = ({ mode }) => mode === "from_design";
const storyClose = ({ mode }) => mode === "story";
const cleanup = ({ mode }) => mode === "cleanup";
const decomposeStories = ({ template }) => template !== "subtasks";
const subtasks = ({ template }) => template === "subtasks";
const intakeModes = [
  ["standard", "常规提需"],
  ["pair", "设计态+运行态双建"],
  ["crossModule", "跨模块找后端"],
  ["backfilled", "急事先做后补录"],
];
const channels = [
  ["wecom", "企微"],
  ["meeting", "会议"],
  ["zentao", "禅道"],
  ["verbal", "口头"],
  ["other", "其他"],
];
const businessFeedback = [
  field("product", "产品名称或编号", "text", required),
  field("module", "功能模块", "text", required),
  field("intake.channel", "反馈渠道", "select", {
    choices: [
      ["", "选择反馈渠道"],
      ["wecom", "企微沟通"],
      ["meeting", "业务评审会"],
      ["other", "邮件或客户反馈"],
      ["verbal", "口头反馈"],
    ],
    required: true,
  }),
  field("title", "一句话诉求简述 *", "text", {
    ...required,
    full: true,
    placeholder: "例如：运营导出审批清单时希望能按二级部门筛选…",
  }),
  field("spec.background", "具体场景与期望效果（可选）", "textarea", {
    full: true,
    placeholder: "描述现在遇到什么不便、希望达到什么效果…",
  }),
  field("spec.scope", "本次实现范围", "textarea", {
    ...required,
    full: true,
    advanced: true,
  }),
  field("verify", "验收标准", "textarea", {
    ...required,
    full: true,
    advanced: true,
  }),
];
const whenIntake =
  (mode) =>
  ({ intakeMode }) =>
    intakeMode === mode;
const paired = whenIntake("pair");
const crossModule = whenIntake("crossModule");
const backfilled = whenIntake("backfilled");

const stages = [
  ["design", "设计"],
  ["review", "评审"],
  ["handoff", "传递"],
  ["dev", "研发"],
  ["interface", "接口"],
  ["test", "测试"],
  ["acceptance", "验收"],
  ["delivery", "交付"],
];
const stageFields = stages.flatMap(([stage, label], index) => {
  const when = ({ template }) =>
    template === "next_stage" ||
    (template === "design" && index < 3) ||
    (template === "feature" && index >= 3);
  const options = { when, advanced: true };
  return [
    field(`assignees.${stage}`, `${label}负责人`, "text", options),
    field(`dates.${stage}.estStarted`, `${label}预计开始`, "date", options),
    field(`dates.${stage}.deadline`, `${label}截止日期`, "date", options),
    field(`estimates.${stage}`, `${label}预计工时`, "hours", options),
  ];
});

const forms = {
  create_story: [
    field("product", "产品名称或编号", "text", required),
    field("module", "模块路径或编号", "text", required),
    field("category", "需要先走设计吗？（N02）", "segments", {
      choices: [
        ["", "按规范推荐"],
        ["design", "先走设计（设计类）"],
        ["feature", "直接研发（研发类）"],
      ],
      full: true,
    }),
    field("plan", "本月 L3 计划（N04）", "text", {
      placeholder: "自动匹配本月计划",
    }),
    field("version", "目标版本标签（N04）", "text", {
      placeholder: "暂不绑定版本",
    }),
    field("title", "需求标题", "text", {
      ...required,
      full: true,
      placeholder: "用清晰的结果描述诉求…",
    }),
    field("feedbackBy", "谁提出的（来源必登记 · N01）"),
    field("intake.channel", "来源渠道（N01）", "select", {
      choices: [["", "选择渠道"], ...channels],
    }),
    field("requirementId", "关联用户需求编号（可选）", "id", {
      full: true,
      placeholder: "可从待关联清单带入",
    }),
    field("pair.product", "配对产品名称或编号", "text", {
      ...required,
      when: paired,
    }),
    field("pair.module", "配对模块路径或编号", "text", {
      ...required,
      when: paired,
    }),
    field("derivesFrom", "触发源需求（derivesFrom）", "id", {
      when: crossModule,
    }),
    field("backfilled.actualStartedAt", "研发实际开始日期", "date", {
      ...required,
      full: true,
      when: backfilled,
    }),
    field("spec.background", "背景与目标", "textarea", {
      full: true,
      advanced: true,
    }),
    field("spec.scope", "本次实现范围", "textarea", {
      ...required,
      full: true,
      placeholder: "写清本次要做的工作…",
    }),
    field("spec.notInScope", "本次不做什么（排除边界）", "text", {
      full: true,
      placeholder: "可选：明确本期排除边界，减少返工",
    }),
    field("spec.designRef.doc", "设计文档（可选 · R05）", "text", {
      placeholder: "如：《权限系统架构详设》",
    }),
    field("spec.designRef.section", "设计文档章节（R05）", "text", {
      placeholder: "章节（如 §3.2）",
    }),
    field("spec.designRef.version", "设计文档版本", "text", { advanced: true }),
    field("verify", "验收标准", "textarea", { ...required, full: true }),
    field("pri", "优先级", "priority", {
      choices: [
        ["", "按规范默认"],
        ["1", "1"],
        ["2", "2"],
        ["3", "3"],
        ["4", "4"],
      ],
      advanced: true,
    }),
    field("maintainer", "状态维护人", "text", { advanced: true }),
    field("assignTo", "指派给", "text", { advanced: true }),
    field("pair.title", "配对需求标题", "text", {
      advanced: true,
      when: paired,
    }),
    field("intake.rawText", "反馈原话", "textarea", { advanced: true }),
  ],
  import_stories: [],
  assign_story: [
    storyIds,
    field("to", "接收人姓名或账号", "text", required),
    field("comment", "指派说明", "textarea"),
    notify,
  ],
  handoff_story: [
    storyId,
    field("mode", "移交方式", "select", {
      choices: [
        ["from_design", "由设计需求生成研发需求"],
        ["activate", "激活现有需求并移交"],
      ],
    }),
    field("receiver", "研发接收人姓名或账号"),
    field("comment", "移交说明", "textarea"),
    notify,
    field("feature.product", "目标产品", "text", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.module", "目标模块", "text", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.title", "研发需求标题", "text", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.scope", "研发实现范围", "textarea", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.designRef.doc", "设计文档", "text", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.designRef.section", "设计文档章节", "text", {
      when: fromDesign,
      advanced: true,
    }),
    field("feature.designRef.version", "设计文档版本", "text", {
      when: fromDesign,
      advanced: true,
    }),
  ],
  decompose_stories: [
    { ...storyIds, when: decomposeStories },
    field("execution", "所属执行名称或编号", "text", {
      when: decomposeStories,
    }),
    field("taskId", "父任务编号", "id", { when: subtasks, required: true }),
    notify,
    ...stageFields,
    ...["interface", "delivery"].map((stage) =>
      field(
        `include.${stage}`,
        stage === "interface" ? "接口阶段" : "交付阶段",
        "triState",
        {
          when: ({ template }) =>
            template === "feature" || template === "next_stage",
          choices: [
            ["", "按规范判断"],
            ["yes", "需要"],
            ["no", "不需要"],
          ],
          advanced: true,
        },
      ),
    ),
  ],
  reschedule_story: [
    storyIds,
    field("toMonth", "目标月份", "month", months),
    field("reason", "挪月原因", "textarea", required),
    field("moveTasks", "同时调整未完成任务", "checkbox"),
  ],
  close_stories: [
    field("mode", "关闭方式", "select", {
      choices: [
        ["story", "关闭指定需求"],
        ["cleanup", "查看待关闭任务"],
      ],
    }),
    { ...storyIds, when: storyClose },
    field("closedReason", "关闭原因", "select", {
      when: storyClose,
      choices: [
        ["", "选择关闭原因"],
        ["done", "已完成"],
        ["cancel", "已取消"],
        ["duplicate", "重复"],
        ["postponed", "延期"],
        ["willnotdo", "不做"],
      ],
      required: true,
    }),
    field("cleanup.scope.team", "团队", "text", { when: cleanup }),
    field("cleanup.scope.execution", "执行名称或编号", "text", {
      when: cleanup,
    }),
    field("cleanup.scope.beforeMonth", "截止月份", "month", {
      when: cleanup,
      placeholder: months.placeholder,
    }),
    field("cleanup.classes", "任务类别", "classes", {
      when: cleanup,
      placeholder: "例如 A、B",
    }),
    field("cleanup.reason", "清理原因", "textarea", { when: cleanup }),
  ],
  set_story_meta: [
    storyId,
    field("waiver.reason", "R13 发布门禁例外原因", "textarea", required),
  ],
};

function fieldsFor(tool, role) {
  if (tool === "decompose_stories") {
    const choices =
      role === "RM"
        ? [
            ["feature", "研发需求拆解"],
            ["next_stage", "补齐缺失阶段"],
            ["subtasks", "创建子任务"],
            ["design", "设计需求拆解"],
          ]
        : [["design", "设计需求拆解"]];
    return [
      field("template", "拆解模板", "select", { choices }),
      ...forms[tool],
    ];
  }
  return forms[tool];
}

function valueOf(spec, control) {
  if (spec.kind === "checkbox") return control.checked;
  const value = control.value.trim();
  if (!value) {
    if (spec.required) throw new Error(`请填写${spec.label}。`);
    return undefined;
  }
  if (spec.choices && !spec.choices.some(([choice]) => choice === value)) {
    throw new Error(`请选择有效的${spec.label}。`);
  }
  if (spec.kind === "id" || spec.kind === "ids") {
    const values = spec.kind === "ids" ? value.split(separator) : [value];
    const ids = values
      .filter(Boolean)
      .map((id) => (/^\d+$/u.test(id) ? Number(id) : 0));
    if (
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      throw new Error("请输入 1 至 100 个有效的正整数编号。");
    }
    return spec.kind === "id" ? ids[0] : [...new Set(ids)];
  }
  if (spec.kind === "hours") {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0)
      throw new Error("预计工时应为非负数字。");
    return hours;
  }
  if (
    spec.kind === "month" &&
    !monthPattern.test(value) &&
    !["本月", "下月", "上月"].includes(value)
  ) {
    throw new Error("请输入 YYYY-MM 格式的月份，或填写本月、下月、上月。");
  }
  if (spec.kind === "classes") {
    const classes = [...new Set(value.split(separator).filter(Boolean))];
    if (classes.some((entry) => !["A", "B", "C"].includes(entry)))
      throw new Error("任务类别可选 A、B、C。");
    return classes;
  }
  if (spec.kind === "triState") return value === "yes";
  if (spec.kind === "priority") return Number(value);
  return value;
}

function setValue(object, name, value) {
  const keys = name.split(".");
  const final = keys.pop();
  let target = object;
  for (const [index, key] of keys.entries()) {
    target[key] ??= /^\d+$/u.test(keys[index + 1] ?? final) ? [] : {};
    target = target[key];
  }
  target[final] = value;
}

function selectedIntakeMode(input) {
  if (input?.pair) return "pair";
  if (input?.crossModule) return "crossModule";
  if (input?.backfilled) return "backfilled";
}

function adorn(node, name, size = 14) {
  if (node.ownerDocument.createElementNS)
    node.prepend(icon(name, size, node.ownerDocument));
}

function catalogEntries(intakeCatalog) {
  return (intakeCatalog?.products ?? []).flatMap((product) =>
    product.modules.map((module) => ({
      key: `${product.id}:${module.id}`,
      product,
      module,
    })),
  );
}

function buildForm(make, tool, role, initial, options) {
  const isIntake = tool === "create_story";
  const simple = isIntake && role === "FB" && options.intakePage;
  const intakePage = isIntake && options.intakePage;
  const choices = intakeModes.filter(
    ([mode]) => role !== "RD" || mode !== "pair",
  );
  const defaultIntakeMode = role === "RD" ? "backfilled" : "standard";
  const requestedMode =
    options.intakeMode ?? selectedIntakeMode(initial) ?? defaultIntakeMode;
  let intakeMode = choices.some(([mode]) => mode === requestedMode)
    ? requestedMode
    : defaultIntakeMode;
  let batch = false;
  let completing = false;
  let locked = false;
  const form = make(
    "form",
    "",
    isIntake ? "write-form daily-intake-form" : "write-form",
  );
  form.noValidate = true;
  const fieldset = make("fieldset", "", "write-fieldset");
  if (intakePage) fieldset.className += " intake-form-body";
  const grid = make("div", "", "form-grid");
  const details = make("details");
  details.append(make("summary", simple ? "提交所需补充内容" : "补充信息"));
  const extra = make("div", "", "form-grid");
  details.append(extra);
  const fields = [];
  const settings = [];
  const manualCatalog = new Set();
  const manualOverrides = new Set();
  const catalog = catalogEntries(options.intakeCatalog);

  function updateForm() {
    sync();
    form.dispatchEvent?.(new Event("change", { bubbles: true }));
  }

  function segments(label, entries, read, select, full = false) {
    const group = make("div", "", `segmented-tabs${full ? " is-full" : ""}`);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    const buttons = entries.map(([value, name]) => {
      const button = make("button", name, "seg-tab");
      button.type = "button";
      button.addEventListener("click", () => {
        if (locked || value === read()) return;
        select(value);
        updateForm();
      });
      group.append(button);
      return [value, button];
    });
    settings.push(() => {
      for (const [value, button] of buttons) {
        const selected = value === read();
        button.setAttribute("aria-pressed", String(selected));
        button.className = selected ? "seg-tab is-active" : "seg-tab";
        button.disabled = locked;
      }
    });
    return group;
  }

  function switchIntakeMode(mode) {
    if (mode === "batchImport" && !options.showBatch) return;
    batch = mode === "batchImport";
    if (!batch && choices.some(([value]) => value === mode)) intakeMode = mode;
    options.showBatch?.(batch);
  }

  if (isIntake && !simple) {
    const entries = options.showBatch
      ? [...choices, ["batchImport", "批量导入草稿"]]
      : choices;
    (options.modeBar ?? form).append(
      segments(
        "提需方式",
        entries,
        () => (batch ? "batchImport" : intakeMode),
        switchIntakeMode,
      ),
    );
  }

  const locate = (name) => fields.find(({ spec }) => spec.name === name);
  function matchingModule(prefix = "") {
    const productValue = locate(`${prefix}product`).control.value.trim();
    const moduleValue = locate(`${prefix}module`).control.value.trim();
    const matches = catalog.filter(
      ({ product, module }) =>
        [String(product.id), product.name].includes(productValue) &&
        [String(module.id), module.path].includes(moduleValue),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  function appendCatalog(prefix, label, when) {
    if (!catalog.length) return;
    const wrapper = make(
      "label",
      "",
      prefix ? "bzt-field is-full" : "bzt-field",
    );
    const picker = make("select", "", "bzt-input");
    picker.name = `${prefix}catalog`;
    const placeholder = make("option", `请选择${label}`);
    placeholder.value = "";
    picker.append(placeholder);
    for (const { key, product, module } of catalog) {
      const option = make("option", `${product.name} / ${module.path}`);
      option.value = key;
      picker.append(option);
    }
    const manual = make("option", "手动填写");
    manual.value = "manual";
    picker.append(manual);
    const findFields = () => [
      locate(`${prefix}product`),
      locate(`${prefix}module`),
    ];
    wrapper.append(make("span", label), picker);
    grid.append(wrapper);
    picker.addEventListener("change", () => {
      if (locked) return;
      if (picker.value === "manual") manualCatalog.add(prefix);
      else {
        manualCatalog.delete(prefix);
        const choice = catalog.find(({ key }) => key === picker.value);
        const [product, module] = findFields();
        product.control.value = choice ? String(choice.product.id) : "";
        module.control.value = choice ? String(choice.module.id) : "";
      }
      updateForm();
    });
    settings.push((selection) => {
      const [productField, moduleField] = findFields();
      const entry = matchingModule(prefix);
      const manuallyEntered =
        manualCatalog.has(prefix) ||
        (!entry &&
          Boolean(productField.control.value || moduleField.control.value));
      wrapper.hidden = when ? !when(selection) : false;
      picker.value = manuallyEntered ? "manual" : (entry?.key ?? "");
      if (!manuallyEntered) {
        productField.wrapper.hidden = true;
        moduleField.wrapper.hidden = true;
      }
    });
  }

  function appendField(spec, target = spec.advanced ? extra : grid) {
    const checkbox = spec.kind === "checkbox";
    const segmented = spec.kind === "segments";
    const wrapper = make(
      segmented ? "div" : "label",
      "",
      checkbox ? "check-label" : `bzt-field${spec.full ? " is-full" : ""}`,
    );
    const label = make("span", spec.label);
    const control = make(
      spec.choices && !segmented
        ? "select"
        : spec.kind === "textarea"
          ? "textarea"
          : "input",
      "",
      checkbox ? "bzt-checkbox" : "bzt-input",
    );
    control.name = spec.name;
    if (segmented) {
      control.type = "hidden";
      control.value = spec.choices[0][0];
      wrapper.append(
        label,
        control,
        segments(
          spec.label,
          spec.name === "category"
            ? spec.choices.filter(([value]) => value)
            : spec.choices,
          () => control.value,
          (value) => {
            control.value = value;
          },
          true,
        ),
      );
    } else if (spec.choices) {
      for (const [value, title] of spec.choices) {
        const option = make("option", title);
        option.value = value;
        control.append(option);
      }
      control.value = spec.choices[0][0];
    } else if (spec.kind !== "textarea") {
      control.type = checkbox
        ? "checkbox"
        : spec.kind === "date"
          ? "date"
          : spec.kind === "hours"
            ? "number"
            : "text";
      if (spec.kind === "hours") {
        control.min = "0";
        control.step = "any";
      }
      if (spec.kind === "id") control.inputMode = "numeric";
    }
    if (spec.placeholder) control.placeholder = spec.placeholder;
    if (spec.kind === "textarea")
      control.rows = simple && !spec.advanced ? 3 : 2;
    if (checkbox) {
      control.checked = spec.value === true;
      control.defaultChecked = control.checked;
      wrapper.append(control, label);
    } else if (!segmented) {
      wrapper.append(label, control);
    }
    fields.push({ spec, wrapper, control });
    target.append(wrapper);
  }

  function appendOverride(spec) {
    const group = make("div", "", "daily-intake-override");
    const label = make("label", "", "bzt-field");
    const picker = make("select", "", "bzt-input");
    const defaultChoice = make(
      "option",
      spec.name === "plan" ? "自动匹配本月计划" : "暂不绑定版本",
    );
    defaultChoice.value = "";
    const manualChoice = make(
      "option",
      spec.name === "plan" ? "指定计划" : "填写版本标签",
    );
    manualChoice.value = "manual";
    picker.append(defaultChoice, manualChoice);
    label.append(make("span", spec.label), picker);
    group.append(label);
    grid.append(group);
    appendField(
      {
        ...spec,
        label: spec.name === "plan" ? "计划名称或编号" : "版本标签",
        placeholder: "",
      },
      group,
    );
    const { wrapper, control } = locate(spec.name);
    picker.addEventListener("change", () => {
      if (picker.value === "manual") {
        manualOverrides.add(spec.name);
        wrapper.hidden = false;
        control.focus?.();
      } else {
        manualOverrides.delete(spec.name);
        control.value = "";
      }
    });
    settings.push(() => {
      const show =
        manualOverrides.has(spec.name) || Boolean(control.value.trim());
      picker.value = show ? "manual" : "";
      wrapper.hidden = !show;
    });
  }

  const specs = simple ? businessFeedback : fieldsFor(tool, role);
  const alongsideCatalog = isIntake && catalog.length > 0;
  if (alongsideCatalog) {
    appendCatalog("", simple ? "涉及平台与功能模块" : "产品与模块");
    if (!simple)
      appendField({
        ...specs.find(({ name }) => name === "category"),
        full: false,
      });
  }
  for (const spec of specs) {
    if (alongsideCatalog && spec.name === "category") continue;
    if (intakePage && ["plan", "version"].includes(spec.name)) {
      appendOverride(spec);
      continue;
    }
    if (spec.name === "pair.product")
      appendCatalog("pair.", "配对产品与模块", paired);
    appendField(spec);
  }

  const modeField = locate("mode")?.control;
  const templateField = locate("template")?.control;
  const children = make("div");
  const childRows = make("div");
  const addChild = make("button", "添加子任务", "btn");
  addChild.type = "button";
  children.append(childRows, addChild);
  const routing = make("p", "", "form-footer-note");
  const missingScope = make("p", "请写清本次实现范围。", "field-warn is-full");
  const missingSection = make(
    "p",
    "R05 提醒：填写了设计文档名但未注明章节，请补充章节编号或标题。",
    "field-warn is-full",
  );
  const pairedNote = make(
    "div",
    "将为所选产品与配对产品生成草稿，关联方式以预览为准。",
    "bzt-alert tone-info",
  );
  if (intakePage && !simple) {
    locate("spec.scope").wrapper.append(missingScope);
    grid.insertBefore?.(missingSection, locate("verify").wrapper);
  }
  const routeValues =
    options.routeStrip &&
    [
      "归属产品",
      "L3 月度计划",
      "草稿默认指派给（状态维护人 · N05）",
      "后续移交研发主管（接收人 · N10）",
    ].map((label) => {
      const cell = make("div", "", "routing-cell");
      const value = make("strong");
      cell.append(make("span", label), value);
      options.routeStrip.append(cell);
      return value;
    });

  function sync() {
    const selection = {
      mode: modeField?.value,
      template: templateField?.value,
      intakeMode,
    };
    children.hidden = !subtasks(selection);
    for (const { spec, wrapper, control } of fields) {
      const visible =
        !(simple && spec.advanced && !completing) &&
        (!spec.when || spec.when(selection));
      wrapper.hidden = !visible;
      control.disabled = !visible;
      control.required = visible && spec.required === true;
    }
    for (const update of settings) update(selection);
    details.hidden = !fields.some(
      ({ spec, wrapper }) => spec.advanced && !wrapper.hidden,
    );
    if (isIntake) {
      const entry = matchingModule();
      routing.textContent = simple
        ? completing
          ? "补齐实际信息后，核对预览并提交草稿。"
          : "提交时先核对诉求内容。"
        : "预览会展示字段来源、计划、状态维护人与指派对象。";
      submitLabel = simple && !completing ? "提交诉求" : "预览并创建";
      if (!locked) updateSubmitLabel(submitLabel);
      if (routeValues) {
        const [product, plan, maintainer, receiver] = routeValues;
        product.textContent =
          entry?.product.name ??
          (locate("product").control.value || "请选择模块");
        plan.textContent =
          locate("plan").control.value.trim() || "按本月计划匹配 · 见预览";
        maintainer.textContent =
          intakeMode === "crossModule"
            ? options.account
            : intakeMode === "backfilled" && entry?.module.designLead
              ? entry.module.designLead
              : "按规范指派 · 见预览";
        receiver.textContent = entry?.module.devLead ?? "按模块配置 · 见预览";
      }
      if (!simple) {
        missingScope.hidden = Boolean(
          locate("spec.scope").control.value.trim(),
        );
        missingSection.hidden =
          !locate("spec.designRef.doc").control.value.trim() ||
          Boolean(locate("spec.designRef.section").control.value.trim());
        pairedNote.hidden = intakeMode !== "pair";
      }
    }
  }

  if (tool === "decompose_stories" && role === "RM") {
    let nextChild = 0;
    function appendChild() {
      const index = nextChild++;
      const group = make("fieldset", "", "filter-grid");
      group.append(make("legend", `子任务 ${index + 1}`));
      const start = fields.length;
      const options = { when: subtasks, required: true };
      appendField(
        field(`subtasks.${index}.name`, "子任务名称", "text", options),
        group,
      );
      appendField(
        field(`subtasks.${index}.assignTo`, "子任务负责人", "text", options),
        group,
      );
      appendField(
        field(`subtasks.${index}.deadline`, "子任务截止日期", "date", {
          when: subtasks,
        }),
        group,
      );
      appendField(
        field(`subtasks.${index}.estimate`, "子任务预计工时", "hours", {
          when: subtasks,
        }),
        group,
      );
      const rowFields = fields.slice(start);
      if (index > 0) {
        const remove = make("button", "移除子任务", "btn");
        remove.type = "button";
        remove.addEventListener("click", () => {
          for (const entry of rowFields)
            fields.splice(fields.indexOf(entry), 1);
          group.remove();
          form.dispatchEvent(new Event("change"));
        });
        group.append(remove);
      }
      childRows.append(group);
      sync();
    }
    const rows = Array.isArray(initial?.subtasks) ? initial.subtasks.length : 0;
    for (let index = 0; index < Math.max(rows, 1); index++) appendChild();
    addChild.addEventListener("click", () => {
      appendChild();
      form.dispatchEvent(new Event("change"));
    });
    fieldset.append(grid, children, details);
  } else {
    fieldset.append(grid, details);
  }
  let submitLabel = isIntake ? "预览并创建" : "生成预览";
  const submit = make("button", "", "btn-primary");
  function updateSubmitLabel(label) {
    submit.textContent = label;
    if (intakePage) adorn(submit, simple && !completing ? "Send" : "Sparkles");
  }
  updateSubmitLabel(submitLabel);
  submit.type = "submit";
  const footer = make(
    "div",
    "",
    intakePage ? "form-footer-bar" : "filter-actions",
  );
  if (isIntake) footer.append(routing);
  footer.append(submit);
  if (intakePage && !simple) fieldset.append(pairedNote);
  if (simple)
    details.addEventListener("toggle", () => {
      if (completing) return;
      completing = details.open;
      if (completing) sync();
    });
  form.append(fieldset, footer);
  for (const name of [
    "spec.scope",
    "spec.designRef.doc",
    "spec.designRef.section",
  ])
    locate(name)?.control.addEventListener("input", sync);
  form.addEventListener("change", sync);

  function apply(input) {
    if (input?.product != null || input?.module != null)
      manualCatalog.delete("");
    if (input?.pair?.product != null || input?.pair?.module != null)
      manualCatalog.delete("pair.");
    let advanced = false;
    for (const { spec, control } of fields) {
      const value = spec.name
        .split(".")
        .reduce((part, name) => part?.[name], input);
      if (value == null) continue;
      if (spec.kind === "checkbox") control.checked = value === true;
      else if (Array.isArray(value)) control.value = value.join(", ");
      else if (spec.kind === "triState" && typeof value === "boolean")
        control.value = value ? "yes" : "no";
      else if (typeof value === "number" || typeof value === "string")
        control.value = String(value);
      advanced ||= spec.advanced === true;
    }
    sync();
    if (advanced) details.open = true;
  }

  apply(initial);

  function payload() {
    const input = {};
    for (const { spec, control } of fields) {
      if (control.disabled) continue;
      const value = valueOf(spec, control);
      if (value !== undefined) setValue(input, spec.name, value);
    }
    if (input.subtasks) input.subtasks = input.subtasks.filter(Boolean);
    if (isIntake && crossModule({ intakeMode })) input.crossModule = true;
    if (isIntake && input.spec) input.spec.background ??= "";
    if (isIntake && input.intake?.channel && !input.intake.rawText)
      input.intake.rawText = [input.title, input.spec?.background]
        .filter(Boolean)
        .join("\n");
    if (simple) input.feedbackBy = options.account;
    if (input.mode === "cleanup") {
      input.cleanup ??= {};
      input.cleanup.scope ??= {};
    }
    if (input.intake && (!input.intake.channel || !input.intake.rawText))
      throw new Error("请同时填写反馈渠道和反馈原话。");
    const ref = input.spec?.designRef ?? input.feature?.designRef;
    if (ref && (!ref.doc || !ref.section))
      throw new Error("请同时填写设计文档和章节。");
    if (tool === "set_story_meta") input.waiver.rule = "R13";
    return input;
  }

  function setLocked(value) {
    locked = value;
    fieldset.disabled = value;
    submit.disabled = value;
    sync();
  }

  function prefill(input) {
    if (locked) return false;
    const mode = selectedIntakeMode(input);
    if (choices.some(([value]) => value === mode)) intakeMode = mode;
    if (batch) {
      batch = false;
      options.showBatch?.(false);
    }
    apply(input);
    updateForm();
    return true;
  }

  function resetForm() {
    form.reset?.();
    manualCatalog.clear();
    manualOverrides.clear();
    intakeMode = defaultIntakeMode;
    if (isIntake && !simple) locate("category").control.value = "";
    if (simple) {
      completing = false;
      details.open = false;
    }
    updateForm();
  }

  function prepareForm() {
    if (!simple || completing) return true;
    payload();
    completing = true;
    sync();
    details.open = true;
    return false;
  }

  return {
    form,
    payload,
    prefill,
    resetForm,
    setLocked,
    prepareForm,
    selectIntakeMode(mode) {
      if (locked || simple) return;
      switchIntakeMode(mode);
      updateForm();
    },
  };
}

function buildBatchForm(make, options) {
  const catalog = catalogEntries(options.intakeCatalog);
  const form = make("form", "", "write-form daily-intake-form");
  form.noValidate = true;
  const fieldset = make("fieldset", "", "write-fieldset intake-form-body");
  const defaults = make("div", "", "form-grid");
  const rows = make("div", "", "import-rows-list");
  const footer = make("div", "", "form-footer-bar");
  const add = make("button", "添加一行", "btn-secondary btn-xs");
  const submit = make("button", "预览并批量导入", "btn-primary");
  const count = make("span", "", "form-footer-note");
  add.type = "button";
  adorn(add, "Plus", 12);
  submit.type = "submit";
  adorn(submit, "Sparkles");
  fieldset.append(defaults, rows);
  footer.append(add, count, submit);
  form.append(fieldset, footer);
  const entries = [];
  let nextRow = 0;
  let locked = false;

  function control(parent, name, label, placeholder = "", choices) {
    const wrap = make("label", "", "bzt-field");
    const input = make(choices ? "select" : "input", "", "bzt-input");
    input.name = name;
    input.placeholder = placeholder;
    for (const [value, text] of choices ?? []) {
      const option = make("option", text);
      option.value = value;
      input.append(option);
    }
    wrap.append(make("span", label), input);
    parent.append(wrap);
    return { wrap, input };
  }
  const { input: version } = control(
    defaults,
    "batch.version",
    "批次目标版本（N04）",
    "暂不绑定版本",
  );
  const { input: channel } = control(
    defaults,
    "batch.channel",
    "统一来源渠道（N01）",
    "",
    [["", "批量导入"], ...channels],
  );

  function sync() {
    count.textContent = `共 ${entries.length} 行，缺项由服务在预览中逐行说明。`;
    add.disabled = locked || entries.length >= 50;
    for (const [index, entry] of entries.entries()) {
      entry.label.textContent = `第 ${index + 1} 行 · 模块`;
      entry.remove.hidden = entries.length < 2;
      const missingScope = !entry.scope.value.trim();
      entry.badge.textContent = missingScope ? "缺范围将被跳过" : "待校验";
      entry.badge.className = `bzt-badge tone-${missingScope ? "warn" : "primary"}`;
    }
  }

  function addRow() {
    const name = `row.${nextRow++}`;
    const card = make("div", "", "import-row-card");
    const moduleCol = make("div", "", "batch-row-column");
    const head = make("div", "", "batch-row-head");
    const label = make("span");
    const badge = make("span");
    const remove = make("button", "移除", "btn-ghost btn-xs");
    remove.type = "button";
    adorn(remove, "X", 12);
    head.append(label, badge, remove);
    moduleCol.append(head);
    let picker;
    if (catalog.length)
      picker = control(moduleCol, `${name}.catalog`, "产品与模块", "", [
        ["", "请选择模块"],
        ...catalog.map(({ key, product, module }) => [
          key,
          `${product.name} / ${module.path}`,
        ]),
        ["manual", "手动填写"],
      ]).input;
    const product = control(moduleCol, `${name}.product`, "产品名称或编号");
    const module = control(moduleCol, `${name}.module`, "模块路径或编号");
    if (picker) {
      product.wrap.hidden = true;
      module.wrap.hidden = true;
      picker.addEventListener("change", () => {
        const manual = picker.value === "manual";
        product.wrap.hidden = !manual;
        module.wrap.hidden = !manual;
        if (manual) return;
        const match = catalog.find(({ key }) => key === picker.value);
        product.input.value = match ? String(match.product.id) : "";
        module.input.value = match ? String(match.module.id) : "";
      });
    }
    const source = make("div", "", "batch-row-column");
    const { input: title } = control(
      source,
      `${name}.title`,
      "需求标题",
      "填写清晰的需求标题…",
    );
    const { input: feedbackBy } = control(
      source,
      `${name}.feedbackBy`,
      "提出人（N01）",
    );
    const scopeColumn = make("div", "", "batch-row-column");
    const { input: scope } = control(
      scopeColumn,
      `${name}.scope`,
      "本次实现范围（N03）",
      "必填，否则按规范跳过",
    );
    const { input: verify } = control(
      scopeColumn,
      `${name}.verify`,
      "验收标准",
    );
    const entry = {
      label,
      badge,
      remove,
      product: product.input,
      module: module.input,
      title,
      feedbackBy,
      scope,
      verify,
    };
    remove.addEventListener("click", () => {
      if (locked || entries.length < 2) return;
      entries.splice(entries.indexOf(entry), 1);
      card.remove();
      form.dispatchEvent(new Event("change"));
    });
    card.append(moduleCol, source, scopeColumn);
    rows.append(card);
    entries.push(entry);
    sync();
  }
  add.addEventListener("click", () => {
    if (locked || entries.length >= 50) return;
    addRow();
    form.dispatchEvent?.(new Event("change"));
  });
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  addRow();

  function payload() {
    const rows = entries.map((entry) => {
      const input = {};
      for (const key of [
        "product",
        "module",
        "title",
        "feedbackBy",
        "verify",
      ]) {
        const value = entry[key].value.trim();
        if (value) input[key] = value;
      }
      const scope = entry.scope.value.trim();
      if (scope) input.spec = { background: "", scope };
      if (channel.value && input.title)
        input.intake = { rawText: input.title, channel: channel.value };
      return input;
    });
    const tag = version.value.trim();
    return {
      source: { kind: "table", rows },
      defaults: { ...(tag && { version: tag }) },
    };
  }

  return {
    form,
    payload,
    prefill: () => false,
    prepareForm: () => true,
    resetForm() {
      form.reset?.();
      rows.replaceChildren();
      entries.length = 0;
      nextRow = 0;
      addRow();
    },
    setLocked(value) {
      locked = value;
      fieldset.disabled = value;
      submit.disabled = value;
      sync();
    },
  };
}

function display(value) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value ?? "空");
}

function list(make, tag, entries) {
  const node = make(tag);
  for (const entry of entries) node.append(make("li", entry));
  return node;
}

function previewBody(make, output, plan, showHeading) {
  if (showHeading) output.append(make("h2", "操作预览"));
  const summary = make("div", "", "bzt-alert tone-info");
  const summaryBody = make("div");
  summaryBody.append(make("strong", `即将执行：${plan.preview.summary}`));
  if (plan.preview.affects.length)
    summaryBody.append(
      make("p", `影响范围 ${plan.preview.affects.join("、")}`, "alert-sub"),
    );
  summary.append(summaryBody);
  adorn(summary, "Info", 16);
  output.append(summary);
  if (plan.opId && showHeading)
    output.append(
      make("p", `${plan.level} · 操作编号 ${plan.opId}`, "invariant-note"),
    );
  const steps = make("ol", "", "preview-steps-list");
  for (const step of plan.preview.steps) {
    const item = make("li", "", "preview-step-card");
    const target = make("div", "", "preview-step-target");
    target.append(
      make("span", `#${step.seq}`, "mono req-id"),
      make("strong", `${actions[step.action] ?? step.action} · ${step.target}`),
    );
    item.append(target);
    const fields = make("div", "", "preview-fields-wrap");
    for (const [name, { value, origin }] of Object.entries(step.fields)) {
      const pill = make("div", "", "preview-field-pill");
      pill.append(
        make("span", name, "preview-field-k"),
        make("strong", display(value)),
        make(
          "span",
          origins[origin],
          `bzt-badge${origin === "derived" ? " tone-purple" : origin === "default" ? " tone-primary" : ""}`,
        ),
      );
      fields.append(pill);
    }
    if (fields.childElementCount !== 0) item.append(fields);
    steps.append(item);
  }
  if (plan.preview.steps.length) output.append(steps);
  if (plan.warnings.length) {
    const warnings = make("div", "", "bzt-alert tone-warn");
    const body = make("div");
    body.append(
      make("strong", "操作提示"),
      list(
        make,
        "ul",
        plan.warnings.map(({ code, message }) => `${code} ${message}`),
      ),
    );
    warnings.append(body);
    adorn(warnings, "TriangleAlert", 16);
    output.append(warnings);
  }
  if (plan.gaps?.length)
    output.append(
      make("p", "部分数据未读取"),
      list(
        make,
        "ul",
        plan.gaps.map(({ source, reason }) => `${source} ${reason}`),
      ),
    );
}

function link(make, label, href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return make("span", label);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  )
    return make("span", label);
  const anchor = make("a", label);
  anchor.setAttribute("href", url.href);
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer");
  return anchor;
}

function receiptBody(make, output, receipt) {
  const complete = receipt.status === "confirmed";
  const state = make(
    "p",
    states[receipt.status] ?? receipt.status,
    `bzt-alert tone-${complete ? "success" : "warn"}`,
  );
  adorn(state, complete ? "CircleCheck" : "TriangleAlert", 16);
  output.append(state);
  if (receipt.steps.length) {
    const steps = make("ol", "", "preview-steps-list");
    for (const step of receipt.steps) {
      const item = make(
        "li",
        `${actions[step.action] ?? step.action} · ${states[step.state] ?? step.state}`,
        "preview-step-card",
      );
      if (step.zentaoId)
        item.append(link(make, ` #${step.zentaoId}`, step.url));
      if (step.error) item.append(make("p", step.error));
      steps.append(item);
    }
    output.append(steps);
  }
  if (receipt.created.length) {
    const created = make("ul");
    for (const { type, id, url } of receipt.created) {
      const item = make("li");
      item.append(link(make, `${objects[type]} #${id}`, url));
      created.append(item);
    }
    output.append(make("p", "已创建对象"), created);
  }
  const next = receipt.nextActions?.filter(
    (action) => !/^confirm_operation\(/u.test(action),
  );
  if (next?.length) output.append(list(make, "ul", next));
  if (receipt.notified?.length)
    output.append(
      list(
        make,
        "ul",
        receipt.notified.map(
          ({ target, state }) =>
            `企微 · ${target} · ${{ sent: "已发送", queued: "排队中", failed: "发送失败" }[state]}`,
        ),
      ),
    );
}

export function renderWrite(
  container,
  tool,
  call,
  role,
  account,
  initial,
  options = {},
) {
  if (!Object.hasOwn(forms, tool)) return;
  function make(tag, text, className) {
    const node = container.ownerDocument.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const page = options.intakePage || tool === "import_stories";
  const view = make("div", "", page ? "daily-write-view" : "view-results");
  const {
    form,
    payload,
    prefill,
    resetForm,
    setLocked,
    prepareForm,
    selectIntakeMode,
  } =
    tool === "import_stories"
      ? buildBatchForm(make, options)
      : buildForm(make, tool, role, initial, { ...options, account });
  const inline = make("section", "", "daily-write-inline");
  inline.hidden = true;
  const dialog = make("dialog", "", "write-modal daily-write-dialog");
  const usesDialog = typeof dialog.showModal === "function";
  const title = make("h3");
  const opIdChip = make("span", "", "bzt-badge mono");
  opIdChip.hidden = true;
  const head = make("header", "", "modal-head");
  const heading = make("div", "", "modal-head-title");
  heading.append(title, opIdChip);
  adorn(heading, "ShieldCheck", 16);
  const close = make("button", "", "icon-btn-subtle");
  close.type = "button";
  close.setAttribute("aria-label", "关闭确认弹窗");
  adorn(close, "X", 16);
  close.addEventListener("click", () => dialog.close());
  head.append(heading, close);
  const detail = make("section", "", "modal-body");
  const foot = make("footer", "", "modal-foot");
  const reopen = make("button", "查看原操作回执", "btn-secondary btn-sm");
  reopen.type = "button";
  reopen.hidden = true;
  reopen.addEventListener("click", () => {
    if (current() && attempt?.acted && !dialog.open) openDialog("操作回执");
  });
  dialog.append(head, detail, foot);
  view.append(form, inline);
  if (usesDialog) view.append(reopen, dialog);
  let output = inline;
  container.replaceChildren(view);
  let attempt;
  let busy = false;
  let timer;
  let finishPreview;
  const current = () =>
    !options.signal?.aborted && view.isConnected && container.contains(view);
  const loading = { signal: options.signal, current };
  const storeKey = `bzt.portal.operation.${JSON.stringify([account, role, tool])}`;
  const fieldLabels = new Map(
    (tool === "create_story" && role === "FB" && options.intakePage
      ? businessFeedback
      : fieldsFor(tool, role)
    ).map(({ name, label }) => [name, label]),
  );

  function openDialog(label, { opId, level } = attempt?.plan ?? attempt ?? {}) {
    if (!usesDialog) return;
    inline.hidden = true;
    inline.replaceChildren();
    output = detail;
    title.textContent = level ? `${level} · ${label}` : label;
    opIdChip.textContent = opId ?? "";
    opIdChip.hidden = !opId;
    dialog.setAttribute("aria-label", label);
    reopen.hidden = true;
    if (!dialog.open) dialog.showModal();
  }

  dialog.addEventListener("close", () => {
    if (!current() || dialog.open) return;
    if (attempt?.acted) reopen.hidden = false;
    else if (output === detail) reset();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });

  function show(message, error = false) {
    output.hidden = !message;
    output.replaceChildren();
    foot.replaceChildren();
    if (!message) return;
    const notice = make(
      "p",
      message,
      `bzt-alert tone-${error ? "warn" : "info"}`,
    );
    notice.setAttribute("role", error ? "alert" : "status");
    output.append(notice);
  }

  function showError(error, fallback) {
    show(error?.message || fallback, true);
    const details = error?.details;
    if (!details) return;
    for (const [name, label] of [
      ["missing", "需要补齐"],
      ["fields", "请核对字段"],
    ]) {
      if (!Array.isArray(details[name])) continue;
      const labels = details[name]
        .filter((entry) => typeof entry === "string")
        .map((entry) => fieldLabels.get(entry) ?? entry);
      if (labels.length)
        output.append(make("p", `${label} ${labels.join("、")}`));
    }
    if (Array.isArray(details.candidates) && details.candidates.length) {
      const values = details.candidates
        .map((candidate) => {
          if (typeof candidate === "string") return candidate;
          return [
            candidate?.realname || candidate?.name || candidate?.title,
            candidate?.account,
            candidate?.id && `#${candidate.id}`,
          ]
            .filter(Boolean)
            .join(" · ");
        })
        .filter(Boolean);
      if (values.length)
        output.append(make("p", "候选项"), list(make, "ul", values));
    }
    if (Array.isArray(details.links)) {
      const links = make("ul");
      for (const entry of details.links) {
        if (typeof entry?.label !== "string" || typeof entry?.url !== "string")
          continue;
        const item = make("li");
        item.append(link(make, entry.label, entry.url));
        links.append(item);
      }
      if (links.childElementCount !== 0) output.append(links);
    }
  }

  function reset(message, error) {
    finishPreview?.();
    finishPreview = undefined;
    clearTimeout(timer);
    attempt = undefined;
    if (output === detail) {
      output = inline;
      detail.replaceChildren();
      if (dialog.open) dialog.close();
    }
    reopen.hidden = true;
    if (error) showError(error, message);
    else show(message, Boolean(message));
    setLocked(busy);
  }

  function existingOperation() {
    if (!account || !role) throw new Error("当前账号无法保存操作回执。");
    const stored = sessionStorage.getItem(storeKey);
    if (!stored) return undefined;
    const record = JSON.parse(stored);
    if (
      record?.account !== account ||
      record.role !== role ||
      record.tool !== tool ||
      typeof record.opId !== "string" ||
      record.opId.trim() === ""
    )
      throw new Error("当前标签页的操作记录无法核对。");
    return record.opId;
  }

  function forgetOperation(entry) {
    try {
      if (existingOperation() === entry.opId)
        sessionStorage.removeItem(storeKey);
      return true;
    } catch {
      renderReceipt(entry, new Error("未能清除当前标签页的操作记录。"));
      return false;
    }
  }

  function invalidateOnEdit() {
    if (attempt && !attempt.acted && !busy) reset();
  }
  form.addEventListener("input", invalidateOnEdit);
  form.addEventListener("change", invalidateOnEdit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    return preview();
  });

  async function preview() {
    if (!current() || busy || attempt?.acted) return;
    reset();
    let input;
    try {
      if (!prepareForm()) return;
      input = payload();
    } catch (error) {
      showError(error, "请核对表单字段。");
      return;
    }
    busy = true;
    setLocked(true);
    if (!usesDialog) {
      inline.hidden = false;
      inline.append(make("h2", "操作预览"));
    }
    const host = usesDialog ? detail : make("div");
    if (!usesDialog) inline.append(host);
    const finish = beginSkeleton(
      host,
      (doc) => {
        openDialog("操作前预览确认");
        return previewSkeleton(doc);
      },
      loading,
    );
    finishPreview = finish;
    const pending = () =>
      current() &&
      finishPreview === finish &&
      (output !== detail || dialog.open);
    try {
      const plan = await call(tool, input);
      if (!pending()) return;
      finish();
      openDialog("操作前预览确认", plan);
      show();
      output.hidden = false;
      previewBody(make, output, plan, output === inline);
      if (
        !plan.opId ||
        plan.preview.steps.length === 0 ||
        plan.level === "W0" ||
        plan.level === "W3"
      )
        return;
      attempt = {
        opId: plan.opId,
        expires: Date.parse(plan.expiresAt),
        ready:
          Date.now() +
          (plan.level === "W2" || plan.requiresPreviewAck ? reviewDelayMs : 0),
        plan,
        acted: false,
      };
      busy = false;
      showConfirmation(attempt);
    } catch (error) {
      if (pending()) reset("生成预览失败。", error);
    } finally {
      finish();
      if (finishPreview === finish) finishPreview = undefined;
      busy = false;
      if (current()) setLocked(false);
    }
  }

  function confirmControls(
    entry,
    label,
    onConfirm,
    usable = () => true,
    checkLabel = "我已核对上述操作及影响",
  ) {
    const controls = make("div", "", "write-confirm-controls");
    const check = make("label", "", "check-label");
    const ack = make("input", "", "bzt-checkbox");
    ack.type = "checkbox";
    ack.name = "previewAck";
    check.append(ack, make("span", checkLabel));
    const button = make("button", label, "btn-primary");
    button.type = "button";
    button.disabled = true;
    const update = () => {
      button.disabled =
        !current() ||
        busy ||
        !controls.isConnected ||
        entry !== attempt ||
        !ack.checked ||
        !usable();
    };
    ack.addEventListener("change", update);
    button.addEventListener("click", async () => {
      update();
      if (!button.disabled) await onConfirm();
    });
    controls.append(check, button);
    return { controls, update };
  }

  function showConfirmation(entry) {
    const hold = make("p", "", "invariant-note");
    hold.setAttribute("role", "status");
    const { controls, update } = confirmControls(
      entry,
      "确认执行",
      () => execute(entry),
      () => Date.now() >= entry.ready && Date.now() < entry.expires,
    );
    output.append(hold);
    if (output === detail) {
      const cancel = make("button", "取消", "btn-ghost");
      cancel.type = "button";
      cancel.addEventListener("click", () => dialog.close());
      controls.insertBefore(cancel, controls.lastElementChild);
      foot.append(controls);
    } else output.append(controls);
    function refresh() {
      if (!current() || attempt !== entry || entry.acted) return;
      const now = Date.now();
      if (now >= entry.expires || !Number.isFinite(entry.expires)) {
        reset("预览已过期，请重新生成预览。");
        return;
      }
      hold.textContent =
        now < entry.ready ? "请先查看预览，等待确认按钮可用。" : "";
      hold.hidden = now >= entry.ready;
      update();
      clearTimeout(timer);
      timer = setTimeout(
        refresh,
        Math.min(
          entry.expires,
          now < entry.ready ? entry.ready : entry.expires,
        ) - now,
      );
    }
    refresh();
  }

  function matchedReceipt(entry, receipt) {
    if (receipt?.opId !== entry.opId)
      throw new Error("回执与当前操作编号不匹配。");
    return receipt;
  }

  async function execute(entry, resume = false) {
    clearTimeout(timer);
    try {
      const recorded = existingOperation();
      if (recorded && recorded !== entry.opId)
        throw new Error("当前操作与已保存的编号不一致。");
      sessionStorage.setItem(
        storeKey,
        JSON.stringify({ account, role, tool, opId: entry.opId }),
      );
    } catch {
      const error = new Error("无法保存操作编号，请检查当前标签页的会话存储。");
      if (resume) renderReceipt(entry, error);
      else {
        showError(error);
        previewBody(make, output, entry.plan, output === inline);
        showConfirmation(entry);
      }
      return;
    }
    busy = true;
    entry.acted = true;
    setLocked(true);
    const finish = pendingReceipt(entry);
    try {
      const result = await call("confirm_operation", {
        opId: entry.opId,
        previewAck: true,
        ...(resume ? { resume: true } : {}),
      });
      if (!current()) return;
      entry.receipt = matchedReceipt(entry, result);
      renderReceipt(entry);
      options.onReceipt?.(entry.receipt);
    } catch (error) {
      if (!current()) return;
      const invalid = ["PLAN_EXPIRED", "PLAN_STALE"].includes(error.code);
      if (!resume && invalid) {
        if (forgetOperation(entry))
          reset("预览已失效，请重新生成预览。", error);
      } else if (
        !resume &&
        ["PREVIEW_TOO_FAST", "PREVIEW_REQUIRED"].includes(error.code)
      ) {
        if (!forgetOperation(entry)) return;
        entry.acted = false;
        entry.ready = Date.now() + reviewDelayMs;
        busy = false;
        if (output === detail && !dialog.open) reset(undefined, error);
        else {
          showError(error, "请重新核对预览并等待确认。");
          previewBody(make, output, entry.plan, output === inline);
          showConfirmation(entry);
        }
      } else {
        if (invalid) {
          entry.expires = 0;
          entry.receipt = undefined;
        }
        renderReceipt(entry, error);
      }
    } finally {
      finish();
      busy = false;
      if (current()) setLocked(Boolean(attempt?.acted));
    }
  }

  async function lookupReceipt(entry) {
    if (!current() || busy || entry !== attempt) return;
    busy = true;
    const finish = pendingReceipt(entry);
    try {
      const response = await call("get_operation", { opId: entry.opId });
      if (!current()) return;
      entry.receipt = matchedReceipt(entry, response.data);
      entry.inaccessible = false;
      renderReceipt(entry);
      options.onReceipt?.(entry.receipt);
    } catch (error) {
      if (current()) {
        entry.inaccessible = [
          "AUTH_FAILED",
          "PERMISSION_DENIED",
          "NOT_FOUND",
        ].includes(error.code);
        renderReceipt(entry, error);
      }
    } finally {
      finish();
      busy = false;
    }
  }

  function startNewOperation(entry) {
    if (!current() || busy || entry !== attempt || !forgetOperation(entry))
      return;
    if (entry.receipt?.status === "confirmed") {
      resetForm();
    }
    reset();
  }

  function receiptHeading(entry) {
    output.hidden = false;
    if (output === detail) {
      const level = entry.plan?.level;
      title.textContent = level ? `${level} · 操作回执` : "操作回执";
      dialog.setAttribute("aria-label", "操作回执");
    } else {
      output.append(
        make("h2", "操作回执"),
        make("p", `操作编号 ${entry.opId}`, "invariant-note"),
      );
    }
  }

  function pendingReceipt(entry) {
    show();
    receiptHeading(entry);
    const host = make("div");
    output.append(host);
    return beginSkeleton(host, receiptSkeleton, loading);
  }

  function renderReceipt(entry, error) {
    if (error) showError(error, "未取得操作回执。");
    else show();
    receiptHeading(entry);
    const receipt = entry.receipt;
    if (receipt) receiptBody(make, output, receipt);
    else
      output.append(make("p", "结果待核对，请先查询该编号的回执。", "notice"));

    if (receipt?.status === "confirmed" && entry.plan?.intakes?.length)
      output.append(
        list(
          make,
          "ul",
          entry.plan.intakes.map(({ message }) => message),
        ),
      );
    const buttons = make("div", "", "row-actions is-end");
    const lookup = make("button", "查询回执", "btn-secondary btn-sm");
    lookup.type = "button";
    lookup.addEventListener("click", () => {
      if (lookup.isConnected) return lookupReceipt(entry);
    });
    buttons.append(lookup);
    (output === detail ? foot : output).append(buttons);

    if (entry.inaccessible) {
      output.append(
        make(
          "p",
          "当前会话无法查询该操作。请在禅道核对原操作结果，核对后再开始新操作。",
          "notice",
        ),
      );
      const { controls } = confirmControls(
        entry,
        "核对后开始新操作",
        () => startNewOperation(entry),
        undefined,
        "我已在禅道核对原操作",
      );
      output.append(controls);
      return;
    }
    if (
      receipt?.status === "confirmed" ||
      (receipt?.status === "not_executed" && entry.expires === 0)
    ) {
      const start = make("button", "开始新操作", "btn-primary");
      start.type = "button";
      start.addEventListener("click", () => {
        if (start.isConnected) startNewOperation(entry);
      });
      buttons.append(start);
    }
    if (
      receipt?.steps.some(({ state }) =>
        ["unknown", "pending", "failed"].includes(state),
      ) &&
      Date.now() < entry.expires
    ) {
      const { controls } = confirmControls(
        entry,
        "恢复此操作",
        () => execute(entry, true),
        () => Date.now() < entry.expires,
      );
      output.append(controls);
    }
  }

  try {
    const opId = existingOperation();
    if (opId) {
      attempt = { opId, expires: Infinity, acted: true };
      setLocked(true);
      openDialog("操作回执");
      void lookupReceipt(attempt);
    } else if (options.preview) void preview();
  } catch (error) {
    showError(error, "无法读取当前标签页的操作编号。");
  }
  return { prefill, selectIntakeMode };
}
