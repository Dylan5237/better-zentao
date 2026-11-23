import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/{unit,contract,service,adapters}/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      thresholds: {
        lines: 80,
        "src/{api,core/dto}/**/*.ts": { lines: 85 },
        "src/{domain,rules}/**/*.ts": { lines: 95, branches: 90 },
        "src/services/operation.ts": { lines: 95, branches: 90 },
      },
    },
  },
});
