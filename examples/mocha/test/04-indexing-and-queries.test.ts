/**
 * Indexes are updated in the background, so a query issued right after a write
 * can miss it. The driver offers two ways to wait for indexing to settle:
 *
 *  - `driver.waitForIndexing(store)` — explicit, call it where you need it.
 *  - `getDocumentStore({ waitForIndexingTimeout })` — waits once, right after
 *    the store (and its seed data) is ready.
 *
 * On timeout, waitForIndexing throws with the server-side index errors included
 * in the message, which is usually enough to see what went wrong.
 */
import * as assert from "node:assert/strict";
import { AbstractJavaScriptIndexCreationTask } from "ravendb";
import { RavenTestDriver } from "ravendb-test-driver";
import { createServerOptions } from "./serverOptions";
import type { Product } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

/** Static index over the Products collection. */
class Products_ByName extends AbstractJavaScriptIndexCreationTask<Product> {
    public constructor() {
        super();
        this.map("Products", p => ({ name: p.name, price: p.price }));
    }
}

describe("indexing and queries", () => {
    const driver = new RavenTestDriver({
        setupDatabase: async (store) => {
            const session = store.openSession();
            // "@collection" metadata puts the documents in the Products collection,
            // which is what the index above maps.
            await session.store<Product>(
                { name: "Widget", price: 9.99, "@metadata": { "@collection": "Products" } } as Product,
                "products/1");
            await session.store<Product>(
                { name: "Gadget", price: 19.99, "@metadata": { "@collection": "Products" } } as Product,
                "products/2");
            await session.saveChanges();

            await new Products_ByName().execute(store);
        }
    });

    after(async () => {
        await driver.dispose();
    });

    it("queries a static index after waitForIndexing", async () => {
        const store = await driver.getDocumentStore();

        // Without this, the query below may return zero results.
        await driver.waitForIndexing(store);

        const session = store.openSession();
        const results = await session.query<Product>({ indexName: "Products/ByName" })
            .whereEquals("name", "Widget")
            .all();

        assert.equal(results.length, 1);
        assert.equal(results[0].price, 9.99);
    });

    it("waits for indexing while handing out the store", async () => {
        // Equivalent to calling waitForIndexing right after getDocumentStore,
        // in one step. The timeout is in milliseconds.
        const store = await driver.getDocumentStore({ waitForIndexingTimeout: 60_000 });

        const session = store.openSession();
        const results = await session.query<Product>({ indexName: "Products/ByName" })
            .whereGreaterThan("price", 10)
            .all();

        assert.equal(results.length, 1);
        assert.equal(results[0].name, "Gadget");
    });

    it("queries a collection directly with waitForNonStaleResults", async () => {
        // For an auto-index the client can wait on the query itself, which is an
        // alternative to waitForIndexing when only one query needs it.
        const store = await driver.getDocumentStore();

        const session = store.openSession();
        const results = await session.query<Product>({ collection: "Products" })
            .waitForNonStaleResults()
            // "Double" is required: the default ordering is lexicographic, which
            // would sort 19.99 before 9.99.
            .orderBy("price", "Double")
            .all();

        assert.deepEqual(results.map(p => p.name), ["Widget", "Gadget"]);
    });
});
