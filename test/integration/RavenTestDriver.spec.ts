import { describe, it, expect, afterAll } from "vitest";
import { DocumentStore, GetDatabaseNamesOperation } from "ravendb";
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
});
