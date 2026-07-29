import { describe, it, expect } from "vitest";
import { RavenTestDriver } from "../../src/RavenTestDriver";
import { TestServerOptions } from "../../src/TestServerOptions";

describe("RavenTestDriver.stopServer", () => {
    it("resolves when no server was ever started", async () => {
        await expect(RavenTestDriver.stopServer()).resolves.toBeUndefined();
    });

    it("resets the configuration lock so configureServer can run again", async () => {
        RavenTestDriver.configureServer(new TestServerOptions());
        await RavenTestDriver.stopServer();
        expect(() => RavenTestDriver.configureServer(new TestServerOptions())).not.toThrow();
    });
});
