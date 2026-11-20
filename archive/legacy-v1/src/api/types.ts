import type { Priority, StoryCategory } from "../core/config.js";
import type { UserRef } from "../core/normalizer.js";

export const STORY_WRITE_CATEGORIES = ["feature", "design"] as const satisfies readonly StoryCategory[];
export type StoryType = "story" | "requirement";

export interface User {
  id?: number;
  account: string;
  realname: string;
  dept: number;
  role: string;
  pinyin: string;
  deleted: 0 | 1;
}

export interface Department {
  id: number;
  name: string;
  parent: number;
  items: Department[];
}

export interface Product {
  id: number;
  name: string;
  code: string;
  status: string;
  url: string;
}

export interface Module {
  id: number;
  name: string;
  path: string;
}

export interface Plan {
  id: number;
  title: string;
  productId: number;
  parentId?: number;
  parentTitle?: string;
  ownerHint?: string;
  level: "L2" | "L3" | "standalone";
  begin: string;
  end: string;
  status: string;
  url: string;
}

export interface Execution {
  id: number;
  name: string;
  project?: number;
  projectName: string;
  status: string;
  begin: string;
  end: string;
  delay?: number;
  progress?: number;
  totalLeft?: number;
  url: string;
}

export interface TaskMember {
  account: string;
  status: string;
  finishedDate: string;
  left?: number;
}

export interface Task {
  id: number;
  name: string;
  type: string;
  status: string;
  assignedTo: UserRef | null;
  storyId?: number;
  executionId?: number;
  parentId?: number;
  isParent: boolean;
  mode: string;
  deadline?: string;
  left?: number;
  consumed?: number;
  team?: TaskMember[];
  url: string;
}

export interface Story {
  id: number;
  productId?: number;
  title: string;
  type: StoryType | "epic";
  category: string;
  status: string;
  stage: string;
  pri?: number;
  planIds: number[];
  assignedTo: UserRef | null;
  openedBy: UserRef | null;
  feedbackBy: string;
  keywords: string;
  url: string;
}

export interface StoryDetail extends Story {
  moduleId?: number;
  source: string;
  sourceNote: string;
  verify: string;
  spec: string;
  deleted: boolean;
  tasks: Task[];
  executionIds: number[];
  linkedStoryIds: number[];
  actions: StoryAction[];
}

export interface StoryAction {
  id: number;
  action: string;
  actor: UserRef | null;
  date: string;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  scanned: number;
}

export interface Pager {
  pageID: number;
  pageTotal: number;
  recTotal?: number;
  recPerPage?: number;
}

export const MY_TODO_CATEGORIES = [
  "task", "aitask", "story", "bug", "case", "testtask", "requirement", "issue",
  "risk", "reviewissue", "qa", "meeting", "ticket", "feedback", "epic",
] as const;

export type TodoBreakdown = Partial<Record<(typeof MY_TODO_CATEGORIES)[number], number>>;

export interface MyPage<T> {
  items: T[];
  todoCount?: number;
  todoBreakdown?: TodoBreakdown;
  pager: Pager;
}

export interface Todo {
  id: number;
  name: string;
  date: string;
  status: string;
}

export interface StoryPayload {
  title: string;
  spec: string;
  type: "story";
  category: StoryCategory;
  pri: Priority;
  reviewer: [];
  status: "draft" | "active";
  module?: number;
  modules?: number[];
  assignedTo?: string;
  plan?: number;
  feedbackBy?: string;
  source: string;
  sourceNote?: string;
  verify?: string;
  needNotReview?: true;
}

export interface AssignResult {
  id: number;
  url: string;
  requestedAssignedTo: string;
  assignedTo: string | null;
  confirmed: boolean;
  assignError?: string;
}
