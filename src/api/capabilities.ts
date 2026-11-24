import { BztError } from "../core/errors.ts";

export type CapabilityState =
  "verified" | "unverified" | "disabled" | "cli-only";

type Registration = { readonly id: string; readonly note?: string } & (
  | { readonly state: "verified"; readonly verifiedOn: string }
  | { readonly state: Exclude<CapabilityState, "verified"> }
);

// docs/06 §7。新增验证结论时须同步回读证据和契约测试。
const registrations = [
  {
    id: "story.create",
    state: "verified",
    verifiedOn: "22.6",
    note: "v2/stories，reviewer=[]，status=draft",
  },
  { id: "story.create.plan", state: "unverified", note: "创建时直接带 plan" },
  { id: "story.create.feedbackBy", state: "unverified" },
  { id: "story.create.design", state: "unverified", note: "category=design" },
  { id: "story.assign", state: "verified", verifiedOn: "22.6" },
  { id: "story.edit", state: "unverified" },
  { id: "story.activate", state: "unverified" },
  { id: "story.linkExecution", state: "unverified" },
  { id: "story.close", state: "unverified" },
  { id: "story.comment", state: "unverified" },
  { id: "requirement.linkStory", state: "unverified" },
  { id: "story.linkStory", state: "unverified" },
  { id: "task.create", state: "unverified" },
  { id: "task.close", state: "unverified" },
  { id: "release.read", state: "unverified" },
  { id: "task.finish", state: "disabled", note: "事实性字段，禁止代填" },
  { id: "bug.create", state: "disabled" },
  { id: "story.delete", state: "cli-only" },
] as const satisfies readonly Registration[];

export type CapabilityId = (typeof registrations)[number]["id"];

export interface Capability {
  readonly id: CapabilityId;
  readonly state: CapabilityState;
  readonly verifiedOn?: string;
  readonly note?: string;
  readonly needsReverification?: true;
}

const capabilities: readonly Capability[] = Object.freeze(
  registrations.map((registration) => Object.freeze(registration)),
);

const reverificationMessage =
  "实例版本与已验证版本不一致，写能力需要重新验证。";

function forVersion(capability: Capability, version?: string): Capability {
  if (
    version === undefined ||
    capability.state !== "verified" ||
    capability.id === "release.read" ||
    capability.verifiedOn === version
  ) {
    return capability;
  }
  return Object.freeze({
    ...capability,
    state: "unverified",
    note: reverificationMessage,
    needsReverification: true,
  });
}

export function listCapabilities(): readonly Capability[] {
  return capabilities;
}

export function getCapability(id: string, version?: string): Capability {
  const capability = capabilities.find((entry) => entry.id === id);
  if (capability === undefined) {
    throw new BztError("INVALID_INPUT", "未知禅道能力。");
  }
  return forVersion(capability, version);
}

export function resolveCapabilitiesForVersion(
  version: string,
): readonly Capability[] {
  return Object.freeze(
    capabilities.map((capability) => forVersion(capability, version)),
  );
}

export function assertCapabilityExecutable(
  id: string,
  options: Readonly<{ channel?: "mcp" | "cli"; instanceVersion?: string }> = {},
): Capability {
  const capability = getCapability(id, options.instanceVersion);
  const details = { capability: capability.id };
  if (capability.state === "unverified") {
    throw new BztError(
      "CAPABILITY_UNVERIFIED",
      capability.needsReverification
        ? reverificationMessage
        : "该能力尚未在产品 #29 验证。",
      details,
    );
  }
  if (capability.state === "disabled") {
    throw new BztError(
      "CAPABILITY_DISABLED",
      "该能力已禁用，请在禅道操作。",
      details,
    );
  }
  if (capability.state === "cli-only" && options.channel !== "cli") {
    throw new BztError(
      "CAPABILITY_CLI_ONLY",
      "该能力仅允许通过 CLI 使用。",
      details,
    );
  }
  return capability;
}
