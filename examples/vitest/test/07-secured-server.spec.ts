/**
 * Running the embedded server over HTTPS with certificate authentication.
 *
 * Everything the other examples do works unchanged against a secured server —
 * the only difference is in the server options, in `securedServerOptions.ts`.
 * Once `secured()` is configured, the driver builds every document store it
 * hands out with the client certificate, so test code never mentions
 * certificates at all.
 *
 * Note this file uses `configureServer` (eager, single-shot), not the
 * `configureServerOnce` the other examples use. A secured server is a different
 * server, and the driver keeps one shared server per process — so this example
 * runs in its own file with `fileParallelism: false` keeping it off the
 * unsecured server's toes, and stops the server afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RavenTestDriver } from "ravendb-test-driver";
import { createSecuredServerOptions } from "./securedServerOptions";
import type { Person } from "./model";

describe("secured server", () => {
    const driver = new RavenTestDriver();

    beforeAll(() => {
        RavenTestDriver.configureServer(createSecuredServerOptions());
    });

    afterAll(async () => {
        await driver.dispose();
        // Leave no secured server behind for the other example files.
        await RavenTestDriver.stopServer();
    });

    it("serves over https", async () => {
        const store = await driver.getDocumentStore();

        expect(store.urls[0]).toMatch(/^https:\/\//);
    });

    it("round-trips a document over the secured connection", async () => {
        const store = await driver.getDocumentStore();

        {
            const session = store.openSession();
            await session.store<Person>({ name: "Grisha", age: 30 }, "people/1");
            await session.saveChanges();
        }

        {
            const session = store.openSession();
            const person = await session.load<Person>("people/1");
            expect(person?.name).toBe("Grisha");
        }
    });

    it("gives each store its own database, as on an unsecured server", async () => {
        const first = await driver.getDocumentStore();
        const second = await driver.getDocumentStore();

        expect(first.database).not.toBe(second.database);

        {
            const session = first.openSession();
            await session.store<Person>({ name: "only-in-first", age: 1 }, "people/1");
            await session.saveChanges();
        }

        const session = second.openSession();
        expect(await session.load<Person>("people/1")).toBeNull();
    });
});
