import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "webhooks",
          include: ["packages/*/src/**/*.test.ts"],
          globalSetup: ["./test/azurite.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "release",
          include: ["scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
