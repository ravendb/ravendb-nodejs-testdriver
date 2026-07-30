import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.spec.ts"],

        // Starting the embedded server — and on the very first run, downloading
        // the RavenDB binaries — takes far longer than vitest's 5s default.
        testTimeout: 300_000,
        hookTimeout: 300_000,

        // The driver keeps one embedded server per Node process, at module scope.
        // Vitest's default is one worker process per file, which would start one
        // server per file. `pool: "forks"` + `fileParallelism: false` runs every
        // file sequentially in a single fork, so the one server is reused.
        //
        // (`poolOptions.forks.singleFork` does not apply here — Vitest 4 removed it.)
        pool: "forks",
        fileParallelism: false
    }
});
