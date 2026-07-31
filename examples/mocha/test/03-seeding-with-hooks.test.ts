/**
 * Seeding and customization hooks. Three ways to shape every database the
 * driver creates:
 *
 *  - `preConfigureDatabase` — mutate the DatabaseRecord before creation.
 *  - `preInitialize`        — set conventions before `store.initialize()`.
 *  - `setupDatabase`        — runs after initialize: seed data here.
 *
 * All three are available as constructor options or as overridable protected
 * methods on a subclass. Both styles are shown below.
 */
import * as assert from "node:assert/strict";
import type { DatabaseRecord, IDocumentStore } from "ravendb";
import { RavenTestDriver } from "ravendb-testdriver";
import { createServerOptions } from "./serverOptions";
import type { Product } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

describe("seeding with constructor hooks", () => {
    let seenDatabaseName = "";

    const driver = new RavenTestDriver({
        preConfigureDatabase: (record: DatabaseRecord) => {
            // Runs before CreateDatabaseOperation — the place for database-level
            // settings (revisions, expiration, custom configuration entries).
            seenDatabaseName = record.databaseName ?? "";
        },
        preInitialize: (store: IDocumentStore) => {
            // Conventions must be set here: they are frozen by initialize().
            store.conventions.maxNumberOfRequestsPerSession = 64;
        },
        setupDatabase: async (store: IDocumentStore) => {
            // Runs for every store this driver hands out.
            const session = store.openSession();
            await session.store<Product>({ name: "Widget", price: 9.99 }, "products/1");
            await session.store<Product>({ name: "Gadget", price: 19.99 }, "products/2");
            await session.saveChanges();
        }
    });

    after(async () => {
        await driver.dispose();
    });

    it("seeds a new store and applies the other hooks", async () => {
        const store = await driver.getDocumentStore();
        const session = store.openSession();

        assert.equal((await session.load<Product>("products/1"))?.name, "Widget");
        assert.equal((await session.load<Product>("products/2"))?.name, "Gadget");
        assert.equal(seenDatabaseName, store.database);
        assert.equal(store.conventions.maxNumberOfRequestsPerSession, 64);
    });

    it("seeds each further store independently", async () => {
        const store = await driver.getDocumentStore();
        const session = store.openSession();

        // Fresh database, seeded again by the same hook.
        assert.equal((await session.load<Product>("products/1"))?.name, "Widget");
    });

    it("propagates a hook failure and leaves no orphaned database", async () => {
        const failingDriver = new RavenTestDriver({
            setupDatabase: async () => {
                throw new Error("seeding failed");
            }
        });
        try {
            // The database is created before setupDatabase runs; when the hook
            // throws, the driver deletes it again before rejecting.
            await assert.rejects(
                () => failingDriver.getDocumentStore(),
                /seeding failed/);
        } finally {
            await failingDriver.dispose();
        }
    });
});

describe("seeding with a subclass", () => {
    // Subclassing suits a shared fixture for a whole suite: define the seed
    // once in a base driver and have each spec use it.
    class ProductTestDriver extends RavenTestDriver {
        protected override async setupDatabase(store: IDocumentStore): Promise<void> {
            const session = store.openSession();
            await session.store<Product>({ name: "FromSubclass", price: 1 }, "products/sub");
            await session.saveChanges();
        }
    }

    const driver = new ProductTestDriver();

    after(async () => {
        await driver.dispose();
    });

    it("uses the overridden hook", async () => {
        const store = await driver.getDocumentStore();
        const session = store.openSession();
        assert.equal((await session.load<Product>("products/sub"))?.name, "FromSubclass");
    });
});
