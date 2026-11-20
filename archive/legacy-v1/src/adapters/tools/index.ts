import { intakeTools } from "./intake.tools.js";
import { resolveTool } from "./resolve.tool.js";
import { trackingTools } from "./tracking.tools.js";

export const TOOL_DEFS = [resolveTool, ...trackingTools, ...intakeTools];
