import type { ReadRequest } from "./http.ts";

export interface CaptureRoute {
  readonly endpoint: string;
  readonly pathTemplate: string;
  readonly query?: ReadRequest["query"];
  readonly pathId?: true;
  readonly queryId?: string;
  readonly collection?: readonly string[];
}

// docs/06 §3 固定允许的 26 个读取路由。只有已验证分页参数的列表才尝试另取空页。
export const captureRoutes = {
  instanceConfig: {
    endpoint: "instance-config",
    pathTemplate: "/index.php",
    query: { mode: "getconfig" },
  },
  currentUser: { endpoint: "current-user", pathTemplate: "/api.php/v1/user" },
  requiredFields: {
    endpoint: "required-fields",
    pathTemplate: "/api.php/v1/requiredFields",
  },
  departments: {
    endpoint: "departments",
    pathTemplate: "/api.php/v1/departments",
    collection: ["departments", "deptTree"],
  },
  users: {
    endpoint: "users",
    pathTemplate: "/api.php/v2/users",
    query: { recPerPage: 3000, pageID: 1 },
    collection: ["users"],
  },
  usersByDepartment: {
    endpoint: "users-by-department",
    pathTemplate: "/api.php/v2/company/browse",
    queryId: "param",
    query: { type: "bydept", recPerPage: 200, pageID: 1 },
    collection: ["users"],
  },
  myWork: {
    endpoint: "my-work",
    pathTemplate: "/api.php/v2/my/work",
    query: {
      mode: "task",
      browseType: "assignedTo",
      recPerPage: 100,
      pageID: 1,
    },
    collection: ["tasks", "todos"],
  },
  myContribute: {
    endpoint: "my-contribute",
    pathTemplate: "/api.php/v2/my/contribute",
    query: {
      mode: "story",
      browseType: "openedBy",
      recPerPage: 100,
      pageID: 1,
    },
    collection: ["stories"],
  },
  products: {
    endpoint: "products",
    pathTemplate: "/api.php/v1/products",
    query: { limit: 100, page: 1 },
    collection: ["products"],
  },
  productModules: {
    endpoint: "product-modules",
    pathTemplate: "/api.php/v1/products/{id}",
    pathId: true,
    query: { fields: "moduleOptionMenu" },
  },
  productPlans: {
    endpoint: "product-plans",
    pathTemplate: "/api.php/v1/products/{id}/plans",
    pathId: true,
    query: { limit: 100, page: 1 },
    collection: ["plans"],
  },
  planDetail: {
    endpoint: "plan-detail",
    pathTemplate: "/api.php/v2/productplan/view",
    queryId: "planID",
  },
  productStories: {
    endpoint: "product-stories",
    pathTemplate: "/api.php/v1/products/{id}/stories",
    pathId: true,
    query: { status: "all", limit: 100, page: 1 },
    collection: ["stories"],
  },
  productRequirements: {
    endpoint: "product-requirements",
    pathTemplate: "/api.php/v2/product/browse",
    queryId: "productID",
    query: { storyType: "requirement", recPerPage: 100, pageID: 1 },
    collection: ["requirements", "stories"],
  },
  storyDetail: {
    endpoint: "story-detail",
    pathTemplate: "/api.php/v1/stories/{id}",
    pathId: true,
  },
  storyDetailV2: {
    endpoint: "story-detail-v2",
    pathTemplate: "/api.php/v2/story/view",
    queryId: "storyID",
  },
  requirementDetail: {
    endpoint: "requirement-detail",
    pathTemplate: "/api.php/v2/requirement/view",
    queryId: "storyID",
  },
  projects: {
    endpoint: "projects",
    pathTemplate: "/api.php/v1/projects",
    query: { limit: 100, page: 1 },
    collection: ["projects"],
  },
  executionsV2: {
    endpoint: "executions-v2",
    pathTemplate: "/api.php/v2/executions",
    query: { recPerPage: 200, pageID: 1 },
    collection: ["executions"],
  },
  executionsV1: {
    endpoint: "executions-v1",
    pathTemplate: "/api.php/v1/executions",
    query: { limit: 200, page: 1 },
    collection: ["executions"],
  },
  executionTasks: {
    endpoint: "execution-tasks",
    pathTemplate: "/api.php/v1/executions/{id}/tasks",
    pathId: true,
    query: { status: "all", limit: 100, page: 1 },
    collection: ["tasks"],
  },
  taskDetail: {
    endpoint: "task-detail",
    pathTemplate: "/api.php/v1/tasks/{id}",
    pathId: true,
  },
  productBugs: {
    endpoint: "product-bugs",
    pathTemplate: "/api.php/v1/products/{id}/bugs",
    pathId: true,
    query: { status: "unclosed", limit: 100, page: 1 },
    collection: ["bugs"],
  },
  projectBugs: {
    endpoint: "project-bugs",
    pathTemplate: "/api.php/v1/projects/{id}/bugs",
    pathId: true,
    query: { limit: 100, page: 1 },
    collection: ["bugs"],
  },
  releases: {
    endpoint: "releases",
    pathTemplate: "/api.php/v1/products/{id}/releases",
    pathId: true,
    collection: ["releases"],
  },
  storyCreateMetadata: {
    endpoint: "story-create-metadata",
    pathTemplate: "/api.php/v2/story/create",
    queryId: "productID",
  },
} satisfies Readonly<Record<string, CaptureRoute>>;
