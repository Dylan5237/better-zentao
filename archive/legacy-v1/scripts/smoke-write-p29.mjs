import assert from "node:assert/strict";
import { createBetterZentao, resolveConfig, ZentaoCreateUnconfirmedError } from "../dist/index.js";

const productId = 29;
const module = 564;

async function verify() {
  const { baseUrl, timeoutMs } = resolveConfig();
  const title = "Phase 1 受控写冒烟 " + new Date().toISOString();
  let candidateId;
  let ownedId;
  let attempted = false;
  const guardedFetch = (url, options) => {
    const request = new URL(url);
    const method = options?.method ?? "GET";
    const target = request.href;
    const createV1 = target === baseUrl + "/api.php/v1/products/29/stories";
    const createV2 = target === baseUrl + "/api.php/v2/stories?productID=29";
    const assign = ownedId !== undefined && target === baseUrl + "/api.php/v1/stories/" + ownedId + "/assign";
    const remove = ownedId !== undefined && target === baseUrl + "/api.php/v1/stories/" + ownedId;
    const login = target === baseUrl + "/api.php/v1/tokens";
    if (method === "POST" && (createV1 || createV2)) {
      const body = JSON.parse(options.body);
      assert(!attempted && body.module === module && body.title === title, "创建超出本次 #29 单条范围");
      attempted = true;
    } else if (!(method === "GET" && target.startsWith(baseUrl + "/")) &&
      !(method === "POST" && (login || assign)) && !(method === "DELETE" && remove)) {
      throw new Error("拦截超出本次 #29 冒烟范围的请求");
    }
    return fetch(url, { ...options, redirect: "error" });
  };
  const platform = await guardedFetch(baseUrl + "/index.php?mode=getconfig", { signal: AbortSignal.timeout(timeoutMs) });
  assert(platform.ok && (await platform.json()).version === "22.6", "目标接口未确认是禅道 22.6");
  const client = createBetterZentao({ fetchImpl: guardedFetch });
  const user = await client.directory.currentUser();
  const fields = {
    product: productId, module, title, category: "feature", mode: "personal", assignTo: user.account,
    spec: "<p>仅用于回读和软删除验证。</p>", verify: "<p>核对创建字段、负责人和软删除状态。</p>",
    feedbackBy: "自动验证样例", source: "user",
  };
  const preview = await client.intake.createStory({ ...fields, dryRun: true });
  assert(preview.dryRun && preview.allOk && preview.drafts[0].product.id === productId &&
    preview.drafts[0].resolvedModule?.id === module, "#29 / 564 创建预检未通过");
  let verifiedAssign = false;
  try {
    const result = await client.intake.createStory({ ...fields, dryRun: false });
    const receipt = result.results?.[0];
    candidateId = receipt?.id;
    assert(receipt?.readbackConfirmed && candidateId, "TC-LIVE-06 创建与回读未确认");
    const readback = await client.api.stories.get(candidateId);
    assert(readback.productId === productId && readback.title === title && readback.moduleId === module &&
      readback.category === fields.category && readback.status === "draft" && readback.feedbackBy === fields.feedbackBy,
      "TC-LIVE-06 回读字段不一致");
    ownedId = candidateId;
    console.log("TC-LIVE-06 PASS #29 单条创建与字段回读", candidateId);
    const assign = await client.intake.assignStory({ storyId: candidateId, assignedTo: user.account });
    assert(assign.confirmed, "TC-LIVE-07 指派未回读确认");
    await assert.rejects(client.intake.deleteStory({ storyId: candidateId }), { code: "INVALID_PARAM" });
    verifiedAssign = true;
  } catch (error) {
    if (error instanceof ZentaoCreateUnconfirmedError) candidateId ??= error.id;
    throw error;
  } finally {
    if (candidateId && ownedId === undefined) {
      const readback = await client.api.stories.get(candidateId).catch(() => null);
      if (readback?.productId === productId && readback.title === title && readback.moduleId === module) ownedId = candidateId;
      else console.error("请手工核查 #29 的候选 ID", candidateId, "标题", title);
    }
    if (ownedId !== undefined) {
      try {
        const deletion = await client.intake.deleteStory({ storyId: ownedId, confirm: true });
        assert(deletion.deleted, "软删除未回读确认");
        console.log(verifiedAssign ? "TC-LIVE-07 PASS 指派、删除守卫与软删除回读" : "已确认测试记录软删除", ownedId);
      } catch {
        console.error("请手工核查清理 #29 测试记录 ID", ownedId, "标题", title);
        process.exitCode = 1;
      }
    } else if (attempted && candidateId === undefined) {
      console.error("创建未返回 ID。请按标题核查 #29，禁止重试创建", title);
    }
  }
}

if (process.argv.length !== 3 || process.argv[2] !== "--confirm-product-29") {
  console.error("仅在获得本次明确批准后执行，并显式传入 --confirm-product-29。");
  process.exitCode = 2;
} else {
  try {
    await verify();
  } catch (error) {
    console.error("受控写冒烟未通过", error instanceof assert.AssertionError ? error.message : "请核查安全回执及清理状态");
    process.exitCode = 1;
  }
}
