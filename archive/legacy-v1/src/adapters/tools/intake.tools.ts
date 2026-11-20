import { assignInput, createInput, deleteInput, importInput } from "../../services/inputs.js";
import { defineTool } from "./definition.js";

export const intakeTools = [
  defineTool({
    name: "create_story", command: "create", schema: createInput, readOnly: false,
    description: "预检或创建单态、多态或设计与研发双单。dryRun 默认 true，用户明确批准后才传 false。回读未确认时按已有 ID 核查。",
    cli: {
      product: "reference", state: "text", states: "list", createDevPair: "boolean", title: "text", spec: "text",
      verify: "text", category: "text", pri: "id", module: "reference", plan: "reference", assignTo: "text",
      feedbackBy: "text", source: "text", batch: "text", requirementId: "id", mode: "text", skipReview: "boolean", dryRun: "dryRun",
    },
    invoke: (client, input) => client.intake.createStory(input),
  }),
  defineTool({
    name: "import_stories", command: "import", schema: importInput, readOnly: false,
    description: "批量预检或逐条创建 1 至 100 条需求。dryRun 默认 true，获用户明确批准后才实写，回执逐条报告。",
    cli: { product: "reference", state: "text", mode: "text", dryRun: "dryRun" },
    invoke: (client, input) => client.intake.importStories(input),
  }),
  defineTool({
    name: "assign_story", command: "assign", schema: assignInput, readOnly: false, positional: ["storyId", "assignedTo"],
    description: "经确认后给指定研发需求独立指派负责人，GET 回读一致时返回 confirmed。",
    cli: { storyId: "id", assignedTo: "text", comment: "text" },
    invoke: (client, input) => client.intake.assignStory(input),
  }),
  defineTool({
    name: "delete_story", command: "delete", schema: deleteInput, readOnly: false, positional: ["storyId"],
    description: "软删除指定研发需求。必须获得明确确认并传入 confirm: true，删除后再次回读。",
    cli: { storyId: "id", confirm: "boolean" },
    invoke: (client, input) => client.intake.deleteStory(input),
  }),
];
