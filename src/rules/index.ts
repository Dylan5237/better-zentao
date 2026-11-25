import * as overdue from "./r01-overdue.ts";
import * as testHandoff from "./r02-test-handoff.ts";
import * as receiptTimeout from "./r03-receipt-timeout.ts";
import * as prematureAssignment from "./r04-premature-assignment.ts";
import * as missingScope from "./r05-missing-scope.ts";
import * as structureViolation from "./r06-structure-violation.ts";
import * as designUnhanded from "./r07-design-unhanded.ts";
import * as unlinkedRequirement from "./r08-unlinked-requirement.ts";
import * as closableStory from "./r09-closable-story.ts";
import * as planExecutionGap from "./r10-plan-execution-gap.ts";
import * as postTestGap from "./r11-post-test-gap.ts";
import * as unlinkedBug from "./r12-unlinked-bug.ts";
import * as releaseGate from "./r13-release-gate.ts";
import * as staleTasks from "./r14-stale-tasks.ts";
import type { RiskHit, RuleContext, RuleId, RuleInput } from "./types.ts";

export type { RiskHit, RuleContext, RuleId, RuleInput } from "./types.ts";

interface Rule {
  readonly id: RuleId;
  readonly name: string;
  evaluate(input: RuleInput, context: RuleContext): RiskHit[];
}

export const rules: readonly Rule[] = Object.freeze([
  overdue,
  testHandoff,
  receiptTimeout,
  prematureAssignment,
  missingScope,
  structureViolation,
  designUnhanded,
  unlinkedRequirement,
  closableStory,
  planExecutionGap,
  postTestGap,
  unlinkedBug,
  releaseGate,
  staleTasks,
]);

// docs/04 §5.1。豁免按规则和对象匹配，保留审阅标记。
export function evaluateRules(input: RuleInput, context: RuleContext) {
  const hits: RiskHit[] = [];
  const waived: (RiskHit & {
    readonly waived: { readonly by: string; readonly reason: string };
  })[] = [];
  for (const rule of rules) {
    if (context.disabledRules?.has(rule.id)) continue;
    for (const hit of rule.evaluate(input, context)) {
      const waiver = input.waivers?.find(
        ({ ruleId, objectType, objectId }) =>
          ruleId === hit.ruleId &&
          objectType === hit.objectType &&
          objectId === hit.objectId,
      );
      if (waiver)
        waived.push({
          ...hit,
          waived: { by: waiver.by, reason: waiver.reason },
        });
      else hits.push(hit);
    }
  }
  return { hits, waived };
}
