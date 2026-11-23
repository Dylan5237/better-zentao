export function hasAbsoluteHttpSyntax(value: string): boolean {
  return /^https?:\/\/[^/\\]/iu.test(value) && !/[\s\\]/u.test(value);
}

export function normalizeZentaoBaseUrl(input: string): URL | null {
  if (!hasAbsoluteHttpSyntax(input)) return null;

  const url = URL.parse(input);
  if (
    !url ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    return null;
  }

  try {
    if (/\/api\.php(?:\/|$)/iu.test(decodeURIComponent(url.pathname)))
      return null;
  } catch {
    return null;
  }

  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}
