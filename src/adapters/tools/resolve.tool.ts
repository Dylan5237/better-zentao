import { resolveInput } from "../../services/inputs.js";
import { defineTool } from "./definition.js";

export const resolveTool = defineTool({
  name: "resolve_context", command: "resolve", schema: resolveInput, readOnly: true, positional: ["query"],
  description: "按账号、中文名、拼音、名称或 ID 解析人员、部门、产品、模块、计划和迭代，列出歧义候选。",
  cli: { query: "text", kinds: "list", product: "reference" },
  invoke: (client, input) => client.directory.resolveContext(input),
});
