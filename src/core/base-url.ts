export function normalizeZentaoBaseUrl(input: string): URL | null {
  const url = URL.parse(input);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    return null;
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}
