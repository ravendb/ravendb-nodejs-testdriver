import { describe, it, expect } from "vitest";
import { RavenTestDriver } from "../../src/RavenTestDriver";
import type { IDocumentStore } from "ravendb";

describe("store argument guard", () => {
    const driver = new RavenTestDriver();

    it("waitForUserToContinueTheTest rejects a missing store with a clear error", async () => {
        await expect(driver.waitForUserToContinueTheTest(undefined as unknown as IDocumentStore))
            .rejects.toThrow("waitForUserToContinueTheTest requires a document store");
    });

    it("waitForIndexing rejects a missing store with a clear error", async () => {
        await expect(driver.waitForIndexing(undefined as unknown as IDocumentStore))
            .rejects.toThrow("waitForIndexing requires a document store");
    });
});
