import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function publishPortalLaunch(
  homeDir: string,
  instanceId: string,
  launchUrl: string,
) {
  const url = URL.parse(launchUrl);
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.username ||
    url.password ||
    !/^#launch=[a-f0-9]{64}$/u.test(url.hash) ||
    !/^[a-f0-9]{32}$/u.test(instanceId)
  )
    throw new Error("本机门户启动地址不合法。");
  // The launcher passes only a file path to the OS browser, never the launch token.
  const dir = join(homeDir, ".better-zentao", "portal-launch");
  const path = join(dir, (url.port || "80") + ".html");
  const pending = path + "." + randomUUID() + ".tmp";
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="bzt-portal-instance" content="${instanceId}">
<meta name="referrer" content="no-referrer">
<title>打开禅道工作台</title>
<script>location.replace(${JSON.stringify(url.href)})</script>
<a href="${url.href}" rel="noreferrer">打开禅道工作台</a>
</html>
`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(pending, html, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true }).catch(() => undefined);
  }
}
