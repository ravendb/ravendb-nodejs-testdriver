import { describe, it, expect, afterAll, vi } from "vitest";
import { RavenTestDriver, _disposeGlobalServer } from "../../src/RavenTestDriver";
import { TestServerOptions } from "../../src/TestServerOptions";
import { createTestServerOptions } from "../testOptions";

// This spec relies on vitest's per-file module isolation: the driver's
// module-level server state is fresh here, so the global server is not
// started until this file's first getDocumentStore() call.

describe("RavenTestDriver.configureServerOnce", () => {
    const driver = new RavenTestDriver();

    afterAll(async () => {
        await driver.dispose();
        await _disposeGlobalServer();
    });

    it("registers lazily, first registration wins, later calls are no-ops", async () => {
        const firstFactory = vi.fn(createTestServerOptions);
        const secondFactory = vi.fn(createTestServerOptions);

        RavenTestDriver.configureServerOnce(firstFactory);
        RavenTestDriver.configureServerOnce(secondFactory);

        // lazy: nothing invoked until the server actually starts
        expect(firstFactory).not.toHaveBeenCalled();
        expect(secondFactory).not.toHaveBeenCalled();

        const store = await driver.getDocumentStore();
        expect(store.database).toBeTruthy();

        expect(firstFactory).toHaveBeenCalledTimes(1);
        expect(secondFactory).not.toHaveBeenCalled();

        // after start: configureServer still throws, configureServerOnce is a safe no-op
        expect(() => RavenTestDriver.configureServer(new TestServerOptions()))
            .toThrow(/Cannot configure server after it was started/);

        const lateFactory = vi.fn(createTestServerOptions);
        expect(() => RavenTestDriver.configureServerOnce(lateFactory)).not.toThrow();
        expect(lateFactory).not.toHaveBeenCalled();

        // second store still comes from the same (first-factory) server
        const another = await driver.getDocumentStore();
        expect(firstFactory).toHaveBeenCalledTimes(1);
        expect(another.urls).toEqual(store.urls);
    });
});
