import { describe, it, expect } from "vitest";
import { toAuthOptions } from "../../src/RavenTestDriver";
import { TestServerOptions } from "../../src/TestServerOptions";

describe("toAuthOptions", () => {
    it("returns undefined for an unsecured server", () => {
        expect(toAuthOptions(new TestServerOptions())).toBeUndefined();
    });

    it("maps the security block onto the client auth options", () => {
        const options = new TestServerOptions();
        const certificate = Buffer.from("client-cert");
        const ca = Buffer.from("ca-cert");
        options.security = {
            clientCertificate: certificate,
            clientCertificateType: "pfx",
            certificatePassword: "s3cret",
            clientCertificateThumbprint: "AA",
            serverCertificateThumbprint: "BB",
            ca,
        };

        expect(toAuthOptions(options)).toEqual({
            certificate,
            type: "pfx",
            password: "s3cret",
            ca,
        });
    });

    it("omits an absent password and CA", () => {
        const options = new TestServerOptions();
        const certificate = Buffer.from("client-cert");
        options.security = {
            clientCertificate: certificate,
            clientCertificateType: "pem",
            clientCertificateThumbprint: "AA",
            serverCertificateThumbprint: "BB",
        };

        expect(toAuthOptions(options)).toEqual({
            certificate,
            type: "pem",
            password: undefined,
            ca: undefined,
        });
    });
});
