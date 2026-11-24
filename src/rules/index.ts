import * as overdue from "./r01-overdue.ts";
import * as testHandoff from "./r02-test-handoff.ts";
import * as receiptTimeout from "./r03-receipt-timeout.ts";
import * as prematureAssignment from "./r04-premature-assignment.ts";
import * as missingScope from "./r05-missing-scope.ts";
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
