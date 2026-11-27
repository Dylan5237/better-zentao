import type { OperationGateway } from "./operation-gateway.ts";
import type { CurrentUser, User } from "../../core/dto/org.ts";
import type { Product, ProductModule } from "../../core/dto/product.ts";
import type { ProductPlan } from "../../core/dto/plan.ts";
import type { Execution } from "../../core/dto/execution.ts";
import type { Task, TaskDetail } from "../../core/dto/task.ts";
import type { Bug } from "../../core/dto/bug.ts";
import type {
  StoryDetail,
  Story,
  StoryDetailV2,
  RequirementDetail,
} from "../../core/dto/story.ts";

/**
 * CR-009 §4.1：业务底座原子能力端口。
 * 上层业务服务（Directory/Tracking/Flow/Workbench）只依赖此契约，
 * ZentaoBusinessProvider 与 MemoryBusinessProvider（零禅道依赖）可互换。
 */
export type BusinessObjectRef = Readonly<{
  provider: string;
  instanceHash: string;
  type: string;
  id: string;
}>;

export type PagedList<T> = Readonly<{
  items: readonly T[];
  truncated: boolean;
}>;

export interface BusinessProvider {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly instanceHash: string;
  getCurrentUser(): Promise<CurrentUser>;
  listUsers(): Promise<PagedList<User>>;
  listProducts(): Promise<PagedList<Product>>;
  listProductModules(productId: number): Promise<ProductModule[]>;
  listProductPlans(productId: number): Promise<PagedList<ProductPlan>>;
  listExecutions(): Promise<PagedList<Execution>>;
  listExecutionTasks(executionId: number): Promise<PagedList<Task>>;
  getTaskDetail(taskId: number): Promise<TaskDetail>;
  listProductBugs(productId: number): Promise<PagedList<Bug>>;
  getStoryDetail(storyId: number): Promise<StoryDetail>;
  listProductStories(productId: number): Promise<PagedList<Story>>;
  getStoryDetailV2(storyId: number): Promise<StoryDetailV2>;
  listProductRequirements(productId: number): Promise<PagedList<Story>>;
  getRequirementDetail(requirementId: number): Promise<RequirementDetail>;
  createOperationGateway(options: {
    account: string;
    instanceVersion?: string;
    storyRoles: {
      get(id: number): {
        maintainer?: string | null;
        receiver?: string | null;
      };
    };
    readStepId?: (opId: string, seq: number) => number | null | undefined;
  }): OperationGateway;
  resolveInstanceVersion(): Promise<string | undefined>;
  checkCapability(
    id: string,
    options: Readonly<{
      channel?: "mcp" | "cli";
      instanceVersion?: string;
    }>,
  ): void;
  formatObjectUrl(
    type:
      | "story"
      | "task"
      | "bug"
      | "requirement"
      | "plan"
      | "execution"
      | "comment"
      | "link",
    id: number,
  ): string;
}
