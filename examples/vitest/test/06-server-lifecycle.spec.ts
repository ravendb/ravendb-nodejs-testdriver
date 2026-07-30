/**
 * Server lifecycle and configuration.
 *
 * The embedded server is a module-level singleton: it starts lazily on the first
 * `getDocumentStore()` call anywhere in the process, and it deliberately
 * survives `driver.dispose()` so later test files reuse it.
 *
 *  - `configureServerOnce(factory)` — idempotent, so every test file can call it
 *    at import time without coordinating. First registration wins, later calls
 *    are no-ops (even after the server started), and the factory runs at most
 *    once, when the server actually starts.
 *  - `configureServer(options)` — eager, single-shot: throws if the server is
 *    already running. Use it when exactly one place owns the configuration.
 *  - `stopServer()` — stops the shared server and resets its configuration.
 *    Usually unnecessary under vitest with `pool: "forks"` (the fork exits and
 *    the server goes with it), but required for in-process runners like Jest and
 *    Mocha, which otherwise hang on the live child-process handle.
 */
import { afterAll, describe, expect, it } from "vitest";
import { RavenTestDriver, TestServerOptions } from "ravendb-test-driver";
import { createServerOptions } from "./serverOptions";

// The call every example file makes. Safe to repeat across files.
RavenTestDriver.configureServerOnce(createServerOptions);

describe("server lifecycle", () => {
    const driver = new RavenTestDriver();

    afterAll(async () => {
        await driver.dispose();
    });

    it("starts the server lazily, on the first store", async () => {
        const store = await driver.getDocumentStore();

        // A real URL means the server is up.
        expect(store.urls[0]).toMatch(/^http/);
    });

    it("rejects configureServer once the server is running", async () => {
        await driver.getDocumentStore();

        expect(() => RavenTestDriver.configureServer(new TestServerOptions()))
            .toThrow(/Cannot configure server after it was started/);
    });

    it("treats a late configureServerOnce as a no-op", async () => {
        await driver.getDocumentStore();

        let called = false;
        const lateFactory = () => {
            called = true;
            return createServerOptions();
        };

        // No throw, and the factory is never invoked — which is exactly why test
        // files can call configureServerOnce unconditionally at import time.
        expect(() => RavenTestDriver.configureServerOnce(lateFactory)).not.toThrow();
        expect(called).toBe(false);
    });

    it("keeps the server alive across driver instances", async () => {
        const firstDriver = new RavenTestDriver();
        const firstStore = await firstDriver.getDocumentStore();
        const urls = firstStore.urls;
        await firstDriver.dispose();

        // dispose() dropped the store and its database, not the server.
        const secondDriver = new RavenTestDriver();
        try {
            const secondStore = await secondDriver.getDocumentStore();
            expect(secondStore.urls).toEqual(urls);
        } finally {
            await secondDriver.dispose();
        }
    });

    // Note: `RavenTestDriver.stopServer()` is not exercised here on purpose —
    // it would tear down the server shared with the other example files. See the
    // jest/ and mocha/ examples, where it is required in a final teardown hook.
});
