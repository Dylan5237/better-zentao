import { z } from "zod";
import { operationResultSchema } from "../operation.ts";
import { queryResultSchema } from "../result.ts";

export { getOperationSchema as getOperationInputSchema } from "../operation.ts";

export const getOperationOutputSchema = queryResultSchema(
  z.union([operationResultSchema, z.array(operationResultSchema)]),
);
