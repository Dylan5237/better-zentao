import { createHash } from "node:crypto";
import {
  prepareConfigEditorData,
  teamConfigKeys,
  type ConfigEditorData,
} from "../../../services/config-ui.ts";

const script = String.raw`
(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("editor-data").textContent);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panel = document.getElementById("editor-panel");
  const status = document.getElementById("editor-status");
  const notice = document.getElementById("directory-notice");
  const fields = ["products", "moduleDefaults", "modules", "teams", "roles", "aliases"];
  const leads = { designLead: "设计主管", devLead: "研发主管", testLead: "测试主管" };
  const roles = { PM: "产品管理", PJ: "项目管理", DM: "设计主管", RM: "研发主管", QA_LEAD: "测试主管" };
  const states = ["design", "runtime", "delivery", "other"];
  const kinds = ["design", "dev", "ui"];
  const searchKey = (value) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const people = new Map(data.users.map(({ account, realname, pinyin }) => [account, {
    label: realname + " · " + account,
    terms: [account, realname, pinyin ?? ""].map(searchKey),
  }]));
  let config = data.config;
  let active = 0;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action, className) {
    const node = el("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function label(text, control) {
    const node = el("label", text, "field");
    node.append(control);
    return node;
  }

  function card(title, description) {
    const node = el("section", undefined, "card");
    node.append(el("h2", title));
    if (description) node.append(el("p", description, "muted"));
    panel.append(node);
    return node;
  }

  function grid(parent, ...controls) {
    const node = el("div", undefined, "grid");
    node.append(...controls);
    parent.append(node);
  }

  function textField(title, value, action) {
    const node = el("input");
    node.value = value;
    node.addEventListener("change", () => action(node));
    return label(title, node);
  }

  function options(node, choices, value) {
    node.replaceChildren();
    for (const [key, title] of choices) {
      const option = el("option", title);
      option.value = key;
      node.append(option);
    }
    node.value = value;
  }

  function selectField(title, value, choices, action) {
    const node = el("select");
    options(node, choices, value);
    node.addEventListener("change", () => action(node.value));
    return label(title, node);
  }

  function checkbox(title, value, action) {
    const node = el("input");
    node.type = "checkbox";
    node.checked = value;
    node.addEventListener("change", () => action(node.checked));
    const field = el("label", undefined, "check");
    field.append(node, document.createTextNode(title));
    return field;
  }

  const section = (key) => config[key] ?? {};
  function set(sectionKey, key, value) {
    config[sectionKey] ??= {};
    if (value === undefined) delete config[sectionKey][key];
    else Object.defineProperty(config[sectionKey], key, {
      value, enumerable: true, configurable: true, writable: true,
    });
    refresh();
  }

  function personLabel(account) {
    return people.get(account)?.label ?? account;
  }

  function picker(title, selected, multiple, change, fallback) {
    const box = el("fieldset", undefined, "picker");
    const tags = el("div", undefined, "tags");
    const search = el("input");
    search.type = "search";
    search.placeholder = "中文姓名、拼音或账号";
    search.setAttribute("aria-label", "搜索" + title + " · " + search.placeholder);
    const choices = el("select");
    choices.setAttribute("aria-label", "选择" + title);
    const manual = button("使用输入的账号", () => choose(search.value.trim()));
    box.append(el("legend", title), tags, search, choices, manual);

    function update() {
      tags.replaceChildren();
      for (const account of selected) {
        const chip = el("span", personLabel(account), "tag");
        const remove = button("×", () => {
          selected = selected.filter((value) => value !== account);
          change(selected);
          update();
          search.focus();
        });
        remove.setAttribute("aria-label", "移除 " + personLabel(account));
        chip.append(remove);
        tags.append(chip);
      }
      if (!selected.length) tags.append(el("span", fallback ?? "未指定", "muted"));
      const query = searchKey(search.value);
      const limit = query ? 100 : 20;
      const matches = [["", "请选择人员"]];
      for (const [account, person] of people) {
        if (selected.includes(account) || !person.terms.some((value) => value.includes(query))) continue;
        if (matches.length > limit) {
          matches[0][1] = "前 " + limit + " 个结果，继续搜索";
          break;
        }
        matches.push([account, person.label]);
      }
      if (matches.length === 1) matches[0][1] = "没有匹配人员";
      options(choices, matches, "");
      const account = search.value.trim();
      manual.hidden = !account || /\s/u.test(account) || people.has(account) ||
        selected.includes(account) || unsafe(account);
    }

    function choose(account) {
      if (!account) return;
      selected = multiple ? [...selected, account] : [account];
      change(selected);
      search.value = "";
      update();
      search.focus();
    }

    search.addEventListener("input", update);
    choices.addEventListener("change", () => choose(choices.value));
    update();
    return box;
  }

  function leadPickers(row, change, defaults = {}) {
    return Object.entries(leads).map(([key, title]) =>
      picker(title, row[key] ? [row[key]] : [], false, ([value]) => change(key, value),
        defaults[key] ? "继承 · " + personLabel(defaults[key]) : undefined));
  }

  function assign(row, field, value) {
    if (value) row[field] = value;
    else delete row[field];
  }

  const enabled = (id, product) =>
    product.enabled !== false && !(Number(id) === data.probeProductId && product.probeOnly);
  const missingDevLead = (id, module) =>
    !(section("modules")[id + ":" + module]?.devLead ?? section("moduleDefaults")[id]?.devLead);

  function productsPanel() {
    const catalog = new Map(data.products.map(({ id, name }) => [String(id), name]));
    for (const [id, product] of Object.entries(section("products"))) catalog.set(id, product.name);
    if (!catalog.size) panel.append(el("p", "暂无产品。可导入已有团队配置。", "muted"));
    for (const [id, name] of catalog) {
      const box = card(name + " · #" + id);
      const product = section("products")[id];
      if (!product) {
        box.append(button("纳入团队配置", () => {
          set("products", id, { name, state: "other", projects: [] });
          render();
        }));
        continue;
      }
      const change = (key, value) => { product[key] = value; refresh(); };
      grid(box,
        checkbox("启用", product.enabled !== false, (value) => change("enabled", value)),
        checkbox("只探查", product.probeOnly === true, (value) => change("probeOnly", value)),
        selectField("产品状态", product.state, states.map((value) => [value, value]),
          (value) => change("state", value)));
      const defaults = section("moduleDefaults")[id] ?? {};
      grid(box, ...leadPickers(defaults, (field, value) => {
        assign(defaults, field, value);
        set("moduleDefaults", id, Object.keys(defaults).length ? defaults : undefined);
      }));
    }
  }

  function modulesPanel() {
    const products = Object.entries(section("products")).filter(([id, product]) => enabled(id, product));
    if (!products.length) panel.append(el("p", "请先在产品页启用团队产品。", "muted"));
    for (const [id, product] of products) {
      const box = card(product.name + " · #" + id);
      const modules = data.modules[id];
      if (!modules) box.append(el("p", "一级模块清单缺失。当前仅显示已有覆盖。", "warning"));
      else if (!modules.length) box.append(el("p", "已确认无一级模块。", "muted"));
      const known = new Map((modules ?? []).map(({ id, name }) => [String(id), name]));
      const stored = Object.entries(section("modules")).filter(([key]) => key.startsWith(id + ":"));
      for (const [key, value] of stored) {
        const moduleId = key.split(":")[1];
        if (!known.has(moduleId)) known.set(moduleId, value.name);
      }
      for (const [moduleId, name] of known) {
        const key = id + ":" + moduleId;
        const row = section("modules")[key] ?? { name };
        const item = el("section", undefined, "module");
        const note = el("p");
        const current = modules?.some((module) => String(module.id) === moduleId);
        function updateNote() {
          const missing = current && missingDevLead(id, moduleId);
          note.className = missing ? "warning" : "muted";
          note.textContent = (Object.keys(row).length === 1 ? "继承产品默认" : "已设置模块覆盖") +
            (missing ? " · CFG-06 缺少研发主管" : "") +
            (current ? "" : " · 一级模块目录未确认此项");
        }
        function change(field, value) {
          assign(row, field, value);
          set("modules", key, Object.keys(row).length > 1 ? row : undefined);
          updateNote();
        }
        updateNote();
        item.append(el("h3", name + " · #" + moduleId), note);
        const teams = Object.entries(section("teams")).map(([team, value]) => [team, value.name || team]);
        if (row.team && !Object.hasOwn(section("teams"), row.team))
          teams.push([row.team, row.team + "（团队不存在）"]);
        grid(item, ...leadPickers(row, change, section("moduleDefaults")[id]),
          selectField("团队覆盖", row.team ?? "", [["", "不指定"], ...teams],
            (value) => change("team", value)));
        box.append(item);
      }
    }
  }

  function addControl(parent, key, title, action, value) {
    let input;
    const submit = () => {
      const name = input.value.trim();
      if (!name || unsafeKey(name) || Object.hasOwn(section(key), name)) {
        input.setCustomValidity("请输入未占用且不含凭据的名称。");
        input.reportValidity();
        return;
      }
      set(key, name, value(name));
      render();
    };
    const field = textField(title, "", (node) => node.setCustomValidity(""));
    input = field.querySelector("input");
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    grid(parent, field, button(action, submit, "primary"));
  }

  function teamsPanel() {
    const add = card("团队分组");
    addControl(add, "teams", "团队配置键", "新增团队", (name) => ({ name, lead: "", members: [] }));
    for (const [id, team] of Object.entries(section("teams"))) {
      const box = card("团队 · " + id);
      const change = (key, value) => { team[key] = value; refresh(); };
      grid(box,
        textField("团队名称", team.name, (input) => change("name", input.value)),
        picker("组长", team.lead ? [team.lead] : [], false, ([value]) => change("lead", value ?? "")),
        picker("组员", team.members, true, (value) => change("members", value)));
      const checks = el("fieldset", undefined, "checks");
      checks.append(el("legend", "执行类型"));
      for (const kind of kinds) {
        checks.append(checkbox(kind, (team.executionKinds ?? []).includes(kind), (checked) => {
          const updated = new Set(team.executionKinds ?? []);
          if (checked) updated.add(kind);
          else updated.delete(kind);
          change("executionKinds", [...updated]);
        }));
      }
      box.append(checks, button("删除团队", () => {
        set("teams", id, undefined);
        render();
      }));
    }
  }

  function rolesPanel() {
    const rolesBox = card("角色成员");
    grid(rolesBox, ...Object.entries(roles).map(([role, title]) =>
      picker(role + " · " + title, section("roles")[role] ?? [], true, (value) => set("roles", role, value))));
    const aliases = card("称呼别名");
    addControl(aliases, "aliases", "称呼", "新增别名", () => "");
    for (const [alias, account] of Object.entries(section("aliases"))) {
      grid(aliases,
        textField("称呼", alias, (input) => {
          const next = input.value.trim();
          if (next === alias) return;
          if (!next || unsafeKey(next) || Object.hasOwn(section("aliases"), next)) {
            input.value = alias;
            status.textContent = "请使用未占用且不含凭据的称呼。";
            return;
          }
          set("aliases", next, section("aliases")[alias]);
          set("aliases", alias, undefined);
          render();
        }),
        picker("对应账号", account ? [account] : [], false, ([value]) => set("aliases", alias, value ?? "")),
        button("删除别名", () => {
          set("aliases", alias, undefined);
          render();
        }));
    }
  }

  const credentialField = /password|passwd|pwd|token|authorization|bearer|credential|cookie|secret|apikey|privatekey|phpsessid|zentaosid|sessionid|webhook|zentaobaseurl/iu;
  const credentialValue = /https?:[\\/]{2}|zentao[_-]?base[_-]?url|bzt[_-]?wecom[_-]?webhook|\bbearer\s+\S+|\b(?:token|authorization|password|x-api-key|zentaosid|phpsessid)["']?\s*[:=]\s*\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|\$(?:2[aby]|argon2(?:id|i|d))\$\S+|[a-f\d]{32}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
  const unsafeKey = (key) => key === "__proto__" ||
    credentialField.test(key.replace(/[^a-z]/giu, "")) || unsafe(key);
  function unsafe(value) {
    if (typeof value === "string") return credentialValue.test(value);
    return value !== null && typeof value === "object" &&
      Object.entries(value).some(([key, child]) => unsafeKey(key) || unsafe(child));
  }

  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && /\S/u.test(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0;
  const idKey = (value) => /^[1-9]\d*$/u.test(value) && id(Number(value));
  const list = (value, check) => Array.isArray(value) && value.every(check);
  const optional = (value, check) => value === undefined || check(value);
  const allowed = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key));
  const leadKeys = Object.keys(leads);
  const validLeads = (row) => leadKeys.every((key) => optional(row[key], text));

  // 校验表单可编辑的结构。其余配置段保留原值，完整契约由 doctor 校验。
  function validImport(input) {
    if (!allowed(input, data.configKeys) || (input.version !== undefined && input.version !== 1))
      return false;
    if (!fields.every((key) => optional(input[key], record))) return false;
    const check = {
      products: (key, row) => idKey(key) && allowed(row, ["name", "state", "projects", "enabled", "probeOnly"]) &&
        text(row.name) && states.includes(row.state) && optional(row.projects, (value) => list(value, id)) &&
        ["enabled", "probeOnly"].every((flag) => optional(row[flag], (value) => typeof value === "boolean")),
      moduleDefaults: (key, row) => idKey(key) && allowed(row, leadKeys) && validLeads(row),
      modules: (key, row) => key.split(":").length === 2 && key.split(":").every(idKey) &&
        allowed(row, ["name", "team", ...leadKeys]) && text(row.name) && validLeads(row) && optional(row.team, text),
      teams: (key, row) => text(key) && allowed(row, ["name", "lead", "members", "executionKinds"]) &&
        text(row.name) && text(row.lead) && list(row.members, text) &&
        optional(row.executionKinds, (value) => list(value, (kind) => kinds.includes(kind))),
      roles: (key, value) => Object.hasOwn(roles, key) && list(value, text),
      aliases: (key, value) => text(key) && text(value),
    };
    return fields.every((key) => Object.entries(input[key] ?? {})
      .every(([entry, row]) => check[key](entry, row)));
  }

  function findings() {
    const warnings = [];
    const errors = [];
    const privateData = unsafe(config);
    if (privateData) return { errors: ["CFG-10 配置含疑似凭据或连接地址。"], warnings, privateData };
    for (const [id, product] of Object.entries(section("products"))) {
      if (!enabled(id, product)) continue;
      const modules = data.modules[id];
      if (!modules) warnings.push("CFG-06 · #" + id + " 缺少一级模块清单，无法确认主管覆盖。");
      else for (const { id: moduleId, name } of modules) {
        if (missingDevLead(id, moduleId)) warnings.push("CFG-06 · " + product.name +
          " / " + name + " 缺少研发主管。");
      }
    }
    for (const [key, row] of Object.entries(section("modules"))) {
      if (row.team && !Object.hasOwn(section("teams"), row.team))
        errors.push("模块 " + key + " 引用的团队「" + row.team + "」不存在。");
    }
    for (const [id, team] of Object.entries(section("teams"))) {
      if (!text(team.name) || !text(team.lead)) errors.push("团队「" + id + "」缺少名称或组长。");
    }
    for (const [alias, account] of Object.entries(section("aliases"))) {
      if (!text(account)) errors.push("称呼「" + alias + "」缺少对应账号。");
    }
    return { errors, warnings, privateData };
  }

  function refresh() {
    const { errors, warnings } = findings();
    status.textContent = errors.length + " 项配置错误 · " + warnings.length + " 项覆盖提示";
  }

  function transferPanel() {
    const { errors, warnings, privateData } = findings();
    const info = card("配置校验");
    if (!errors.length && !warnings.length) info.append(el("p", "当前编辑项校验通过。"));
    for (const message of errors) info.append(el("p", message, "error"));
    for (const message of warnings) info.append(el("p", message, "warning"));
    const box = card("导入或保存团队配置", "导入会替换当前编辑内容。其他配置段随 JSON 一并导出。");
    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        const input = JSON.parse((await selected.text()).replace(/^\uFEFF/u, ""));
        if (unsafe(input) || !validImport(input)) throw new Error();
        config = input;
        render();
        status.textContent = "已导入团队配置。 " + status.textContent;
      } catch {
        file.value = "";
        status.textContent = "导入失败。请检查 JSON、编辑区字段和疑似凭据。";
      }
    });
    const json = privateData ? "" : JSON.stringify(config, null, 2) + "\n";
    const preview = el("textarea");
    preview.readOnly = true;
    preview.value = json;
    const copy = button("复制 JSON", async () => {
      try {
        await navigator.clipboard.writeText(json);
        status.textContent = "已复制 JSON。";
      } catch {
        preview.focus();
        preview.select();
        status.textContent = document.execCommand("copy") ? "已复制 JSON。" : "请按 Ctrl+C 复制已选中的 JSON。";
      }
    });
    const download = button("下载 team.local.json", () => {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = el("a");
      link.href = url;
      link.download = "team.local.json";
      box.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      status.textContent = "已发起下载。";
    }, "primary");
    copy.disabled = download.disabled = errors.length > 0;
    box.append(label("导入 JSON", file), label("JSON 预览", preview));
    grid(box, copy, download);
  }

  const views = [productsPanel, modulesPanel, teamsPanel, rolesPanel, transferPanel];
  function render() {
    panel.replaceChildren();
    panel.setAttribute("aria-labelledby", tabs[active].id);
    tabs.forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === active));
      tab.tabIndex = index === active ? 0 : -1;
    });
    views[active]();
    refresh();
  }
  function activate(index) { active = index; render(); tabs[index].focus(); }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", (event) => {
      const next = ({ ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 })[event.key];
      if (next === undefined) return;
      event.preventDefault();
      activate(next);
    });
  });
  if (data.completeness === "partial") {
    notice.append(el("strong", "目录读取不完整"));
    const list = el("ul");
    for (const { source, reason } of data.gaps) {
      const title = source === "products" ? "产品目录" : source === "users" ? "人员目录" :
        "一级模块 · #" + source.split(":")[1];
      list.append(el("li", title + " · " + reason));
    }
    notice.append(list);
    notice.hidden = false;
  }
  render();
})();
`;

export function renderTeamConfigEditorHtml(input: ConfigEditorData): string {
  const data = prepareConfigEditorData(input);
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const json = JSON.stringify({ ...data, configKeys: teamConfigKeys })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

  // 动态数据只进入 JSON 脚本块；页面用文本节点读取和呈现。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>团队配置编辑器</title>
<style>
  :root { color-scheme: dark; font: 15px/1.55 system-ui, sans-serif; background: #10141a; color: #ecf0f6; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; }
  main { max-width: 78rem; margin: auto; padding: clamp(1rem, 4vw, 3rem); }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem 1rem; }
  h1 { margin: 0; font-size: clamp(1.65rem, 4vw, 2.45rem); }
  h2, h3 { margin: 0; overflow-wrap: anywhere; }
  h2 { font-size: 1.14rem; }
  h3 { font-size: 1rem; }
  p, ul { margin: .45rem 0; }
  nav { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.4rem 0 1rem; }
  button, input, select, textarea { font: inherit; color: inherit; background: #1a222c; border: 1px solid #566579; border-radius: .45rem; padding: .45rem .65rem; min-width: 0; }
  button { cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  :focus-visible { outline: 2px solid #8ed5ff; outline-offset: 3px; }
  [aria-selected="true"], .primary { background: #a8d8fa; color: #101c28; border-color: #a8d8fa; }
  .card { background: #171e27; border: 1px solid #354355; padding: 1rem; border-radius: .65rem; margin-bottom: .75rem; }
  .module { margin-top: .8rem; padding-top: .8rem; border-top: 1px solid #354355; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); align-items: end; gap: .75rem; margin-top: .65rem; }
  .module .grid, .card .grid:has(.picker) { align-items: start; }
  .field, .picker { display: grid; gap: .35rem; }
  fieldset { margin: 0; min-width: 0; border: 1px solid #354355; border-radius: .45rem; padding: .6rem; }
  legend { padding: 0 .3rem; }
  .check, .checks, .tags { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
  .checks { margin: .7rem 0; }
  .tag { overflow-wrap: anywhere; background: #25394b; border-radius: .35rem; padding: .1rem .35rem; }
  .tag button { margin-left: .25rem; padding: 0 .3rem; border: 0; }
  .muted, #editor-status { color: #abb8c8; }
  .warning { color: #ffd78d; }
  .error { color: #ffadad; }
  #directory-notice { padding: .65rem .85rem; margin-top: 1rem; border-left: .25rem solid #d2a35c; background: #28251f; }
  textarea { min-height: 17rem; resize: vertical; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <header><h1>团队配置编辑器</h1><p id="editor-status" role="status"></p></header>
  <aside id="directory-notice" class="warning" hidden></aside>
  <nav role="tablist" aria-label="配置页签">
    <button type="button" id="tab-products" role="tab" aria-controls="editor-panel">产品与默认兜底</button>
    <button type="button" id="tab-modules" role="tab" aria-controls="editor-panel">一级模块覆盖</button>
    <button type="button" id="tab-teams" role="tab" aria-controls="editor-panel">团队分组</button>
    <button type="button" id="tab-roles" role="tab" aria-controls="editor-panel">角色权限与称呼别名</button>
    <button type="button" id="tab-transfer" role="tab" aria-controls="editor-panel">校验与导入/导出</button>
  </nav>
  <div id="editor-panel" role="tabpanel" tabindex="0"></div>
</main>
<script type="application/json" id="editor-data">${json}</script>
<script>${script}</script>
</body>
</html>
`;
}
