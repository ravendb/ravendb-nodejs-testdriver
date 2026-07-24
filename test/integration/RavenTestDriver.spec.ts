import { describe, it, expect, afterAll } from "vitest";
import { DocumentStore, GetDatabaseNamesOperation, IndexDefinition, PutIndexesOperation } from "ravendb";
import type { IDocumentStore } from "ravendb";
import { RavenTestDriver, _disposeGlobalServer } from "../../src/RavenTestDriver";
import { TestServerOptions } from "../../src/TestServerOptions";
import { createTestServerOptions } from "../testOptions";

RavenTestDriver.configureServer(createTestServerOptions());

interface Person {
    name: string;
}

describe("RavenTestDriver", () => {
    const driver = new RavenTestDriver();

    afterAll(async () => {
        await driver.dispose();
        await _disposeGlobalServer();
    });

    it("stores and loads a document", async () => {
        const store = await driver.getDocumentStore();
        {
            const session = store.openSession();
            await session.store<Person>({ name: "Grisha" }, "people/1");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            const person = await session.load<Person>("people/1");
            expect(person?.name).toBe("Grisha");
        }
    });

    it("gives every store its own database", async () => {
        const first = await driver.getDocumentStore(undefined, "isolated");
        const second = await driver.getDocumentStore(undefined, "isolated");
        expect(first.database).not.toBe(second.database);

        {
            const session = first.openSession();
            await session.store<Person>({ name: "OnlyInFirst" }, "people/1");
            await session.saveChanges();
        }
        {
            const session = second.openSession();
            const person = await session.load<Person>("people/1");
            expect(person).toBeNull();
        }
    });

    it("configureServer after server start throws", () => {
        expect(() => RavenTestDriver.configureServer(new TestServerOptions()))
            .toThrow(/Cannot configure server after it was started/);
    });

    it("hard-deletes the database when the store is disposed", async () => {
        const store = await driver.getDocumentStore(undefined, "todelete");
        const databaseName = store.database;
        const urls = store.urls;
        store.dispose();

        const parent = new DocumentStore(urls, "");
        parent.conventions.disableTopologyUpdates = true;
        parent.initialize();
        try {
            // deletion is async — poll up to 10 s
            let names: string[] = [];
            for (let i = 0; i < 100; i++) {
                names = await parent.maintenance.server.send(new GetDatabaseNamesOperation(0, 100));
                if (!names.includes(databaseName)) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            expect(names).not.toContain(databaseName);
        } finally {
            parent.dispose();
        }
    });

    it("driver.dispose() waits for the database deletion to complete before returning", async () => {
        const dedicatedDriver = new RavenTestDriver();
        try {
            const store = await dedicatedDriver.getDocumentStore(undefined, "disposewaits");
            const databaseName = store.database;
            const urls = store.urls;

            await dedicatedDriver.dispose();

            // No polling here: dispose() must only resolve once the
            // DeleteDatabasesOperation triggered by the store's afterDispose
            // handler has actually completed.
            const parent = new DocumentStore(urls, "");
            parent.conventions.disableTopologyUpdates = true;
            parent.initialize();
            try {
                const names = await parent.maintenance.server.send(new GetDatabaseNamesOperation(0, 100));
                expect(names).not.toContain(databaseName);
            } finally {
                parent.dispose();
            }
        } finally {
            await dedicatedDriver.dispose();
        }
    });

    it("setupDatabase constructor option seeds every store", async () => {
        const seedingDriver = new RavenTestDriver({
            setupDatabase: async (store) => {
                const session = store.openSession();
                await session.store<Person>({ name: "Seeded" }, "people/seed");
                await session.saveChanges();
            }
        });
        try {
            const store = await seedingDriver.getDocumentStore(undefined, "seeded");
            const session = store.openSession();
            const seeded = await session.load<Person>("people/seed");
            expect(seeded?.name).toBe("Seeded");
        } finally {
            await seedingDriver.dispose();
        }
    });

    it("subclass hook overrides work", async () => {
        class SeedingTestDriver extends RavenTestDriver {
            protected override async setupDatabase(store: IDocumentStore): Promise<void> {
                const session = store.openSession();
                await session.store<Person>({ name: "SubclassSeeded" }, "people/seed");
                await session.saveChanges();
            }
        }
        const seedingDriver = new SeedingTestDriver();
        try {
            const store = await seedingDriver.getDocumentStore(undefined, "subclassseeded");
            const session = store.openSession();
            const seeded = await session.load<Person>("people/seed");
            expect(seeded?.name).toBe("SubclassSeeded");
        } finally {
            await seedingDriver.dispose();
        }
    });

    it("preConfigureDatabase sees the database record before creation", async () => {
        let seenName = "";
        const hookedDriver = new RavenTestDriver({
            preConfigureDatabase: (record) => {
                seenName = record.databaseName ?? "";
            }
        });
        try {
            const store = await hookedDriver.getDocumentStore(undefined, "preconfigured");
            expect(seenName).toBe(store.database);
        } finally {
            await hookedDriver.dispose();
        }
    });

    it("cleans up the orphaned database when a hook throws", async () => {
        const hookError = new Error("setupDatabase intentionally failed");
        const throwingDriver = new RavenTestDriver({
            setupDatabase: async () => {
                throw hookError;
            }
        });
        try {
            // Learn the server urls from the shared driver's own store so we can
            // inspect the database list without depending on the throwing call
            // ever returning a store.
            const referenceStore = await driver.getDocumentStore();
            const urls = referenceStore.urls;

            await expect(throwingDriver.getDocumentStore(undefined, "hookthrow")).rejects.toThrow(
                "setupDatabase intentionally failed"
            );

            const parent = new DocumentStore(urls, "");
            parent.conventions.disableTopologyUpdates = true;
            parent.initialize();
            try {
                // Cleanup is awaited before the rejection above, so this should
                // already be true; poll briefly anyway to avoid flakiness.
                let names: string[] = [];
                for (let i = 0; i < 50; i++) {
                    names = await parent.maintenance.server.send(new GetDatabaseNamesOperation(0, 200));
                    if (!names.some((n) => n.startsWith("hookthrow_"))) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                expect(names.some((n) => n.startsWith("hookthrow_"))).toBe(false);
            } finally {
                parent.dispose();
            }
        } finally {
            await throwingDriver.dispose();
        }
    });

    it("waitForIndexing waits until the index is not stale", async () => {
        const store = await driver.getDocumentStore(undefined, "indexed");
        {
            const session = store.openSession();
            await session.store({ name: "Alice", "@metadata": { "@collection": "People" } } as any, "people/1");
            await session.store({ name: "Bob", "@metadata": { "@collection": "People" } } as any, "people/2");
            await session.saveChanges();
        }

        const indexDefinition = new IndexDefinition();
        indexDefinition.name = "People/ByName";
        indexDefinition.maps = new Set(["from p in docs.People select new { p.name }"]);
        await store.maintenance.send(new PutIndexesOperation(indexDefinition));

        await driver.waitForIndexing(store);

        {
            const session = store.openSession();
            const results = await session.query<Person>({ indexName: "People/ByName" })
                .whereEquals("name", "Alice")
                .all();
            expect(results).toHaveLength(1);
        }
    });
});
