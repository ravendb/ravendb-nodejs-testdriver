/**
 * Why the driver exists: test isolation.
 *
 * Every `getDocumentStore()` call gets its own database, so tests can write
 * conflicting data without interfering. The second argument is a database-name
 * prefix (default "test"); the driver appends a counter, so reusing the same
 * prefix still yields distinct databases.
 */
import * as assert from "node:assert/strict";
import { RavenTestDriver } from "ravendb-test-driver";
import { createServerOptions } from "./serverOptions";
import type { Person } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

describe("isolated databases", () => {
    const driver = new RavenTestDriver();

    after(async () => {
        await driver.dispose();
    });

    it("gives each store its own database", async () => {
        const first = await driver.getDocumentStore(undefined, "isolated");
        const second = await driver.getDocumentStore(undefined, "isolated");

        assert.notEqual(first.database, second.database);

        {
            const session = first.openSession();
            await session.store<Person>({ name: "OnlyInFirst", age: 1 }, "people/1");
            await session.saveChanges();
        }

        // Same document id, different database: nothing to load.
        {
            const session = second.openSession();
            assert.equal(await session.load<Person>("people/1"), null);
        }
    });

    it("shares one embedded server across all stores", async () => {
        const first = await driver.getDocumentStore();
        const second = await driver.getDocumentStore();

        assert.deepEqual(first.urls, second.urls);
        assert.notEqual(first.database, second.database);
    });

    it("drops the database as soon as its store is disposed", async () => {
        const store = await driver.getDocumentStore(undefined, "shortlived");
        {
            const session = store.openSession();
            await session.store<Person>({ name: "Ephemeral", age: 1 }, "people/1");
            await session.saveChanges();
        }

        // Disposing the store triggers a hard delete of its database. No need to
        // do this by hand in normal tests — driver.dispose() disposes every store.
        store.dispose();
    });

    it("scopes a driver to a single test with `await using`", async () => {
        // RavenTestDriver implements AsyncDisposable, so a per-test driver can be
        // declared with `await using` and is disposed at the end of the block —
        // no afterEach needed. Requires TypeScript 5.2+ and the
        // "ESNext.Disposable" lib (see tsconfig.json).
        await using scopedDriver = new RavenTestDriver();

        const store = await scopedDriver.getDocumentStore(undefined, "scoped");
        const session = store.openSession();
        await session.store<Person>({ name: "Scoped", age: 1 }, "people/1");
        await session.saveChanges();

        assert.match(store.database, /^scoped_/);
    });
});
