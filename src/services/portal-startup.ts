import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import { loadFileConfig, readConfigEnvironment } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { loginPortal } from "./portal.ts";
import type { WorkbenchRuntime } from "./workbench.ts";

const portalIdentity = z.strictObject({
  baseUrl: z
    .string()
    .refine((value) => normalizeZentaoBaseUrl(value)?.href === value),
  account: z.string().trim().min(1).max(256).optional(),
});

type PortalIdentity = z.infer<typeof portalIdentity>;

interface LoginOptions {
  baseUrl?: string;
  localOwner?: boolean;
  saved?: boolean;
}

async function readIdentity(path: string): Promise<PortalIdentity | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new BztError("INVALID_INPUT", "无法读取本机门户设置。");
  }
  try {
    return portalIdentity.parse(JSON.parse(text));
  } catch {
    throw new BztError("INVALID_INPUT", "本机门户设置文件不合法。");
  }
}

function startupChanged() {
  return new BztError(
    "INVALID_INPUT",
    "本机门户设置已变更，请刷新后重新登录。",
  );
}

async function saveIdentity(
  path: string,
  next: PortalIdentity,
  previous?: PortalIdentity,
) {
  const pending = path + "." + randomUUID() + ".tmp";
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(pending, JSON.stringify(next) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (previous) {
      const actual = await readIdentity(path);
      if (
        actual?.baseUrl !== previous.baseUrl ||
        actual.account !== previous.account
      )
        throw startupChanged();
      await rename(pending, path);
    } else {
      // Exclude a competing first login even when two portals use one state directory.
      await link(pending, path);
    }
  } catch (error) {
    if (error instanceof BztError) throw error;
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw startupChanged();
    throw new BztError("INVALID_INPUT", "无法保存本机门户设置。");
  } finally {
    await rm(pending, { force: true }).catch(() => undefined);
  }
}

export async function preparePortalStartup(
  runtime: WorkbenchRuntime,
  allowMissingDefaultTeam: boolean,
) {
  const { stateDir } = await loadFileConfig({
    ...runtime,
    optionalTeamConfig: allowMissingDefaultTeam,
  });
  if (!stateDir)
    throw new BztError(
      "CONFIG_MISSING",
      "无法确定本机门户设置目录，请设置 BZT_HOME。",
    );

  const { baseUrl: configuredUrl } = readConfigEnvironment(runtime.env).zentao;
  const configuredAccount = runtime.env.ZENTAO_ACCOUNT?.trim() || undefined;
  const configuredPassword = runtime.env.ZENTAO_PASSWORD;
  // An environment password is bound only to the instance explicitly configured with it.
  const hasSavedLogin = Boolean(
    configuredUrl && configuredAccount && configuredPassword?.trim(),
  );
  const identityPath = join(stateDir, "portal-identity.json");
  const configuredIdentity = Boolean(configuredUrl && configuredAccount);
  let identity = configuredIdentity
    ? undefined
    : await readIdentity(identityPath);

  function settings() {
    const baseUrl = configuredUrl ?? identity?.baseUrl;
    const account =
      configuredAccount ??
      (identity?.baseUrl === baseUrl ? identity?.account : undefined);
    return { baseUrl, account };
  }

  return {
    startup() {
      const { baseUrl, account } = settings();
      return {
        needsBaseUrl: !baseUrl,
        ...(account ? { account } : {}),
        hasSavedLogin,
      };
    },
    async login(
      account: string,
      password: string,
      { baseUrl: inputUrl, localOwner, saved }: LoginOptions = {},
    ) {
      if (!configuredIdentity) identity = await readIdentity(identityPath);
      const { baseUrl: currentUrl, account: currentOwner } = settings();
      if (
        (inputUrl && (!localOwner || saved)) ||
        (saved && (!localOwner || !hasSavedLogin))
      )
        throw new BztError(
          "PERMISSION_DENIED",
          "请从本机启动入口完成登录设置。",
        );
      const suppliedUrl = inputUrl
        ? normalizeZentaoBaseUrl(inputUrl.trim())
        : undefined;
      if (inputUrl && !suppliedUrl)
        throw new BztError("INVALID_INPUT", "请输入合法的禅道部署地址。");
      if (currentUrl && suppliedUrl && currentUrl !== suppliedUrl.href)
        throw new BztError("PERMISSION_DENIED", "此门户已绑定禅道实例。");
      const baseUrl = currentUrl ?? suppliedUrl?.href;
      if (!baseUrl)
        throw new BztError("CONFIG_MISSING", "请从本机启动入口设置禅道地址。");

      const bindOwner = Boolean(localOwner && !currentOwner);
      const connection = await loginPortal(
        {
          ...runtime,
          env: {
            ...runtime.env,
            ZENTAO_BASE_URL: baseUrl,
            ZENTAO_ACCOUNT: currentOwner,
          },
        },
        saved ? (configuredAccount ?? "") : account,
        saved ? (configuredPassword ?? "") : password,
        bindOwner,
      );
      if (localOwner && (!currentUrl || bindOwner)) {
        const authenticatedAccount = connection.identity.account;
        const next = {
          baseUrl,
          ...(!currentOwner || currentOwner === authenticatedAccount
            ? { account: authenticatedAccount }
            : {}),
        };
        try {
          await saveIdentity(identityPath, next, identity);
          identity = next;
        } catch (error) {
          connection.close();
          throw error;
        }
      }
      return connection;
    },
  };
}
