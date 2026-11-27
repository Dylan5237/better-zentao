import type { Clock } from "../core/clock.ts";
import type { PartitionedReadPool } from "../core/http-policy.ts";
import { exchangeZentaoToken } from "./internal/http.ts";
import {
  registerReadClient,
  revokeReadClient,
} from "./internal/read-client.ts";

const readClientBrand: unique symbol = Symbol("ZentaoReadClient");

export type ZentaoReadClient = Readonly<{ [readClientBrand]: true }>;

type ZentaoReadCredentials =
  | { readonly password: string; readonly token?: never }
  | { readonly token: string; readonly password?: never };

export type ZentaoReadConfig = ZentaoReadCredentials & {
  readonly baseUrl: string;
  readonly account: string;
  readonly clock: Clock;
  readonly timezone?: string;
  readonly env?: Readonly<{
    ZENTAO_TIMEOUT_MS?: string;
    BZT_LOG_LEVEL?: string;
  }>;
  readonly logSink?: (line: string) => void;
  readonly onAuthFailed?: () => void;
  readonly isRevoked?: () => boolean;
  /** CR-009 CAP-02：在取得写锁后、实际派发写请求前的最终授权校验钩子。 */
  readonly assertBeforeWrite?: (opId?: string) => void | Promise<void>;
  readonly readPool?: PartitionedReadPool;
  readonly instanceHash?: string;
};

export interface ZentaoTokenExchangeConfig {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly clock: Clock;
  readonly env?: Readonly<{
    ZENTAO_TIMEOUT_MS?: string;
    BZT_LOG_LEVEL?: string;
  }>;
  readonly logSink?: (line: string) => void;
  readonly readPool?: PartitionedReadPool;
  readonly instanceHash?: string;
}

export function exchangeZentaoSessionToken(
  config: ZentaoTokenExchangeConfig,
): Promise<{ readonly token: string }> {
  return exchangeZentaoToken(config);
}

export function createZentaoReadClient(
  config: ZentaoReadConfig,
): ZentaoReadClient {
  const client: ZentaoReadClient = Object.freeze(
    Object.defineProperty(
      { [readClientBrand]: true as const },
      readClientBrand,
      { enumerable: false },
    ),
  );
  registerReadClient(client, config);
  return client;
}

export function revokeZentaoReadClient(client: ZentaoReadClient): void {
  revokeReadClient(client);
}
