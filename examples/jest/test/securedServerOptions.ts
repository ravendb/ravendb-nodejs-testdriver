import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { TestServerOptions } from "ravendb-testdriver";

/** examples/certs, shared by every runner's secured example. */
const certsDir = path.resolve(__dirname, "../../certs");

export const caCertPath = path.join(certsDir, "ca.crt");
export const serverCertPath = path.join(certsDir, "server.pfx");
/** Same certificate as server.pfx without the key — node:crypto reads PEM, not PKCS#12. */
export const serverCertPemPath = path.join(certsDir, "server.crt");

/**
 * Server options for an HTTPS server that authenticates its client by certificate.
 *
 * Four things have to line up, and each one fails differently if it doesn't:
 *
 *  1. **The certificate.** `secured()` uses a single certificate for both roles:
 *     the server presents it, and the client authenticates with it. Its
 *     thumbprint is registered as `--Security.WellKnownCertificates.Admin`
 *     automatically, which is what makes that client an operator. Two separate
 *     certificates would mean registering the client's thumbprint yourself.
 *  2. **The thumbprint argument.** For a PFX, `secured()` cannot compute the
 *     thumbprint itself (node:crypto does not parse PKCS#12) and throws unless
 *     you pass one. We read it from the PEM copy of the same certificate.
 *  3. **The bind address.** `https://localhost:0` — the name must be covered by
 *     the certificate's SAN (ours has localhost / 127.0.0.1 / ::1) or the TLS
 *     handshake fails. Port 0 lets the OS pick, and the driver reads the real
 *     URL back.
 *  4. **The CA.** The certificates are self-signed, so the client is told to
 *     trust our own CA. Without it, the client rejects the server's certificate.
 */
export function createSecuredServerOptions(): TestServerOptions {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-example-secured-"));

    const options = new TestServerOptions();
    options.dataDirectory = path.join(tempDir, "data");
    options.logsPath = path.join(tempDir, "logs");
    options.licensing.eulaAccepted = true;

    const license = process.env["RAVEN_LICENSE"];
    const licensePath = process.env["RAVEN_LICENSE_PATH"];
    if (license?.trim()) {
        options.licensing.license = license;
    } else if (licensePath?.trim()) {
        options.licensing.licensePath = licensePath;
    } else {
        options.licensing.throwOnInvalidOrMissingLicense = false;
    }

    options.serverUrl = "https://localhost:0";

    // (certificate, password, thumbprint, CA). Our certificates carry no
    // password, so undefined rather than "".
    options.secured(serverCertPath, undefined, serverCertificateThumbprint(), caCertPath);

    return options;
}

/**
 * SHA-1 thumbprint of the committed certificate, in the uppercase unseparated
 * form RavenDB expects. Read from the PEM copy, since node's X509Certificate
 * parses PEM/DER but not PKCS#12.
 */
export function serverCertificateThumbprint(): string {
    const certificate = new X509Certificate(fs.readFileSync(serverCertPemPath));
    return certificate.fingerprint.replace(/:/g, "").toUpperCase();
}
