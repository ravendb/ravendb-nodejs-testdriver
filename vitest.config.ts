import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.spec.ts"],
        testTimeout: 300_000,
        hookTimeout: 300_000,
        passWithNoTests: true,
        pool: "forks",
        fileParallelism: false
    }
});
