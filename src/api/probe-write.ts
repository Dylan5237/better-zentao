import { z } from "zod";
import type { Clock } from "../core/clock.ts";
import { PROBE_PRODUCT_ID } from "../core/config-checks.ts";
import type { RequiredFieldsMap } from "../core/dto/metadata.ts";
import { zCount, zId } from "../core/dto/common.ts";
import { BztError } from "../core/errors.ts";
import type { ZentaoReadClient } from "./client.ts";
import { createCaptureFixtures } from "./internal/capture-fixture.ts";
import {
  getProbeOwnershipOptions,
  readProbeOwnership,
} from "./internal/probe-scope.ts";
import {
  createProbeWriteApproval,
  getProbeWriteRoute,
  readProbeWriteResponse,
  sendAuthenticatedProbeWrite,
} from "./internal/probe-transport.ts";
import { getReadClient } from "./internal/read-client.ts";
import { assertSanitizedJson } from "./internal/fixture-sensitivity.ts";
import { getRequiredFields, listUsers } from "./org.ts";
import type { SanitizedFixture } from "./probe-capture.ts";

export interface ProbeDraft {
  product: 29;
  type: "story";
  module: number;
  modules: readonly number[];
  plan?: number;
  category: "feature" | "design";
  source: "user";
  feedbackBy?: string;
  title: string;
  pri: number;
  spec: string;
  verify: string;
  assignedTo: string;
  reviewer: readonly never[];
  status: "draft";
}

export type ProbeRequest = { productId: 29 } & (
  | { action: "story.create"; body: ProbeDraft }
  | ({ id: number } & (
      | { action: "story.assign"; body: { assignedTo: string } }
      | { action: "story.close"; body: { closedReason: "cancel" } }
      | { action: "story.edit"; body: { title: string; keywords: string } }
      | { action: "story.comment"; body: { comment: string }; candidate?: "v2" }
      | {
          action: "story.activate";
          body: { comment?: string };
          candidate?: undefined;
        }
      | {
          action: "story.activate";
          body: { status: "active" };
          candidate: "put";
        }
    ))
);

export interface ProbeWriteScope {
  readonly moduleIds: readonly number[];
  readonly openPlanIds: readonly number[];
  readonly projectsCount: number | null;
  readonly executionsCount: number | null;
}

export interface ProbeWriteResponse {
  readonly route: string;
  readonly httpStatus?: number;
  readonly storyId?: number;
  readonly accepted: boolean;
  readonly clearlyRejected: boolean;
  readonly candidateUnavailable?: boolean;
  readonly missingFields?: readonly string[];
  readonly fixture?: SanitizedFixture;
  readonly fixtureFailed?: boolean;
}

const reportableFields = new Set([
  "assignedTo",
  "category",
  "closedReason",
  "estimate",
  "feedbackBy",
  "keywords",
  "module",
  "modules",
  "plan",
  "pri",
  "product",
  "reviewer",
  "source",
  "sourceNote",
  "spec",
  "status",
  "title",
  "type",
  "verify",
]);

function checkRequired(
  request: ProbeRequest,
  fields: RequiredFieldsMap["story"],
  active: ReadonlySet<string>,
): readonly string[] {
  const required =
    request.action === "story.create"
      ? fields.create
      : request.action === "story.edit"
        ? fields.edit
        : request.action === "story.close"
          ? fields.close
          : undefined;
  const body: Readonly<Record<string, unknown>> = { ...request.body };
  const missing = (required ?? []).filter((field) => {
    const value = Object.hasOwn(body, field) ? body[field] : undefined;
    return (
      value === undefined || (typeof value === "string" && value.trim() === "")
    );
  });
  if (
    (request.action === "story.create" || request.action === "story.assign") &&
    !active.has(request.body.assignedTo)
  )
    missing.push("assignedTo");
  return [
    ...new Set(
      missing.map((field) =>
        reportableFields.has(field) ? field : "[未知字段]",
      ),
    ),
  ];
}

const productLinksDto = z.object({
  id: zId.refine((id) => id === PROBE_PRODUCT_ID),
  projects: zCount.optional(),
  executions: zCount.optional(),
  projectsCount: zCount.optional(),
  executionsCount: zCount.optional(),
});

async function readProbeProductLinks(client: ZentaoReadClient) {
  // 研究记录 §六。旧实例未返回计数时不从其他产品的执行列表推断归属。
  try {
    return await getReadClient(client).http.read(
      {
        pathTemplate: "/api.php/v1/products/{id}",
        params: { id: PROBE_PRODUCT_ID },
        query: { fields: "projects,executions" },
        objectId: PROBE_PRODUCT_ID,
      },
      productLinksDto,
    );
  } catch {
    return undefined;
  }
}

export async function createProbeWriteSession(
  client: ZentaoReadClient,
  options: {
    account: string;
    password: string;
    clock: Clock;
    timeoutMs: number;
    capture: boolean;
    cleanupOnly: boolean;
  },
): Promise<{
  scope?: ProbeWriteScope;
  send: (request: ProbeRequest) => Promise<ProbeWriteResponse>;
}> {
  const { baseUrl } = getReadClient(client);
  const [ownership, links, required, directory] = await Promise.all([
    options.cleanupOnly ? undefined : readProbeOwnership(client),
    options.cleanupOnly ? undefined : readProbeProductLinks(client),
    getRequiredFields(client),
    options.cleanupOnly ? undefined : listUsers(client),
  ]);
  if (directory?.truncated) {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "人员目录回读不完整。");
  }
  const active = new Set(
    directory?.items
      .filter((entry) => !entry.deleted)
      .map(({ account }) => account),
  );
  const owned = ownership ? getProbeOwnershipOptions(ownership) : undefined;
  const scope = owned && {
    moduleIds: owned.modules,
    openPlanIds: owned.openPlans,
    projectsCount: links?.projects ?? links?.projectsCount ?? null,
    executionsCount: links?.executions ?? links?.executionsCount ?? null,
  };
  const isAssigneeActive = (account: string) => active.has(account);

  return {
    scope,
    async send(request) {
      const missingFields = checkRequired(request, required.story, active);
      if (missingFields.length)
        return {
          route: "",
          accepted: false,
          clearlyRejected: false,
          missingFields,
        };
      // 只接受由严格配方导出的端点，批准签发后由发送层验证并一次性消耗。
      const route = getProbeWriteRoute(request);
      const approval = createProbeWriteApproval(
        {
          baseUrl,
          route,
          expiresAt: options.clock() + 30_000,
          clock: options.clock,
        },
        request,
      );
      const response = await sendAuthenticatedProbeWrite(
        {
          baseUrl,
          clock: options.clock,
          client,
          approval,
          env: { ZENTAO_TIMEOUT_MS: String(options.timeoutMs) },
          ownership,
          preflight: {
            isPlanOpen: (instance, plan) =>
              instance === baseUrl &&
              (scope?.openPlanIds.includes(plan) ?? false),
            isAssigneeActive: (instance, account) =>
              instance === baseUrl && isAssigneeActive(account),
          },
        },
        request,
      );
      if (!(response instanceof Response)) {
        return { route, accepted: false, clearlyRejected: false };
      }
      const httpStatus = response.status;
      const {
        body,
        createdStoryId: storyId,
        recognizedFailure,
        sessionToken,
      } = await readProbeWriteResponse(response);
      const candidateUnavailable = httpStatus === 404 || httpStatus === 405;
      const clearlyRejected =
        storyId === undefined &&
        (candidateUnavailable || (response.ok && recognizedFailure));
      const accepted = response.ok && !recognizedFailure;
      let fixture: SanitizedFixture | undefined;
      let fixtureFailed = false;
      if (options.capture && accepted) {
        try {
          const knownSecrets = [options.password, baseUrl, sessionToken ?? ""];
          const requestBody = Object.fromEntries(
            Object.entries(request.body).filter(
              ([, value]) => value !== undefined,
            ),
          );
          [fixture] = createCaptureFixtures(
            [
              {
                endpoint: route,
                status: httpStatus,
                body: { request: requestBody, response: body },
                sample: "normal",
              },
            ],
            {
              configuredAccount: options.account,
              knownSecrets,
            },
          );
          if (fixture)
            assertSanitizedJson(
              {
                endpoint: fixture.endpoint,
                status: fixture.status,
                body: fixture.body,
              },
              knownSecrets,
              [options.account],
            );
        } catch {
          fixture = undefined;
          fixtureFailed = true;
        }
      }
      return {
        route,
        httpStatus,
        storyId,
        accepted,
        clearlyRejected,
        candidateUnavailable,
        fixture,
        fixtureFailed,
      };
    },
  };
}
