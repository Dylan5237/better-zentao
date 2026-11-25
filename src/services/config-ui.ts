import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ZentaoReadClient } from "../api/client.ts";
import { listUsers } from "../api/org.ts";
import { getProductModules, listProducts } from "../api/product.ts";
import {
  assertNoConfigCredentials,
  loadFileConfig,
  PROBE_PRODUCT_ID,
  teamConfigSchema,
  type ConfigEnv,
} from "../core/config.ts";
import { BztError } from "../core/errors.ts";

const missing = "未提供离线目录。";
const truncated = "目录分页未读完整。";
const failed = "目录读取失败。";
const gapSchema = z.object({
  source: z.string().regex(/^(?:products|users|modules:[1-9]\d*)$/u),
  reason: z.enum([missing, truncated, failed]),
});
const id = z.int().positive();
const directoryEntry = z.object({ id, name: z.string() });
const directorySchema = z.object({
  products: z.array(directoryEntry),
  modules: z.record(z.string().regex(/^[1-9]\d*$/u), z.array(directoryEntry)),
  users: z.array(
    z.object({
      account: z.string().regex(/\S/u),
      realname: z.string(),
      pinyin: z.string().nullable(),
      dept: id.nullable(),
    }),
  ),
  gaps: z.array(gapSchema).default([]),
});

type Gap = z.output<typeof gapSchema>;
type ConfigEditorSnapshot = z.input<typeof directorySchema>;
export const teamConfigKeys = Object.keys(teamConfigSchema.shape);
export type ConfigEditorData = z.output<typeof directorySchema> & {
  config: unknown;
  completeness: "complete" | "partial";
};

interface GenerateConfigEditorOptions {
  readonly outPath: string;
  readonly config?: unknown;
  readonly configPath?: string;
  readonly env?: ConfigEnv;
  readonly render: (data: ConfigEditorData) => string;
}

// 不把运行环境或连接元数据交给渲染函数。
function checkSensitiveData(input: unknown, env: ConfigEnv) {
  assertNoConfigCredentials(input, env);
  if (env.ZENTAO_TOKEN)
    assertNoConfigCredentials(input, { ZENTAO_PASSWORD: env.ZENTAO_TOKEN });
  const connection =
    /https?:[\\/]{2}|zentao[_-]?base[_-]?url|bzt[_-]?wecom[_-]?webhook/iu;
  if (connection.test(JSON.stringify(input))) {
    throw new BztError("INVALID_INPUT", "页面数据中含连接地址或连接字段。");
  }
}

export function prepareConfigEditorData(
  { config, completeness, ...directory }: ConfigEditorData,
  env: ConfigEnv = {},
) {
  // 即使由调用方传入快照，也只序列化页面目录的白名单字段。
  const projected = directorySchema.safeParse(directory);
  if (!projected.success || !["complete", "partial"].includes(completeness))
    throw new BztError("INVALID_INPUT", "配置页目录格式不合法。");
  const payload: ConfigEditorData = {
    ...projected.data,
    config,
    completeness: projected.data.gaps.length ? "partial" : completeness,
  };
  checkSensitiveData(payload, env);
  const json = z.record(z.string(), z.json()).safeParse(config);
  if (!json.success || !teamConfigSchema.safeParse(json.data).success)
    throw new BztError("INVALID_INPUT", "团队配置字段不合法。");
  return { ...payload, config: json.data, probeProductId: PROBE_PRODUCT_ID };
}

async function readSource<T>(
  gaps: Gap[],
  source: string,
  read: () => Promise<T>,
) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof BztError)) throw error;
    gaps.push({ source, reason: failed });
    return undefined;
  }
}

async function readDirectory(client: ZentaoReadClient) {
  const gaps: Gap[] = [];
  const [catalog, people] = await Promise.all([
    readSource(gaps, "products", () => listProducts(client)),
    readSource(gaps, "users", () => listUsers(client)),
  ]);
  if (catalog?.truncated) gaps.push({ source: "products", reason: truncated });
  if (people?.truncated) gaps.push({ source: "users", reason: truncated });
  const products = (catalog?.items ?? [])
    .filter(({ deleted }) => !deleted)
    .map(({ id, name }) => ({ id, name }));
  const modules: z.output<typeof directorySchema>["modules"] = {};
  for (const { id } of products) {
    const items = await readSource(gaps, "modules:" + id, () =>
      getProductModules(client, id),
    );
    if (items) {
      // 菜单用斜杠表示路径，ID 0 是根选项。空列表表示成功读取。
      modules[id] = items
        .filter(
          ({ id, name }) =>
            id > 0 && name.split("/").filter(Boolean).length === 1,
        )
        .map(({ id, name }) => ({ id, name }));
    }
  }
  const users = (people?.items ?? [])
    .filter(({ deleted, account }) => !deleted && account?.trim())
    .map(({ account, realname, pinyin, dept }) => ({
      account,
      realname,
      pinyin,
      dept,
    }));
  return { products, modules, users, gaps };
}

export async function generateConfigEditorPage({
  outPath,
  config,
  configPath,
  env = {},
  render,
  client,
  snapshot,
}: GenerateConfigEditorOptions &
  (
    | { readonly client: ZentaoReadClient; readonly snapshot?: never }
    | { readonly client?: never; readonly snapshot?: ConfigEditorSnapshot }
  )) {
  const teamPath = (configPath ?? env.BZT_CONFIG)?.trim();
  if (!outPath.trim() || (teamPath && resolve(teamPath) === resolve(outPath)))
    throw new BztError("INVALID_INPUT", "请选择独立的 HTML 输出路径。");
  // 团队文件不能混入个人偏好。只保留加载器识别配置和敏感值所需的环境项。
  const initialConfig: unknown =
    config === undefined
      ? (
          await loadFileConfig({
            env: {
              BZT_CONFIG: env.BZT_CONFIG,
              ZENTAO_PASSWORD: env.ZENTAO_PASSWORD,
              BZT_WECOM_WEBHOOK: env.BZT_WECOM_WEBHOOK,
            },
            ...(configPath === undefined
              ? {}
              : { cli: { config: configPath } }),
          })
        ).config
      : config;
  const directory = client
    ? await readDirectory(client)
    : (snapshot ?? {
        products: [],
        modules: {},
        users: [],
        gaps: [
          { source: "products", reason: missing },
          { source: "users", reason: missing },
        ],
      });
  const gaps: Gap[] = [...(directory.gaps ?? [])];
  for (const { id } of directory.products) {
    const source = "modules:" + id;
    if (
      !Object.hasOwn(directory.modules, id) &&
      !gaps.some((gap) => gap.source === source)
    ) {
      gaps.push({ source, reason: missing });
    }
  }
  const completeness = gaps.length ? "partial" : "complete";
  const data = prepareConfigEditorData(
    { ...directory, config: initialConfig, completeness, gaps },
    env,
  );
  const html = render(data);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html, "utf8");
  } catch {
    throw new BztError(
      "INVALID_INPUT",
      "无法写入配置页，请检查输出路径和权限。",
    );
  }
  return { outPath, completeness, gaps };
}
