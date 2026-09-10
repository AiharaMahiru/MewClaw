import { defineConfig } from "vitest/config";

const EXTERNAL_E2E_TIMEOUT_MS = 180_000;

if (process.env.DSH_RUN_EXTERNAL_E2E !== "1") {
  throw new Error("Set DSH_RUN_EXTERNAL_E2E=1 before running external E2E tests.");
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/knowledge-e2e.test.ts"],
    hookTimeout: EXTERNAL_E2E_TIMEOUT_MS,
    testTimeout: EXTERNAL_E2E_TIMEOUT_MS,
  },
});
