import type { StoryDetail } from "../core/dto/story.ts";
import type { User } from "../core/dto/org.ts";
import { parseStoryRoleTag } from "./story-html-spec.ts";

type DirectoryEntry = Pick<User, "account" | "realname"> &
  Partial<Pick<User, "deleted">>;
type Account = string | null;

interface RoleInput {
  readonly story: Pick<
    StoryDetail,
    "spec" | "feedbackBy" | "openedBy" | "assignedTo"
  >;
  readonly directory?: readonly DirectoryEntry[];
  readonly intake?: { readonly feedbackByAccount?: Account };
  readonly stored?: {
    readonly maintainer?: Account;
    readonly receiver?: Account;
  };
  readonly module?: {
    readonly maintainer?: Account;
    readonly devLead?: Account;
  };
  readonly crossModule?: {
    readonly requester: string;
    readonly dependencyDevLead?: Account;
  };
}

type FeedbackMatch =
  | { readonly text: string; readonly account: Account }
  | {
      readonly text: string;
      readonly code: "AMBIGUOUS_ENTITY";
      readonly candidates: readonly string[];
    };

function matchFeedback(
  text: string,
  directory: readonly DirectoryEntry[],
): FeedbackMatch {
  const query = text.toLowerCase();
  const exact = directory.filter(
    ({ account, realname }) =>
      account.toLowerCase() === query || realname.toLowerCase() === query,
  );
  const matches = exact.length
    ? exact
    : directory.filter(({ realname }) =>
        realname.toLowerCase().includes(query),
      );
  const candidates = [...new Set(matches.map(({ account }) => account))];
  if (candidates.length > 1)
    return { text, code: "AMBIGUOUS_ENTITY", candidates };
  return { text, account: candidates[0] ?? null };
}

function resolveFeedback(input: RoleInput) {
  const account = input.intake?.feedbackByAccount;
  if (account)
    return { original: account, matches: [{ text: account, account }] };
  const original = input.story.feedbackBy ?? null;
  const directory = (input.directory ?? []).filter(({ deleted }) => !deleted);
  const tokens =
    original
      ?.split(/[、，,;]/u)
      .map((text) => text.trim())
      .filter(Boolean) ?? [];
  return {
    original,
    matches: tokens.map((text) => matchFeedback(text, directory)),
  };
}

// docs/04 §2、docs/06 Q13 角色回退逐字段进行，反馈者歧义保留候选。
export function resolveStoryRoles(input: RoleInput) {
  const { story, stored, module, crossModule } = input;
  const tag = parseStoryRoleTag(story.spec ?? "");
  const proposer = story.openedBy ?? null;
  return {
    proposer,
    currentHandler: story.assignedTo ?? null,
    // docs/03 N10 跨模块由发起方维护，被依赖模块的研发主管接收。
    maintainer:
      tag?.maintainer ??
      stored?.maintainer ??
      crossModule?.requester ??
      module?.maintainer ??
      proposer,
    receiver:
      tag?.receiver ??
      stored?.receiver ??
      (crossModule ? crossModule.dependencyDevLead : module?.devLead) ??
      null,
    feedback: resolveFeedback(input),
  };
}
