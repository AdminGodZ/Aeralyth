import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "performance/**/*.perf.ts",
      "deployment/**/*.test.ts",
      "database/migration-contract.test.ts",
      "src/features/dashboard/legacy-folder-manifest.test.ts",
    ],
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
    },
  },
});
