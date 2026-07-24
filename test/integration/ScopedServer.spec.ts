import { describe, it, expect } from "vitest";
import { RavenTestDriver } from "../../src/RavenTestDriver";
import { createTestServerOptions } from "../testOptions";

interface Person {
    name: string;
}

describe("scoped server", () => {
    it("runs the driver against its own embedded server", async () => {
        const driver = new RavenTestDriver();
        const disposeScopedServer = driver.configureScopedServer(createTestServerOptions());
        try {
            const store = await driver.getDocumentStore(undefined, "scoped");
            {
                const session = store.openSession();
                await session.store<Person>({ name: "Scoped" }, "people/1");
                await session.saveChanges();
            }
            {
                const session = store.openSession();
                const person = await session.load<Person>("people/1");
                expect(person?.name).toBe("Scoped");
            }
        } finally {
            await driver.dispose();
            await disposeScopedServer();
        }
    });
});
