/**
 * Running the embedded server over HTTPS with certificate authentication.
 *
 * Everything the other examples do works unchanged against a secured server —
 * the only difference is in the server options, in `securedServerOptions.ts`.
 * Once `secured()` is configured, the driver builds every document store it
 * hands out with the client certificate, so test code never mentions
 * certificates at all.
 *
 * Mocha runs every file in one process sharing one embedded server, and a
 * secured server is a different server — so this file cannot simply join the
 * one the other files use. Two things make that work, and both depend on this
 * file sorting last (the `07-` prefix; Mocha loads spec files in sorted order):
 *
 *  - `before` stops the shared unsecured server, which also resets the stored
 *    configuration so `configureServer` is allowed again. Any file running after
 *    this one would silently get the secured server instead.
 *  - `after` stops the secured server in turn, leaving the root hook in
 *    `00-root-hooks.test.ts` with nothing to do (it is a no-op when no server is
 *    running).
 */
import * as assert from "node:assert/strict";
import { RavenTestDriver } from "ravendb-test-driver";
import { createSecuredServerOptions } from "./securedServerOptions";
import type { Person } from "./model";

describe("secured server", () => {
    const driver = new RavenTestDriver();

    before(async () => {
        // Retire the shared unsecured server before claiming the slot.
        await RavenTestDriver.stopServer();
        RavenTestDriver.configureServer(createSecuredServerOptions());
    });

    after(async () => {
        await driver.dispose();
        await RavenTestDriver.stopServer();
    });

    it("serves over https", async () => {
        const store = await driver.getDocumentStore();

        assert.match(store.urls[0], /^https:\/\//);
    });

    it("round-trips a document over the secured connection", async () => {
        const store = await driver.getDocumentStore();

        {
            const session = store.openSession();
            await session.store<Person>({ name: "Grisha", age: 30 }, "people/1");
            await session.saveChanges();
        }

        // A fresh session: no identity-map hit, so this really round-trips.
        {
            const session = store.openSession();
            const person = await session.load<Person>("people/1");
            assert.equal(person?.name, "Grisha");
        }
    });

    it("gives each store its own database, as on an unsecured server", async () => {
        const first = await driver.getDocumentStore();
        const second = await driver.getDocumentStore();

        assert.notEqual(first.database, second.database);

        {
            const session = first.openSession();
            await session.store<Person>({ name: "only-in-first", age: 1 }, "people/1");
            await session.saveChanges();
        }

        const session = second.openSession();
        assert.equal(await session.load<Person>("people/1"), null);
    });
});
