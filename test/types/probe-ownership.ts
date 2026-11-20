import { $brand } from "zod";
import type { VerifiedOwnership } from "../../src/api/internal/probe-scope.ts";
import { createProbeWriteSender } from "../../src/api/internal/probe-transport.ts";
import type { ProbeWriteOptions } from "../../src/api/internal/probe-transport.ts";

declare const options: Omit<ProbeWriteOptions, "ownership">;
declare const proof: VerifiedOwnership;
const publicBrand = { [$brand]: { VerifiedOwnership: true } } as const;

// @ts-expect-error 普通 Map 不是回读证据。
createProbeWriteSender({ ...options, ownership: new Map([[999, 29]]) });
// @ts-expect-error 对象字面量无法获得回读品牌。
createProbeWriteSender({ ...options, ownership: {} });
// @ts-expect-error 通用 Zod 品牌也不能仿造私有回读品牌。
createProbeWriteSender({ ...options, ownership: publicBrand });
createProbeWriteSender({ ...options, ownership: proof });
