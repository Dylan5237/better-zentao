import { describe, expect, it } from "vitest";
import { actionDtoFor } from "../../src/core/dto/action.ts";
import {
  foldExplicitStageRequirements,
  foldStageRequirements,
  stageRequirementApprovers,
} from "../../src/services/structured-notes.ts";

/**
 * CR-009 D-204：阶段要求评论作者校验与旧记录兼容口径测试。
 */

const actionDto = actionDtoFor("Asia/Shanghai");

const defaults = {
  dev: { required: true },
  test: { required: true },
  acceptance: { required: true },
  delivery: { required: true },
};

describe("D-204 阶段要求评论作者校验", () => {
  it("仅采信受权作者（PM/DM/RM/需求维护人）的 [bzt:meta v1] 阶段覆盖，忽略无权评论者", () => {
    const approvers = stageRequirementApprovers(
      {
        PM: ["acct_pm"],
        DM: ["acct_dm"],
        RM: ["acct_rm"],
      },
      "acct_owner",
    );
    const actions = [
      actionDto.parse({
        id: 1,
        action: "commented",
        actor: "acct_pm",
        date: "2026-11-20 10:00:00",
        comment:
          '[bzt:meta v1 {"stageRequirements":{"acceptance":{"required":false}}}]',
      }),
      actionDto.parse({
        id: 2,
        action: "commented",
        actor: "acct_dev_unauthorized",
        date: "2026-11-21 10:00:00",
        comment:
          '[bzt:meta v1 {"stageRequirements":{"test":{"required":false},"acceptance":{"required":true}}}]',
      }),
      actionDto.parse({
        id: 3,
        action: "commented",
        actor: "acct_owner",
        date: "2026-11-22 10:00:00",
        comment: "[bzt:meta v1] stage.delivery=false | reason=无需单独交付",
      }),
    ];

    const result = foldStageRequirements(defaults, [], actions, approvers);
    expect(result).toEqual({
      dev: true,
      test: true, // 无权评论者的覆盖被忽略
      acceptance: false, // PM 的覆盖保留，未被无权评论者改回 true
      delivery: false, // 需求维护人的旧格式覆盖生效
    });
  });

  it("未配置任何受权角色时保留显式历史兼容口径", () => {
    const actions = [
      actionDto.parse({
        id: 1,
        action: "commented",
        actor: "legacy_actor",
        date: "2026-11-20 10:00:00",
        comment:
          '[bzt:meta v1 {"stageRequirements":{"acceptance":{"required":false}}}]',
      }),
    ];
    const result = foldStageRequirements(defaults, [], actions, []);
    expect(result.acceptance).toBe(false);
  });

  it("缓存记录（decidedBy）与评论同样执行受权作者校验", () => {
    const approvers = stageRequirementApprovers(
      { PM: ["acct_pm"] },
      "acct_owner",
    );
    const cached = [
      { stage: "test", required: false, decidedBy: "acct_dev_unauthorized" },
      { stage: "delivery", required: false, decidedBy: "acct_pm" },
    ];
    const result = foldStageRequirements(defaults, cached, [], approvers);
    expect(result).toEqual({
      dev: true,
      test: true, // 无权作者写入的缓存被忽略
      acceptance: true,
      delivery: false, // 受权 PM 写入的缓存生效
    });
  });

  it("显式阶段决定（即便等于默认值）保留为显式记录，且忽略无权作者", () => {
    const approvers = stageRequirementApprovers(
      { PM: ["acct_pm"] },
      "acct_owner",
    );
    const actions = [
      actionDto.parse({
        id: 1,
        action: "commented",
        actor: "acct_owner",
        date: "2026-11-20 10:00:00",
        comment:
          '[bzt:meta v1 {"stageRequirements":{"delivery":{"required":false}}}]',
      }),
      actionDto.parse({
        id: 2,
        action: "commented",
        actor: "acct_unauthorized",
        date: "2026-11-21 10:00:00",
        comment:
          '[bzt:meta v1 {"stageRequirements":{"interface":{"required":true}}}]',
      }),
    ];
    const explicit = foldExplicitStageRequirements(
      ["dev", "test", "interface", "delivery"],
      [],
      actions,
      approvers,
    );
    expect(explicit.get("delivery")).toBe(false);
    expect(explicit.has("interface")).toBe(false);
    expect(explicit.has("dev")).toBe(false);
  });
});
