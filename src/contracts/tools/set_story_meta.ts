import { z } from "zod";
import { handoffDesignRefSchema } from "./handoff_story.ts";

export { preparedOperationSchema as setStoryMetaOutputSchema } from "../operation.ts";

const text = z.string().trim().min(1);
const stageRequirement = z
  .object({ required: z.boolean(), reason: text.optional() })
  .strict();
export const stageRequirementsSchema = z
  .object({
    interface: stageRequirement.optional(),
    delivery: stageRequirement.optional(),
    acceptance: stageRequirement.optional(),
    test: stageRequirement.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined));
export const metaRolesSchema = z
  .object({ maintainer: text.optional(), receiver: text.optional() })
  .strict()
  .refine(({ maintainer, receiver }) => Boolean(maintainer || receiver));
export const waiverSchema = z.object({ rule: text, reason: text }).strict();

// docs/07 §4.7。
export const setStoryMetaInputSchema = z
  .object({
    storyId: z.int().positive(),
    stageRequirements: stageRequirementsSchema.optional(),
    waiver: waiverSchema.optional(),
    roles: metaRolesSchema.optional(),
    scope: z
      .object({ scope: text, designRef: handoffDesignRefSchema.optional() })
      .strict()
      .optional(),
    version: text.optional(),
  })
  .strict()
  .refine(({ stageRequirements, waiver, roles, scope, version }) =>
    Boolean(stageRequirements || waiver || roles || scope || version),
  );

export type SetStoryMetaInput = z.input<typeof setStoryMetaInputSchema>;
