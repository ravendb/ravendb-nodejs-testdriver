/**
 * Seeding from a `.ravendbdump` file instead of code. Useful when the fixture is
 * large, or was exported from a real database: the dump is imported into every
 * database the driver creates, before `setupDatabase` runs.
 *
 *  - `databaseDumpFilePath`   — a path; re-read for every store.
 *  - `databaseDumpFileStream` — a readable stream, buffered to a temp file.
 *    The stream is consumed by the first `getDocumentStore()` call, so a driver
 *    configured this way is good for exactly one store. Use the path variant
 *    for a driver that hands out several.
 *
 * This example builds its own dump with the smuggler so it stays self-contained;
 * in a real suite the dump would be a committed fixture file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSmugglerExportOptions } from "ravendb";
import { RavenTestDriver } from "ravendb-test-driver";
import { createServerOptions } from "./serverOptions";
import type { Person } from "./model";

RavenTestDriver.configureServerOnce(createServerOptions);

describe("importing a database dump", () => {
    const driver = new RavenTestDriver();
    let dumpDir: string;
    let dumpFile: string;

    beforeAll(async () => {
        // Build the fixture: seed a database, then export it to a dump file.
        const source = await driver.getDocumentStore(undefined, "dumpsource");
        {
            const session = source.openSession();
            await session.store<Person>({ name: "FromDump", age: 7 }, "people/dumped");
            await session.saveChanges();
        }

        dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-example-dump-"));
        dumpFile = path.join(dumpDir, "fixture.ravendbdump");

        const exportOperation = await source.smuggler.export(new DatabaseSmugglerExportOptions(), dumpFile);
        await exportOperation.waitForCompletion();
    });

    afterAll(async () => {
        await driver.dispose();
        fs.rmSync(dumpDir, { recursive: true, force: true });
    });

    it("imports a dump from a file path into every store", async () => {
        const fileDriver = new RavenTestDriver({ databaseDumpFilePath: dumpFile });
        try {
            const first = await fileDriver.getDocumentStore(undefined, "dumpfile");
            expect((await first.openSession().load<Person>("people/dumped"))?.name).toBe("FromDump");

            // The path variant is re-read, so a second store is seeded too.
            const second = await fileDriver.getDocumentStore(undefined, "dumpfile");
            expect((await second.openSession().load<Person>("people/dumped"))?.name).toBe("FromDump");
        } finally {
            await fileDriver.dispose();
        }
    });

    it("imports a dump from a stream", async () => {
        const streamDriver = new RavenTestDriver({
            databaseDumpFileStream: fs.createReadStream(dumpFile)
        });
        try {
            const store = await streamDriver.getDocumentStore(undefined, "dumpstream");
            expect((await store.openSession().load<Person>("people/dumped"))?.name).toBe("FromDump");
        } finally {
            await streamDriver.dispose();
        }
    });

    it("combines a dump with a setupDatabase hook", async () => {
        // The dump is imported first, then setupDatabase runs — so the hook can
        // build on, or override, what the dump contains.
        const combinedDriver = new RavenTestDriver({
            databaseDumpFilePath: dumpFile,
            setupDatabase: async (store) => {
                const session = store.openSession();
                await session.store<Person>({ name: "AddedAfterImport", age: 1 }, "people/extra");
                await session.saveChanges();
            }
        });
        try {
            const store = await combinedDriver.getDocumentStore(undefined, "dumpplusseed");
            const session = store.openSession();
            expect((await session.load<Person>("people/dumped"))?.name).toBe("FromDump");
            expect((await session.load<Person>("people/extra"))?.name).toBe("AddedAfterImport");
        } finally {
            await combinedDriver.dispose();
        }
    });
});
