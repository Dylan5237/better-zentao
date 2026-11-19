import assert from "node:assert/strict";
import { draftInput, PASSWORD, PRIVATE_HASH, RESET_VALUE, startMock, TOKEN } from "./zentao.mjs";
import { mcpProcess, runCli, toolData } from "./process.mjs";

export const toolNames = [
  "resolve_context", "get_my_dashboard", "get_team_overdue", "query_stories", "get_story_progress",
  "create_story", "import_stories", "assign_story", "delete_story",
];

export function assertNoSecrets(text) {
  for (const secret of [TOKEN, PASSWORD, PRIVATE_HASH, RESET_VALUE]) assert(!text.includes(secret));
  assert(!/"(?:password|resetToken|token)"\s*:/i.test(text));
}

export async function verifyMcpLifecycle(mock, rpc) {
  const setup = await rpc.initialize();
  assert.equal(setup.serverInfo.name, "better-zentao-mcp");
  assert.deepEqual((await rpc.list()).tools.map(tool => tool.name), toolNames);
  assert.equal(mock.requests.length, 0);
  assert.match(rpc.stderr, /better-zentao-mcp 已启动/);
  for (const line of rpc.stdout) assert.equal(JSON.parse(line).jsonrpc, "2.0");
}

export async function verifyMcpTools(mock, rpc) {
  async function call(name, args) {
    const raw = await rpc.call(name, args);
    assertNoSecrets(JSON.stringify(raw));
    const output = toolData(raw);
    assert.equal(output.isError, false);
    assert.deepEqual(output.data, output.structured);
    return output.data;
  }
  const context = await call("resolve_context", { query: "用户甲", kinds: ["user"] });
  assert.equal(context.matches.user.candidates[0].account, "jia");
  assert.equal((await call("get_my_dashboard")).me.account, "jia");
  assert.equal((await call("get_team_overdue")).totalOverdueTasks, 3);
  assert.equal((await call("query_stories", { state: "design" })).stories[0].id, 101);
  assert.equal((await call("get_story_progress", { storyId: 101 })).tasks[0].left, 2.5);
  assert.equal((await call("create_story", draftInput)).allOk, true);
  assert.equal((await call("import_stories", { stories: [draftInput] })).allOk, true);
  assert.equal(mock.businessWrites().length, 0);
  const created = await call("create_story", { ...draftInput, dryRun: false });
  const [story] = created.results;
  assert(story.id && story.readbackConfirmed && story.assignResult.confirmed);
  assert.equal((await call("assign_story", { storyId: story.id, assignedTo: "用户乙" })).confirmed, true);
  const beforeDelete = mock.businessWrites().length;
  const refused = toolData(await rpc.call("delete_story", { storyId: story.id }));
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error.code, "INVALID_PARAM");
  assert.equal(mock.businessWrites().length, beforeDelete);
  assert.equal((await call("delete_story", { storyId: story.id, confirm: true })).deleted, true);
  assert.deepEqual(mock.businessWrites().map(request => request.method), ["POST", "POST", "DELETE"]);
}

export async function verifyCliParity(mock, rpc) {
  const entries = [
    ["resolve_context", { query: "用户甲", kinds: ["user"] }, ["resolve", "用户甲", "--kinds", "user"]],
    ["get_my_dashboard", { upcomingDays: 2 }, ["me", "--upcoming-days", "2"]],
    ["get_team_overdue", { members: ["用户甲", "用户乙"] }, ["overdue", "--members", "用户甲,用户乙"]],
    ["query_stories", { state: "design", status: "all" }, ["stories", "--state", "design", "--status", "all"]],
    ["get_story_progress", { storyId: 101 }, ["progress", "101"]],
    ["create_story", draftInput, ["create", "--title", draftInput.title, "--spec", draftInput.spec, "--verify", draftInput.verify,
      "--module", draftInput.module, "--assign-to", draftInput.assignTo]],
    ["import_stories", { stories: [draftInput] }, ["import", "--stdin"], JSON.stringify({ stories: [draftInput] })],
    ["assign_story", { storyId: 102, assignedTo: "用户乙" }, ["assign", "102", "用户乙"]],
    ["delete_story", { storyId: 103, confirm: true }, ["delete", "103", "--confirm"]],
  ];
  for (const [name, input, args, stdin] of entries) {
    const mcp = toolData(await rpc.call(name, input));
    assert.equal(mcp.isError, false, name);
    if (name === "delete_story") mock.stories.get(103).deleted = "0";
    const cli = await runCli(["--json", ...args], mock.env, stdin);
    assert.equal(cli.code, 0, name);
    assert.equal(cli.stderr, "", name);
    assertNoSecrets(cli.stdout);
    assert.deepEqual(JSON.parse(cli.stdout), mcp.structured, name);
  }
}

export async function runLocalSmoke() {
  const mock = await startMock({ leaks: true });
  const rpc = mcpProcess(mock.env);
  try {
    await verifyMcpLifecycle(mock, rpc);
    console.log("TC-ADP-01 PASS 真实 stdio 握手、9 工具发现与输出隔离");
    await verifyMcpTools(mock, rpc);
    console.log("TC-ADP-03 PASS 真实 MCP 调用、Mock 写路径和确认守卫");
    await verifyCliParity(mock, rpc);
    console.log("TC-ADP-05 PASS 真实 CLI 9 子命令与 MCP JSON 一致");
  } finally {
    await rpc.close();
    await mock.close();
  }
}
