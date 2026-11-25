import { describe, expect, it } from "vitest";
import {
  assertCapabilityExecutable,
  getCapability,
  listCapabilities,
  resolveCapabilitiesForVersion,
} from "../../src/api/capabilities.ts";

describe("WP-05 能力注册表（06 §7）", () => {
  it("逐项列出约定的 18 个能力和四种状态", () => {
    expect(
      Object.fromEntries(
        listCapabilities().map(({ id, state }) => [id, state]),
      ),
    ).toEqual({
      "story.create": "verified",
      "story.create.plan": "unverified",
      "story.create.feedbackBy": "verified",
      "story.create.design": "verified",
      "story.assign": "verified",
      "story.edit": "verified",
      "story.activate": "verified",
      "story.linkExecution": "verified",
      "story.close": "verified",
      "story.comment": "verified",
      "requirement.linkStory": "unverified",
      "story.linkStory": "verified",
      "task.create": "verified",
      "task.close": "verified",
      "release.read": "unverified",
      "task.finish": "disabled",
      "bug.create": "disabled",
      "story.delete": "cli-only",
    });
    const verified = listCapabilities().filter(
      ({ state }) => state === "verified",
    );
    expect(verified).toHaveLength(12);
    for (const capability of verified)
      expect(capability.verifiedOn).toBe("22.6");
  });

  it("拒绝未验证和已禁用能力，CLI 专用能力只有显式 CLI 才允许", () => {
    for (const id of [
      "story.create",
      "story.linkExecution",
      "story.linkStory",
      "task.create",
      "task.close",
    ]) {
      expect(assertCapabilityExecutable(id)).toBe(getCapability(id));
    }
    for (const id of [
      "story.create.plan",
      "requirement.linkStory",
      "release.read",
    ]) {
      expect(() => assertCapabilityExecutable(id)).toThrow(
        expect.objectContaining({ code: "CAPABILITY_UNVERIFIED" }),
      );
    }
    for (const id of ["task.finish", "bug.create"]) {
      expect(() => assertCapabilityExecutable(id, { channel: "cli" })).toThrow(
        expect.objectContaining({ code: "CAPABILITY_DISABLED" }),
      );
    }
    expect(() => assertCapabilityExecutable("story.delete")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_CLI_ONLY" }),
    );
    expect(
      assertCapabilityExecutable("story.delete", { channel: "cli" }).state,
    ).toBe("cli-only");
  });

  it("实例版本变化仅降级有旧版本验证依据的写能力", () => {
    expect(resolveCapabilitiesForVersion("22.6")).toEqual(listCapabilities());
    const drift = resolveCapabilitiesForVersion("22.7");
    const drifted = drift.filter(
      ({ needsReverification }) => needsReverification,
    );
    expect(drifted.map(({ id }) => id)).toEqual(
      listCapabilities()
        .filter(({ state }) => state === "verified")
        .map(({ id }) => id),
    );
    for (const capability of drifted) {
      expect(capability).toMatchObject({
        state: "unverified",
        verifiedOn: "22.6",
        note: expect.stringContaining("需要重新验证"),
      });
    }
    for (const id of [
      "release.read",
      "story.create.plan",
      "task.finish",
      "story.delete",
    ]) {
      expect(drift.find((capability) => capability.id === id)).toEqual(
        getCapability(id),
      );
    }
    expect(getCapability("story.create").state).toBe("verified");
    expect(() =>
      assertCapabilityExecutable("story.create", { instanceVersion: "22.7" }),
    ).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNVERIFIED",
        message: expect.stringContaining("需要重新验证"),
      }),
    );
  });

  it("冻结查询结果，拒绝未知或继承属性名", () => {
    expect(Object.isFrozen(listCapabilities())).toBe(true);
    expect(Object.isFrozen(getCapability("story.create"))).toBe(true);
    expect(Object.isFrozen(resolveCapabilitiesForVersion("22.7"))).toBe(true);
    expect(Object.isFrozen(getCapability("story.create", "22.7"))).toBe(true);
    for (const id of ["made.up", "constructor", "__proto__"]) {
      expect(() => getCapability(id)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      expect(() => assertCapabilityExecutable(id)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });
});
