import type { Clock } from "../core/clock.ts";
import { registerReadClient } from "./internal/read-client.ts";

const readClientBrand: unique symbol = Symbol("ZentaoReadClient");

export type ZentaoReadClient = Readonly<{ [readClientBrand]: true }>;

export interface ZentaoReadConfig {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly clock: Clock;
  readonly timezone?: string;
  readonly env?: Readonly<{
    ZENTAO_TIMEOUT_MS?: string;
    BZT_LOG_LEVEL?: string;
  }>;
  readonly logSink?: (line: string) => void;
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
