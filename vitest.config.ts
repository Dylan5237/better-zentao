import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include:
      mode === "smoke"
        ? ["test/smoke/**/*.test.ts"]
        : ["test/{unit,contract,service,adapters}/**/*.test.ts"],
    testTimeout: mode === "smoke" ? 120_000 : 15_000,
    coverage: {
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      thresholds: {
        lines: 80,
        "scripts/eval.ts": { lines: 80 },
        "src/{api,core/dto}/**/*.ts": { lines: 85 },
        "src/{domain,rules}/**/*.ts": { lines: 95, branches: 90 },
        "src/services/operation.ts": { lines: 95, branches: 90 },
      },
    },
  },
}));
