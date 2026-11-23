import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  captureProbeFixtures,
  type CaptureReport,
  type SanitizedFixture,
} from "../api/probe-capture.ts";
import type { Clock } from "../core/clock.ts";
import {
  findMissingEnv,
  loadConfig,
  type ConfigEnv,
  type ConfigOverrides,
} from "../core/config.ts";
import { BztError } from "../core/errors.ts";

const defaultOutput = "test/fixtures/zentao-22.6";
const filePath = z
  .string()
  .refine((path) => !!path.trim() && !path.includes("\0"));

interface CaptureArgs {
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly logSink: (line: string) => void;
  readonly cli: ConfigOverrides & { readonly out?: string };
}

interface CaptureFailure {
  readonly kind: "failed" | "invalid-args";
  readonly message: string;
}

type CaptureOutcome =
  | CaptureFailure
  | {
      readonly kind: "captured";
      readonly summary: Pick<CaptureReport, "completeness" | "gaps"> & {
        readonly captured: number;
      };
    };

function configFailure(error: unknown, env: ConfigEnv): CaptureFailure {
  if (!(error instanceof BztError)) {
    return { kind: "failed", message: "无法加载夹具采集配置。" };
  }
  if (error.code === "CONFIG_MISSING") {
    return {
      kind: "failed",
      message: `CONFIG_MISSING 缺少必填禅道环境变量（${findMissingEnv(env).join("、")}）。`,
    };
  }
  const fields = error.details?.fields;
  if (
    Array.isArray(fields) &&
    fields.length === 1 &&
    fields[0] === "--product"
  ) {
    return { kind: "invalid-args", message: "产品编号必须是正整数。" };
  }
  return { kind: "failed", message: `${error.code} 无法加载夹具采集配置。` };
}

async function writeFixtures(
  directory: string,
  fixtures: readonly SanitizedFixture[],
): Promise<void> {
  const files = fixtures.map(({ endpoint, status, body, sample }) => ({
    name: sample === "empty" ? `${endpoint}.empty.json` : `${endpoint}.json`,
    contents: JSON.stringify({ endpoint, status, body }, null, 2) + "\n",
  }));
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  // 在同一文件系统完成暂存，每份最终夹具通过重命名一次发布。
  const staged = await mkdtemp(join(destination, ".bzt-capture-"));
  try {
    for (const { name, contents } of files) {
      await writeFile(join(staged, name), contents, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    for (const { name } of files) {
      await rename(join(staged, name), join(destination, name));
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

export async function runProbeCapture(
  options: CaptureArgs,
): Promise<CaptureOutcome> {
  const { env, homeDir, clock, logSink, cli } = options;
  const out = cli.out ?? defaultOutput;
  if (!filePath.safeParse(out).success) {
    return { kind: "invalid-args", message: "输出目录不合法。" };
  }
  if (cli.config !== undefined && !filePath.safeParse(cli.config).success) {
    return { kind: "invalid-args", message: "配置文件路径不合法。" };
  }

  let config;
  try {
    config = await loadConfig({ env, homeDir, cli });
  } catch (error) {
    return configFailure(error, env);
  }

  let report: CaptureReport;
  try {
    report = await captureProbeFixtures({
      ...config.zentao,
      password: env.ZENTAO_PASSWORD ?? "",
      productId: config.productId,
      logLevel: config.logLevel,
      clock,
      logSink,
    });
  } catch (error) {
    const code = error instanceof BztError ? `${error.code} ` : "";
    return { kind: "failed", message: `${code}无法完成脱敏夹具采集。` };
  }

  try {
    await writeFixtures(out, report.fixtures);
  } catch {
    return { kind: "failed", message: "无法写入夹具目录。" };
  }
  return {
    kind: "captured",
    summary: {
      completeness: report.completeness,
      gaps: report.gaps,
      captured: report.fixtures.length,
    },
  };
}
