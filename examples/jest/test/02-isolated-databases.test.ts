/**
 * Why the driver exists: test isolation.
 *
 * Every `getDocumentStore()` call gets its own database, so tests can write
 * conflicting data without interfering. The second argument is a database-name
 * prefix (default "test"); the driver appends a counter, so reusing the same
 * prefix still yields distinct databases.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { RavenTestDriver } from "ravendb-test-driver";
import { createServerOptions } from "./serverOptions";
import { stopServerAfterAll } from "./stopServerAfterAll";
import type { Person } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

// Required for Jest: stops this file's embedded server so the run can exit.
stopServerAfterAll();

describe("isolated databases", () => {
    const driver = new RavenTestDriver();

    afterAll(async () => {
        await driver.dispose();
    });

    it("gives each store its own database", async () => {
        const first = await driver.getDocumentStore(undefined, "isolated");
        const second = await driver.getDocumentStore(undefined, "isolated");

        expect(first.database).not.toBe(second.database);

        {
            const session = first.openSession();
            await session.store<Person>({ name: "OnlyInFirst", age: 1 }, "people/1");
            await session.saveChanges();
        }

        // Same document id, different database: nothing to load.
        {
            const session = second.openSession();
            expect(await session.load<Person>("people/1")).toBeNull();
        }
    });

    it("shares one embedded server across all stores", async () => {
        const first = await driver.getDocumentStore();
        const second = await driver.getDocumentStore();

        expect(first.urls).toEqual(second.urls);
        expect(first.database).not.toBe(second.database);
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

        expect(store.database).toMatch(/^scoped_/);
    });
});
