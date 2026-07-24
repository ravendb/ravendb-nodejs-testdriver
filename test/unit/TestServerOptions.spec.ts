import { describe, it, expect } from "vitest";
import { TestServerOptions } from "../../src/TestServerOptions";
import { ServerOptions } from "ravendb-embedded";

describe("TestServerOptions", () => {
    it("extends ServerOptions", () => {
        expect(new TestServerOptions()).toBeInstanceOf(ServerOptions);
    });

    it("throws on invalid or missing license by default", () => {
        expect(new TestServerOptions().licensing.throwOnInvalidOrMissingLicense).toBe(true);
    });

    it("respects an explicit licensing override in init", () => {
        const options = new TestServerOptions({ licensing: { throwOnInvalidOrMissingLicense: false } });
        expect(options.licensing.throwOnInvalidOrMissingLicense).toBe(false);
    });

    it("keeps the license-throw default when licensing init omits the key", () => {
        const options = new TestServerOptions({ licensing: { eulaAccepted: true } });
        expect(options.licensing.throwOnInvalidOrMissingLicense).toBe(true);
        expect(options.licensing.eulaAccepted).toBe(true);
    });

    it("useFiddler binds to the machine hostname and allows private-network access", () => {
        const options = TestServerOptions.useFiddler();
        expect(options.serverUrl).toMatch(/^http:\/\/.+:0$/);
        expect(options.commandLineArgs).toContain("--Security.UnsecuredAccessAllowed=PrivateNetwork");
        expect(options.licensing.throwOnInvalidOrMissingLicense).toBe(true);
    });
});
