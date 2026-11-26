import { normalizeZentaoBaseUrl } from "../core/base-url.ts";

const idFields = new Map([
  ["story", "storyID"],
  ["requirement", "storyID"],
  ["epic", "storyID"],
  ["task", "taskID"],
  ["bug", "bugID"],
  ["execution", "executionID"],
  ["project", "projectID"],
  ["productplan", "planID"],
  ["product", "productID"],
]);

export function portalLinkProjector(
  baseUrl: string,
  requestType?: string,
  moduleVar = "m",
  methodVar = "f",
) {
  const base = normalizeZentaoBaseUrl(baseUrl);
  if (!base || requestType !== "GET") return (value: unknown) => value;

  function rewrite(value: string) {
    return value.replace(
      /https?:\/\/[^\s<>()\[\]，。；、]+?\.html(?=$|[^\w/#?])/gu,
      (match) => {
        const url = URL.parse(match);
        if (
          !url ||
          url.origin !== base?.origin ||
          !url.pathname.startsWith(base.pathname)
        )
          return match;
        const parts = /^([a-z]+)-(view|edit)-([1-9]\d*)\.html$/u.exec(
          url.pathname.slice(base.pathname.length),
        );
        if (!parts) return match;
        const [, module, method, id] = parts;
        const idField = module && idFields.get(module);
        if (!idField || !method || !id) return match;
        const target = new URL("index.php", base);
        target.searchParams.set(moduleVar, module);
        target.searchParams.set(methodVar, method);
        target.searchParams.set(idField, id);
        return target.href;
      },
    );
  }

  function project(value: unknown, key?: string): unknown {
    if (typeof value === "string")
      return key &&
        ["url", "message", "card", "nextActions", "hints"].includes(key)
        ? rewrite(value)
        : value;
    if (Array.isArray(value)) return value.map((entry) => project(entry, key));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([field, entry]) => [
          field,
          project(entry, field),
        ]),
      );
    return value;
  }

  return project;
}
