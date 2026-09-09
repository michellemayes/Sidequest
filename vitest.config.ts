import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Keep the informational session logs out of test output.
    env: { CCSLACK_LOG_LEVEL: "error" },
  },
});
