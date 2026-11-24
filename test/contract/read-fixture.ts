import { readFileSync } from "node:fs";
import { afterEach, vi } from "vitest";
import { z } from "zod";
import { createZentaoReadClient } from "../../src/api/client.ts";

const fixtureSchema = z.strictObject({
  endpoint: z.string(),
  status: z.int(),
  body: z.unknown(),
});
const mockBaseUrl = "https://zentao.fixture.test/zentao/";

export function readFixture(name: string) {
  const file = name.endsWith(".json") ? name : `${name}.json`;
  if (!/^[a-z0-9-]+(?:\.empty)?\.json$/u.test(file))
    throw new Error("Invalid fixture name");
  const url = new URL(`../fixtures/zentao-22.6/${file}`, import.meta.url);
  return fixtureSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

export function mockReadClient(respond: (url: URL) => Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, request) => {
    const url = new URL(String(input));
    if (
      url.origin !== new URL(mockBaseUrl).origin ||
      request?.redirect !== "error"
    ) {
      throw new Error("Unexpected fixture origin or redirect policy");
    }
    if (
      request.method === "POST" &&
      url.pathname === "/zentao/api.php/v1/tokens"
    ) {
      return Response.json(
        { token: "offline-contract-token" },
        { status: 201 },
      );
    }
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      new Headers(request.headers).get("Token") !== "offline-contract-token"
    ) {
      throw new Error("Unexpected method, payload or token");
    }
    return respond(url);
  });
  vi.stubGlobal("fetch", fetch);
  const client = createZentaoReadClient({
    baseUrl: mockBaseUrl,
    account: "acct_fixture",
    password: "offline-contract-password",
    clock: () => 0,
    logSink: () => undefined,
  });
  return { client, fetch };
}

interface FixtureOptions {
  readonly transform?: (body: unknown) => unknown;
  readonly path?: string;
  readonly query?: Readonly<Record<string, string | number>>;
}

export function mockReadFixture(name: string, options: FixtureOptions = {}) {
  const fixture = readFixture(name);
  return mockReadClient((url) => {
    const path = options.path;
    if (
      path !== undefined &&
      url.pathname !== path &&
      url.pathname !== `/zentao${path}`
    ) {
      throw new Error("Unexpected endpoint for contract fixture");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (url.searchParams.get(key) !== String(value))
        throw new Error("Unexpected query for contract fixture");
    }
    const body = options.transform
      ? options.transform(fixture.body)
      : fixture.body;
    return Response.json(body, { status: fixture.status });
  });
}

afterEach(() => vi.unstubAllGlobals());
