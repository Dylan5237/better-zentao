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
    note: "v2/stories，reviewer=[]、status=draft、可见微标签",
  },
  {
    id: "story.create.plan",
    state: "unverified",
    note: "22.6 v2/stories 创建时忽略 plan，改由 story.edit 挂接计划",
  },
  {
    id: "story.create.feedbackBy",
    state: "verified",
    verifiedOn: "22.6",
    note: "创建后反馈者文本回读一致",
  },
  {
    id: "story.create.design",
    state: "verified",
    verifiedOn: "22.6",
    note: "category=design",
  },
  { id: "story.assign", state: "verified", verifiedOn: "22.6" },
  {
    id: "story.edit",
    state: "verified",
    verifiedOn: "22.6",
    note: "v1 PUT 已验证改关键词和计划；不修改 spec 正文",
  },
  {
    id: "story.activate",
    state: "verified",
    verifiedOn: "22.6",
    note: "v1 PUT status=active，从草稿激活",
  },
  {
    id: "story.linkExecution",
    state: "verified",
    verifiedOn: "22.6",
    note: "v2 execution/linkStory?objectID={id}，仅接受 active 需求",
  },
  {
    id: "story.close",
    state: "verified",
    verifiedOn: "22.6",
    note: "v1 close，已验证关闭原因为 cancel",
  },
  {
    id: "story.comment",
    state: "verified",
    verifiedOn: "22.6",
    note: "v2 action/comment，需求动作列表回读评论",
  },
  {
    id: "requirement.linkStory",
    state: "unverified",
    note: "#29 尚无可用用户需求，待验证",
  },
  {
    id: "story.linkStory",
    state: "verified",
    verifiedOn: "22.6",
    note: "v2 story/linkStory?storyID={id}，v2/story/view relations.story 双向回读",
  },
  {
    id: "task.create",
    state: "verified",
    verifiedOn: "22.6",
    note: "v1 executions/{id}/tasks 单级任务与可见 [bzt:stage=...] 标签；L4 子任务 v2 batchCreate 待验",
  },
  {
    id: "task.close",
    state: "verified",
    verifiedOn: "22.6",
    note: "v2 task/close?taskID={id}，未开始/进行中任务需先 v2 task/cancel",
  },
  {
    id: "release.read",
    state: "unverified",
    note: "v1/products/{id}/releases 仅实测空列表，非空结构待验证",
  },
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
