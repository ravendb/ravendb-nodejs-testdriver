/**
 * The smallest useful setup: one driver, one store, plain CRUD.
 *
 * `driver.getDocumentStore()` creates a brand-new, isolated database on the
 * shared embedded server and returns a store pointed at it. That database is
 * hard-deleted when the store is disposed — which `driver.dispose()` does for
 * every store the driver handed out.
 */
import * as assert from "node:assert/strict";
import type { IDocumentStore } from "ravendb";
import { RavenTestDriver } from "ravendb-testdriver";
import { createServerOptions } from "./serverOptions";
import type { Person } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

describe("basic CRUD", () => {
    const driver = new RavenTestDriver();
    let store: IDocumentStore;

    before(async () => {
        store = await driver.getDocumentStore();
    });

    after(async () => {
        await driver.dispose();
    });

    it("stores and loads a document", async () => {
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
            assert.equal(person?.age, 30);
        }
    });

    it("updates a tracked document on saveChanges", async () => {
        {
            const session = store.openSession();
            await session.store<Person>({ name: "Ayende", age: 40 }, "people/2");
            await session.saveChanges();
        }
        {
            // The session tracks the loaded entity; mutating it is enough.
            const session = store.openSession();
            const person = await session.load<Person>("people/2");
            person!.age = 41;
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            assert.equal((await session.load<Person>("people/2"))?.age, 41);
        }
    });

    it("deletes a document", async () => {
        {
            const session = store.openSession();
            await session.store<Person>({ name: "Temporary", age: 1 }, "people/3");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            await session.delete("people/3");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            assert.equal(await session.load<Person>("people/3"), null);
        }
    });
});
