import { vi } from "vitest";

export const deleteStoryEnv = {
  ZENTAO_BASE_URL: "https://delete.fixture.test",
  ZENTAO_ACCOUNT: "delete_fixture",
  ZENTAO_PASSWORD: "delete-fixture-password",
  BZT_LOG_LEVEL: "debug",
};
const token = "delete-fixture-session";
const spec = "删除测试的私有正文";
const title = "删除测试的私有标题";
export const deleteStorySecrets = [
  deleteStoryEnv.ZENTAO_PASSWORD,
  token,
  spec,
  title,
];

export function fakeDeleteStory(
  mode:
    | "normal"
    | "timeout"
    | "disconnected"
    | "still-present"
    | "missing"
    | "denied"
    | "wrong-id" = "normal",
) {
  const requests: string[] = [];
  let attempted = false;
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push(method + " " + url.pathname);
      if (url.origin !== deleteStoryEnv.ZENTAO_BASE_URL)
        throw new Error("离线测试禁止访问外部地址。");
      if (url.pathname === "/api.php/v1/tokens" && method === "POST")
        return Response.json({ token }, { status: 201 });
      if (url.pathname !== "/api.php/v1/stories/31")
        throw new Error("离线测试收到未定义的请求。");
      if (method === "DELETE") {
        attempted = true;
        if (mode === "denied") return Response.json({ spec }, { status: 403 });
        deleted = mode !== "still-present";
        if (mode === "timeout") throw new Error(token);
        return new Response(null, { status: 204 });
      }
      if (method !== "GET") throw new Error("非法请求方法。");
      if (attempted && mode === "disconnected")
        return Response.json({ spec }, { status: 403 });
      if (deleted || mode === "missing")
        return Response.json({ spec }, { status: 404 });
      return Response.json({
        id: mode === "wrong-id" ? 32 : 31,
        type: "story",
        product: 29,
        title,
        status: "draft",
        spec,
        password: deleteStoryEnv.ZENTAO_PASSWORD,
      });
    }),
  );
  return requests;
}
