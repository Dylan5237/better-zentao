import type { ZentaoReadClient, ZentaoReadConfig } from "../client.ts";
import { BztError } from "../../core/errors.ts";
import { isIanaTimezone } from "../../core/calendar.ts";
import { normalizeZentaoBaseUrl } from "./base-url.ts";
import { createZentaoHttp } from "./http.ts";

interface ReadClientState {
  readonly baseUrl: string;
  readonly account: string;
  readonly timezone: string;
  readonly http: Pick<ReturnType<typeof createZentaoHttp>, "read">;
  readonly getProbeSender: ReturnType<
    typeof createZentaoHttp
  >["getProbeSender"];
}

interface WriteClientState {
  readonly http: Pick<ReturnType<typeof createZentaoHttp>, "write">;
}

const readClients = new WeakMap<
  ZentaoReadClient,
  { read: ReadClientState; write: WriteClientState }
>();

export function registerReadClient(
  client: ZentaoReadClient,
  config: ZentaoReadConfig,
): void {
  const baseUrl = normalizeZentaoBaseUrl(config.baseUrl);
  const timezone = config.timezone ?? "Asia/Shanghai";
  if (!baseUrl || !isIanaTimezone(timezone)) {
    throw new BztError("INVALID_INPUT", "禅道读取地址或时区不合法。");
  }
  const { read, write, getProbeSender } = createZentaoHttp({
    ...config,
    baseUrl: baseUrl.href,
  });
  readClients.set(client, {
    read: {
      baseUrl: baseUrl.href,
      account: config.account,
      timezone,
      http: { read },
      getProbeSender,
    },
    write: { http: { write } },
  });
}

export function getReadClient(client: ZentaoReadClient): ReadClientState;
export function getReadClient(
  client: ZentaoReadClient,
  mode: "write",
): WriteClientState;
export function getReadClient(
  client: ZentaoReadClient,
  mode: "read" | "write" = "read",
) {
  const state = readClients.get(client);
  if (!state) throw new BztError("INVALID_INPUT", "禅道只读客户端未初始化。");
  return state[mode];
}
