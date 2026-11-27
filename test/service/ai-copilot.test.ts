import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseModelPatchOutput,
  projectOutboundFormFields,
  validateFormPatchProposal,
} from "../../src/services/ai/copilot-contracts.ts";
import { createPersonalModelStore } from "../../src/services/ai/personal-model-store.ts";
import type { ModelTransport } from "../../src/services/ai/model-gateway.ts";
import {
  browser,
  login,
  report,
  useServerFixture,
} from "../helpers/server-fixture.ts";

/**
 * CR-009 §11.2 / ADR-28：AI 原位协作（In-context Copilot）契约校验与集中端真实 HTTP 闭环验证。
 */

const gatewayOrigin = "https://llm-gateway.corp.invalid";
const tokenAlice = "synthetic-alice-model-token-123456";
const tokenBob = "synthetic-bob-model-token-654321";
const masterKeyHex = "ab".repeat(32);

describe("ADR-28 validateFormPatchProposal 纯契约校验", () => {
  it("空字段走 fill_empty、已手工编辑字段走 propose_replace、事实字段与越权字段被拦截", () => {
    const proposal = validateFormPatchProposal({
      proposalId: "prop_1",
      role: "FB",
      readOnly: false,
      currentForm: {
        formId: "create_story",
        tool: "create_story",
        revision: 2,
        fields: { title: "用户手写标题", "spec.scope": "" },
        userEditedFields: ["title"],
      },
      targetFormId: "create_story",
      targetTool: "create_story",
      baseRevision: 2,
      candidates: [
        { field: "title", value: "AI 改写标题", rationale: "润色标题" },
        { field: "spec.scope", value: "按二级部门导出", rationale: "补全范围" },
        { field: "verify", value: "导出结果与筛选一致", rationale: "补全验收" },
        {
          field: "backfilled.actualStartedAt",
          value: "2026-11-20",
          rationale: "伪造事实日期",
        },
        { field: "plan", value: "22", rationale: "FB 未授权字段" },
      ],
    });
    expect(proposal.patches).toEqual([
      {
        field: "title",
        value: "AI 改写标题",
        rationale: "润色标题",
        mode: "propose_replace",
      },
      {
        field: "spec.scope",
        value: "按二级部门导出",
        rationale: "补全范围",
        mode: "fill_empty",
      },
      {
        field: "verify",
        value: "导出结果与筛选一致",
        rationale: "补全验收",
        mode: "fill_empty",
      },
    ]);
    expect(proposal.warnings.some((w) => w.includes("actualStartedAt"))).toBe(
      true,
    );
    expect(proposal.warnings.some((w) => w.includes("plan"))).toBe(true);
    expect(proposal.missingFields).toEqual(
      expect.arrayContaining(["product", "module"]),
    );
  });

  it("版本号失配、只读模式或职责无权编辑表单均被拒绝", () => {
    const base = {
      proposalId: "prop_2",
      currentForm: {
        formId: "create_story",
        tool: "create_story" as const,
        revision: 3,
        fields: {},
        userEditedFields: [],
      },
      targetFormId: "create_story",
      targetTool: "create_story" as const,
      candidates: [{ field: "title", value: "t", rationale: "r" }],
    };
    expect(() =>
      validateFormPatchProposal({
        ...base,
        role: "RD",
        readOnly: false,
        baseRevision: 2,
      }),
    ).toThrow(/迟到|更新/u);
    expect(() =>
      validateFormPatchProposal({
        ...base,
        role: "RD",
        readOnly: true,
        baseRevision: 3,
      }),
    ).toThrow(/只读/u);
    expect(() =>
      validateFormPatchProposal({
        ...base,
        role: "RM",
        readOnly: false,
        baseRevision: 3,
      }),
    ).toThrow(/无权/u);
  });

  it("parseModelPatchOutput 可解析代码块 JSON 并安全忽略非结构化文本", () => {
    const ok = parseModelPatchOutput(
      '```json\n{"summary":"已补全","patches":[{"field":"title","value":"导出功能"}]}\n```',
    );
    expect(ok.summary).toBe("已补全");
    expect(ok.patches).toHaveLength(1);
    expect(parseModelPatchOutput("普通自由文本不含 JSON")).toEqual({
      ok: false,
      patches: [],
      missingFields: [],
    });
  });
});

describe("集中端 /api/ai/* 个人网关隔离与原位协作端到端闭环", () => {
  const fixture = useServerFixture();

  async function startAiServer(
    options: {
      readOnly?: boolean;
      withMasterKey?: boolean;
      aiTransport?: ModelTransport;
    } = {},
  ) {
    const keyFile = join(fixture.root(), "ai-master.key");
    if (options.withMasterKey !== false) {
      await writeFile(keyFile, masterKeyHex, "utf8");
    }
    return fixture.start(
      {
        readOnly: options.readOnly ?? false,
        ai: {
          enabled: true,
          ...(options.withMasterKey !== false
            ? { masterKeyFile: keyFile }
            : {}),
          allowedGateways: [
            {
              origin: gatewayOrigin,
              pathPrefix: "/v1",
              allowInsecure: false,
              allowPrivateNetwork: false,
            },
          ],
          timeoutMs: 5_000,
          maxTokens: 1024,
        },
      },
      {
        aiTransport: options.aiTransport,
      },
    );
  }

  it("D-203：缺少独立主密钥时仅禁用 AI，人工业务工作台 100% 正常运行", async () => {
    const server = await startAiServer({ withMasterKey: false });
    const alice = browser(server);
    const sessionRes = await login(alice, "instanceA", "alice");
    expect(sessionRes.body).toMatchObject({
      ai: {
        enabled: true,
        available: false,
        configured: false,
        verified: false,
      },
    });

    const cfg = await alice.send("/api/ai/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ enabled: true, available: false });

    const copilotRes = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "查一下 #101 进展",
      context: { view: "workbench" },
    });
    expect(copilotRes.status).toBe(400);
    expect(copilotRes.body).toMatchObject({
      ok: false,
      code: "CONFIG_MISSING",
    });

    // 人工业务工作台完全不受影响。
    const humanReport = await alice.call(report);
    expect(humanReport.status).toBe(200);
  });

  it("MG-01 / MG-02：双用户个人 Token 隔离、白名单拦截，未配置/未验证连 L1 规则也不放行且不注销业务会话", async () => {
    const seenTokens: string[] = [];
    const transport: ModelTransport = {
      async send(req) {
        seenTokens.push(req.token);
        return {
          kind: "ok",
          text: JSON.stringify({
            summary: "已为您补全范围与验收标准",
            patches: [
              { field: "title", value: "AI 建议新标题", rationale: "提炼标题" },
              {
                field: "spec.scope",
                value: "审批清单导出新增二级部门筛选条件",
                rationale: "明确范围",
              },
              {
                field: "verify",
                value: "1. 按二级部门筛选结果准确；2. 无越权数据。",
                rationale: "可测验收",
              },
              {
                field: "backfilled.actualStartedAt",
                value: "2026-11-20",
                rationale: "违规事实字段",
              },
            ],
          }),
        };
      },
    };
    const server = await startAiServer({ aiTransport: transport });
    const alice = browser(server);
    const bob = browser(server);
    await login(alice, "instanceA", "alice");
    await login(bob, "instanceA", "bob");

    // 1. 非白名单地址保存被拒绝且零出站。
    const badSave = await alice.send("/api/ai/config", {
      baseUrl: "https://evil.invalid/v1",
      protocol: "openai-compatible",
      modelId: "m1",
      token: tokenAlice,
    });
    expect(badSave.status).toBe(403);
    expect(seenTokens).toHaveLength(0);

    // 2. alice 保存并验证个人网关；响应与日志中零明文 Token。
    const saved = await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenAlice,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(tokenAlice);
    expect(saved.body).toMatchObject({
      ok: true,
      masked: { configured: true, verified: false, tokenHint: "••••3456" },
    });

    // 保存后未测试连接：即便 L1 规则查询也必须被拒绝（AUTH_FAILED），且业务会话保持有效。
    const unverifiedCall = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "看下 #101 进展",
      context: { view: "workbench" },
    });
    expect(unverifiedCall.status).toBe(401);
    expect(unverifiedCall.body).toMatchObject({
      ok: false,
      code: "AUTH_FAILED",
    });
    expect((await alice.send("/api/session")).status).toBe(200);

    // 测试连接通过。
    const tested = await alice.send("/api/ai/config/test", {});
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true, masked: { verified: true } });

    // 3. bob 未配置时零回退到 alice 凭据，直接返回 CONFIG_MISSING。
    const bobCfg = await bob.send("/api/ai/config");
    expect(bobCfg.body).toMatchObject({ masked: { configured: false } });
    const bobCall = await bob.send("/api/ai/copilot", {
      role: "RM",
      prompt: "看下 #101 进展",
      context: { view: "workbench" },
    });
    expect(bobCall.status).toBe(400);
    expect(bobCall.body).toMatchObject({ ok: false, code: "CONFIG_MISSING" });

    // 4. alice 在正式「提出需求」表单中（RD 具备 create_story）执行原位协作：
    // 空字段 fill_empty，已手写 title 走 propose_replace，事实字段被剔除。
    const formTurn = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "按运营审批导出诉求补全表单",
      context: {
        view: "intake",
        form: {
          formId: "create_story",
          tool: "create_story",
          revision: 1,
          fields: { title: "审批导出手写标题" },
          userEditedFields: ["title"],
        },
      },
    });
    expect(formTurn.status).toBe(200);
    expect(formTurn.body).toMatchObject({
      ok: true,
      kind: "form_patch",
      routeSource: "in_context",
      proposal: {
        formId: "create_story",
        tool: "create_story",
        baseRevision: 1,
      },
    });
    const proposal = (
      formTurn.body as {
        proposal: {
          patches: Array<{ field: string; mode: string }>;
          warnings: string[];
        };
      }
    ).proposal;
    expect(proposal.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title", mode: "propose_replace" }),
        expect.objectContaining({ field: "spec.scope", mode: "fill_empty" }),
        expect.objectContaining({ field: "verify", mode: "fill_empty" }),
      ]),
    );
    expect(proposal.warnings.some((w) => w.includes("actualStartedAt"))).toBe(
      true,
    );

    // 5. RM 职责无 create_story 权限：在调用模型前即被 403 拒绝（零模型出站）。
    const callsBeforeRm = seenTokens.length;
    const rmBlocked = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "帮我填表单",
      context: {
        view: "intake",
        form: {
          formId: "create_story",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(rmBlocked.status).toBe(403);
    expect(seenTokens.length).toBe(callsBeforeRm);

    // 6. 自然语言从台账发起提需：返回 open_form_patch 打开同一正式表单。
    const nlLaunch = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "帮我提一个需求：审批清单支持按二级部门导出",
      context: { view: "workbench" },
    });
    expect(nlLaunch.status).toBe(200);
    expect(nlLaunch.body).toMatchObject({
      ok: true,
      kind: "open_form_patch",
      openForm: { section: "intake", tool: "create_story" },
    });

    // 7. 真实业务查询经 CapabilityRuntime(channel="ai") 执行并返回假禅道 #101。
    const queryTurn = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "查看 #101 进展",
      context: { view: "workbench", selectedStoryId: 101 },
    });
    expect(queryTurn.status).toBe(200);
    expect(queryTurn.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "get_story_progress",
      untrusted: true,
    });

    // 全链路日志与响应扫描：零明文 Token 泄漏。
    expect(fixture.logs.join("\n")).not.toContain(tokenAlice);
    expect(fixture.logs.join("\n")).not.toContain(tokenBob);
  });

  it("在途 Token 轮换或撤权时，AI 响应交付被阻断", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sendSpy = vi.fn<ModelTransport["send"]>(async () => {
      // 首次探活立即返回 ok，第二次原位协作挂起以模拟在途轮换。
      if (sendSpy.mock.calls.length === 1) {
        return { kind: "ok", text: "pong" };
      }
      started.resolve();
      await release.promise;
      return {
        kind: "ok",
        text: JSON.stringify({
          summary: "ok",
          patches: [{ field: "title", value: "不应交付", rationale: "r" }],
        }),
      };
    });
    const server = await startAiServer({ aiTransport: { send: sendSpy } });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenAlice,
    });
    expect((await alice.send("/api/ai/config/test", {})).status).toBe(200);

    const inflight = alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "补全需求表单",
      context: {
        view: "intake",
        form: {
          formId: "create_story",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    await started.promise;

    // 在途轮换个人 Token：旧请求返回时必须被 401 阻断，不交付旧结果。
    await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenBob,
    });
    release.resolve();

    const blocked = await inflight;
    expect(blocked.status).toBe(401);
    expect(blocked.body).toMatchObject({ ok: false, code: "AUTH_FAILED" });
  });

  it("readOnly=true 时阻断表单补丁请求且不外发模型调用，同时允许只读查询", async () => {
    const sendSpy = vi.fn(async () => ({ kind: "ok" as const, text: "pong" }));
    const server = await startAiServer({
      readOnly: true,
      aiTransport: { send: sendSpy },
    });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenAlice,
    });
    expect((await alice.send("/api/ai/config/test", {})).status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 1. 只读模式下，写表单补丁在调用 LLM 前被明确拒绝（不外发任何模型请求）。
    const denied = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "帮我补全需求表单",
      context: {
        view: "intake",
        form: {
          formId: "create_story",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 2. 只读模式下，只读查询（通过 CapabilityRuntime channel="ai"）仍正常工作。
    const readRes = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "查 #101 进展",
      context: { view: "workbench" },
    });
    expect(readRes.status).toBe(200);
    expect(readRes.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "get_story_progress",
      untrusted: true,
    });
  });

  it("P1-2 & P1-3 & P2-5：实例白名单交集收窄、换网关禁止沿用旧 Token、磁盘凭据物理隔离与主密钥失配提示", async () => {
    const keyFile = join(fixture.root(), "ai-master-iso.key");
    await writeFile(keyFile, masterKeyHex, "utf8");
    const dataDir = join(fixture.root(), "server-iso-data");
    const server = await fixture.start(
      {
        dataDir,
        readOnly: false,
        ai: {
          enabled: true,
          masterKeyFile: keyFile,
          allowedGateways: [
            {
              origin: gatewayOrigin,
              pathPrefix: "/v1/team",
              allowInsecure: false,
              allowPrivateNetwork: false,
            },
          ],
          timeoutMs: 5_000,
          maxTokens: 1024,
        },
        instances: {
          instanceA: {
            name: "实例 A",
            baseUrl: fixture.upstream().instances.instanceA.baseUrl,
            teamConfigPath: join(fixture.root(), "instanceA.json"),
            // 试图把 /v1/team 放宽为 /v1：必须被交集收窄回 /v1/team！
            ai: {
              allowedGateways: [
                {
                  origin: gatewayOrigin,
                  pathPrefix: "/v1",
                  allowInsecure: false,
                  allowPrivateNetwork: false,
                },
              ],
            },
          },
          instanceB: {
            name: "实例 B",
            baseUrl: fixture.upstream().instances.instanceB.baseUrl,
            teamConfigPath: join(fixture.root(), "instanceB.json"),
          },
        },
      },
      {
        aiTransport: { send: async () => ({ kind: "ok", text: "pong" }) },
      },
    );

    const aliceA = browser(server);
    const bobA = browser(server);
    const aliceB = browser(server);
    await login(aliceA, "instanceA", "alice");
    await login(bobA, "instanceA", "bob");
    await login(aliceB, "instanceB", "alice");

    // 尝试用被放宽的路径 /v1（超出全局 /v1/team）必须被拒绝。
    const widened = await aliceA.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenAlice,
    });
    expect(widened.status).toBe(403);

    // 三个主体分别在合法路径 /v1/team 下保存独立凭据。
    expect(
      (
        await aliceA.send("/api/ai/config", {
          baseUrl: gatewayOrigin + "/v1/team",
          protocol: "openai-compatible",
          modelId: "corp-gpt",
          token: tokenAlice,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await bobA.send("/api/ai/config", {
          baseUrl: gatewayOrigin + "/v1/team",
          protocol: "openai-compatible",
          modelId: "corp-gpt",
          token: tokenBob,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await aliceB.send("/api/ai/config", {
          baseUrl: gatewayOrigin + "/v1/team",
          protocol: "openai-compatible",
          modelId: "corp-gpt",
          token: "synthetic-alice-b-token-778899",
        })
      ).status,
    ).toBe(200);

    // P1-2：更换 Base URL 或协议时省略 Token 必须被拒绝（防止旧 Token 迁移到新目的地）。
    const migrateUrl = await aliceA.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1/team/sub",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
    });
    expect(migrateUrl.status).toBe(400);
    const migrateProto = await aliceA.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1/team",
      protocol: "anthropic-compatible",
      modelId: "corp-gpt",
    });
    expect(migrateProto.status).toBe(400);
    // 仅更换 modelId 允许保留现有加密 Token（且重置 verified=false）。
    const renameModel = await aliceA.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1/team",
      protocol: "openai-compatible",
      modelId: "corp-gpt-v2",
    });
    expect(renameModel.status).toBe(200);

    // P1-3：检查磁盘上每个凭据文件均只含 1 条本人记录，绝无其他账号/实例密文混存！
    const credRoot = join(dataDir, "ai-credentials");
    const instanceDirs = await readdir(credRoot);
    expect(instanceDirs.length).toBe(2);
    let totalFiles = 0;
    for (const dir of instanceDirs) {
      const files = await readdir(join(credRoot, dir));
      for (const f of files) {
        totalFiles += 1;
        const parsed = JSON.parse(
          await readFile(join(credRoot, dir, f), "utf8"),
        ) as { records: Record<string, unknown> };
        expect(Object.keys(parsed.records)).toHaveLength(1);
      }
    }
    expect(totalFiles).toBe(3);

    // P2-5：若用不同主密钥打开同一数据目录，getMasked 必须立即暴露 verified=false 与 MASTER_KEY_MISMATCH。
    const wrongStore = createPersonalModelStore({
      masterKey: Buffer.from("cd".repeat(32), "hex"),
      dataDir,
    });
    const instHashA = instanceDirs[0]!;
    const firstFile = (await readdir(join(credRoot, instHashA)))[0]!;
    const firstKey = Object.keys(
      (
        JSON.parse(
          await readFile(join(credRoot, instHashA, firstFile), "utf8"),
        ) as { records: Record<string, unknown> }
      ).records,
    )[0]!;
    const [ih, acct] = firstKey.split("\n");
    expect(
      wrongStore.getMasked({ instanceHash: ih!, account: acct! }),
    ).toMatchObject({
      configured: true,
      verified: false,
      lastErrorCode: "MASTER_KEY_MISMATCH",
    });

    // 删除 bobA 配置后，磁盘上不再保留 bobA 的凭据文件。
    expect((await bobA.send("/api/ai/config/delete", {})).status).toBe(200);
    let remainingFiles = 0;
    for (const dir of await readdir(credRoot)) {
      remainingFiles += (await readdir(join(credRoot, dir))).length;
    }
    expect(remainingFiles).toBe(2);
  });

  it("P1-4 & P1-5 & P1-6：探活在途登出不落盘已验证、出站字段白名单投影、凭据回显拦截与表单 untrusted=true", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let probeAborted = false;
    let capturedUserPrompt = "";
    let callIdx = 0;
    const sendSpy = vi.fn<ModelTransport["send"]>(async (req) => {
      callIdx += 1;
      // 第 1 次：探活在途登出测试
      if (callIdx === 1) {
        req.abortSignal?.addEventListener("abort", () => {
          probeAborted = true;
        });
        started.resolve();
        await release.promise;
        return { kind: "ok", text: "pong" };
      }
      // 第 2 次：重新登录后正常探活
      if (callIdx === 2) {
        return { kind: "ok", text: "pong" };
      }
      // 第 3 次：表单补丁测试，检查出站字段已剥离白名单外字段，返回合法补丁
      if (callIdx === 3) {
        const body = req.body as { messages: Array<{ content: string }> };
        capturedUserPrompt = body.messages[1]?.content ?? "";
        return {
          kind: "ok",
          text: JSON.stringify({
            summary: "已按最小上下文补全",
            patches: [
              { field: "spec.scope", value: "仅导出部门数据", rationale: "r" },
            ],
          }),
        };
      }
      // 第 4 次：模拟恶意/错误网关在成功响应中回显个人 Token -> 必须被网关拦截！
      return {
        kind: "ok",
        text: `{"summary":"echo ${tokenAlice}","patches":[]}`,
      };
    });

    const server = await startAiServer({ aiTransport: { send: sendSpy } });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: tokenAlice,
    });

    // 1. 在途探活期间登出：必须中止传输且不写入 verified=true！
    const inflightProbe = alice.send("/api/ai/config/test", {});
    await started.promise;
    await alice.send("/api/logout", {});
    release.resolve();
    const probeRes = await inflightProbe;
    expect(probeAborted).toBe(true);
    expect(probeRes.status).toBe(401);

    // 重新登录验证 config 仍为 verified=false。
    await login(alice, "instanceA", "alice");
    const cfgAfter = await alice.send("/api/ai/config");
    expect(cfgAfter.body).toMatchObject({
      masked: { configured: true, verified: false },
    });

    // 2. 正常探活通过后，发起表单原位请求（携带额外未授权字段 secretField 与事实字段）。
    expect((await alice.send("/api/ai/config/test", {})).status).toBe(200);
    const patchRes = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "补全实现范围",
      context: {
        view: "intake",
        form: {
          formId: "create_story:1",
          tool: "create_story",
          revision: 1,
          fields: {
            title: "正常标题",
            "backfilled.actualStartedAt": "2026-11-01",
            internalSecret: "SHOULD-NOT-LEAVE-SERVER",
          },
          userEditedFields: ["title"],
        },
      },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({
      ok: true,
      kind: "form_patch",
      untrusted: true,
      proposal: {
        formId: "create_story:1",
        contextBinding: expect.any(String),
      },
    });
    expect(capturedUserPrompt).not.toContain("SHOULD-NOT-LEAVE-SERVER");
    expect(capturedUserPrompt).not.toContain("actualStartedAt");

    // 校验纯投影函数同样剥离事实/越权字段。
    expect(
      projectOutboundFormFields("create_story", "FB", {
        title: "ok",
        plan: "22",
        "backfilled.actualStartedAt": "2026-11-01",
      }),
    ).toEqual({ title: "ok" });

    // 3. 目标绑定型表单缺少 targetObjectId 时，在调用 LLM 前被拦截！
    const missingTarget = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "帮我填指派",
      context: {
        view: "stories",
        form: {
          formId: "assign_story:1",
          tool: "assign_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(missingTarget.status).toBe(403);

    // 4. 上游成功响应回显个人 Token（含原文及 JSON Unicode 转义）时均被 ModelGateway 拦截，绝不透传给前端！
    const echoBlocked = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "再生成一次",
      context: {
        view: "intake",
        form: {
          formId: "create_story:1",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(echoBlocked.status).toBe(503);
    expect(JSON.stringify(echoBlocked.body)).not.toContain(tokenAlice);

    // 5. P2-4->P1：自然语言触发「扫一下本月流程风险」按 scan_workflow_risks 契约传入 scope.month 并成功返回！
    const riskScan = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "扫一下本月流程风险",
      context: { view: "workbench" },
    });
    expect(riskScan.status).toBe(200);
    expect(riskScan.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "scan_workflow_risks",
      untrusted: true,
      toolResult: { ok: true },
    });

    // 6. P1-5：storyIds 与 targetObjectId 不一致时在调用 LLM 前被拦截，超长值被拒绝而非截断！
    const mismatchIds = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "帮我填指派",
      context: {
        view: "stories",
        selectedStoryId: 101,
        form: {
          formId: "assign_story:1",
          tool: "assign_story",
          targetObjectId: 101,
          revision: 1,
          fields: { storyIds: "101, 102" },
          userEditedFields: [],
        },
      },
    });
    expect(mismatchIds.status).toBe(409);

    const oversized = validateFormPatchProposal({
      proposalId: "prop_over",
      role: "RD",
      readOnly: false,
      currentForm: {
        formId: "create_story:1",
        tool: "create_story",
        revision: 1,
        fields: {},
        userEditedFields: [],
      },
      targetFormId: "create_story:1",
      targetTool: "create_story",
      baseRevision: 1,
      candidates: [
        { field: "spec.scope", value: "a".repeat(4001), rationale: "oversize" },
      ],
    });
    expect(oversized.patches).toHaveLength(0);
    expect(oversized.warnings.length).toBeGreaterThan(0);
  });

  it("P1-6 & P1-4：JSON 转义编码、5 字符短 Token 回显均被拦截，且台账不返回空 filters", async () => {
    const { containsCredentialLeak } =
      await import("../../src/services/ai/model-gateway.ts");
    const escaped = `\\u0073${tokenAlice.slice(1)}`;
    expect(
      containsCredentialLeak(
        JSON.stringify({ summary: "ok" }).replace(
          '"ok"',
          `"prefix ${escaped}"`,
        ),
        tokenAlice,
      ),
    ).toBe(true);

    // 5 字符短 Token 在 containsCredentialLeak 中直接被拦截，且 HTTP 配置要求最少 8 位；
    // 8 位最小合法 Token 在端到端 Copilot 响应回显时同样被拦截且零泄露。
    expect(containsCredentialLeak("echo tk987 here", "tk987")).toBe(true);
    const minToken = "tk987654";
    let step = 0;
    const server = await startAiServer({
      aiTransport: {
        send: async () => {
          step += 1;
          if (step === 1) return { kind: "ok", text: "pong" };
          return {
            kind: "ok",
            text: JSON.stringify({
              summary: `泄露短令牌 ${minToken}`,
              patches: [],
            }),
          };
        },
      },
    });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    const tooShort = await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: "tk987",
    });
    expect(tooShort.status).toBe(400);
    const savedMin = await alice.send("/api/ai/config", {
      baseUrl: gatewayOrigin + "/v1",
      protocol: "openai-compatible",
      modelId: "corp-gpt",
      token: minToken,
    });
    expect(savedMin.status).toBe(200);
    expect((await alice.send("/api/ai/config/test", {})).status).toBe(200);
    const blocked = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "补全表单",
      context: {
        view: "intake",
        form: {
          formId: "create_story:1",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(blocked.status).toBe(503);
    expect(JSON.stringify(blocked.body)).not.toContain(minToken);

    // P1-4：含「逾期」「阻塞」「巡检 2026-11」的问法（即便带 selectedStoryId: 101）均正确进入风险扫描，
    // 且逾期/阻塞聚焦对应规则并给出类别过滤说明，不误查需求 #101。
    const overdueDev = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "只看研发逾期需求",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(overdueDev.status).toBe(200);
    expect(overdueDev.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "scan_workflow_risks",
      summary: expect.stringContaining("暂不支持按「研发/设计」类别二次筛选"),
    });

    const overdueAll = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "所有逾期需求",
      month: "2026-12",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(overdueAll.status).toBe(200);
    expect(overdueAll.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "scan_workflow_risks",
      toolResult: {
        scope: {
          filters: {
            rules: ["R01"],
          },
        },
      },
    });

    const blockedDev = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "扫描研发阻塞需求",
      month: "2026-12",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(blockedDev.status).toBe(200);
    expect(blockedDev.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "scan_workflow_risks",
      toolResult: {
        scope: {
          filters: {
            rules: ["R02", "R03", "R04"],
          },
        },
      },
    });

    const patrolMonth = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "巡检 2026-11",
      month: "2026-12",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(patrolMonth.status).toBe(200);
    expect(patrolMonth.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "scan_workflow_risks",
      toolResult: {
        scope: {
          filters: {
            month: "2026-11",
          },
        },
      },
    });

    // 完整可执行的台账筛选（如「只看未就绪的设计需求」）正常返回 filter_suggestion。
    const validFilter = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "只看未就绪的设计需求",
      context: { view: "stories" },
    });
    expect(validFilter.status).toBe(200);
    expect(validFilter.body).toMatchObject({
      ok: true,
      kind: "filter_suggestion",
      filters: { progress: "未就绪", category: "design" },
    });

    // P2：1-2 字节短凭据的 Base64URL 形式同样被 containsCredentialLeak 拦截。
    expect(containsCredentialLeak("leak YWI end", "ab")).toBe(true);
  });

  it("M3 收口：真实 /api/ai/copilot 接入 L3 模型分类兜底、L1 零冗余调用、选中对象不误劫持及降级如实提示", async () => {
    const modelCalls: string[] = [];
    const server = await startAiServer({
      aiTransport: {
        send: async (req) => {
          const userMsg = JSON.stringify(req.body ?? "");
          modelCalls.push(userMsg);
          if (userMsg.includes('"ping"')) return { kind: "ok", text: "pong" };
          if (userMsg.includes("最近有哪些活儿压在我手上")) {
            return {
              kind: "ok",
              text: JSON.stringify({
                kind: "label",
                intent: "my_work",
                confidence: "medium",
              }),
            };
          }
          if (userMsg.includes("帮我订机票") || userMsg.includes("航班")) {
            return {
              kind: "ok",
              text: JSON.stringify({
                kind: "unsupported",
                reason: "差旅订票不在研发协作工作台支持范围内。",
              }),
            };
          }
          if (
            userMsg.includes("顺便") ||
            (userMsg.includes("新建需求") && userMsg.includes("#101")) ||
            (userMsg.includes("只看研发需求") && userMsg.includes("#101"))
          ) {
            return {
              kind: "ok",
              text: JSON.stringify({
                kind: "ambiguous",
                question: "您同时提到了多个独立目标，请问先处理哪一项？",
              }),
            };
          }
          if (userMsg.includes("无需修改表单")) {
            return {
              kind: "ok",
              text: JSON.stringify({ patches: [] }),
            };
          }
          if (userMsg.includes("越权删除")) {
            return {
              kind: "ok",
              text: JSON.stringify({
                kind: "label",
                intent: "confirm_operation",
                confidence: "high",
              }),
            };
          }
          if (userMsg.includes("新开一个诉求单")) {
            return {
              kind: "ok",
              text: JSON.stringify({
                kind: "label",
                intent: "draft_story",
                confidence: "medium",
              }),
            };
          }
          if (userMsg.includes("乱码输出")) {
            return {
              kind: "ok",
              text: "这是一段非 JSON 自由文本，不包含任何结构化字段。",
            };
          }
          return {
            kind: "ok",
            text: JSON.stringify({
              summary: "已按诉求整理需求草稿",
              patches: [
                {
                  field: "title",
                  value: "新增导出报表功能",
                  rationale: "提炼需求标题",
                },
              ],
              missingFields: ["product", "module"],
            }),
          };
        },
      },
    });

    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    expect(
      (
        await alice.send("/api/ai/config", {
          baseUrl: gatewayOrigin + "/v1",
          protocol: "openai-compatible",
          modelId: "corp-gpt",
          token: tokenAlice,
        })
      ).status,
    ).toBe(200);
    expect((await alice.send("/api/ai/config/test", {})).status).toBe(200);
    modelCalls.length = 0;

    // 1. 明确规则命中（L1 短路）：零模型调用。
    const l1Hit = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "我今天的工作待办",
      context: { view: "workbench" },
    });
    expect(l1Hit.status).toBe(200);
    expect(l1Hit.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "get_my_work",
      routeSource: "l1",
    });
    expect(modelCalls).toHaveLength(0);

    // 2. 关键词未命中的同义表达 + 页面已选中需求 #101：不被 selectedStoryId 劫持，走 L3 模型分类到 my_work。
    const l3Synonym = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "最近有哪些活儿压在我手上",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(l3Synonym.status).toBe(200);
    expect(l3Synonym.body).toMatchObject({
      ok: true,
      kind: "tool_result",
      tool: "get_my_work",
      routeSource: "l3",
      untrusted: true,
    });
    expect(modelCalls).toHaveLength(1);

    // 3. 选中对象下的不支持请求：不被劫持进 story_progress，L3 返回 rejection。
    const unsupported = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "帮我订机票",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(unsupported.status).toBe(200);
    expect(unsupported.body).toMatchObject({
      ok: true,
      kind: "rejection",
      routeSource: "l3",
      summary: expect.stringContaining("不在研发协作工作台支持范围内"),
    });

    // 4. 多意图请求（含提需+待办、筛选+待办、待办+风险）：均不被提前截断，交 L3 澄清。
    const multiIntent = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "看我的待办顺便扫一下风险",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(multiIntent.status).toBe(200);
    expect(multiIntent.body).toMatchObject({
      ok: true,
      kind: "clarification",
      routeSource: "l3",
    });

    const multiIntake = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "新建需求：增加导出，顺便查一下我的待办",
      context: { view: "workbench" },
    });
    expect(multiIntake.status).toBe(200);
    expect(multiIntake.body).toMatchObject({
      ok: true,
      kind: "clarification",
      routeSource: "l3",
    });

    const multiFilter = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "只看研发需求，顺便查一下我的待办",
      context: { view: "stories" },
    });
    expect(multiFilter.status).toBe(200);
    expect(multiFilter.body).toMatchObject({
      ok: true,
      kind: "clarification",
      routeSource: "l3",
    });

    // 4b. 选中需求 #101 后，含「当前」或裸数字的无关状态查询（如「帮我查当前航班 123 什么状态」）：
    //     不被 L1 劫持进 story_progress，经 L3 拒识；含 #101 进展的多意图也不被提需/筛选截断。
    const unrelatedStatus = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "帮我查当前航班 123 现在什么状态",
      context: { view: "stories", selectedStoryId: 101 },
    });
    expect(unrelatedStatus.status).toBe(200);
    expect(unrelatedStatus.body).toMatchObject({
      ok: true,
      kind: "rejection",
      routeSource: "l3",
    });

    const multiIntakeProgress = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "新建需求：增加导出，查看 #101 的进展",
      context: { view: "workbench" },
    });
    expect(multiIntakeProgress.status).toBe(200);
    expect(multiIntakeProgress.body).toMatchObject({
      ok: true,
      kind: "clarification",
      routeSource: "l3",
    });

    const validEmptyPatch = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "无需修改表单，确认是否完整",
      context: {
        view: "intake",
        form: {
          formId: "create_story:100",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(validEmptyPatch.status).toBe(200);
    expect(validEmptyPatch.body).toMatchObject({
      ok: true,
      kind: "form_patch",
      summary: expect.stringContaining("未发现需要调整的表单字段"),
      proposal: { patches: [] },
    });

    // 5. 模型输出越权动作（confirm_operation）：严禁执行，返回 rejection。
    const privEsc = await alice.send("/api/ai/copilot", {
      role: "RM",
      prompt: "帮我越权删除",
      context: { view: "stories" },
    });
    expect(privEsc.status).toBe(200);
    expect(privEsc.body).toMatchObject({
      ok: true,
      kind: "rejection",
      routeSource: "l3",
      summary: expect.stringContaining("不在当前允许的业务意图范围内"),
    });

    // 6. L3 分类为 draft_story：打开正式 create_story 表单草稿，不落入 query_stories。
    const l3Draft = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "新开一个诉求单：需要支持导出报表",
      context: { view: "workbench" },
    });
    expect(l3Draft.status).toBe(200);
    expect(l3Draft.body).toMatchObject({
      ok: true,
      kind: "open_form_patch",
      routeSource: "l3",
      openForm: { section: "intake", tool: "create_story" },
    });

    // 7. 表单拟稿模型输出不可解析时：如实提示规则降级，且不编造泛化验收标准。
    const degraded = await alice.send("/api/ai/copilot", {
      role: "RD",
      prompt: "帮我补全乱码输出场景的需求草稿",
      context: {
        view: "intake",
        form: {
          formId: "create_story:99",
          tool: "create_story",
          revision: 1,
          fields: {},
          userEditedFields: [],
        },
      },
    });
    expect(degraded.status).toBe(200);
    expect(degraded.body).toMatchObject({
      ok: true,
      kind: "form_patch",
      summary: expect.stringContaining("无法解析"),
      proposal: {
        warnings: expect.arrayContaining([
          expect.stringContaining("降级按规则提取"),
        ]),
      },
    });
    const degradedPatches = (
      degraded.body as { proposal: { patches: { field: string }[] } }
    ).proposal.patches;
    expect(degradedPatches.some((p) => p.field === "verify")).toBe(false);
  });
});
