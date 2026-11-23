import { expect, it } from "vitest";
import { createFixtureSanitizer } from "../../src/api/internal/fixture-sanitizer.ts";

it.each([" -->", ""])(
  "WP-03 角色注释与账号字段使用相同别名（结束符 %j）",
  (ending) => {
    const account = "secret.user";
    const sanitized = createFixtureSanitizer().sanitize({
      account,
      spec: `<!-- bzt:v1 maintainer=${account}${ending}`,
    });

    expect(sanitized).toEqual({
      account: "acct_001",
      spec: "<!-- bzt:v1 maintainer=acct_001 -->",
    });
  },
);
