import { runLocalSmoke } from "../test/fixtures/local-scenarios.mjs";

try {
  await runLocalSmoke();
} catch (error) {
  console.error("本地联调失败", error instanceof Error ? error.message : "未知错误");
  process.exitCode = 1;
}
